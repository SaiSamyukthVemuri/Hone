// PURE. The rules by which a calendar screen decides WHEN to ask "has what I show changed?" and WHEN to refresh because it did.
// CalendarAutoRefresh only wires timers, fetch and router.refresh() to this; every rule is testable here without a browser
// (the repo has no jsdom, the same split as lib/onboarding/celebration-machine).
//
// Sam's bounds for HON-48 option B, as rules:
//   * poll only while the calendar is VISIBLE and online; a hidden tab aborts its request and sends nothing
//   * never two requests at once (one in flight, the next scheduled only after it settles)
//   * back off exponentially after errors, up to a cap; an auth refusal stops polling for good
//   * check IMMEDIATELY when the tab becomes visible or focused again
//   * refresh ONLY when the server's fingerprint differs from the one this screen was rendered from
//   * the existing hold-off rules stand: never refresh under an open dialog or drawer, a focused field, a hidden tab or
//     while offline. A change seen during a hold-off stays PENDING and is applied when the hold-off clears. It is never
//     dropped, and the baseline never advances early
//   * the 60 s refresh in refresh-policy.ts stays as the backstop (it is not part of this machine)
//
// THE FAILURE THIS IS BUILT AGAINST is a refresh loop: the screen's rendered fingerprint and the server's answer
// disagreeing for the SAME data, so every probe refreshes and every refresh re-renders the same mismatch. Two guards:
//   1. at most ONE change-refresh per distinct server fingerprint (`lastHandled`): a mismatch that persists costs one
//      extra refresh, not one per probe;
//   2. a loop breaker: more than LOOP_MAX_REFRESHES UNFULFILLED change-refreshes inside LOOP_WINDOW_MS suspends probing
//      for LOOP_SUSPEND_MS, logs once, and leaves the 60 s refresh to carry the screen. A refresh is FULFILLED when the next
//      render's baseline catches up to the value it was fired for (or the latest server value): that is a real change,
//      applied, and never counts. Counting real changes here silenced a busy studio's screens for five minutes (found by
//      the five-practitioner measurement: rounds 5 to 14 of 20 fell back to the 60 s cycle).

/** Named so the interval can be tuned against the measured load. About 1.5 s plus the 1.2 to 1.8 s render fits the 2.5 to 4 s target. */
export const PROBE_INTERVAL_MS = 1_500;
export const PROBE_BACKOFF_MAX_MS = 60_000;
/** A probe that has not answered by then is aborted and counted as a transient failure. */
export const PROBE_TIMEOUT_MS = 8_000;
export const LOOP_WINDOW_MS = 60_000;
export const LOOP_MAX_REFRESHES = 5;
/** Short on purpose: a false trip costs one minute on the 60 s backstop, not five. */
export const LOOP_SUSPEND_MS = 120_000;
/** While a change is pending under a hold-off, re-check this often (a dialog closing raises no event of its own). */
export const HOLD_OFF_RECHECK_MS = 500;

/** The shape of a fingerprint answer: 32 lowercase hex characters. Lives here, not in change-fingerprint.ts, because that module is server-only (node:crypto) and the client must validate the body. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

/**
 * What a probe's HTTP status means to the poller. Only an authorization answer stops polling for good: 401, 403, or the
 * session middleware's redirect (an opaque redirect, or status 0). Everything else that is not a success, a 5xx above all
 * (the route answers 503 when its membership read threw), is TRANSIENT: back off and resume when the server recovers.
 */
export function classifyProbeStatus(status: number, type?: string): "auth" | "transient" | "ok" {
  if (type === "opaqueredirect" || status === 0) return "auth";
  if (status === 401 || status === 403) return "auth";
  if (status >= 200 && status < 300) return "ok";
  return "transient";
}

export type PollerEnv = {
  visible: boolean;
  online: boolean;
  /** a modal dialog or drawer is open */
  dialogOpen: boolean;
  /** a text field, select or contenteditable has focus */
  editing: boolean;
};

export type ProbeResult =
  | { kind: "ok"; fingerprint: string }
  | { kind: "transient" } // network error, timeout, 5xx, a malformed body
  | { kind: "auth" }; // 401, 403, or a redirect to /login or /no-access

export type PollerState = {
  /** The fingerprint of the data this screen was last rendered from (supplied by the server render). */
  baseline: string;
  inFlight: boolean;
  nextProbeAtMs: number;
  consecutiveErrors: number;
  /** A server fingerprint that differs from the baseline and has not been applied yet. */
  pending: string | null;
  /** The last server fingerprint a change-refresh was fired for. */
  lastHandled: string | null;
  /** The latest fingerprint the server answered. */
  lastServer: string | null;
  refreshTimesMs: number[];
  suspendedUntilMs: number;
  loopLogged: boolean;
  /** An auth refusal: polling stops for the life of the screen. */
  stopped: boolean;
};

export type PollerEvent =
  | { type: "tick"; nowMs: number; env: PollerEnv }
  /** The tab became visible, took focus, or came back online: probe now. */
  | { type: "returned"; nowMs: number; env: PollerEnv }
  | { type: "hidden" }
  /** A new server render arrived carrying its own fingerprint. */
  | { type: "baseline"; fingerprint: string }
  /** `jitter` is a number in [0, 1) supplied by the caller, so this stays deterministic. */
  | { type: "probed"; nowMs: number; env: PollerEnv; result: ProbeResult; jitter: number };

export type PollerEffect =
  | { type: "probe" }
  | { type: "abort" }
  | { type: "refresh" }
  | { type: "log"; code: "change_refresh_loop" };

export function initialPollerState(baseline: string, nowMs: number): PollerState {
  return {
    baseline,
    inFlight: false,
    nextProbeAtMs: nowMs + PROBE_INTERVAL_MS,
    consecutiveErrors: 0,
    pending: null,
    lastHandled: null,
    lastServer: null,
    refreshTimesMs: [],
    suspendedUntilMs: 0,
    loopLogged: false,
    stopped: false,
  };
}

/** The wait after the n-th consecutive failure: 3 s, 6 s, 12 s ... capped. */
export function probeBackoffMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return PROBE_INTERVAL_MS;
  return Math.min(PROBE_BACKOFF_MAX_MS, PROBE_INTERVAL_MS * 2 ** consecutiveErrors);
}

function holdOffClear(env: PollerEnv): boolean {
  return env.visible && env.online && !env.dialogOpen && !env.editing;
}

type Step = { state: PollerState; effects: PollerEffect[] };

/** The shared decision after any event: apply a pending change if allowed, then probe if due. */
function settle(input: PollerState, nowMs: number, env: PollerEnv): Step {
  let state = input;
  const effects: PollerEffect[] = [];
  if (state.stopped) return { state, effects };

  if (state.suspendedUntilMs > 0) {
    if (nowMs < state.suspendedUntilMs) return { state, effects };
    state = { ...state, suspendedUntilMs: 0, refreshTimesMs: [], loopLogged: false };
  }

  if (state.pending !== null && holdOffClear(env)) {
    const recent = state.refreshTimesMs.filter((t) => nowMs - t < LOOP_WINDOW_MS);
    if (recent.length >= LOOP_MAX_REFRESHES) {
      // The loop breaker: stop asking, leave the screen to the 60 s refresh, say so once.
      state = { ...state, refreshTimesMs: recent, suspendedUntilMs: nowMs + LOOP_SUSPEND_MS, pending: null, loopLogged: true };
      if (!input.loopLogged) effects.push({ type: "log", code: "change_refresh_loop" });
      return { state, effects };
    }
    effects.push({ type: "refresh" });
    state = { ...state, lastHandled: state.pending, pending: null, refreshTimesMs: [...recent, nowMs] };
  }

  if (!state.inFlight && env.visible && env.online && nowMs >= state.nextProbeAtMs) {
    effects.push({ type: "probe" });
    state = { ...state, inFlight: true };
  }
  return { state, effects };
}

export function stepPoller(state: PollerState, event: PollerEvent): Step {
  switch (event.type) {
    case "tick":
      return settle(state, event.nowMs, event.env);

    case "returned":
      // Immediate check on return, even inside a back-off window; the error count is kept so a dead endpoint still backs off.
      return settle({ ...state, nextProbeAtMs: Math.min(state.nextProbeAtMs, event.nowMs) }, event.nowMs, event.env);

    case "hidden":
      return state.inFlight
        ? { state: { ...state, inFlight: false }, effects: [{ type: "abort" }] }
        : { state, effects: [] };

    case "baseline": {
      const pending = state.pending === event.fingerprint ? null : state.pending;
      // A render that carries a DIFFERENT baseline than the one held means the screen has caught up with something (our own
      // refresh, or a change this very session made): the dedupe marker has done its job, so clear it. Otherwise a later,
      // real return to a value we once handled (B -> local change C -> another session returns the server to B) would be
      // suppressed until the 60 s backstop. A persistent page/probe MISMATCH re-renders the SAME baseline, so it keeps the
      // marker, and the breaker still bounds a baseline that keeps moving.
      const moved = event.fingerprint !== state.baseline;
      const lastHandled = moved ? null : state.lastHandled;
      // FULFILLED: the render moved the baseline to what the refresh was fired for (or to the latest server value). That
      // refresh did its job, so it stops counting toward the loop breaker.
      const fulfilled = moved && (event.fingerprint === state.lastHandled || event.fingerprint === state.lastServer);
      const refreshTimesMs = fulfilled ? state.refreshTimesMs.slice(0, -1) : state.refreshTimesMs;
      return { state: { ...state, baseline: event.fingerprint, pending, lastHandled, refreshTimesMs }, effects: [] };
    }

    case "probed": {
      // A late answer to a request that was aborted or superseded decides nothing.
      if (!state.inFlight) return { state, effects: [] };
      let next: PollerState = { ...state, inFlight: false };
      const r = event.result;
      if (r.kind === "auth") {
        return { state: { ...next, stopped: true, pending: null }, effects: [] };
      }
      if (r.kind === "transient") {
        const errors = next.consecutiveErrors + 1;
        next = { ...next, consecutiveErrors: errors, nextProbeAtMs: event.nowMs + probeBackoffMs(errors) };
        return settle(next, event.nowMs, event.env);
      }
      // ok. A little jitter keeps five screens from probing in lockstep.
      const wait = Math.round(PROBE_INTERVAL_MS * (0.9 + 0.2 * event.jitter));
      next = { ...next, consecutiveErrors: 0, nextProbeAtMs: event.nowMs + wait, lastServer: r.fingerprint };
      if (r.fingerprint === next.baseline) {
        next = { ...next, pending: null };
      } else if (r.fingerprint !== next.lastHandled) {
        next = { ...next, pending: r.fingerprint };
      }
      return settle(next, event.nowMs, event.env);
    }
  }
}

/** Milliseconds until the machine next has something to do, or null when only an event (a result, a return) can wake it. */
export function nextWakeDelayMs(state: PollerState, nowMs: number, env: PollerEnv): number | null {
  if (state.stopped) return null;
  if (state.suspendedUntilMs > 0) return Math.max(0, state.suspendedUntilMs - nowMs);
  if (!env.visible || !env.online) return null;
  if (state.pending !== null && !holdOffClear(env)) return HOLD_OFF_RECHECK_MS;
  if (state.inFlight) return null;
  return Math.max(0, state.nextProbeAtMs - nowMs);
}
