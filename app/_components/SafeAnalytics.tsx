"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// PR #142. Shared client wrapper that mounts both Vercel Analytics
// and Vercel Speed Insights together. Used by route-tree layouts
// and marketing leaf pages that are explicitly considered SAFE for
// analytics (no bearer tokens in their URL, no token descendants).
//
// SafeAnalytics is deliberately NOT mounted in the root layout.
// Mounting in root would inherit to every route, including the
// tokenized public routes:
//
//   /portal/verify/<token>
//   /cancel/<token>
//   /reschedule/<token>
//   /manage/<token>
//   /intake/<token>
//   /calendar-feed/<token>     (route handler; no React tree, but
//                              the URL is still bearer-token-shaped)
//
// Token URLs ARE the credential. They MUST NOT be sent to the
// analytics provider, captured in route-change telemetry, or
// leaked via a script that was already loaded in the same SPA
// session. A structural mount-only-on-safe-routes split (this
// component, plus the absence of any analytics import in
// app/layout.tsx) is the correct fix; a client-side pathname
// denylist is too weak because the analytics script can have
// already loaded on a prior safe page.
export function SafeAnalytics() {
  return (
    <>
      <Analytics />
      <SpeedInsights />
    </>
  );
}
