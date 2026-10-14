// Phone normalization for SMS: format coercion and digit extraction only.
//
// PURE AND BROWSER-SAFE. No imports, no I/O, no secrets, so the public
// waitlist form can validate a number with the SAME law the sender applies
// before it texts (SMS-04: a phone number is required for every new public
// waitlist signup). Moved verbatim out of lib/sms/twilio.ts, which re-exports
// both functions for every existing caller; behaviour is unchanged, and
// public.sms_normalized_phone (0199) remains its parity-proven SQL twin
// (tests/db/sms-phone-parity.db.test.ts).

const VALID_E164_DIGIT_RANGE = { min: 8, max: 15 } as const;

/**
 * Normalize a free-text phone string into Twilio-acceptable E.164
 * format (`+` followed by 8-15 digits). Returns null for anything we
 * cannot safely coerce; the caller treats null as "do not send SMS".
 *
 * Rules:
 *   - `+` prefix kept verbatim if the digits after it land in 8..15.
 *   - 10 digits assumed North-America-Numbering-Plan and prepended
 *     with `+1` (Hone is currently Canadian-only).
 *   - 11 digits starting with `1` get a `+` prepended.
 *   - Anything else returns null. We deliberately do not guess country
 *     codes for international numbers; an invalid Twilio destination
 *     would surface as a non-retryable error anyway.
 */
export function normalizePhoneForSms(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (
      digits.length >= VALID_E164_DIGIT_RANGE.min &&
      digits.length <= VALID_E164_DIGIT_RANGE.max
    ) {
      return `+${digits}`;
    }
    return null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Canonical phone digits for matching. Used to compare:
 *   1. a public-booking-submitted phone against a stored client phone
 *      (consent gate in app/book/[slug]/actions.ts),
 *   2. an inbound Twilio STOP From-number against stored client phones
 *      (app/api/twilio/inbound-sms/route.ts).
 *
 * Both surfaces MUST share the same normalization so consent and STOP
 * always resolve to the same client. The earlier "digits only"
 * implementation broke for the common case where one side stored a
 * 10-digit Canadian/US number ("647-555-1234" -> "6475551234") and
 * the other side carried the E.164 country prefix ("+16475551234" ->
 * "16475551234"), so a real client replying STOP could fail to opt
 * out. We now canonicalize through normalizePhoneForSms first (which
 * promotes 10-digit NANP to "+1XXXXXXXXXX" and accepts any
 * +-prefixed international number with 8-15 digits) and only then
 * strip non-digits. The fallback to plain-digit-strip preserves the
 * historical behaviour for inputs we cannot canonicalize.
 *
 * Returns "" for null/empty so callers can compare with strict
 * equality without a null check.
 */
export function normalizePhoneForMatch(raw: string | null): string {
  const e164 = normalizePhoneForSms(raw);
  if (e164) return e164.replace(/\D/g, "");
  if (typeof raw !== "string") return "";
  return raw.replace(/\D/g, "");
}
