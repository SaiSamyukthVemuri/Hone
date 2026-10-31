"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import {
  AUTO_REFRESH_INTERVAL_MS,
  shouldAutoRefresh,
  type AutoRefreshTrigger,
} from "@/lib/calendar/refresh-policy";
import {
  SCHEDULE_SIGNAL_EVENT,
  createRefreshAttribution,
  createScheduleSignalController,
  REJOIN_MAX_ATTEMPTS,
  isUnannouncedFind,
  rejoinDelayMs,
  scheduleSignalEnabled,
  scheduleSignalTopic,
  type SignalController,
} from "@/lib/calendar/schedule-signal";
import { createClient } from "@/lib/supabase/client";

// HON-48: keeps a passive calendar screen current for the other people using it.
// See lib/calendar/refresh-policy.ts for the rules and why, and
// lib/calendar/schedule-signal.ts for the live signal (migration 0271). Renders
// nothing. It asks the existing server render for a refresh; the live signal is a
// data-free private Realtime message that only sets a flag, and it reads no data.
// The 60 s interval and the focus refresh stay as the floor for anything lost.

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

function readGuards() {
  return {
    visible: document.visibilityState === "visible",
    online: navigator.onLine,
    dialogOpen: document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
    editing: isEditing(),
  };
}

// At most once per page load: a stuck signal path must be visible, not a flood.
let degradedReported = false;

export function CalendarAutoRefresh({
  studioId,
  scheduleFingerprint,
  scopeKey,
}: {
  studioId?: string;
  scheduleFingerprint?: string;
  /** The visible range (view + label). A change is a navigation, not a refresh. */
  scopeKey?: string;
}) {
  const router = useRouter();
  const lastRefreshMs = useRef<number>(Date.now());
  const controllerRef = useRef<SignalController | null>(null);
  const hiddenAtMs = useRef<number | null>(null);
  const channelStatus = useRef<string>("none");
  // What started the last refresh, and whether a live signal had announced a change.
  // Scoped to the refresh that produced the render (see createRefreshAttribution).
  const attribution = useRef(createRefreshAttribution());
  const previousFingerprint = useRef<string | undefined>(scheduleFingerprint);
  const [isPending, startTransition] = useTransition();

  // Navigation to another range discards any pending attribution. Declared before the
  // fingerprint effect so it runs first in the commit that renders the new range.
  useEffect(() => {
    attribution.current.scoped(scopeKey);
  }, [scopeKey]);

  // A fingerprint that changed after a fallback refresh no signal announced = degraded.
  useEffect(() => {
    const changed =
      previousFingerprint.current !== undefined &&
      scheduleFingerprint !== undefined &&
      previousFingerprint.current !== scheduleFingerprint;
    previousFingerprint.current = scheduleFingerprint;
    const last = changed ? attribution.current.landed(true) : null;
    if (
      !changed ||
      !last ||
      controllerRef.current === null ||
      !isUnannouncedFind({ cause: last.cause, announced: last.announced, fingerprintChanged: true })
    ) {
      return;
    }
    if (degradedReported) return;
    degradedReported = true;
    const detail = { cause: last.cause, channel: channelStatus.current };
    console.warn("calendar.schedule_signal.degraded", detail);
    Sentry.captureMessage("calendar.schedule_signal.degraded", { level: "warning", tags: detail });
  }, [scheduleFingerprint]);

  // A refresh that finished without moving the fingerprint is spent: it must not be blamed
  // for a later render. Runs after the fingerprint effect, which consumes a changed one.
  useEffect(() => {
    if (!isPending) attribution.current.landed(false);
  }, [isPending]);

  useEffect(() => {
    function maybeRefresh(trigger: AutoRefreshTrigger) {
      const nowMs = Date.now();
      const ok = shouldAutoRefresh({
        trigger,
        ...readGuards(),
        nowMs,
        lastRefreshMs: lastRefreshMs.current,
      });
      if (!ok) return;
      lastRefreshMs.current = nowMs;
      const announced = controllerRef.current?.markRefresh() ?? false;
      attribution.current.begin(trigger === "signal" ? "signal" : trigger, announced);
      startTransition(() => router.refresh());
    }

    // Poll at a fraction of the interval so a held-off refresh (a drawer was
    // open) happens soon after it closes instead of up to a full interval later.
    const timer = window.setInterval(() => maybeRefresh("interval"), AUTO_REFRESH_INTERVAL_MS / 4);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtMs.current = Date.now();
        return;
      }
      const hiddenFor = hiddenAtMs.current === null ? 0 : Date.now() - hiddenAtMs.current;
      hiddenAtMs.current = null;
      // Catch-up first (a long hide may have slept through signals); the focus
      // refresh then sees the fresh refresh time and does not double it.
      controllerRef.current?.resume(hiddenFor);
      maybeRefresh("focus");
    };
    const onFocus = () => maybeRefresh("focus");
    const onOnline = () => controllerRef.current?.resume(Number.POSITIVE_INFINITY);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [router, startTransition]);

  useEffect(() => {
    const topic = scheduleSignalTopic(studioId);
    if (!topic || !scheduleSignalEnabled(process.env.NEXT_PUBLIC_CALENDAR_SCHEDULE_SIGNAL)) return;
    const supabase = createClient();
    const controller = createScheduleSignalController({
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      guards: readGuards,
      lastRefreshMs: () => lastRefreshMs.current,
      refresh: () => {
        lastRefreshMs.current = Date.now();
        controller.markRefresh();
        attribution.current.begin("signal", true);
        startTransition(() => router.refresh());
      },
    });
    controllerRef.current = controller;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let rejoinTimer: number | null = null;
    let attempt = 0;
    // A refused or queued join (project at its client ceiling, authorization queue) is NOT an
    // error for the user: nothing is shown, nothing blocks render, the 60 s and focus refresh
    // stay the floor. The join is retried a bounded number of times with jitter.
    async function join() {
      // A private channel authorizes with the user's token: hand it over before joining.
      // supabase-js re-sends it on every token refresh by itself.
      await supabase.realtime.setAuth();
      if (cancelled) return;
      const ch = supabase
        .channel(topic as string, { config: { private: true } })
        .on("broadcast", { event: SCHEDULE_SIGNAL_EVENT }, () => controller.signal())
        .subscribe((status) => {
          if (cancelled) return;
          channelStatus.current = status;
          controller.status(status);
          if (status === "SUBSCRIBED") {
            attempt = 0;
            return;
          }
          if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && rejoinTimer === null && attempt < REJOIN_MAX_ATTEMPTS) {
            const delay = rejoinDelayMs(attempt, Math.random);
            attempt += 1;
            void supabase.removeChannel(ch);
            rejoinTimer = window.setTimeout(() => {
              rejoinTimer = null;
              if (!cancelled) void join();
            }, delay);
          }
        });
      channel = ch;
    }
    void join();
    return () => {
      cancelled = true;
      controllerRef.current = null;
      controller.dispose();
      if (rejoinTimer !== null) window.clearTimeout(rejoinTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [studioId, router, startTransition]);

  return null;
}
