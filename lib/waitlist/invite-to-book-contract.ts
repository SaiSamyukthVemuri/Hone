// ===========================================================================
// WAIT-03 B4 — THE SERVER INTERFACE "INVITE TO BOOK" REQUIRES
// ===========================================================================
//
// TYPES AND OBLIGATIONS ONLY. This module contains no implementation, no I/O,
// no React and no adapter. It is the contract B2 must satisfy before any
// control on the practitioner surface may be enabled, written down as code so
// that "the composer is ready to bind" is a compile-time fact rather than a
// claim in a pull request description.
//
// WHY A CONTRACT MODULE EXISTS AT ALL
// -----------------------------------
// The product ruling is that a practitioner never sees the waitlist state
// machine. The primary action on a waiting person is INVITE TO BOOK, and there
// is no Claim step, no Claim-next step and no Reinvite button. That ruling is
// about the practitioner's screen, but it lands almost entirely on the SERVER,
// because the shipped commands are single-hop and the product action is not.
//
// THE SHIPPED TRANSITION GRAPH (migration 0188, verbatim edge list):
//
//     waiting  -> claimed        claimed  -> invited      invited  -> converted
//     waiting  -> removed        claimed  -> released     invited  -> expired
//     expired  -> waiting        expired  -> released     invited  -> released
//     expired  -> removed        released -> waiting      released -> removed
//
// Read the product actions against it and every one of them that matters is a
// MULTI-HOP path:
//
//   Invite to book, from `waiting`     claim -> issue                 2 commands
//   Invite to book, from `claimed`     issue                          1 command
//   Resend invitation, from `invited`  release -> requeue -> claim
//                                              -> issue               4 commands
//   Cancel invitation, from `invited`  release                        1 command
//   Return to waitlist, from `expired` requeue                        1 command
//   Return to waitlist, from `released`requeue                        1 command
//   Return to waitlist, from an
//     `invited` entry whose window has
//     already elapsed                  expire -> requeue              2 commands
//
// EVERY MULTI-HOP PATH MUST BE ONE ATOMIC SERVER OPERATION. Not a loop in a
// server action, and emphatically not a sequence of calls from React. This is
// not a style preference — the repository has already paid for the alternative
// twice:
//
//   * `claim` succeeding and `issue` then failing strands the entry at
//     `claimed`, which under this design has NO practitioner-facing exit,
//     because Claim and Release are exactly the controls the product ruling
//     removes from the screen;
//   * the same failure class is already recorded against redemption — a
//     prospect who redeems and never books is stuck at `invited` with every
//     operator exit refused. A partially-applied compound invents that dead end
//     a second time, on a path a practitioner walks every day.
//
// A TypeScript loop over two RPCs would additionally invent partial-success
// semantics the database never agreed to, which is the same objection that
// keeps "claim these five" and "claim the next five" apart: the bulk command
// takes a COUNT over the database's own order and accepts no id list.
//
// THE TOKEN FACT THAT DECIDES WHAT "RESEND" CAN MEAN
// --------------------------------------------------
// `issue_new_client_waitlist_invitation` returns `raw_token` once and stores
// only `token_hash`. The raw token is therefore UNRECOVERABLE after the issuing
// transaction returns. "Resend invitation" consequently cannot re-deliver the
// existing link; it necessarily mints a NEW token on a NEW window. That is a
// product-visible consequence, not an implementation detail, and the composer
// discloses it — see `RESEND_MINTS_A_NEW_LINK`.
//
// Storing the raw token so it could be re-sent would put a live bearer
// credential in a table that today holds only its digest. That is not a
// trade this contract offers.
// ===========================================================================

// --- 1. WHAT THE PRACTITIONER ASKS FOR --------------------------------------

/**
 * The booking scope a practitioner expresses in the composer.
 *
 * NONE OF THIS HAS A SHIPPED PARAMETER TODAY. `issue_new_client_waitlist_
 * invitation(p_studio_id, p_entry_id, p_actor_user_id, p_ttl_hours)` is the
 * whole surface: there is no service, horizon, weekday or date argument on any
 * command in 0188..0191.
 *
 * That is precisely why it is written down here as a REQUIREMENT rather than
 * collected as decorative intent. An earlier revision of this prototype badged
 * these fields "Not enforced yet" and let the practitioner send anyway; that is
 * a screen which asks a question it intends to ignore. The ruling is now the
 * other way round: the composer collects scope, the contract demands that the
 * invitation carry it, and nothing sends until an adapter satisfying this
 * interface exists.
 *
 * An adapter that accepts a scope and silently drops it does not satisfy this
 * contract. `AdapterCapabilities.enforcesScope` exists so that such an adapter
 * has to say so, and so the surface can refuse to imply otherwise.
 */
export type BookingScope = {
  /**
   * The service the invitation is for. `null` means the studio did not narrow
   * it and the invitee may book any bookable service.
   */
  serviceId: string | null;
  /**
   * How many days from issuance the invitee may book within. Product presets
   * are 7, 14 and 30; a custom value is bounded 1..365.
   *
   * Deliberately a DURATION, not a pair of dates. The window has to be anchored
   * to the moment the invitation is issued — the same anchoring correction
   * migration 0190 already had to make for the expiry clock, where a window
   * computed from the transaction's start handed back time that had already
   * been spent.
   */
  windowDays: number;
  /**
   * Which weekdays the invitee may choose, `0` = Sunday .. `6` = Saturday.
   *
   * `null` means every day, and is NOT the same as an empty array. An empty
   * array would say "no day is permitted", which is an invitation that cannot
   * be redeemed; the draft validator refuses it rather than sending it.
   */
  allowedWeekdays: ReadonlyArray<number> | null;
};

export type InviteToBookInput = {
  /** The waitlist entry. The studio and the acting practitioner are resolved
   *  server-side from the session and are deliberately NOT parameters here:
   *  a browser may name an entry, never a tenant, an actor or a role. */
  entryId: string;
  scope: BookingScope;
  /** 1..168. The bound is the shipped command's own, and out-of-range is
   *  REFUSED rather than clamped — a clamped window is one the caller did not
   *  ask for and cannot see. */
  expiresInHours: number;
};

export type ResendInvitationInput = {
  entryId: string;
  /** Resending re-states the scope, because it mints a new invitation rather
   *  than re-delivering the old one. Supplying it explicitly keeps the second
   *  invitation from silently inheriting a scope the practitioner can no longer
   *  see on screen. */
  scope: BookingScope;
  expiresInHours: number;
};

export type EntryOnlyInput = { entryId: string };

// --- 2. WHAT THE SERVER MAY ANSWER ------------------------------------------

/**
 * Every failure an adapter may report, derived from the result codes the
 * shipped commands actually return rather than invented alongside them.
 *
 * Sources, all in supabase/migrations/0188..0190:
 *   resolve_owner  invalid_input · not_a_member · not_owner
 *   claim          invalid_input · not_found · not_waiting
 *   issue          invalid_input · invalid_ttl · not_found · not_claimed
 *                  · already_invited
 *   release        invalid_input · not_releasable · already_redeemed
 *   requeue        invalid_input · not_requeueable · already_active
 *   expire         invalid_input · not_invited · not_expired · already_redeemed
 *   remove         invalid_input · not_found · already_removed
 *                  · release_required · not_removable
 *
 * `tests/lib/waitlist/invite-to-book-contract.test.ts` re-derives this set from
 * the migration files and fails if a command grows a code this union does not
 * carry. A missing code is how the live removal action already drifted once:
 * its hand-written map still spelled 0185's vocabulary after 0188 replaced it,
 * so the two codes added specifically to tell an operator what to do instead
 * fell through to "please try again".
 */
export const INVITE_TO_BOOK_FAILURES = [
  // Authority, re-derived in the database from the session's user id.
  "not_owner",
  "not_a_member",
  // The entry moved under the practitioner between render and press.
  "not_found",
  "not_waiting",
  "not_claimed",
  "already_invited",
  "not_releasable",
  "not_requeueable",
  "already_active",
  "not_invited",
  "not_expired",
  "already_redeemed",
  "already_removed",
  "release_required",
  "not_removable",
  // The request itself was malformed — a bug on this side of the wire.
  "invalid_input",
  "invalid_ttl",
  // The scope the practitioner expressed could not be honoured. NEW: no
  // shipped command can answer this yet, and it is the one code this contract
  // ADDS rather than derives. It exists so an adapter that cannot carry a
  // scope has a way to refuse the send instead of quietly widening it.
  "scope_not_supported",
  // Transport, timeout, or an unmapped database error.
  "unavailable",
] as const;

export type InviteToBookFailure = (typeof INVITE_TO_BOOK_FAILURES)[number];

export type InvitationOutcome =
  | {
      ok: true;
      /** ISO 8601, server-stamped. The surface never computes this: 0190's
       *  whole correction was that the window belongs to the issuing instant,
       *  which only the database observes. */
      expiresAt: string;
    }
  | { ok: false; code: InviteToBookFailure };

export type EntryOutcome = { ok: true } | { ok: false; code: InviteToBookFailure };

// --- 3. THE ADAPTER ----------------------------------------------------------

/**
 * What an adapter admits it can actually do.
 *
 * The surface reads these to decide what it may SAY, never to decide what it
 * may offer — availability comes from the entry's state, and a capability an
 * adapter lacks disables the send outright rather than silently narrowing it.
 *
 * `enforcesScope: false` is a legitimate intermediate state for a B2 adapter
 * that has wired sending before 0193 carries scope. It is not a licence to send
 * a scoped-looking invitation unscoped: the composer refuses the send and says
 * which part is missing.
 */
export type AdapterCapabilities = {
  /** The invitation carries `serviceId`, `windowDays` and `allowedWeekdays`
   *  through to the recipient's booking surface and enforces them there. */
  enforcesScope: boolean;
  /** `resendInvitation` is implemented atomically. */
  canResend: boolean;
  /** `cancelInvitation` is implemented. */
  canCancel: boolean;
  /** `returnToWaitlist` is implemented atomically for ALL THREE of its paths —
   *  the one-hop requeue from `released`/`expired`, the two-hop
   *  expire-then-requeue from an elapsed `invited` entry, and the two-hop
   *  release-then-requeue from a legacy `claimed` one. Reporting `true` while
   *  implementing only some of them advertises an escape that is guaranteed to
   *  fail on the rows that have no other way out. */
  canReturnToWaitlist: boolean;
  /** `removeFromWaitlist` is implemented atomically for BOTH its paths — the
   *  single-command removal, and the expire-then-remove compound needed by an
   *  `invited` entry whose window has already closed. Reporting `true` while
   *  implementing only the first makes removal fail on exactly the rows a
   *  practitioner reaches after an invitation lapses. */
  canRemove: boolean;
};

/**
 * THE INTERFACE B2 / 0193 MUST PROVIDE.
 *
 * Every method is ATOMIC with respect to the entry: it either leaves the entry
 * in the stated end state or leaves it exactly where it started. There is no
 * partial outcome, and no method may return `ok: true` having completed some of
 * its hops. See the header for why, and for the per-method hop counts.
 *
 * Every method resolves studio and actor SERVER-SIDE from the session. None of
 * them accepts a studio id, an actor id or a role, and an adapter that added
 * one would be widening the trust boundary the shipped commands deliberately
 * closed.
 */
export interface WaitlistInvitationAdapter {
  readonly capabilities: AdapterCapabilities;

  /**
   * Invite a waiting or held person to book.
   *
   * ACCEPTS `waiting` AND `claimed`, and the caller does not know or care which
   * — that is the entire product ruling expressed as a signature. From
   * `waiting` this is claim-then-issue as one operation; from `claimed` it is
   * issue alone. A previously-invited person who has been returned to the
   * queue arrives here as `waiting` like anyone else, which is why there is no
   * `reinvite` method: invitation history changes what the SERVER does, never
   * what the practitioner is asked to decide.
   *
   * End state: `invited`, with one live invitation row.
   */
  inviteToBook(input: InviteToBookInput): Promise<InvitationOutcome>;

  /**
   * Replace a live invitation with a fresh one.
   *
   * MINTS A NEW LINK ON A NEW WINDOW — it cannot re-deliver the existing one,
   * because only the token's digest is stored. Four hops today
   * (release, requeue, claim, issue); B2 may instead add a single command that
   * supersedes the live invitation in place. The contract states the OUTCOME
   * and leaves the path to the database, which is where the transition rules
   * live.
   *
   * Refuses `already_redeemed`: a used invitation is terminal and releasing it
   * is exactly what `release_new_client_waitlist_entry` guards against.
   *
   * End state: `invited`, with one live invitation row and the previous one
   * stamped terminal.
   */
  resendInvitation(input: ResendInvitationInput): Promise<InvitationOutcome>;

  /**
   * End a live invitation early.
   *
   * This is `release`, and it is the ONLY way to end a live invitation before
   * its window runs out. Recording an expiry is not cancellation: expiry
   * records that the clock ran out, it does not cause it, and offering both
   * under two names would make one of them a lie about what it does. The
   * practitioner surface therefore has no "record expired" control at all.
   *
   * End state: `released`. The entry is NOT back in the queue — returning it is
   * a second, explicit act, which is why `released` reads "Ready to return".
   */
  cancelInvitation(input: EntryOnlyInput): Promise<EntryOutcome>;

  /**
   * Put someone back in the queue.
   *
   * THREE PATHS, ONE METHOD. From `released` or `expired` this is a single
   * requeue. From an `invited` entry whose window has already elapsed it is
   * expire-then-requeue, atomically — because `invited -> waiting` is not a
   * legal edge and the dead invitation must be stamped before the entry can
   * move. From a legacy `claimed` entry — held by the older operator surface,
   * never invited — it is release-then-requeue, also atomically.
   *
   * THE `claimed` PATH IS NOT OPTIONAL. The practitioner surface offers
   * "Return to waitlist" on a `claimed` row precisely so a legacy hold is never
   * a dead end, and it enables that control on `canReturnToWaitlist` alone. An
   * adapter that implemented only the one-hop and expire-then-requeue paths
   * could therefore report `canReturnToWaitlist: true` truthfully and still
   * guarantee failure on the one row that most needs the escape.
   *
   * The caller chooses none of them; it does not know which applies, and asking
   * it to would be handing the state machine back to the practitioner one level
   * down.
   *
   * End state: `waiting`.
   */
  returnToWaitlist(input: EntryOnlyInput): Promise<EntryOutcome>;

  /**
   * Take someone off the waitlist permanently.
   *
   * TWO PATHS. From `waiting`, `expired` or `released` this is the single
   * `remove_new_client_waitlist_entry`. From an `invited` entry whose window
   * has already elapsed it is expire-then-remove, atomically — because the
   * command answers `release_required` for `invited`, and refusing there would
   * mean the row rendered Remove disabled until a background transition
   * silently enabled it. The practitioner cannot see the difference between
   * those two rows and must not be given different controls on them.
   *
   * Still refused while the entry is held, or invited with a LIVE invitation —
   * `remove_new_client_waitlist_entry` answers `release_required` for both, and
   * there the surface says so in its own words.
   * Not a delete: the row transitions to `removed` with its actor and timestamp
   * recorded. Physically purging waitlist history belongs to a retention
   * policy, not to a button.
   *
   * End state: `removed`.
   */
  removeFromWaitlist(input: EntryOnlyInput): Promise<EntryOutcome>;
}

// --- 4. THE UNBOUND STATE ----------------------------------------------------

/**
 * No adapter exists yet, so this is the value every surface renders against
 * today, and the reason every send control is disabled.
 *
 * A NULL ADAPTER, NOT A FAKE ONE. There is deliberately no stub implementation
 * anywhere in this repository — not even one that resolves
 * `{ ok: false, code: "unavailable" }`. A stub that can be called is a stub
 * that can be wired by accident, and "do not fake a working Send invitation"
 * is only enforceable if there is nothing to fake with.
 */
export const NO_ADAPTER_BOUND = null;

export type BoundAdapter = WaitlistInvitationAdapter | typeof NO_ADAPTER_BOUND;

/**
 * The disclosure the composer shows beside a resend control.
 *
 * Product-visible because of the token fact above: the practitioner is about to
 * invalidate a link the invitee may already have, and the window restarts.
 * Saying so is cheaper than the support conversation that follows a client
 * clicking a link that has silently stopped working.
 */
export const RESEND_MINTS_A_NEW_LINK =
  "Resending sends a new booking link and starts the expiry window again. Any link they already have stops working.";

/**
 * Why a send control is off when no adapter is bound.
 *
 * Names THIS action, not "sending" in the abstract — a control that is disabled
 * for a reason describing some other control teaches a practitioner to ignore
 * the explanation entirely.
 */
export function adapterMissingReason(actionLabel: string): string {
  return `“${actionLabel}” is not connected yet. The invitation service ships before this becomes available.`;
}

/**
 * Why a send control is off when the bound adapter cannot carry the scope.
 *
 * The alternative — sending anyway and hoping — would produce an invitation
 * that ignores the service and window the practitioner just chose, which the
 * invitee then books outside. Refusing is the honest failure.
 */
export const SCOPE_UNSUPPORTED_REASON =
  "This studio's invitation service cannot apply a service or booking window yet, so the invitation cannot be sent as written.";
