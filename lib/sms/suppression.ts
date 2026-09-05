import { normalizePhoneForMatch } from "./twilio";

// SMS suppression: two different things that must not be confused (COMMS-01B).
//
// Before per-studio senders existed there was only one sender, so "the carrier
// stopped it" and "Hone stopped it" were indistinguishable in practice and
// nobody had to name them. Giving each studio its own number pulls them apart,
// and the failure that follows is specific and silent:
//
//     Someone texts STOP to Studio A's number. Studio B has a DIFFERENT
//     number, so the carrier's block does not cover it. Studio B resumes
//     texting a person who has opted out.
//
// Nothing in this file is new behaviour. The phone-wide rule below is exactly
// what app/api/twilio/inbound-sms/route.ts has always done -- it stamps every
// client row whose phone matches, in every studio. What changes is that the
// rule is now a NAMED, TESTED concept instead of an emergent property of a
// loop, so a future per-studio scoping cannot narrow it by accident while
// looking entirely reasonable in review.

// ---------------------------------------------------------------------------
// The two concepts
// ---------------------------------------------------------------------------

/**
 * CARRIER SUPPRESSION — external, provider-owned, SENDER-SCOPED.
 *
 * When a person texts STOP, the carrier and Twilio block further messages
 * between THAT PAIR of numbers. It is enforced outside Hone, Hone cannot read
 * or set it, and -- the part that matters here -- it does NOT follow the
 * person to a different sender. A second studio with a second number is, as
 * far as the carrier is concerned, an unrelated conversation.
 *
 * Hone must therefore never treat carrier suppression as sufficient.
 */
export const CARRIER_SUPPRESSION_SCOPE = "sender_scoped" as const;

/**
 * HONE SUPPRESSION — internal, Hone-owned, PHONE-WIDE ACROSS STUDIOS.
 *
 * Hone's own rule is deliberately broader than the carrier's: opting out is
 * treated as a statement by a PERSON about their PHONE, not a preference about
 * one studio's sender. Phone-number ownership is per-person; a studio boundary
 * is Hone's internal concern and not something the person consented to being
 * segmented by.
 *
 * Consequence, and it is the whole point: if someone opts out through Studio
 * A, Studio B must not start sending merely because Studio B now has a
 * different Twilio number.
 */
export const HONE_SUPPRESSION_SCOPE = "phone_wide" as const;

export type SuppressionScope =
  | typeof CARRIER_SUPPRESSION_SCOPE
  | typeof HONE_SUPPRESSION_SCOPE;

// ---------------------------------------------------------------------------
// Phone-wide target selection
// ---------------------------------------------------------------------------

/** The minimum a client row must carry to be considered. */
export type SuppressionCandidate = {
  id: string;
  studio_id: string;
  phone: string | null;
  sms_opted_out_at: string | null;
};

export type SuppressionTarget = { id: string; studio_id: string };

export type SuppressionSelection = {
  /** Rows to stamp now: phone matches and they are not already opted out. */
  targets: SuppressionTarget[];
  /** Rows that matched but were already opted out. Retry-dedup, not an error. */
  alreadyOptedOutCount: number;
};

/**
 * Select every client row an inbound STOP should opt out.
 *
 * NOTE WHAT IS ABSENT FROM THE SIGNATURE: the studio, and the number the
 * message arrived on. Neither participates. With per-studio senders it will be
 * possible -- and will look sensible -- to resolve the inbound `To` to one
 * studio and filter to it. Doing that would silently reintroduce the exact
 * cross-studio leak this rule exists to prevent, so the parameter that would
 * enable it is deliberately not here.
 *
 * Matching goes through normalizePhoneForMatch so a stored "647-555-1234" and
 * an inbound "+16475551234" resolve to the same person -- the canonicalization
 * bug that once let a real STOP miss.
 */
export function selectHoneSuppressionTargets(input: {
  candidates: readonly SuppressionCandidate[];
  fromPhone: string;
}): SuppressionSelection {
  const fromDigits = normalizePhoneForMatch(input.fromPhone);
  if (fromDigits.length === 0) {
    return { targets: [], alreadyOptedOutCount: 0 };
  }

  const targets: SuppressionTarget[] = [];
  let alreadyOptedOutCount = 0;

  for (const row of input.candidates) {
    const digits = normalizePhoneForMatch(row.phone);
    if (digits.length === 0 || digits !== fromDigits) continue;
    if (row.sms_opted_out_at) {
      alreadyOptedOutCount += 1;
      continue;
    }
    targets.push({ id: row.id, studio_id: row.studio_id });
  }

  return { targets, alreadyOptedOutCount };
}

/**
 * Whether Hone may send to this person at all, before any studio toggle or
 * per-studio sender is consulted.
 *
 * A studio's own sender identity is NOT an input. Having a fresh number is not
 * a reason to text someone who has opted out.
 */
export function honeSuppressionAllowsSend(client: {
  sms_consent_at: string | null;
  sms_opted_out_at: string | null;
}): boolean {
  if (client.sms_opted_out_at) return false;
  return Boolean(client.sms_consent_at);
}
