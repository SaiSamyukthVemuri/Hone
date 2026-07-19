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
// Token-bearing route prefixes that must never have their URLs sent to
// analytics. These are credentials; the same list is enforced structurally in
// the SafeAnalytics component, and sanitized here as a defence-in-depth layer.
const TOKEN_PATH_PREFIXES = [
  "/portal/verify/",
  "/cancel/",
  "/reschedule/",
  "/manage/",
  "/intake/",
  "/calendar-feed/",
];

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const prefix of TOKEN_PATH_PREFIXES) {
      if (parsed.pathname.startsWith(prefix)) {
        parsed.pathname = prefix + "[token]";
        return parsed.toString();
      }
    }
  } catch {
    // Non-URL string; return as-is
  }
  return url;
}

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",

  // Clinical-data hardening (do NOT re-enable without a privacy review):
  //   * Session recording OFF — it records the live DOM (client names,
  //     treatment notes, probe settings on screen).
  //   * Autocapture OFF — otherwise every click/input/DOM-text snapshot is
  //     sent automatically, which would capture on-screen clinical data. Only
  //     the explicit, reviewed server-side events in the *-actions.ts files
  //     are sent.
  //   * Exception capture OFF — Sentry owns error tracking and scrubs PII;
  //     PostHog's exception capture is un-scrubbed, so don't double-send raw
  //     error messages/stack traces here.
  disable_session_recording: true,
  autocapture: false,
  capture_exceptions: false,

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
});
