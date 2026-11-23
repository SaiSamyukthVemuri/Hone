"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  SUMMARY_TIMEOUT_MS,
  classifyProbeStatus,
  initialLivePollerState,
  nextLiveWakeDelayMs,
  parseSummary,
  stepLivePoller,
  type LivePollerEffect,
  type LivePollerEvent,
  type LivePollerState,
  type PollerEnv,
  type ProbeResult,
} from "@/lib/notifications/live-poller";

// HON-40 shell contract: the once-per-page notification host. Mounted in layout.tsx above BOTH header containers, because the header
// renders every control twice (one per header mode) and a poller inside a control would run twice. HON-106 owns this file. Props:
//   initialPersistedUnread  the server-read count of unread persisted notifications for this viewer
//   computedUnread          the computed overdue-disinfectant count (no row, no event); the live count ADDS it and never drops it,
//                           only the persisted part is live
//
// WHAT IT DOES: one poll of /api/notifications/summary per tab (see lib/notifications/live-poller for the rules), keeps the last known
// persisted count on any failure, and records the ids of notifications that ARRIVED after the page loaded, each once. A server render
// that carries a new count (a navigation, a mark-as-read) replaces the polled one: the server's number wins.
// WHAT IT DOES NOT DO YET: show a toast. Which events toast, and where, is a product decision; the arrival ids are exposed for the
// toast host that decision will add inside this provider.

const SEEN_KEY = "hone:notifications-seen";
const SUMMARY_URL = "/api/notifications/summary";

export type NotificationsLive = {
  /** persisted unread (live) + computed overdue disinfectant alerts (server render) */
  unread: number;
  /** ids that arrived after this screen loaded, each once, newest last */
  arrivals: readonly string[];
};

const NotificationsContext = createContext<NotificationsLive | null>(null);

/** The live bell count, or null when no provider is mounted (the caller falls back to the server-rendered number). */
export function useNotificationsLive(): NotificationsLive | null {
  return useContext(NotificationsContext);
}

// The seen set is stored WITH an opaque marker of the viewer it belongs to (from the summary answer), so another person signing in
// in the same tab never inherits the first person's ids: the poller discards a set whose marker differs from the first answer's.
function readSeen(): { viewer: string | null; seen: string[] } {
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return { viewer: null, seen: [] };
    const { viewer, seen } = parsed as { viewer?: unknown; seen?: unknown };
    return {
      viewer: typeof viewer === "string" ? viewer : null,
      seen: Array.isArray(seen) ? seen.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return { viewer: null, seen: [] };
  }
}

function writeSeen(viewer: string | null, seen: readonly string[]) {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify({ viewer, seen }));
  } catch {
    // storage unavailable (private window, blocked): the seen set still lives in memory for this page
  }
}

function readEnv(): PollerEnv {
  return { visible: document.visibilityState === "visible", online: navigator.onLine, dialogOpen: false, editing: false };
}

async function classify(res: Response): Promise<ProbeResult> {
  // The session middleware answers an unauthorized or role-less caller with a redirect; with redirect:"manual" that is an opaque redirect.
  const kind = classifyProbeStatus(res.status, res.type);
  if (kind !== "ok") return { kind };
  try {
    const summary = parseSummary(await res.json());
    return summary ? { kind: "ok", summary } : { kind: "transient" };
  } catch {
    return { kind: "transient" };
  }
}

export function NotificationsProvider({
  initialPersistedUnread,
  computedUnread,
  children,
}: {
  initialPersistedUnread: number;
  computedUnread: number;
  children: ReactNode;
}) {
  const [persisted, setPersisted] = useState(initialPersistedUnread);
  const [arrivals, setArrivals] = useState<readonly string[]>([]);

  // The server's number wins whenever a new render carries one.
  const [feedBaseline, setFeedBaseline] = useState<((n: number) => void) | null>(null);
  useEffect(() => {
    setPersisted(initialPersistedUnread);
    feedBaseline?.(initialPersistedUnread);
  }, [initialPersistedUnread, feedBaseline]);

  useEffect(() => {
    const remembered = readSeen();
    let state: LivePollerState = initialLivePollerState(initialPersistedUnread, Date.now(), remembered.seen, remembered.viewer);
    let wake: number | undefined;
    let controller: AbortController | null = null;
    let timeout: number | undefined;
    let disposed = false;

    function publish(prev: LivePollerState, next: LivePollerState) {
      if (next.persistedUnread !== prev.persistedUnread) setPersisted(next.persistedUnread);
      if (next.arrivals !== prev.arrivals) setArrivals(next.arrivals);
      if (next.seen !== prev.seen || next.viewer !== prev.viewer) writeSeen(next.viewer, next.seen);
    }

    function schedule() {
      window.clearTimeout(wake);
      const delay = nextLiveWakeDelayMs(state, Date.now(), readEnv());
      if (delay !== null) wake = window.setTimeout(() => run({ type: "tick", nowMs: Date.now(), env: readEnv() }), delay);
    }

    function run(event: LivePollerEvent) {
      if (disposed) return;
      const prev = state;
      const out = stepLivePoller(state, event);
      state = out.state;
      publish(prev, state);
      for (const effect of out.effects) apply(effect);
      schedule();
    }

    function apply(effect: LivePollerEffect) {
      if (effect.type === "probe") void startProbe();
      else {
        const c = controller;
        controller = null; // its late answer is dropped
        window.clearTimeout(timeout);
        c?.abort();
      }
    }

    async function startProbe() {
      const c = new AbortController();
      controller = c;
      timeout = window.setTimeout(() => c.abort(), SUMMARY_TIMEOUT_MS);
      let result: ProbeResult;
      try {
        const res = await fetch(SUMMARY_URL, { cache: "no-store", credentials: "same-origin", redirect: "manual", signal: c.signal });
        result = await classify(res);
      } catch {
        result = { kind: "transient" };
      }
      window.clearTimeout(timeout);
      if (controller !== c) return; // aborted because the tab was hidden, or superseded
      controller = null;
      run({ type: "probed", nowMs: Date.now(), env: readEnv(), result, jitter: Math.random() });
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") run({ type: "returned", nowMs: Date.now(), env: readEnv() });
      else run({ type: "hidden" });
    };
    const onReturn = () => run({ type: "returned", nowMs: Date.now(), env: readEnv() });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onReturn);
    window.addEventListener("online", onReturn);
    setFeedBaseline(() => (n: number) => run({ type: "baseline", persistedUnread: n }));
    schedule();

    return () => {
      disposed = true;
      setFeedBaseline(null);
      window.clearTimeout(wake);
      window.clearTimeout(timeout);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("online", onReturn);
    };
    // One machine for the life of the shell; a new server count reaches it through `feedBaseline`, never by restarting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<NotificationsLive>(() => ({ unread: persisted + computedUnread, arrivals }), [persisted, computedUnread, arrivals]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
