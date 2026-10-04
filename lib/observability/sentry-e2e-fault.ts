import "server-only";
import type { ErrorEvent } from "@sentry/nextjs";
import {
  E2E_ROUTE_FAULT_CANARY,
  isE2eRouteFaultEnabled,
} from "@/lib/reliability/e2e-route-fault";
import { scrubErrorEvent } from "@/lib/observability/sentry-scrub";

// ===========================================================================
// SENTRY-NOISE-01 - the deliberate E2E fault harness is not an operational event
// ===========================================================================
//
// `app/(app)/e2e-fault/[case]` throws on purpose so `app/(app)/error.tsx` is
// proven to contain a REAL route error, and `e2e/helpers/local-env.ts` sets
// HONE_E2E_ROUTE_FAULT=1 for every run of the local browser lane. Each run
// posted synthetic failures into the Sentry project that carries genuine
// production ones, and a queue that mixes the two cannot be triaged.
//
// SUPPRESSION REQUIRES A CONJUNCTION, AND BOTH HALVES WERE LEARNED THE HARD WAY.
//
//   * ROUTE ALONE IS NOT AN IDENTITY. `/e2e-fault/<case>` proves WHERE an error
//     was raised, never that it was deliberate. The harness page runs real
//     framework code behind the real middleware and app shell, so an unexpected
//     TypeError or a `cookies()` misuse can be raised there like anywhere else.
//
//   * THE CANARY ALONE IS NOT AN IDENTITY EITHER, because it is not secret and
//     real error messages interpolate request-controlled text. Concretely:
//     `app/(app)/calendar/page.tsx` passes `params.month` through unvalidated to
//     `firstOfMonthString`, and `lib/booking/month-grid.ts` throws
//     `Invalid YYYY-MM-DD date string: ${dateStr}` with the raw value in it. So
//     GET /calendar?view=month&month=<canary> makes a GENUINE production error
//     carry the canary. Dropping on the canary alone would let any visitor
//     silence their own real failures.
//
// So an event is suppressed only when the canary is present AND the harness is
// provably active in THIS process. The second half is
// `isE2eRouteFaultEnabled`, the harness's OWN activation invariant, reused
// rather than re-derived: HONE_E2E_ROUTE_FAULT=1 and no deployed-runtime
// signal. It is read from the server environment, never from the request, so no
// header, cookie, query or form value can supply it.
//
// WHY THIS MODULE IS server-only, AND WHY THAT IS THE POINT. The canary and the
// activation predicate both live in the server-only guard module, and
// `ClientFault.tsx` records why that matters: keeping the canary there means it
// "is never compiled into the production client bundle". An earlier revision of
// this change declared the marker in the isomorphic `sentry-scrub.ts`, which
// `instrumentation-client.ts` imports - and that shipped the token into two
// public client chunks, handing every visitor the string needed to abuse the
// weakness above. Keeping the whole decision server-side restores that
// invariant; `sentry-scrub.ts` is untouched and stays harness-free.
//
// CONSEQUENCE, ACCEPTED DELIBERATELY: the browser cannot read a server-only
// env, so a CLIENT-side synthetic fault is no longer dropped. The only way to
// gate the client would be a NEXT_PUBLIC_* input - inlined at build time,
// shipped to every visitor, and a deployable bypass able to silence client-side
// Sentry in production. Per the fail-open rule, an unprovable harness identity
// keeps the event. Server-side synthetic noise (server-throw, once) is
// suppressed; the client-throw case stays visible in the local lane.

// WHY ONLY THE NODE SERVER RUNTIME IS WIRED, AND NOT EDGE.
// The harness throws inside a Node Server Component (`app/(app)/e2e-fault/
// [case]/page.tsx`, force-dynamic), so no synthetic event originates in the
// edge runtime. Wiring edge as well would rest on an UNVERIFIED assumption -
// that Next's edge runtime exposes this non-inlined, server-only variable
// through `process.env` - which a unit test cannot establish and which would
// therefore be a vacuous guard. Edge keeps `scrubErrorEvent` directly and, by
// the fail-open rule, keeps every event. If a synthetic edge source ever
// appears, wiring it needs its own evidence that the variable is readable
// there.

/** The ONE real error reachable on the harness route, which must always be sent.
 *
 *  `assertRouteFaultNotRequestedInDeployment` throws when HONE_E2E_ROUTE_FAULT
 *  is set in a deployed runtime, and exists precisely so that misconfiguration
 *  "surfaces immediately". Checked FIRST, so the alarm survives even when the
 *  harness is active and a canary string is present beside it. */
export const E2E_FAULT_DEPLOYMENT_GUARD_SENTINEL =
  "must never be set in a deployed environment";

/** The message-bearing strings of an error event, and only those.
 *
 *  Deliberately NOT breadcrumbs, extra, tags or contexts: the canary is matched
 *  to DROP an event, so widening where it may be found widens what a stray
 *  mention can silence. */
function errorTexts(event: ErrorEvent): string[] {
  const texts: string[] = [];
  if (typeof event.message === "string") texts.push(event.message);
  // `logentry.message` IS included, deliberately. Sentry populates this
  // interface instead of the plain `message` for some captures, so a synthetic
  // fault could carry the canary only here; leaving it out would make the drop
  // depend on which capture path fired. Widening the scan cannot widen
  // attacker-driven suppression, because positive harness context is checked
  // FIRST - in a deployed runtime no field of any event is ever examined.
  const logentry = (event as { logentry?: { message?: unknown } }).logentry;
  if (typeof logentry?.message === "string") texts.push(logentry.message);
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === "string") texts.push(ex.value);
  }
  return texts;
}

/**
 * True only when BOTH the exact canary identity and positive server-side
 * harness context are proven.
 *
 * Pure given `env`, and evaluated on the RAW event before any redaction,
 * because `redactString` rewrites `exception.values[].value` and a scrubbed
 * message is no longer reliable evidence of its own origin.
 *
 * Nothing about the route, transaction or URL participates.
 */
export function isDeliberateE2eFaultEvent(
  event: ErrorEvent,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const texts = errorTexts(event);

  // 1. The deployment-guard alarm always wins.
  if (texts.some((t) => t.includes(E2E_FAULT_DEPLOYMENT_GUARD_SENTINEL))) {
    return false;
  }

  // 2. Positive harness context, checked BEFORE the canary so that in a
  //    deployed runtime no event is ever examined for it: production
  //    short-circuits here and every event is kept.
  if (!isE2eRouteFaultEnabled(env)) return false;

  // 3. The exact deliberate canary.
  return texts.some((t) => t.includes(E2E_ROUTE_FAULT_CANARY));
}

/**
 * `beforeSend` for the server and edge runtimes: drop a proven deliberate E2E
 * fault, otherwise hand the event to the ordinary privacy scrub.
 *
 * Scrubbing is NOT reimplemented here - `scrubErrorEvent` remains the single
 * authority, so a kept event is redacted exactly as it is in every runtime.
 */
export function beforeSendWithE2eFaultSuppression(
  event: ErrorEvent,
): ErrorEvent | null {
  if (isDeliberateE2eFaultEvent(event)) return null;
  return scrubErrorEvent(event);
}
