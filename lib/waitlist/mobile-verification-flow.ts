import "server-only";
import {
  limitMobileVerificationCheck,
  limitMobileVerificationStart,
} from "@/lib/rate-limit/public";
import {
  checkMobileVerification,
  startMobileVerification,
  type VerificationRefusal,
} from "@/lib/waitlist/mobile-verification-server";
import type { MobileVerificationProvider } from "@/lib/waitlist/mobile-verification";

// WAIT B2b-2 — the authorized flow around the B2b-1 state machine.
//
// WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
//
// B2b-1 shipped `startMobileVerification` / `checkMobileVerification`, which take
// `{entryId, storedPhone}` ALREADY RESOLVED and hold no identity decision. Its own
// header says the caller "arrives in B2b-2". This is that caller, and it adds
// exactly three things: an authorization step, a rate-limit boundary, and a single
// generic refusal vocabulary. It adds no new promotion path, no new RPC call, and
// no new provider outcome.
//
// THERE IS STILL NO PHONE-ONLY ENTRY POINT, AT ANY LAYER. Nothing here accepts a
// phone number. The destination is derived inside the state machine from the row,
// which is the property that stops this being a waitlist-membership oracle: a
// caller who could name a number and learn that a challenge started would have
// learned the number is on a waitlist.
//
// ---------------------------------------------------------------------------
// THE D1 SEAM — READ THIS BEFORE WIRING A SURFACE TO IT
// ---------------------------------------------------------------------------
//
// `VerificationContextResolver` is a SEAM, not an implementation, and Phase 1
// ships no concrete resolver on purpose. Which authorization resolves a
// verification context is owner decision D1, and it is not a detail this file may
// guess: the three candidates differ in what they authorize, when they are
// reachable, and whether a migration is required.
//
//   A  INVITATION CAPABILITY. Compose two commands already in production:
//      `resolve_new_client_waitlist_invitation` (entry_id, studio_id) and
//      `resolve_waitlist_invitation_recipient_identity` (phone). No migration.
//      Reachable only once an invitation is LIVE — which is after the moment a
//      verified mobile would have been useful, because the point of verifying is
//      to be allowed to text a prospect at all.
//   B  PROFILE-COMPLETION GRANT. Needs one new narrow capability-gated read
//      returning (entry_id, phone), in the shape 0192 established twice. The right
//      moment, and the only option under which WAIT_04B_CAPABILITIES.verifiesMobile
//      can become true, because that flag describes the COMPLETION binding.
//      Requires a migration.
//   C  OWNER-AUTHENTICATED. `authenticated` holds row SELECT under RLS and the
//      owner UI already reads `phone`. Solves `start` only: an owner cannot enter
//      the prospect's code, so `check` still needs a prospect-facing surface.
//
// WHY A SEAM AND NOT A DEFAULT. A resolver is the one component that decides WHO
// is being verified. Shipping a plausible-looking one and letting a later surface
// find it would put an identity decision in place that nobody chose — the same
// shape of defect as B2b-1's first revision, where a resolver returned something
// that looked inert and was not. So the seam is a required argument with no
// fallback, and a surface cannot reach this flow without naming its authorization.
//
// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
//
// NO LOGS HERE, for the reason the state machine gives: the capability, the
// submitted code and the resolved phone are all in local scope. The rate limiter
// logs a route class and a retry-after and hashes the IP before it does; nothing
// in this file passes it anything else.

/**
 * The opaque authorization a surface holds. A bearer string and a studio id.
 *
 * `capability` IS NEVER LOGGED, never returned, never put in an error string and
 * never used as a rate-limit key. It goes to the resolver and nowhere else.
 *
 * `studioId` scopes the rate-limit buckets. It is a public-ish identifier already
 * present on every public surface, and it is NOT trusted for authorization: the
 * resolver re-derives the studio from the capability, and the promotion command
 * re-checks the row.
 */
export type VerificationAuthorization = {
  capability: string;
  studioId: string;
};

/**
 * What a resolver must produce: the row's own identity and the phone AS STORED.
 *
 * `storedPhone` is the exact stored string and not an E.164 form, because
 * `mark_waitlist_mobile_verified` compares it EXACTLY as a compare-and-set. A
 * resolver that canonicalized it here would refuse every real proof.
 */
export type ResolvedVerificationContext = {
  entryId: string;
  studioId: string;
  storedPhone: string | null;
};

/**
 * Resolve an authorization into a row context, or null when it authorizes nothing.
 *
 * NULL MUST COVER EVERY UNAUTHORIZED CASE INDISTINGUISHABLY — absent, malformed,
 * unknown, revoked, expired, already-consumed, or belonging to another studio. A
 * resolver that returned a different value for "expired" than for "unknown" would
 * hand the surface a distinction it must not render, which is how a membership
 * oracle gets rebuilt one helpful refinement at a time.
 */
export type VerificationContextResolver = (
  authorization: VerificationAuthorization,
) => Promise<ResolvedVerificationContext | null>;

export type FlowOutcome =
  | { ok: true }
  | { ok: false; code: VerificationRefusal };

/**
 * WHAT AN UNRESOLVED CONTEXT REPORTS, AND WHY IT IS `unavailable` **IN PHASE 1
 * SPECIFICALLY**.
 *
 * B2b-1 defines `unavailable` as "Not configured, network failure, provider
 * error. Retryable." With no concrete resolver in the tree, an unresolvable
 * context is precisely NOT CONFIGURED — the same fact about the deployment that
 * the fail-closed provider reports, and the honest thing to say about a system
 * whose authorization step does not exist yet.
 *
 * THIS MAPPING IS PART OF DECISION D1 AND MUST BE REVISITED WITH IT. Once a real
 * resolver exists, `null` stops meaning "not configured" and starts meaning "this
 * capability authorizes nothing" — which is NOT retryable, and must be
 * indistinguishable from the coarsest legitimate refusal on the same operation
 * rather than from an outage. Leaving `unavailable` in place after D1 would invite
 * a caller to retry a capability that will never work, and would distinguish an
 * unauthorized start from a provider-refused start by its retry advice.
 *
 * It is a named constant so that the decision has one place to land, and so that
 * a source guard can assert no second site drifted away from it.
 */
const UNRESOLVED_CONTEXT_REFUSAL: VerificationRefusal = "unavailable";

/**
 * Begin a possession challenge for whichever entry the authorization resolves to.
 *
 * ORDER: authorize, then rate limit, then ask the provider. Authorizing first is
 * what lets the per-entry budget exist at all — the bucket is keyed by the
 * resolved row, so an unauthorized caller cannot choose which bucket to spend, and
 * cannot spend anyone's.
 *
 * THE COST OF THAT ORDER, STATED RATHER THAN HIDDEN: an unauthorized caller reaches
 * the resolver on every attempt, so the resolver is the surface that must be cheap
 * and constant-ish. That is a property of the D1 implementation, and it is the
 * reason the per-IP bucket exists as well as the per-entry one.
 */
export async function runStartMobileVerification(
  authorization: VerificationAuthorization,
  resolve: VerificationContextResolver,
  headers: Headers,
  provider?: MobileVerificationProvider,
): Promise<FlowOutcome> {
  const context = await resolve(authorization);
  if (!context) return { ok: false, code: UNRESOLVED_CONTEXT_REFUSAL };

  const gate = await limitMobileVerificationStart({
    headers,
    studioId: context.studioId,
    entryId: context.entryId,
  });
  if (!gate.allowed) return { ok: false, code: "rate_limited" };

  // The state machine derives the destination from `storedPhone` and refuses when
  // there is not one. No number from the request reaches it.
  return provider
    ? startMobileVerification(
        { entryId: context.entryId, storedPhone: context.storedPhone },
        provider,
      )
    : startMobileVerification({
        entryId: context.entryId,
        storedPhone: context.storedPhone,
      });
}

/**
 * Submit a code. ONLY a provider approval can promote a standing, and this
 * function adds no path to that write: it calls the same state machine, which asks
 * the provider first and returns before any write exists to make on every
 * non-approval.
 *
 * THE CODE IS THE ONLY CALLER-SUPPLIED VALUE THAT REACHES THE PROVIDER, and it
 * reaches it as an opaque string. It is never compared here, never logged, and
 * never used as a key.
 */
export async function runCheckMobileVerification(
  authorization: VerificationAuthorization,
  code: string,
  resolve: VerificationContextResolver,
  headers: Headers,
  provider?: MobileVerificationProvider,
): Promise<FlowOutcome> {
  const context = await resolve(authorization);
  if (!context) return { ok: false, code: UNRESOLVED_CONTEXT_REFUSAL };

  const gate = await limitMobileVerificationCheck({
    headers,
    studioId: context.studioId,
    entryId: context.entryId,
  });
  if (!gate.allowed) return { ok: false, code: "rate_limited" };

  const target = {
    entryId: context.entryId,
    storedPhone: context.storedPhone,
    code,
  };
  const outcome = provider
    ? await checkMobileVerification(target, provider)
    : await checkMobileVerification(target);

  // Collapsed to the flow's shape. `verified: true` is not re-reported: a surface
  // that needs to know the standing reads the row, and passing the flag onward
  // would invite a caller to treat this return value as the evidence.
  return outcome.ok ? { ok: true } : { ok: false, code: outcome.code };
}
