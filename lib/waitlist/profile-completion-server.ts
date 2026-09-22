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

  // FALSE, AND THIS IS THE FLAG THE WHOLE SLICE TURNS ON.
  //
  // The contract requires BOTH halves: the six SMS columns writable AND an
  // inbound STOP reaching the row. 0202 gives the first. The second does not
  // exist — `app/api/twilio/inbound-sms/route.ts` selects from and updates
  // `clients`, and never touches `new_client_waitlist_entries`. 0202 ships
  // `suppress_waitlist_prospects` for that path to use, and no path uses it
  // yet.
  //
  // A consent we could record but not honour is worse than no consent field at
  // all, because it produces written evidence of an agreement we would then
  // break. So the surface does not ask (`collectsSmsConsent`), and
  // `completeWaitlistProfile` forces the argument false regardless of what the
  // payload says — belt and braces, because the surface is client code and the
  // guarantee must not depend on it.
  recordsSmsConsent: false,

  // FALSE until a verification mechanism exists. `mobile_verified_at` has no
  // writer in 0202 at all: the guard raises on any attempt to move it. A
  // candidate is not a destination, and `prospectMayReceiveSms` therefore
  // refuses every prospect send — the correct standing behaviour, not a gap.
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

  const admin = createAdminClient();
  try {
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
