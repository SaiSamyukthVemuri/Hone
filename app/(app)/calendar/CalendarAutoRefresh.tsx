"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  AUTO_REFRESH_INTERVAL_MS,
  shouldAutoRefresh,
  type AutoRefreshTrigger,
} from "@/lib/calendar/refresh-policy";
import {
  FINGERPRINT_PATTERN,
  PROBE_TIMEOUT_MS,
  initialPollerState,
  nextWakeDelayMs,
  stepPoller,
  type PollerEffect,
  type PollerEnv,
  type PollerEvent,
  type PollerState,
  type ProbeResult,
} from "@/lib/calendar/change-poller";
import type { CalendarView } from "@/lib/calendar/calendar-load-range";

// HON-48: keeps a passive calendar screen current for the other people using it. See lib/calendar/refresh-policy.ts for
// the 60 s refresh and lib/calendar/change-poller.ts for the change probe and why. Renders nothing. It asks the existing
// server render for a refresh; it holds no open connection and reads no data itself: the probe is one small GET that
// answers with a hash, and the screen refreshes only when that hash differs from the one its own render carried.

export type ChangeProbeProps = {
  view: CalendarView;
  /** The view's anchor date (the day, the week's first day, or the month's first day), exactly as the page loaded it. */
  anchor: string;
  /** The fingerprint of the rows this render was drawn from. */
  fingerprint: string;
};

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

function readEnv(): PollerEnv {
  return {
    visible: document.visibilityState === "visible",
    online: navigator.onLine,
    dialogOpen: dialogOpen(),
    editing: isEditing(),
  };
}

async function classify(res: Response): Promise<ProbeResult> {
  // The session middleware answers an unauthorized or role-less caller with a redirect; with redirect:"manual" that is an
  // opaque redirect (or status 0). It is an authorization answer, not an outage, so polling stops.
  if (res.type === "opaqueredirect" || res.status === 0) return { kind: "auth" };
  if (res.status === 401 || res.status === 403) return { kind: "auth" };
  if (!res.ok) return { kind: "transient" };
  try {
    const body = (await res.json()) as { fingerprint?: unknown };
    return typeof body.fingerprint === "string" && FINGERPRINT_PATTERN.test(body.fingerprint)
      ? { kind: "ok", fingerprint: body.fingerprint }
      : { kind: "transient" };
  } catch {
    return { kind: "transient" };
  }
}

export function CalendarAutoRefresh({ probe }: { probe?: ChangeProbeProps }) {
  const router = useRouter();
  const lastRefreshMs = useRef<number>(Date.now());

  // The 60 s backstop and the focus refresh, unchanged.
  useEffect(() => {
    function maybeRefresh(trigger: AutoRefreshTrigger) {
      const nowMs = Date.now();
      const ok = shouldAutoRefresh({
        trigger,
        visible: document.visibilityState === "visible",
        online: navigator.onLine,
        dialogOpen: dialogOpen(),
        editing: isEditing(),
        nowMs,
        lastRefreshMs: lastRefreshMs.current,
      });
      if (!ok) return;
      lastRefreshMs.current = nowMs;
      router.refresh();
    }

    // Poll at a fraction of the interval so a held-off refresh (a drawer was
    // open) happens soon after it closes instead of up to a full interval later.
    const timer = window.setInterval(() => maybeRefresh("interval"), AUTO_REFRESH_INTERVAL_MS / 4);
    const onVisible = () => {
      if (document.visibilityState === "visible") maybeRefresh("focus");
    };
    const onFocus = () => maybeRefresh("focus");
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [router]);

  // The change probe. One machine per (view, anchor); a new render's fingerprint is fed to it as the new baseline.
  const fingerprintRef = useRef<string | null>(probe?.fingerprint ?? null);
  const feedBaseline = useRef<((fingerprint: string) => void) | null>(null);
  const view = probe?.view;
  const anchor = probe?.anchor;

  useEffect(() => {
    if (probe?.fingerprint) {
      fingerprintRef.current = probe.fingerprint;
      feedBaseline.current?.(probe.fingerprint);
    }
  }, [probe?.fingerprint]);

  useEffect(() => {
    if (!view || !anchor || !fingerprintRef.current) return;
    const url = `/api/calendar/change-fingerprint?view=${encodeURIComponent(view)}&anchor=${encodeURIComponent(anchor)}`;
    let state: PollerState = initialPollerState(fingerprintRef.current, Date.now());
    let wake: number | undefined;
    let controller: AbortController | null = null;
    let timeout: number | undefined;
    let disposed = false;

    function schedule() {
      window.clearTimeout(wake);
      const delay = nextWakeDelayMs(state, Date.now(), readEnv());
      if (delay !== null) wake = window.setTimeout(() => run({ type: "tick", nowMs: Date.now(), env: readEnv() }), delay);
    }

    function run(event: PollerEvent) {
      if (disposed) return;
      const out = stepPoller(state, event);
      state = out.state;
      for (const effect of out.effects) apply(effect);
      schedule();
    }

    function apply(effect: PollerEffect) {
      if (effect.type === "probe") void startProbe();
      else if (effect.type === "abort") {
        const c = controller;
        controller = null; // its late answer is dropped
        window.clearTimeout(timeout);
        c?.abort();
      } else if (effect.type === "refresh") {
        lastRefreshMs.current = Date.now(); // the 60 s backstop need not fire right behind a change refresh
        router.refresh();
      } else if (effect.type === "log") {
        console.warn("calendar change refresh suspended: the screen kept differing from the server; the 60 s refresh continues");
      }
    }

    async function startProbe() {
      const c = new AbortController();
      controller = c;
      timeout = window.setTimeout(() => c.abort(), PROBE_TIMEOUT_MS);
      let result: ProbeResult;
      try {
        const res = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "manual", signal: c.signal });
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
    feedBaseline.current = (fingerprint) => run({ type: "baseline", fingerprint });
    schedule();

    return () => {
      disposed = true;
      feedBaseline.current = null;
      window.clearTimeout(wake);
      window.clearTimeout(timeout);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("online", onReturn);
    };
  }, [view, anchor, router]);

  return null;
}
