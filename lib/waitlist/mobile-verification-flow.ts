import "server-only";
import {
  limitMobileVerificationEntry,
  limitMobileVerificationIp,
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
// WHAT IS ALREADY DECIDED, THOUGH, IS WHAT A DECLINING RESOLVER REPORTS. A resolver
// that runs and returns null yields `not_proved` — the same value a provider
// refusal yields on the same operation — so a caller cannot tell an unauthorized
// attempt from a refused one. See UNRESOLVED_CONTEXT_REFUSAL below. That answer
// holds whichever mechanism D1 selects, so it did not have to wait for D1.
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
 * WHAT AN UNRESOLVED CONTEXT REPORTS: `not_proved`. **OWNER-DECIDED, 2026-09-28.**
 *
 * A resolver that RUNS and returns null has decided that this authorization proves
 * nothing. That is a statement about the authorization, not about the deployment,
 * and `not_proved` is the coarsest existing refusal — it does not say WHICH
 * possession or authorization step failed, which is exactly the property wanted.
 *
 * IT WAS `unavailable` FOR TWO REVISIONS AND THAT LEAKED AUTHORIZATION VALIDITY.
 * The reasoning was that with no concrete resolver in the tree an unresolvable
 * context is literally "not configured", which `./mobile-verification/types.ts`
 * assigns to `unavailable`. True of Phase 1 as a statement about the tree, and
 * beside the point as a statement about the CALLER: an unauthorized start returned
 * `unavailable` while a provider-refused start returned `not_proved`, so a caller
 * could switch on the difference and learn that their capability was GOOD. Learning
 * a capability resolves to a real entry is learning that entry exists, which is the
 * membership oracle this whole module is shaped to deny. Raised as a P2 against
 * ef5a9278 -- against the TEST that claimed the property held while comparing only
 * object keys, which is how the leak survived being "covered".
 *
 * SO THE TWO NOW MATCH, EXACTLY, AT THE CALLER-VISIBLE LEVEL:
 *
 *   START  unauthorized -> not_proved   ==  provider `refused`  -> not_proved
 *   CHECK  unauthorized -> not_proved   ==  provider `rejected` -> not_proved
 *
 * Asserted by value, not by shape, in tests/lib/waitlist/mobile-verification-flow.test.ts.
 *
 * THIS DOES NOT DECIDE D1. Which authorization mechanism resolves a context --
 * invitation capability, profile-completion grant, or owner-authenticated -- is
 * still open. What is decided is what the flow says when a supplied resolver
 * declines, and that answer is the same whichever mechanism is chosen.
 *
 * PHASE 1 STILL SHIPS NO RESOLVER, and that remains enforced structurally rather
 * than by this constant: `resolve` is a required argument with no default, so no
 * product surface can reach this flow without naming its authorization.
 *
 * One named constant, so the decision has one place to land and a source guard can
 * assert no second site drifted away from it.
 */
const UNRESOLVED_CONTEXT_REFUSAL: VerificationRefusal = "not_proved";

/**
 * Begin a possession challenge for whichever entry the authorization resolves to.
 *
 * ORDER: IP GATE, then authorize, then the per-entry gate, then the provider.
 *
 * THE IP GATE IS FIRST AND THAT IS THE SECURITY PROPERTY. The previous order was
 * authorize-then-limit, and it leaked capability validity once a bucket was
 * exhausted: an INVALID capability returned before the limiter ran (`not_proved`)
 * while a VALID one reached the limiter and returned `rate_limited`. A caller could
 * exhaust their own bucket deliberately and then read validity off the difference.
 * Running the IP gate first makes both cases `rate_limited`, identically, before the
 * resolver is even called.
 *
 * AN EARLIER VERSION OF THIS COMMENT CLAIMED THE MITIGATION IT DID NOT HAVE. It said
 * the per-IP bucket existed for exactly this exposure — and that bucket never ran
 * for an unauthorized caller, because it sat after the resolver. The sentence
 * described a protection the code did not apply.
 *
 * A DENIAL AT STAGE 1 ALSO BOUNDS FAILED-RESOLVER TRAFFIC, which the old order left
 * unbounded: an unauthorized caller reached the resolver on every attempt with no
 * budget to spend.
 */
export async function runStartMobileVerification(
  authorization: VerificationAuthorization,
  resolve: VerificationContextResolver,
  headers: Headers,
  provider?: MobileVerificationProvider,
): Promise<FlowOutcome> {
  // STAGE 1, before anything is resolved or even looked at.
  const ipGate = await limitMobileVerificationIp("start", { headers });
  if (!ipGate.allowed) return { ok: false, code: "rate_limited" };

  const context = await resolve(authorization);
  if (!context) return { ok: false, code: UNRESOLVED_CONTEXT_REFUSAL };

  // STAGE 2, on server-resolved ids only. No second IP budget is spent: one
  // request must not be charged twice for the same conceptual limit.
  const entryGate = await limitMobileVerificationEntry("start", {
    studioId: context.studioId,
    entryId: context.entryId,
  });
  if (!entryGate.allowed) return { ok: false, code: "rate_limited" };

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
  // STAGE 1, before the resolver — same reasoning as `start` above.
  const ipGate = await limitMobileVerificationIp("check", { headers });
  if (!ipGate.allowed) return { ok: false, code: "rate_limited" };

  const context = await resolve(authorization);
  if (!context) return { ok: false, code: UNRESOLVED_CONTEXT_REFUSAL };

  // STAGE 2, on server-resolved ids only.
  const entryGate = await limitMobileVerificationEntry("check", {
    studioId: context.studioId,
    entryId: context.entryId,
  });
  if (!entryGate.allowed) return { ok: false, code: "rate_limited" };

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
