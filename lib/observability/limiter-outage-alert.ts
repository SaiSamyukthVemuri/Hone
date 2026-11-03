import * as Sentry from "@sentry/nextjs";
import { THROWN_ERROR_CLASSES } from "@/lib/logging/error-class";

// DN-29 operator alert (Sam chose the EXISTING Sentry project). ONE event per instance per route class per interval (the
// throttle lives in lib/rate-limit/outage.ts), and it carries ONLY closed values: no identifier, hash, slug, studio id, email,
// token, link, URL, IP, header, error message or stack. Every field is validated against a closed list here, so even a caller
// that passed something it should not cannot put it on the wire: an unknown value becomes "other"/"unknown".
//
// It is sent as a Sentry MESSAGE (not an exception): there is no stack to scrub, and `extra`, `contexts`, `user`, `request`
// and breadcrumbs are never set. The runtime's own beforeSend (scrubErrorEvent, deny-by-default) still runs over it. The
// The tag is deploy_env (not "environment", which Sentry reserves for its own field). The fingerprint groups by route class and outcome so the alert rule fires once per kind of outage, not once per request.

export const LIMITER_OUTAGE_EVENT = "ratelimit_outage_fallback";

const ROUTE_CLASSES = new Set([
  "public_slots", "public_book", "new_client_waitlist", "portal_login", "waitlist_proof", "waitlist", "demo",
  "cancel_view", "cancel_submit", "reschedule_view", "reschedule_slots", "reschedule_submit", "intake_save", "intake_submit",
]);
const KINDS = new Set(["refuse", "book", "slots", "marketing", "open"]);
const MODES = new Set(["enforce", "open"]);
const REASONS = new Set(["disabled", "error"]);
const OUTCOMES = new Set(["refused", "refused_no_keys", "refused_counter_unreachable", "fallback_active", "fallback_limited"]);
const ENVIRONMENTS = new Set(["production", "preview", "development", "test"]);
const ERROR_CLASSES: ReadonlySet<string> = new Set(THROWN_ERROR_CLASSES);

const closed = (set: ReadonlySet<string>, v: unknown, fallback: string): string => (typeof v === "string" && set.has(v) ? v : fallback);

export type LimiterOutagePayload = {
  routeClass: unknown;
  kind: unknown;
  mode: unknown;
  reason: unknown;
  outcome: unknown;
  errorClass?: unknown;
  environment: unknown;
};

/** The exact tag set that leaves the process. Exported so the tests assert on the real thing. */
export function limiterOutageTags(p: LimiterOutagePayload): Record<string, string> {
  return {
    event: LIMITER_OUTAGE_EVENT,
    route_class: closed(ROUTE_CLASSES, p.routeClass, "other"),
    kind: closed(KINDS, p.kind, "other"),
    mode: closed(MODES, p.mode, "other"),
    reason: closed(REASONS, p.reason, "other"),
    outcome: closed(OUTCOMES, p.outcome, "other"),
    error_class: closed(ERROR_CLASSES, p.errorClass, "none"),
    deploy_env: closed(ENVIRONMENTS, p.environment, "other"),
  };
}

export function reportLimiterOutage(p: LimiterOutagePayload): void {
  try {
    const tags = limiterOutageTags(p);
    // An ISOLATED, CLEARED isolation scope AND current scope: whatever the surrounding request attached (user, extra, contexts, breadcrumbs, request data)
    // is not inherited, so the alert carries only the closed tags below.
    Sentry.withIsolationScope((isolation) => {
      isolation.clear();
      Sentry.withScope((scope) => {
        scope.clear();
        Sentry.captureMessage(LIMITER_OUTAGE_EVENT, {
          level: "error",
          tags,
          fingerprint: [LIMITER_OUTAGE_EVENT, tags.route_class, tags.outcome],
        });
      });
    });
  } catch {
    // Alerting must never break the request it describes.
  }
}
