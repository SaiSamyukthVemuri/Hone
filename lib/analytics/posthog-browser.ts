// Marketing-only PostHog browser init (HON-124 item 6).
//
// PostHog is deliberately NOT started from instrumentation-client.ts: that file
// runs on EVERY route, and posthog-js writes a stable device/distinct id to a
// cookie, localStorage and sessionStorage as soon as it initialises, whatever
// `before_send` later drops. A production-build browser check showed `ph_*`
// storage on the app, /book, /cancel/<token> and the portal. So PostHog now
// starts only from the marketing surface (MarketingAnalytics, mounted by
// MarketingSurface on the exact marketing pages), after a route check, and the
// posthog-js code is loaded lazily so non-marketing routes do not even fetch it.
// `before_send` (guardBrowserEvent) stays as the backstop for what leaves.
//
// A visitor who lands on a marketing page and then navigates in-app keeps the id
// that page created; nothing new is created off the marketing surface.
//
// Clinical-data browser-event boundary (P1-ANALYTICS-01/-02). Full rationale +
// pure, tested logic in lib/analytics/client-boundary.ts. Fail closed by
// (event, surface): the ONLY browser events that leave are $pageview,
// $pageleave, autocapture-family, and marketing:*, and ONLY on the exact
// canonical marketing routes. The authenticated app, /book/*, portal, all
// token routes, login/auth and payment send NOTHING (browser $pageview/
// $pageleave/autocapture all dropped). Authenticated product measurement runs
// through the server taxonomy (lib/analytics/server.ts); identify is
// server-side only. Config is explicit, never rely on an SDK default that a
// future release could flip; `before_send` is the default-independent
// guarantee.
import {
  AUTOCAPTURE_URL_ALLOWLIST,
  guardBrowserEvent,
  isMarketingPath,
} from "@/lib/analytics/client-boundary";

let started: Promise<void> | null = null;

/** Start PostHog once, and only when the current page is an exact marketing route. */
export function initMarketingPostHog(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!isMarketingPath(window.location.pathname)) return Promise.resolve();
  if (started) return started;
  started = import("posthog-js").then(({ default: posthog }) => {
    // Re-check after the async load: the visitor may have navigated off the marketing surface.
    if (!isMarketingPath(window.location.pathname)) {
      started = null;
      return;
    }
    // No token (local and CI lanes) means no init. The chunk still loads on marketing pages, which is what
    // e2e/marketing-analytics-boundary.spec.ts uses as its positive control.
    const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    if (!token) return;
    posthog.init(token, {
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      defaults: "2026-01-30",

      // Explicit safety switches (do not rely on SDK defaults):
      disable_session_recording: true, // never record the live DOM
      disable_surveys: true, // no remotely-injected UI in a clinical product
      // No /flags request at all (#828 G-07/G-26). Hone uses no feature flags, and
      // posthog-js 1.404.1 sends the first page this browser ever loaded
      // ($initial_current_url, which can be /clients/<uuid>) in every /flags body,
      // which before_send never sees. Pinned by tests/lib/analytics/posthog-url-ids.test.ts.
      advanced_disable_flags: true,
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
  });
  return started;
}
