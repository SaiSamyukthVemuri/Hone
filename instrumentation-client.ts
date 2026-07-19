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
// Clinical-data privacy boundary (P1-ANALYTICS-01/-02). Full rationale and the
// pure, tested logic live in lib/analytics/client-boundary.ts:
//   * Autocapture runs ONLY on the explicit public-marketing surface
//     allowlist. The authenticated app, public booking, portal, and every
//     token-bearing route send NO autocapture events. Two independent layers:
//     `autocapture.url_allowlist` (SDK) + `before_send` (drops any
//     autocapture-family event whose URL is not allowlisted, fail closed).
//   * `before_send` also token-sanitizes EVERY string in every outgoing
//     event — including $elements[].attr__href / attr__src and the serialized
//     elements_chain — so a bearer credential can never ride an attribute.
//     (mask_all_text only masks textContent; sanitize_properties only sees
//     top-level properties. Neither protects $elements — before_send does.)
//   * Session recording OFF — it records the live DOM (client names,
//     treatment notes, probe settings on screen).
//   * Exception capture OFF — Sentry owns error tracking, WITH scrubbing.
//   * Surveys OFF — no remotely-configured PostHog UI may inject into a
//     clinical product.
//   * mask_all_text + element_attribute_ignorelist retained for the allowed
//     marketing surface (defense-in-depth even where autocapture is allowed).
import {
  AUTOCAPTURE_URL_ALLOWLIST,
  guardOutgoingEvent,
  sanitizeUrl,
} from "@/lib/analytics/client-boundary";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",

  disable_session_recording: true,
  disable_surveys: true,
  capture_exceptions: false,

  autocapture: {
    // Layer 1: SDK-level surface allowlist (public marketing pages only).
    url_allowlist: AUTOCAPTURE_URL_ALLOWLIST,
    // Drop attributes that commonly hold human-readable PII; keep structural
    // ones (id/class/data-*) for element identification.
    element_attribute_ignorelist: ["aria-label", "title", "alt", "placeholder"],
  },
  mask_all_text: true,

  debug: process.env.NODE_ENV === "development",
  sanitize_properties: (properties) => {
    const urlKeys = ["$current_url", "$referrer"];
    for (const key of urlKeys) {
      if (typeof properties[key] === "string") {
        properties[key] = sanitizeUrl(properties[key] as string);
      }
    }
    return properties;
  },
  // Layer 2: the guarantee. Drops non-allowlisted autocapture-family events
  // and token-sanitizes every string in the payload (incl. $elements).
  before_send: guardOutgoingEvent,
});
