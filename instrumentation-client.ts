// Sentry initialization for the browser. Hardened for a clinical app:
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
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import {
  scrubBreadcrumb,
  scrubErrorEvent,
  scrubTransactionEvent,
  tracesSampleRate,
} from "@/lib/observability/sentry-scrub";

Sentry.init({
  dsn: "https://83582fd24c2d75b0a2ada024251147bc@o4511758551941120.ingest.us.sentry.io/4511758557839360",

  sendDefaultPii: false,

  tracesSampleRate: tracesSampleRate(),

  beforeSend: scrubErrorEvent,
  beforeSendTransaction: scrubTransactionEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
