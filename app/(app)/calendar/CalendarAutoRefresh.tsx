"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  AUTO_REFRESH_INTERVAL_MS,
  shouldAutoRefresh,
  type AutoRefreshTrigger,
} from "@/lib/calendar/refresh-policy";

// HON-48: keeps a passive calendar screen current for the other four people
// using it. See lib/calendar/refresh-policy.ts for the rules and why. Renders
// nothing. It asks the existing server render for a refresh; it opens no
// connection and reads no data itself.

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

export function CalendarAutoRefresh() {
  const router = useRouter();
  const lastRefreshMs = useRef<number>(Date.now());

  useEffect(() => {
    function maybeRefresh(trigger: AutoRefreshTrigger) {
      const nowMs = Date.now();
      const ok = shouldAutoRefresh({
        trigger,
        visible: document.visibilityState === "visible",
        online: navigator.onLine,
        dialogOpen: document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
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

  return null;
}
