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

/**
 * How long the provider honours an `Idempotency-Key`.
 *
 * Resend retains an idempotency record for roughly 24 hours. AFTER THAT THE KEY
 * IS NOT A DEDUPLICATOR — it is just a header. Presenting it again submits a
 * fresh email rather than replaying the original response.
 *
 * That interval is reachable here and not theoretically: invitations default to
 * 72 hours (0189), the absolute expiry copy exists precisely so a delayed retry
 * still reads correctly, and every disposition permits a resend. So the window
 * has to be a guard rather than a footnote.
 *
 * Deduplicating beyond it needs a DURABLE local record of the delivery attempt
 * — a claim/result row keyed by invitation — which is schema, and schema is out
 * of this lane. Until that exists, the honest move is to refuse the send this
 * module cannot make idempotent rather than to issue one and hope. See
 * `invitationSendWindow`, which distinguishes a genuinely stale invitation
 * from a clock that is merely a moment out of step.
 */
export const PROVIDER_IDEMPOTENCY_RETENTION_HOURS = 24;

/**
 * Whether an invitation send can still be deduplicated by the provider.
 *
 * A TYPED RESULT, not a boolean, because "false" was hiding two outcomes that
 * deserve opposite treatment:
 *
 *   OUTSIDE RETENTION — the invitation was issued longer ago than the provider
 *   remembers a key for. `now - issuedAt` only grows, so no later attempt at
 *   THIS invitation falls back inside the window. TERMINAL.
 *
 *   CLOCK DISAGREEMENT — `issuedAt` is AHEAD of `now`. The elapsed value is
 *   negative, which the old boolean also answered "false", so a database clock
 *   a millisecond ahead of the application clock made a perfectly good
 *   invitation look permanently undeliverable. That is the opposite of the
 *   truth: the same input becomes eligible the moment the application clock
 *   catches up. RETRYABLE.
 *
 * NO TOLERANCE WINDOW IS INTRODUCED. A skew allowance would be a second number
 * to justify, and it would silently accept genuinely-future timestamps up to
 * its size. Classifying the case is strictly better than tolerating it: the
 * caller is told what is wrong and that waiting fixes it. The repo's only
 * existing `*_SKEW_MS` is `DEFAULT_EXPIRY_SKEW_MS` in the Google token cache,
 * which is a refresh margin before an expiry rather than a clock-disagreement
 * allowance — reusing it here would borrow a number for a purpose it was not
 * chosen for.
 *
 * Measured from ISSUANCE, which is the anchor the idempotency key is built on:
 * the key is one per invitation, so its provider-side lifetime starts when the
 * first send for that invitation was made, and that follows issuance.
 */
export type InvitationSendWindow =
  | { eligible: true }
  | {
      eligible: false;
      /** TERMINAL: no later attempt at this invitation can succeed. */
      disposition: "terminal";
      reason: "outside_provider_idempotency_window";
    }
  | {
      eligible: false;
      /** RETRYABLE: the same input succeeds once time advances. */
      disposition: "retryable";
      reason: "clock_disagreement";
    };

export function invitationSendWindow(
  issuedAt: Date,
  now: Date,
): InvitationSendWindow {
  const elapsed = now.getTime() - issuedAt.getTime();
  if (!Number.isFinite(elapsed)) {
    // An unusable timestamp is not a clock that will catch up.
    return {
      eligible: false,
      disposition: "terminal",
      reason: "outside_provider_idempotency_window",
    };
  }
  if (elapsed < 0) {
    return {
      eligible: false,
      disposition: "retryable",
      reason: "clock_disagreement",
    };
  }
  if (elapsed > PROVIDER_IDEMPOTENCY_RETENTION_HOURS * 3_600_000) {
    return {
      eligible: false,
      disposition: "terminal",
      reason: "outside_provider_idempotency_window",
    };
  }
  return { eligible: true };
}

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
  /**
   * ALWAYS `false`, and a LITERAL TYPE so no branch can set it otherwise.
   *
   * ONE INVITATION ID = ONE DELIVERY EVENT. 0193 mints the invitation id and
   * the raw token exactly once and hands the token straight to Delivery in that
   * same request. The token is never persisted, so once this function returns
   * nothing in the system can reconstruct the email that was sent — there is no
   * supported "send this invitation again later" operation, and Delivery must
   * not imply one.
   *
   * Product recovery is a REISSUE, which is a lifecycle operation belonging to
   * a higher layer: close or release the old invitation, re-admit atomically,
   * and issue a NEW invitation with a new id, a new token and its own delivery
   * event. `reissueRequired` below is how that is signalled.
   *
   * The type is the enforcement. A boolean would let a future branch set it
   * true and reintroduce same-event retry semantics with nothing to catch it.
   */
  sameEventRetryAllowed: false;
  /**
   * The delivery did not confirm, so the product should offer a REISSUE — a new
   * invitation — rather than another attempt at this one.
   */
  reissueRequired: boolean;
  /**
   * TRUE when the INVITATION ITSELF is finished, not merely this delivery.
   *
   * Under the one-shot law no delivery is ever retried, so this no longer
   * distinguishes retryable from non-retryable. It distinguishes something
   * still useful: whether a REISSUE is even possible. An expired invitation is
   * terminal — reissuing means admitting a new one, not re-sending this. A
   * clock disagreement is not: the invitation is perfectly good and the next
   * issue-and-send will work.
   */
  terminal: boolean;
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

/**
 * The provider's answer when a key is presented with a payload different from
 * the one it was first bound to.
 *
 * WHY THIS CAN HAPPEN AT ALL, given the payload is a pure function of the
 * invitation. It is pure per BUILD, not across builds. The bytes are rendered
 * by `buildWaitlistInvitationEmail` from `FROM_ADDRESS` and the template copy,
 * and a deployment may change any of those. So:
 *
 *   attempt 1 -> ambiguous (timeout, or the bounded internal retry also
 *                ambiguous), nothing confirmed;
 *   deploy    -> template wording, sender, or URL construction changes;
 *   attempt 2 -> same invitation, same key, DIFFERENT bytes.
 *
 * The provider then refuses rather than replaying, and the invitation is stuck
 * for the remainder of the retention window while the caller is told to keep
 * trying.
 *
 * WHY IT SHOULD BE UNREACHABLE, AND IS KEPT ANYWAY. The sequence above needs a
 * SECOND invocation carrying the same invitation id and the same raw token. The
 * product law forbids exactly that: 0193 mints the id and the token once and
 * hands the token straight to Delivery in the same request, the token is never
 * persisted, and no operation reconstructs an existing invitation's email. A
 * later "Resend" is a REISSUE — new invitation, new token, new key — so it
 * cannot collide with an old one.
 *
 * It is classified rather than assumed away because the invariant lives in a
 * call graph this module cannot see. If a caller ever does reach here, the
 * answer is a reissue, not a retry, and saying so in the disposition is how
 * that arrives at the call site rather than as a provider error nobody expects.
 *
 * Persisting the original serialized payload — the other way to close it —
 * would need a delivery record keyed by invitation, which is schema, and would
 * build a same-invitation retry API the product does not want.
 */
export const PROVIDER_KEY_BOUND_TO_OTHER_BYTES = "invalid_idempotent_request";

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
      sameEventRetryAllowed: false,
      reissueRequired: false,
      terminal: false,
      mayInvalidateChallenge: false,
      mayMutateLifecycle: false,
      reason: "accepted",
    };
  }
  if (outcome.status === "ambiguous") {
    return {
      delivered: "unknown",
      sameEventRetryAllowed: false,
      // Ambiguous means it MAY have arrived. A reissue is the caller's call,
      // weighed against sending a second invitation for one spot.
      reissueRequired: true,
      terminal: false,
      // The in-flight request was never cancelled and may still be accepted.
      mayInvalidateChallenge: false,
      mayMutateLifecycle: false,
      reason: `ambiguous_${outcome.reason}`,
    };
  }
  if (outcome.code === PROVIDER_KEY_BOUND_TO_OTHER_BYTES) {
    // THE PROVIDER IS TELLING US OUR KEY IS ALREADY BOUND TO DIFFERENT BYTES.
    // Retrying with the same inputs cannot succeed, because the bytes will not
    // revert — so this is TERMINAL for this send event even though it came
    // from the provider rather than from a pre-send check.
    return {
      delivered: "no",
      sameEventRetryAllowed: false,
      reissueRequired: true,
      terminal: false,
      mayInvalidateChallenge: true,
      mayMutateLifecycle: false,
      reason: `rejected_${PROVIDER_KEY_BOUND_TO_OTHER_BYTES}`,
    };
  }
  return {
    delivered: "no",
    sameEventRetryAllowed: false,
    reissueRequired: true,
    terminal: false,
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
 * The invitation's expiry as an ABSOLUTE moment, in a FIXED zone.
 *
 * V1 renders UTC, deliberately, and the reason is idempotency rather than
 * convenience. Three shapes were tried and only this one holds:
 *
 *   * REMAINING time drifted between retries, moved the payload, moved the
 *     payload-derived key, and let the provider send a second invitation.
 *   * The MINTED window was stable and then lied — "expires in 3 days" on a
 *     send made a day after issuance.
 *   * An absolute instant in the STUDIO's timezone was stable and truthful, and
 *     still wrong: `studios.timezone` is mutable operator state, so correcting
 *     it moved the bytes under a key that had not moved, which the provider
 *     answers with `invalid_idempotent_request` rather than a replay.
 *
 * A fixed zone removes the last mutable input. The payload becomes a pure
 * function of `expires_at` alone, which is exactly what the event-only key
 * requires. UTC is labelled explicitly in the output, so a reader is never left
 * guessing whose clock it is.
 *
 * THE COST, STATED. A prospect reads UTC rather than their studio's local time.
 * That is the launch-scope reduction this slice accepts: the secure invitation
 * page can show local time freely, because a page renders fresh on every visit
 * and has no idempotency key to contradict. Studio-local email copy needs a
 * delivery snapshot this lane deliberately does not build.
 */
export const INVITATION_EXPIRY_TIMEZONE = "UTC";

export function invitationExpiryLabel(expiresAt: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: INVITATION_EXPIRY_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expiresAt);
}

/**
 * Whether an invitation is still live at the authoritative current time.
 *
 * Checked BEFORE any render or provider call. An expired invitation must never
 * be mailed: the recipient follows a link that cannot work, and the send burns
 * a provider request on a message whose only possible outcome is a dead end.
 *
 * Strictly greater than. An expiry exactly equal to now is NOT eligible — the
 * window is closed at that instant, and a boundary that leaks by a millisecond
 * is a boundary nobody can reason about.
 */
export function invitationIsLive(expiresAt: Date, now: Date): boolean {
  const ms = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(ms)) return false;
  return ms > 0;
}

/**
 * A refusal made BEFORE any provider call, which no retry can change.
 *
 * Every current caller turns on elapsed time — an expired invitation, an
 * elapsed challenge, a mint older than the provider's idempotency retention, a
 * send too long after its mint. Time moves one way, so none of them can become
 * true later. Under the one-shot law no delivery is retried in any case, so the
 * distinction these carry is whether a REISSUE can help: for these it cannot,
 * because the invitation itself is spent.
 *
 * `delivered` is "no" rather than "unknown" because nothing was transmitted at
 * all, and `mayMutateLifecycle` stays false for the same reason it is false
 * everywhere else — delivery is not lifecycle, and a refusal to send says
 * nothing about whether the invitation is still claimed, expired or released in
 * the database.
 */
export function terminalRefusal(reason: string): DeliveryDisposition {
  return {
    delivered: "no",
    sameEventRetryAllowed: false,
    reissueRequired: true,
    terminal: true,
    // Nothing was sent, so there is nothing in flight to strand. Whether the
    // challenge should be retired is the caller's decision, not a consequence
    // of this refusal.
    mayInvalidateChallenge: false,
    mayMutateLifecycle: false,
    reason: `rejected_${reason}`,
  };
}

/**
 * A refusal made before any provider call that a LATER attempt may pass.
 *
 * The counterpart to `terminalRefusal`, and the distinction is the point: one
 * Neither authorizes a retry of this send — the one-shot law forbids that — but
 * they say different things about the INVITATION: one is spent, the other is
 * perfectly good and will deliver on the next issue-and-send. Collapsing them
 * would discard a valid invitation over a clock a millisecond out.
 *
 * Nothing was transmitted, so `delivered` is "no"; nothing is in flight, so
 * there is nothing to strand; and the invitation must NOT be invalidated —
 * waiting is the whole remedy.
 */
export function retryableRefusal(reason: string): DeliveryDisposition {
  return {
    delivered: "no",
    sameEventRetryAllowed: false,
    reissueRequired: true,
    // The invitation is fine; only the clock disagreed. A reissue will work,
    // which is why this is not terminal.
    terminal: false,
    mayInvalidateChallenge: false,
    mayMutateLifecycle: false,
    reason: `rejected_${reason}`,
  };
}
