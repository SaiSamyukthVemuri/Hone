// WAIT-04B — server authority for completing a legacy waitlist profile.
//
// SERVER ONLY. The single command this calls is granted to service_role alone,
// so there is no browser-reachable path to it. `complete_waitlist_profile_by_grant`
// resolves the entry from the hashed capability under the canonical studio ->
// entry lock order; this module adds no identity decision of its own.
//
// THE DATABASE REMAINS THE AUTHORITY. Validity, replay, expiry, revocation,
// lifecycle and the one-way mobile rule are all decided in 0202 and reported as
// closed result codes. This translates those codes into the contract's typed
// outcome and nothing more.
//
// NOTHING HERE THROWS ACROSS THE BOUNDARY, and nothing here reports a write it
// did not observe: an unexpected transport failure becomes `unavailable`, which
// is the one refusal the contract lets a surface invite a retry on.

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type {
  CompleteProfileInput,
  CompletionOutcome,
  ProfileAdapterCapabilities,
} from "@/lib/waitlist/profile-binding-contract";

// ---------------------------------------------------------------------------
// WHAT THIS BINDING CAN ACTUALLY DO
// ---------------------------------------------------------------------------
//
// Declared once, here, and read by the surface. Each flag is a fact about the
// SYSTEM, not an intention.

export const WAIT_04B_CAPABILITIES: ProfileAdapterCapabilities = {
  // 0202 shipped first_name, last_name, treatment_area_ids and the availability
  // row that 0193 already owned.
  storesProfileFields: true,

  // TRUE NOW, AND ONLY BECAUSE BOTH HALVES ARE FINALLY TRUE.
  //
  // The contract requires both: the six SMS columns writable AND an inbound
  // STOP reaching the row. 0202 gave the first and this slice gives the second
  // — `app/api/twilio/inbound-sms/route.ts` now scans
  // `waitlist_prospect_suppression_candidates()`, runs the SAME
  // `selectHoneSuppressionTargets` it runs for clients, and stamps through
  // `suppress_waitlist_prospects`. One valid STOP reaches a prospect row, in
  // every studio, whichever sender received it.
  //
  // WHY THE ORDER MATTERED. A consent we could record but not honour is worse
  // than no consent field at all: it produces written evidence of an agreement
  // the system would then break. So the flag stayed false while only the
  // recording half existed, the surface did not ask, and the binding forced the
  // argument false. Flipping it before the STOP path existed would have been
  // the flag lying about the system rather than describing it.
  //
  // WHAT THIS DOES NOT DECIDE: sending. Since Roadmap v1.25 (operator decision
  // D4(2), 2026-10-08) `prospectMayReceiveSms` allows a text on recorded consent
  // and no STOP, with verification optional. Each text is still claimed once
  // per invitation, behind the studio switch, the phone check and the
  // deployment fence (SMS-01). Recording consent honestly is this flag's
  // question; acting on it is the sender's.
  recordsSmsConsent: true,

  // FALSE, AND THE REASON HAS NARROWED AGAIN RATHER THAN GONE AWAY.
  //
  // PRODUCTION NOW HAS A WRITER. `0203` was applied on 2026-09-27 and is the
  // hosted head, so `mark_waitlist_mobile_verified` exists in production and the
  // guard admits it. An earlier revision of this comment said production had no
  // writer at all; that was true until the apply and false the instant it landed.
  //
  // THE FLAG STAYS FALSE ANYWAY, and the reason is now the only one left: A WRITER
  // IS NOT A VERIFICATION MECHANISM. The provider the state machine resolves by
  // default is FAIL-CLOSED — it answers `unavailable` to everything and approves
  // nothing — the fake is reachable only by explicit injection from a test, no
  // Twilio Verify Service exists, and nothing arms the real adapter. So no
  // possession proof can be obtained today, and nothing may claim one was.
  //
  // WHAT WOULD FLIP IT: a live Verify adapter armed against a real service. Not
  // the migration, which has landed, and not the plumbing, which exists.
  //
  // THIS FLIPS WHEN THE PROVIDER IS REAL, not when the plumbing exists: 0203
  // applied AND a live Verify adapter armed. Flipping it on the strength of the
  // plumbing would be the flag lying about the system, which is the same mistake
  // `recordsSmsConsent` above was held back from making.
  //
  // No mobile is proven, and since D4(2) that refuses nothing:
  // `prospectMayReceiveSms` decides on consent and STOP. This flag only says
  // that no verification is claimed.
  verifiesMobile: false,

  // 0193 issues and revokes the grant; 0202 redeems it for profile completion.
  supportsCompletionCapability: true,
};

// ---------------------------------------------------------------------------
// RESULT TRANSLATION
// ---------------------------------------------------------------------------
//
// 0202 returns exactly three codes. They are mapped to the contract's coarse
// refusals, and the coarseness is deliberate: an invalid token, a revoked
// grant, an expired grant and an already-completed entry all return
// `not_authorized`, because distinguishing them tells an anonymous holder which
// it was — and "valid but already used" is itself a disclosure about a named
// person.

function outcomeFor(result: string | null): CompletionOutcome {
  switch (result) {
    case "accepted":
      return { ok: true };
    case "invalid_submission":
      return { ok: false, code: "invalid_submission" };
    case "refused":
      return { ok: false, code: "not_authorized" };
    default:
      // An unrecognised code is NOT a refusal. It means this module and the
      // database disagree about the contract, and reporting it as
      // `not_authorized` would render "not authorised" to someone who may have
      // done nothing wrong and whose submission may or may not have committed.
      return { ok: false, code: "unavailable" };
  }
}

/**
 * Redeem a completion capability and write the profile.
 *
 * THE TOKEN IS NEVER LOGGED, never returned, never put in an error string and
 * never used to key anything. It goes to the database and nowhere else.
 */
export async function completeWaitlistProfile(
  input: CompleteProfileInput,
): Promise<CompletionOutcome> {
  const { patch } = input;

  try {
    // CONSTRUCTED INSIDE THE BOUNDARY. This sat outside the `try`, so a client
    // that failed to construct — a missing service-role key, a malformed URL —
    // threw straight past every typed outcome in this file and out to the
    // caller, which is exactly what the header above promises never happens.
    // The failure mode it produced was the worst available: an exception on a
    // path whose whole job is to report IN DOUBT rather than raise.
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("complete_waitlist_profile_by_grant", {
      p_raw_token: input.capabilityToken,
      p_first_name: patch.firstName,
      p_last_name: patch.lastName,
      p_treatment_area_ids: patch.treatmentAreaIds,
      p_preference: patch.availabilityPreference,
      // THE ARM IS CARRIED BY THE PATCH, NOT BY A NULL CHECK. `unchanged` has
      // no `mobileCandidate` property to read, so a replacement cannot be
      // expressed here even by mistake — the union already made it unsayable in
      // TypeScript and this preserves that at the call.
      p_mobile_candidate:
        patch.mobileDisposition === "candidate_supplied" ? patch.mobileCandidate : null,
      // FORCED, NOT FORWARDED. While `recordsSmsConsent` is false the answer is
      // false whatever the payload carried. The surface already withholds the
      // question; this makes the guarantee independent of the surface, which is
      // client code and therefore not where a consent rule should rest.
      p_sms_consent: WAIT_04B_CAPABILITIES.recordsSmsConsent
        ? input.smsOperationalConsent
        : false,
    });

    // A transport failure is IN DOUBT, not a refusal: the statement may or may
    // not have committed, and `unavailable` is the only code that says so.
    if (error) return { ok: false, code: "unavailable" };

    return outcomeFor(typeof data === "string" ? data : null);
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
