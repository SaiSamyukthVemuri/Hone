import { SIGNAL_REFRESH_MIN_GAP_MS, shouldAutoRefresh } from "@/lib/calendar/refresh-policy";

// HON-48 Q7 (migration 0271): the database sends a data-free "the schedule changed"
// message on a private per-studio Realtime topic after a schedule write commits.
// This module is the whole client-side decision, kept free of React, the DOM and
// the Supabase client so every rule is proved without a browser:
//
//   * a message only SETS A FLAG; the same guards as every other refresh decide
//     WHEN (never while a drawer is open, a field is focused, the tab is hidden or
//     the browser is offline) — a held refresh stays pending and fires once the
//     screen is idle again;
//   * a burst of messages inside COALESCE_MS becomes one refresh;
//   * Broadcast is at-most-once with no replay, so EVERY join (the first one too: a
//     change may land between the page render and the join) and every return from a
//     long hide or an offline spell sets the flag (one catch-up refresh), and the
//     60 s and focus refreshes in CalendarAutoRefresh remain the floor;
//   * when that floor finds a change no signal announced, that is reported as a
//     degraded-signal event (isUnannouncedFind);
//   * the message content is never read.

export const SCHEDULE_SIGNAL_EVENT = "changed";
/** Signals arriving within this window of the first become one refresh. */
export const SIGNAL_COALESCE_MS = 250;
/** While a refresh is held (drawer open, field focused), look again this often. */
export const PENDING_RECHECK_MS = 500;
/**
 * A tab hidden at least this long may have had its socket silently put to sleep and
 * missed messages for good, so coming back is a catch-up. A short alt-tab is not.
 */
export const RESUME_CATCHUP_AFTER_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The private topic for a studio, or null for anything that is not a lower-case uuid. */
export function scheduleSignalTopic(studioId: string | null | undefined): string | null {
  return typeof studioId === "string" && UUID.test(studioId) ? `schedule:${studioId}` : null;
}

/**
 * Operational switch (build-time public env). DEFAULT OFF: the client ships dark and only
 * "on" enables it, so the triggers may land first. Anything else, including unset, is off.
 */
export function scheduleSignalEnabled(flag: string | undefined): boolean {
  return flag === "on";
}

/** Rejoin attempts after a refused, queued or errored join before giving up to the 60 s floor. */
export const REJOIN_MAX_ATTEMPTS = 6;

/**
 * Jittered, bounded back-off for re-joining after CHANNEL_ERROR / TIMED_OUT (a refused or
 * queued join, a project at its client ceiling). Equal jitter, so a reconnect storm after an
 * outage does not re-queue itself in lockstep. `random` is injected for tests.
 */
export function rejoinDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export type SignalGuards = { visible: boolean; online: boolean; dialogOpen: boolean; editing: boolean };

export type SignalControllerDeps = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  guards: () => SignalGuards;
  /** When this screen last loaded or refreshed (shared with the interval/focus triggers). */
  lastRefreshMs: () => number;
  /** Performs the refresh AND records it as the last refresh. */
  refresh: () => void;
};

export type SignalController = {
  /** A schedule-changed message arrived. */
  signal: () => void;
  /** A channel status: SUBSCRIBED, CLOSED, CHANNEL_ERROR, TIMED_OUT. */
  status: (s: string) => void;
  /**
   * The tab became visible or the browser came back online. A refresh held while it
   * was hidden may now run; after a long hide (or any offline spell: pass Infinity)
   * the socket may have slept through messages, so this is also a catch-up.
   */
  resume: (hiddenForMs: number) => void;
  /**
   * A refresh is being started by anything. Returns true when a live signal was heard
   * since the previous mark (the change, if any, was announced) and starts a new window.
   */
  markRefresh: () => boolean;
  isPending: () => boolean;
  dispose: () => void;
};

export function createScheduleSignalController(deps: SignalControllerDeps): SignalController {
  let pending = false;
  let timer: unknown = null;
  let heard = false;
  let disposed = false;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    if (disposed || timer !== null) return;
    timer = deps.setTimer(() => {
      timer = null;
      evaluate();
    }, ms);
  };

  function evaluate() {
    if (disposed || !pending) return;
    const g = deps.guards();
    const ok = shouldAutoRefresh({
      trigger: "signal",
      ...g,
      nowMs: deps.now(),
      lastRefreshMs: deps.lastRefreshMs(),
    });
    if (ok) {
      pending = false;
      deps.refresh();
      return;
    }
    // Hidden or offline: no polling at all; resume() continues. Held by a drawer or a
    // focused field: look again shortly. Held ONLY by the minimum gap: look again exactly
    // when it ends, so a burst folded into this flag is one refresh at the earliest moment,
    // not up to a recheck interval later. Nothing here touches the network.
    if (g.visible && g.online) {
      const sinceLast = deps.now() - deps.lastRefreshMs();
      const remaining = SIGNAL_REFRESH_MIN_GAP_MS - sinceLast;
      const onlyTheGap = !g.dialogOpen && !g.editing && Number.isFinite(sinceLast) && sinceLast >= 0 && remaining > 0;
      schedule(onlyTheGap ? remaining : PENDING_RECHECK_MS);
    }
  }

  return {
    signal() {
      if (disposed) return;
      heard = true;
      pending = true;
      schedule(SIGNAL_COALESCE_MS);
    },
    status(s) {
      if (disposed || s !== "SUBSCRIBED") return;
      // Every join is a catch-up: anything sent before the first join, or while the
      // socket was down, is gone for good. It is not an announcement of a change.
      pending = true;
      schedule(SIGNAL_COALESCE_MS);
    },
    resume(hiddenForMs) {
      if (disposed) return;
      if (hiddenForMs >= RESUME_CATCHUP_AFTER_MS) pending = true;
      if (!pending) return;
      clear();
      evaluate();
    },
    markRefresh() {
      const was = heard;
      heard = false;
      return was;
    },
    isPending: () => pending,
    dispose() {
      disposed = true;
      clear();
    },
  };
}

export type RefreshCause = "interval" | "focus" | "signal";

/**
 * True when the 60 s or focus fallback refresh found a schedule change that no live
 * signal announced since the previous refresh: the signal path is degraded (socket
 * down, policy missing, Realtime outage). Refreshes caused by a signal, and the screen's
 * own writes (cause null), never count.
 */
export function isUnannouncedFind(a: {
  cause: RefreshCause | null;
  announced: boolean;
  fingerprintChanged: boolean;
}): boolean {
  return a.fingerprintChanged && !a.announced && (a.cause === "interval" || a.cause === "focus");
}
