"use client";

import { useEffect } from "react";
import { track } from "@vercel/analytics";

// Privacy-safe click delegator. Fires a marketing analytics event, the event
// NAME only, never any PII/PHI, when the user clicks any element carrying a
// `data-event` attribute (marketing CTAs). Mounted once per marketing page via
// MarketingSurface. Event names come from lib/marketing/content ANALYTICS_EVENTS.
// No name/email/studio/free-text/token/client data is ever attached.
export function MarketingAnalytics() {
  useEffect(() => {
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
