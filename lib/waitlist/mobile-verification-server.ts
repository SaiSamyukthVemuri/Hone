// WAIT B2b — server authority for proving possession of a prospect's mobile.
//
// SERVER ONLY. The single promoting command is granted to service_role alone, so
// there is no browser-reachable path to it, and 0185 left no role holding DML on
// new_client_waitlist_entries at all.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE REFUSES TO DECIDE
// ---------------------------------------------------------------------------
//
// IT NEVER RESOLVES WHO IS BEING VERIFIED. `entryId` and `storedPhone` arrive
// already resolved by the caller from a capability or an authenticated context.
// There is deliberately no "start verification for this phone number" entry
// point: a phone-only lookup is a membership oracle, because a caller who learns
// that a challenge was accepted has learned that the number is on a waitlist.
//
// IT HOLDS NO OTP STATE. No code, no secret, no expiry, no attempt counter. The
// provider owns all of it (`./mobile-verification/types.ts` says why). Hone
// inventing those is how brute-force and replay defects get written.
//
// IT NEVER WRITES THE STANDING ITSELF. Only 0203's
// `mark_waitlist_mobile_verified` can, it is the only writer the transition
// guard admits, and it re-checks the phone as a compare-and-set.
//
// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
//
// NO CODE, NO FULL PHONE NUMBER, NO CAPABILITY TOKEN, NO PROVIDER PAYLOAD is
// logged here — and the simplest way to guarantee that is to emit no logs at
// all from this module, the same position lib/sms/provider/twilio-provider.ts
// takes. Callers receive a typed outcome and decide what is safe to record.

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { normalizePhoneForMatch, normalizePhoneForSms } from "@/lib/sms/twilio";
import {
  resolveMobileVerificationProvider,
  type MobileVerificationProvider,
} from "@/lib/waitlist/mobile-verification";

/**
 * What the caller must already know. Both fields come from the row, not from the
 * person: `storedPhone` is the value the entry holds, read server-side.
 */
export type MobileVerificationTarget = {
  entryId: string;
  /** Exactly as stored on the row. Passed through to the compare-and-set. */
  storedPhone: string | null;
};

export const VERIFICATION_REFUSALS = [
  /** No usable destination: absent, or not canonicalizable to E.164. */
  "no_destination",
  /** The provider would not start, or would not accept the proof. ONE value. */
  "not_proved",
  /** Too many attempts in the current window. */
  "rate_limited",
  /** Not configured, provider outage, transport failure, or an unknown code. */
  "unavailable",
] as const;

export type VerificationRefusal = (typeof VERIFICATION_REFUSALS)[number];

export type StartOutcome = { ok: true } | { ok: false; code: VerificationRefusal };

export type CheckOutcome =
  | { ok: true; verified: true }
  | { ok: false; code: VerificationRefusal };

/**
 * The E.164 destination for a stored value, or null when there is not one.
 *
 * `normalizePhoneForSms` is the SEND normalizer and returning null is the point:
 * a number Hone could not address is a number Hone cannot prove possession of,
 * and guessing a country code for it would start a challenge to someone else.
 */
function destinationFor(storedPhone: string | null): string | null {
  return normalizePhoneForSms(storedPhone);
}

/**
 * Begin a possession challenge for the entry's own stored mobile.
 *
 * The destination is derived from the ROW, never from the request. A submitted
 * number cannot redirect the challenge, which is the same threat
 * `mobileLocked` closes on the completion surface.
 */
export async function startMobileVerification(
  target: MobileVerificationTarget,
  provider: MobileVerificationProvider = resolveMobileVerificationProvider(),
): Promise<StartOutcome> {
  const e164 = destinationFor(target.storedPhone);
  if (!e164) return { ok: false, code: "no_destination" };

  try {
    const outcome = await provider.start({ e164 });
    switch (outcome) {
      case "started":
        return { ok: true };
      case "refused":
        return { ok: false, code: "not_proved" };
      case "rate_limited":
        return { ok: false, code: "rate_limited" };
      case "unavailable":
        return { ok: false, code: "unavailable" };
      default:
        // An outcome this module does not know means it and the provider
        // disagree about the contract. That is not a refusal to report to a
        // person; it is an outage.
        return { ok: false, code: "unavailable" };
    }
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

/**
 * Check a submitted code and, ONLY on the provider's approval, promote the
 * standing.
 *
 * THE ORDER IS THE SAFETY PROPERTY. The provider is asked first and the database
 * is written only on `approved`; every other outcome returns before any write
 * exists to make. A client-submitted value therefore cannot construct verified
 * evidence — it can only be handed to the provider and rejected.
 */
export async function checkMobileVerification(
  target: MobileVerificationTarget & { code: string },
  provider: MobileVerificationProvider = resolveMobileVerificationProvider(),
): Promise<CheckOutcome> {
  const e164 = destinationFor(target.storedPhone);
  if (!e164) return { ok: false, code: "no_destination" };
  if (typeof target.code !== "string" || target.code.trim().length === 0) {
    return { ok: false, code: "not_proved" };
  }

  let outcome;
  try {
    outcome = await provider.check({ e164 }, target.code.trim());
  } catch {
    return { ok: false, code: "unavailable" };
  }

  // EXHAUSTIVE, LIKE `start` ABOVE, AND FOR THE REASON `start` ALREADY GAVE.
  //
  // An earlier revision ended with a catch-all `outcome !== "approved"` ->
  // `not_proved`. That was correct for today's union, where `rejected` is the only
  // remaining value, and wrong in the two ways that will actually happen: a real
  // adapter returning a status this module does not map (Twilio Verify has more
  // than four), or someone adding a fifth non-approval outcome later. Either way
  // a person would be told their proof was REJECTED when nothing evaluated it.
  //
  // `not_proved` is a statement about the person's code. It is only ever earned by
  // `rejected`. Everything unrecognized is a contract disagreement between this
  // module and the provider, which is an outage.
  switch (outcome) {
    case "approved":
      break;
    case "rejected":
      return { ok: false, code: "not_proved" };
    case "rate_limited":
      return { ok: false, code: "rate_limited" };
    case "unavailable":
      return { ok: false, code: "unavailable" };
    default:
      return { ok: false, code: "unavailable" };
  }

  // PROVED. The destination the provider approved must still be the row's own
  // number — checked here with the ONE normalizer, and again inside the command
  // as a compare-and-set on the exact stored string. Two independent checks
  // because a single one is a single place to get the row wrong.
  if (
    normalizePhoneForMatch(target.storedPhone) !== normalizePhoneForMatch(e164) ||
    normalizePhoneForMatch(e164).length === 0
  ) {
    return { ok: false, code: "no_destination" };
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("mark_waitlist_mobile_verified", {
      p_entry_id: target.entryId,
      // The value AS STORED, not the E.164 form. The command compares exactly,
      // so sending a canonicalized string here would refuse every real proof.
      p_expected_phone: target.storedPhone,
    });
    if (error) return { ok: false, code: "unavailable" };

    switch (typeof data === "string" ? data : "") {
      case "verified":
      case "already_verified":
        // Idempotent by design: a retry after success is a success, and the
        // recorded instant does not move.
        return { ok: true, verified: true };
      case "phone_mismatch":
      case "not_found":
      case "refused":
        // The proof was real but did not belong to this row's current state.
        // Reported as no_destination rather than not_proved: the person's code
        // was right, and telling them otherwise would be false.
        return { ok: false, code: "no_destination" };
      default:
        return { ok: false, code: "unavailable" };
    }
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
