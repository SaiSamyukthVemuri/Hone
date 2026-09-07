// WAIT DELIVERY-01 — the delivery policy, in one place.
//
// Pure data and pure functions: no I/O, no env, no provider, no `server-only`.
// Everything here is a number or a decision the send path and its tests must
// agree on, stated once so they cannot drift.
//
// ===========================================================================
// WHAT THIS MODULE DOES **NOT** OWN
// ===========================================================================
//
// It does not own the proof's expiry. The database does — it mints the
// challenge, stores only its hash, and stamps `expires_at` from a server-owned
// trigger, exactly as 0188 does for `new_client_waitlist_invitations`.
//
// ===========================================================================
// THREE DIFFERENT TTLs. THEY ARE NOT THE SAME NUMBER AND NOT THE SAME OBJECT.
// ===========================================================================
//
// An earlier revision of this file collapsed them, and asserted a 30-minute
// ceiling over the CHALLENGE. That was wrong twice: 30 minutes is not the
// challenge's bound, and the challenge is not the object that bound governs.
//
//   1. PROOF CHALLENGE — minted by `beginRecipientProof`, delivered by this
//      module as a code in an email. Its bound is B2's and is set
//      independently. Delivery REQUESTS 20 minutes; that is a product target,
//      not a law, and this module enforces only that the mint honoured the
//      request it made (below).
//
//   2. MUTATION CAPABILITY — minted by `completeRecipientProof` AFTER a
//      challenge is answered. THIS is what the B1/B1.5c "<= 30 minutes" hard
//      law governs. **This module never mints, delivers, sees or guards a
//      capability.** It is recorded here only so the two are not re-conflated.
//
//   3. INVITATION — `issue_new_client_waitlist_invitation`, `p_ttl_hours`
//      default 72 clamped 1..168 (0189). Hours, not minutes. Unrelated to both.
//
// NOT REPO-VERIFIABLE TODAY, and said plainly rather than implied: no proof
// challenge or capability TTL exists anywhere in `supabase/migrations/**` at
// this SHA — B2 and B1.5c are not in the repository. Items 1 and 2 above are
// therefore recorded from the operator's statement of the in-flight design, and
// must be re-read from the migration that lands them before being relied on.
// Item 3 is mechanically established in 0189 and is the only one that is.
//
// The distinction is load-bearing. `app/portal/login/actions.ts` owns
// MAGIC_LINK_TTL_MS *because* the application inserts `expires_at` itself
// there. Here the database inserts it, so an application constant that claimed
// to be the expiry would be a second owner of a value it does not write — and
// the drift would be invisible until a proof died early in someone's hands.

// ---------------------------------------------------------------------------
// PROOF WINDOW
// ---------------------------------------------------------------------------

/**
 * What Delivery REQUESTS for a proof CHALLENGE: 20 minutes.
 *
 * A product target, not a database law. B2 bounds the challenge independently;
 * this number is what this feature asks for and what it will mail.
 *
 * WHY SO SHORT, GIVEN HONE'S OWN HISTORY. Hone has already paid for a too-short
 * emailed credential once. PR #166 raised the portal magic link from 30 minutes
 * to 60 after a real bug report ("secure link stopped working under 30 mins"),
 * because Resend's floor is 3-15 seconds, receiving MTAs queue new senders for
 * 1-10 minutes, and the human then has to notice, open and act.
 *
 * WHY 20 IS NEVERTHELESS SAFE HERE, where 30 was not safe there. That comment
 * names its own escape clause: *"Two-factor and bank login emails are typically
 * 10-15 minutes, but those have a recovery path (resend in one tap); ours is
 * 'request another email from the studio login page' so the failure cost is
 * higher and the safe TTL is longer."*
 *
 * This flow has the recovery path the magic link lacked. The recipient is
 * already on the invitation page when the proof is requested, so a resend is
 * one tap in front of them rather than a navigation they must rediscover. A
 * shorter window is therefore cheap to recover from, and the shorter window is
 * what keeps a leaked code from being useful.
 *
 * THE RESEND AFFORDANCE IS NOT OPTIONAL. If it is ever removed, this constant
 * must go back up: 20 minutes without one-tap resend recreates the exact defect
 * PR #166 fixed. `PROOF_RESEND_MIN_INTERVAL_SECONDS` below exists because of
 * this, not as an afterthought.
 */
export const PROOF_CHALLENGE_TTL_TARGET_MINUTES = 20;

/**
 * The B1/B1.5c hard law on the MUTATION CAPABILITY — the object
 * `completeRecipientProof` mints once a challenge is answered.
 *
 * DOCUMENTATION ONLY. It is exported so the distinction is greppable and so a
 * future reader who finds "30 minutes" in a design note can see which object it
 * governs. Nothing in this module compares anything against it, because
 * Delivery never handles a capability: it delivers the challenge that precedes
 * one. Guarding it here would be a second owner of someone else's law, which is
 * the same defect as the rate-limit copy this file's own review caught.
 *
 * Re-read it from the migration that lands B1.5c before relying on it; it is
 * not established anywhere in `supabase/migrations/**` at this SHA.
 */
export const MUTATION_CAPABILITY_TTL_CEILING_MINUTES = 30;

/**
 * How far after the mint this module will still mail a challenge.
 *
 * The email advertises the MINTED window, because the idempotency key carries
 * no payload digest and the payload must therefore be a pure function of the
 * challenge. That sentence stops being true as the gap grows, so rather than
 * let the copy drift into a false claim, a stale send is refused and the caller
 * mints again. In the real flow mint and send happen in one request, so this is
 * a tripwire rather than a routine path.
 */
export const PROOF_SEND_MAX_DELAY_AFTER_MINT_SECONDS = 60;

/** Minimum gap between two proof sends for one invitation. */
export const PROOF_RESEND_MIN_INTERVAL_SECONDS = 60;

/**
 * How many proof sends one invitation may accumulate before the recipient must
 * involve the studio. Bounded so a mailbox cannot be used as a free relay.
 */
export const PROOF_MAX_SENDS_PER_INVITATION = 5;

/**
 * Whether a minted CHALLENGE is one this module is willing to mail.
 *
 * Checks two things, and both are Delivery's own business rather than a claim
 * about anyone else's bound:
 *
 *   ALREADY ELAPSED -> refuse. Emailing a dead code is worse than refusing: the
 *   recipient spends a resend from a bounded budget to discover it, and an
 *   expiry already in the past means the mint and the send disagree about the
 *   clock, which is worth surfacing rather than papering over.
 *
 *   LONGER THAN DELIVERY ASKED FOR -> refuse. This is NOT an assertion about
 *   B2's bound, which is B2's to set and may legitimately be wider. It asks
 *   only whether the mint honoured the window THIS module requested. Keying on
 *   `PROOF_CHALLENGE_TTL_TARGET_MINUTES` means the check follows the request
 *   automatically if the target ever moves, and it imports no foreign number.
 */
export type ChallengeMailability =
  | { mailable: true }
  | {
      mailable: false;
      reason:
        | "minted_window_exceeds_request"
        | "already_elapsed"
        | "stale_since_mint";
    };

/**
 * Whether a minted CHALLENGE is one this module is willing to mail.
 *
 * THREE INDEPENDENT CHECKS, and they are independent on purpose. An earlier
 * revision folded the first two into one comparison against the SEND time,
 * which is not the contract: the contract is about the duration MINTED. A
 * 30-minute challenge delivered ten minutes late has twenty minutes left and
 * passed, even though nothing had ever authorised a thirty-minute mint.
 *
 *   MINTED WINDOW > WHAT DELIVERY REQUESTED -> refuse. Measured
 *   `expiresAt - issuedAt`, never against `now`, so a delayed send can no
 *   longer make an overlong mint look compliant. This is not a claim about
 *   B2's bound, which may legitimately be wider; it asks only whether the mint
 *   honoured the window THIS module asked for.
 *
 *   ALREADY ELAPSED -> refuse, separately and with its own reason. Emailing a
 *   dead code costs the recipient a send from a bounded budget to discover it.
 *
 *   SENT LONG AFTER THE MINT -> refuse. This one exists because of the copy.
 *   The email advertises the MINTED window (it must: the idempotency key
 *   carries no payload digest, so the payload has to be a pure function of the
 *   challenge). That sentence is only true while send follows mint closely. In
 *   the real flow it does — the same request mints and sends — so a large gap
 *   means something is wrong, and mailing "expires in 20 minutes" to someone
 *   who has five left is a false statement this module should not make.
 */
export function challengeMailability(
  issuedAt: Date,
  expiresAt: Date,
  now: Date,
): ChallengeMailability {
  const minted = expiresAt.getTime() - issuedAt.getTime();
  const remaining = expiresAt.getTime() - now.getTime();
  const sinceMint = now.getTime() - issuedAt.getTime();
  if (
    !Number.isFinite(minted) ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(sinceMint)
  ) {
    return { mailable: false, reason: "already_elapsed" };
  }
  // A non-positive mint means the expiry is at or before issuance, which is
  // definitionally elapsed rather than overlong — the label has to match the
  // fault or it sends whoever reads it looking in the wrong place.
  if (minted <= 0) return { mailable: false, reason: "already_elapsed" };
  // Order matters for the REASON, not the outcome: an overlong mint is a defect
  // in the minter and worth naming even if the code has also since expired.
  if (minted > PROOF_CHALLENGE_TTL_TARGET_MINUTES * 60_000) {
    return { mailable: false, reason: "minted_window_exceeds_request" };
  }
  if (remaining <= 0) return { mailable: false, reason: "already_elapsed" };
  if (sinceMint > PROOF_SEND_MAX_DELAY_AFTER_MINT_SECONDS * 1_000) {
    return { mailable: false, reason: "stale_since_mint" };
  }
  return { mailable: true };
}

/**
 * The challenge's AUTHORISED WINDOW in whole minutes, from database-owned
 * values. This is what the email advertises.
 *
 * NOT THE REMAINING TIME, deliberately. The proof send keys its provider
 * idempotency on the challenge alone — a payload digest would carry the code to
 * the provider and turn the header into an offline verifier for it — so the
 * payload must be a pure function of the challenge. A wall clock in the body
 * would make two attempts under one key render different bytes, which the
 * provider answers with `invalid_idempotent_request` rather than a replay.
 *
 * Rounds DOWN. A code advertised as lasting longer than it does is the failure
 * mode that matters; one advertised as shorter merely hurries the recipient.
 */
export function proofWindowMinutes(issuedAt: Date, expiresAt: Date): number {
  const ms = expiresAt.getTime() - issuedAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 60_000);
}

// ---------------------------------------------------------------------------
// RATE LIMIT POLICY
// ---------------------------------------------------------------------------
//
// Stated here as data so the limiter in lib/rate-limit/public.ts and the tests
// that pin it read the same numbers.
//
// KEYED ON THE INVITATION ID, NOT THE BEARER TOKEN. `limitTokenRoute` hashes
// the raw token because at that point the token is the only identifier it has —
// nothing has resolved a row yet. This flow is different by construction: the
// invitation link RESOLVES before any proof is requested, so a server-resolved
// `invitations.id` is already in hand. Using it keeps the bearer credential out
// of the limiter's key derivation entirely, which is strictly better than
// hashing it, and it is available only *because* the two authorities are split.

/**
 * CONSUMED BY `limitWaitlistProofRequest` in lib/rate-limit/public.ts, which
 * imports this object rather than restating it. An earlier revision declared
 * these numbers here and hard-coded a second copy in the limiter, so the
 * exported "policy" was decorative and production would have kept enforcing the
 * old values while this file and its tests agreed on the new ones. That is the
 * two-competing-maps failure CLAUDE.md §3 names outright.
 */
export const PROOF_REQUEST_LIMITS = {
  /** Per invitation. The dominant control: it bounds one recipient's mailbox. */
  invitation: { limit: 3, window: "15 m" },
  /** Per IP, scoped by studio. Bounds a single source enumerating invitations. */
  ip: { limit: 10, window: "1 h" },
} as const;

// ---------------------------------------------------------------------------
// PROVIDER FAILURE CLASSIFICATION
// ---------------------------------------------------------------------------

/**
 * What the caller should do with a send outcome.
 *
 * `mayMutateLifecycle` is `false` in EVERY branch, and that is the point rather
 * than an oversight. Delivery is not lifecycle. A send that failed, succeeded,
 * or may have succeeded says nothing about whether the invitation is claimed,
 * expired or released, and `lib/email/client.ts` already states the house rule
 * for the unconfigured case: *"The invitation row still persists in the DB and
 * the share-message UI is the user-facing fallback."* The field exists so that
 * a future caller reaching for "mark it failed" finds an explicit `false` and a
 * reason, instead of an absence it can read either way.
 */
export type DeliveryDisposition = {
  /** Did the provider take custody? */
  delivered: "yes" | "no" | "unknown";
  /** May the caller offer another send immediately? */
  offerResend: boolean;
  /**
   * May the caller invalidate the challenge it just tried to deliver?
   * Only when the provider definitively refused — an ambiguous send may
   * already be in the recipient's inbox, and killing it would strand a code
   * they are about to type.
   */
  mayInvalidateChallenge: boolean;
  /** Always false. See the note above. */
  mayMutateLifecycle: false;
  /** Stable, non-sensitive reason for logs and tests. */
  reason: string;
};

export type SendOutcomeShape =
  | { status: "accepted"; messageId: string }
  | { status: "rejected"; code: string | null }
  | { status: "ambiguous"; reason: "timeout" | "concurrent" | "no_message_id" };

/**
 * Map a provider outcome to a disposition.
 *
 * The three-way outcome comes from `sendWaitlistEmailIdempotent`, which is the
 * only send primitive in the codebase that distinguishes "refused" from "may
 * have happened". That distinction is the whole reason this flow uses it rather
 * than `sendEmailSafely`.
 */
export function classifyDelivery(outcome: SendOutcomeShape): DeliveryDisposition {
  if (outcome.status === "accepted") {
    return {
      delivered: "yes",
      offerResend: true,
      mayInvalidateChallenge: false,
      mayMutateLifecycle: false,
      reason: "accepted",
    };
  }
  if (outcome.status === "ambiguous") {
    return {
      delivered: "unknown",
      offerResend: true,
      // The in-flight request was never cancelled and may still be accepted.
      mayInvalidateChallenge: false,
      mayMutateLifecycle: false,
      reason: `ambiguous_${outcome.reason}`,
    };
  }
  return {
    delivered: "no",
    offerResend: true,
    // A definite refusal: nothing was delivered, so retiring the challenge
    // strands nobody.
    mayInvalidateChallenge: true,
    mayMutateLifecycle: false,
    reason: outcome.code ? `rejected_${outcome.code}` : "rejected",
  };
}

// ---------------------------------------------------------------------------
// INVITATION WINDOW
// ---------------------------------------------------------------------------

/**
 * The invitation's MINTED window, phrased for the email.
 *
 * Derived from `expires_at - issued_at`, never from the remaining time. The
 * invitation send now keys on the event alone — its payload carries the raw
 * bearer token, which must not be hashed into a header the provider retains —
 * so the payload has to be a pure function of the invitation. A remaining-time
 * phrase is a wall clock: it moved from "3 days" to "2 days" between retries,
 * changed the payload, changed the key, and let the provider send a SECOND
 * invitation for one spot. That is the exact duplicate this wrapper exists to
 * prevent, and it was reproduced before this function existed.
 *
 * 0189 mints invitations in HOURS (`p_ttl_hours`, default 72, clamped 1..168),
 * so hours and days are the only units this needs.
 */
export function invitationWindowPhrase(issuedAt: Date, expiresAt: Date): string {
  const ms = expiresAt.getTime() - issuedAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "a limited time";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "less than an hour";
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}
