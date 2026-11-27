"use client";

import { useEffect } from "react";
import { track } from "@vercel/analytics";
import { initMarketingPostHog } from "@/lib/analytics/posthog-browser";

// Privacy-safe click delegator. Fires a marketing analytics event, the event
// NAME only, never any PII/PHI, when the user clicks any element carrying a
// `data-event` attribute (marketing CTAs). Mounted once per marketing page via
// MarketingSurface. Event names come from lib/marketing/content ANALYTICS_EVENTS.
// No name/email/studio/free-text/token/client data is ever attached.
//
// It is also the ONLY place PostHog starts (HON-124 item 6): MarketingSurface
// mounts it on exactly the marketing pages, so no PostHog id is stored on the
// app, /book, portal or token routes. See lib/analytics/posthog-browser.ts.
export function MarketingAnalytics() {
  useEffect(() => {
    void initMarketingPostHog();
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[data-event]");
      const name = el?.getAttribute("data-event");
      if (name) track(name);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
