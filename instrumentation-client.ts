// Browser instrumentation: Sentry (errors + tracing) AND PostHog (product
// analytics). Both initialize at client load. Hardened for a clinical app.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import {
  scrubBreadcrumb,
  scrubErrorEvent,
  scrubTransactionEvent,
  tracesSampleRate,
} from "@/lib/observability/sentry-scrub";

// --- Sentry ---
//   * sendDefaultPii: false  — no IPs, cookies, headers, request bodies or
//     user identity are attached by default.
//   * Session Replay: DISABLED — it records the live DOM (client names,
//     treatment notes on screen). Do NOT re-enable without a privacy review.
//   * Sentry Logs: DISABLED — console output routinely contains PII.
//   * beforeSend / beforeSendTransaction / beforeBreadcrumb run the
//     deny-by-default scrubbers in lib/observability/sentry-scrub.ts.
//   * Events reach Sentry via the same-origin tunnel (/monitoring, configured
//     in next.config.ts), so the strict CSP connect-src 'self' already permits
//     them and no ingest host is added to the policy.
Sentry.init({
  dsn: "https://83582fd24c2d75b0a2ada024251147bc@o4511758551941120.ingest.us.sentry.io/4511758557839360",

  sendDefaultPii: false,

  tracesSampleRate: tracesSampleRate(),

  beforeSend: scrubErrorEvent,
  beforeSendTransaction: scrubTransactionEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

// --- PostHog ---
// Clinical-data browser-event boundary (P1-ANALYTICS-01/-02). Full rationale +
// pure, tested logic in lib/analytics/client-boundary.ts. Fail closed by
// (event, surface): the ONLY browser events that leave are $pageview,
// $pageleave, autocapture-family, and marketing:* — and ONLY on the exact
// canonical marketing routes. The authenticated app, /book/*, portal, all
// token routes, login/auth and payment send NOTHING (browser $pageview/
// $pageleave/autocapture all dropped). Authenticated product measurement runs
// through the server taxonomy (lib/analytics/server.ts); identify is
// server-side only. Config is explicit — never rely on an SDK default that a
// future release could flip; `before_send` is the default-independent
// guarantee.
import {
  AUTOCAPTURE_URL_ALLOWLIST,
  guardBrowserEvent,
} from "@/lib/analytics/client-boundary";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",

  // Explicit safety switches (do not rely on SDK defaults):
  disable_session_recording: true, // never record the live DOM
  disable_surveys: true, // no remotely-injected UI in a clinical product
  capture_exceptions: false, // Sentry owns errors, with scrubbing
  capture_heatmaps: false, // no heatmap events
  capture_performance: false, // no $web_vitals (carries URLs)

  // Pageview/pageleave ARE generated, but before_send delivers them only on
  // marketing surfaces. Set explicitly so behaviour is not default-dependent.
  capture_pageview: true,
  capture_pageleave: true,

  autocapture: {
    url_allowlist: AUTOCAPTURE_URL_ALLOWLIST, // arm autocapture on marketing only
    element_attribute_ignorelist: ["aria-label", "title", "alt", "placeholder"],
  },
  mask_all_text: true,

  debug: process.env.NODE_ENV === "development",

  // The authoritative, fail-closed boundary for EVERY browser event.
  before_send: guardBrowserEvent,
});
