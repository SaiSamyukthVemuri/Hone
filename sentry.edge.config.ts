// Sentry initialization for the edge runtime (middleware, edge routes).
// Same hardening as the server config: sendDefaultPii:false plus the
// deny-by-default scrubbers in lib/observability/sentry-scrub.ts, Sentry Logs
// off. See instrumentation-client.ts for the full rationale.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import {
  scrubBreadcrumb,
  scrubErrorEvent,
  scrubTransactionEvent,
  tracesSampleRate,
} from "@/lib/observability/sentry-scrub";

// Staging isolation overlay: DSN is env-controlled. Left unset in staging so
// `enabled:false` prevents any events reaching the production Sentry project.
const sentryDsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn),

  sendDefaultPii: false,

  tracesSampleRate: tracesSampleRate(),

  beforeSend: scrubErrorEvent,
  beforeSendTransaction: scrubTransactionEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
