// The ONE canonical form of a phone number for a provisioning claim.
//
// WHY THIS IS NOT normalizePhoneForSms
// ---------------------------------------------------------------------------
// `lib/sms/twilio.ts` already has a normalizer, and it is the wrong one here.
// It strips every non-digit and prepends `+1` to a bare ten-digit string, which
// is right for a CLIENT phone typed into a booking form and wrong for a
// provisioning identity: it would turn "4165550100" — a number nobody chose in
// that form — into "+14165550100" and then buy or adopt it. Coercing an invalid
// value into a valid one is the failure mode this module must not have.
//
// WHY IT MIRRORS THE DATABASE
// ---------------------------------------------------------------------------
// 0191's `claim_studio_sms_provisioning` does
//
//     v_number := nullif(btrim(coalesce(p_phone_number, '')), '')
//
// and STORES that trimmed value as `claimed_phone_number`. `renew_studio_sms_lease`
// then compares `s.claimed_phone_number = p_phone_number` with NO trim of its own.
// So the canonical form is defined by the database, and any caller that keeps
// carrying its own raw string fails its own fence — reporting `lease_lost`,
// which claims another worker took over, about a whitespace mismatch.
//
// This is therefore not a second normalizer. It is the client-side statement of
// the ONE the database already applies, so both sides compare the same bytes.

/** The validity rule 0191 enforces, character for character. */
const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Canonicalize a caller-supplied number for a claim, or return null.
 *
 * Trims — because the database does — and then validates. It never repairs:
 * a value that is not already E.164 after trimming is refused, not rewritten.
 */
export function canonicalClaimPhoneNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return E164.test(trimmed) ? trimmed : null;
}
