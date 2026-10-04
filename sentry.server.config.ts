// Sentry initialization for the Node.js server runtime. Hardened for a
// clinical app: sendDefaultPii:false plus the deny-by-default scrubbers in
// lib/observability/sentry-scrub.ts (applied to extra, contexts, tags,
// breadcrumbs, request data, span data and the user object). Sentry Logs stay
// off. See instrumentation-client.ts for the full rationale.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import {
  scrubBreadcrumb,
  scrubTransactionEvent,
  tracesSampleRate,
} from "@/lib/observability/sentry-scrub";
// SENTRY-NOISE-01: the server-side runtimes drop a PROVEN deliberate E2E fault
// (exact canary AND the harness's own server-only activation invariant) and
// delegate every kept event to `scrubErrorEvent`. The client runtime cannot
// prove harness context without a NEXT_PUBLIC_* bypass, so it keeps wiring
// `scrubErrorEvent` directly and fails open.
import { beforeSendWithE2eFaultSuppression } from "@/lib/observability/sentry-e2e-fault";

Sentry.init({
  dsn: "https://83582fd24c2d75b0a2ada024251147bc@o4511758551941120.ingest.us.sentry.io/4511758557839360",

  sendDefaultPii: false,

  tracesSampleRate: tracesSampleRate(),

  beforeSend: beforeSendWithE2eFaultSuppression,
  beforeSendTransaction: scrubTransactionEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
