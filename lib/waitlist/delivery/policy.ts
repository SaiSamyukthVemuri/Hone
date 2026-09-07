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
// trigger, exactly as 0188 does for `new_client_waitlist_invitations`. The
// constants below are the APPLICATION-SIDE contract: the window the product
// asks for, and the ceiling the database must never exceed. They are inputs to
// a request and an assertion about a returned value, never a second source of
// truth for a live expiry.
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
 * What the product asks for: 20 minutes.
 *
 * WHY NOT 30, WHICH IS THE CEILING. Hone has already paid for a too-short
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
export const PROOF_TTL_TARGET_MINUTES = 20;

/**
 * The hard ceiling. A proof whose stored expiry is further out than this is a
 * defect in whatever minted it, and the send path refuses rather than delivers
 * a code that outlives its mandate.
 */
export const PROOF_TTL_CEILING_MINUTES = 30;

/** Minimum gap between two proof sends for one invitation. */
export const PROOF_RESEND_MIN_INTERVAL_SECONDS = 60;

/**
 * How many proof sends one invitation may accumulate before the recipient must
 * involve the studio. Bounded so a mailbox cannot be used as a free relay.
 */
export const PROOF_MAX_SENDS_PER_INVITATION = 5;

/**
 * Whether a stored expiry is inside the mandate.
 *
 * Deliberately checks BOTH ends. An expiry in the past is not merely useless,
 * it is evidence that the mint and the send disagree about the clock, and
 * emailing a dead code is worse than refusing: the recipient burns their resend
 * budget discovering it.
 */
export function isProofExpiryWithinCeiling(
  expiresAt: Date,
  now: Date,
): boolean {
  const ms = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(ms)) return false;
  if (ms <= 0) return false;
  return ms <= PROOF_TTL_CEILING_MINUTES * 60_000;
}

/**
 * Whole minutes remaining, for the email copy. DERIVED from the stored expiry
 * on every send, so the sentence in the recipient's inbox describes the value
 * the database is actually enforcing rather than the value we asked for.
 *
 * Rounds DOWN. A code advertised as lasting longer than it does is the failure
 * mode that matters; one advertised as shorter merely hurries the recipient.
 */
export function proofRemainingMinutes(expiresAt: Date, now: Date): number {
  const ms = expiresAt.getTime() - now.getTime();
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
