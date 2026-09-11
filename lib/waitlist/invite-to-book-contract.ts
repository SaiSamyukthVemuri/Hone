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

// --- 2b. THE SERVER VOCABULARY THIS CONTRACT MUST CARRY ----------------------

/**
 * Every result `admit_new_client_waitlist_entry` can return.
 *
 * DERIVED MECHANICALLY, NOT ASSUMED. The command lives on WAIT-ADMIT-01
 * (migration `0193_waitlist_admission_authority.sql`, read at exact head
 * `519cfe6cf7e3281d4c445a35f34653c10b054100`), which is not on this branch, so
 * this list cannot be re-derived from the migrations in this tree the way the
 * shipped vocabulary is. It is therefore written out with the provenance of
 * every value, and the test beside it holds an independent copy.
 *
 * THE SET IS A UNION, AND THAT IS THE WHOLE POINT. The command returns four
 * literals of its own, and then carries its callees' refusals out unchanged
 * through a `WA001` raise caught by its own handler, which re-emits `SQLERRM`
 * as the result. Reading only the literal `return query select` statements in
 * the command reports FOUR results and misses ten. The integration finding named
 * two missing codes; deriving the union found eight.
 *
 * `0193`'s own source comment lists this pass-through vocabulary as
 * "no_round_open, round_full, invalid_service, invalid_scope_dates,
 * invalid_weekdays, already_declined_offer, already_invited, invalid_ttl...",
 * which trails off AND names two codes 0192 no longer emits directly. Prose was
 * not treated as the authority; each callee was read.
 */
export const ADMIT_SERVER_SUCCESS = "admitted" as const;

export const ADMIT_SERVER_REFUSALS = [
  // --- the command's own refusals, returned directly -----------------------
  /** The studio id resolved to no studio, or the actor is not its owner. */
  "unknown_studio",
  /** No entry with that id in that studio. Scoped by both, so another tenant's
   *  entry is indistinguishable from one that does not exist. */
  "not_found",
  /** The entry is not in a status this button can act on — `invited`,
   *  `converted`, `expired`, `released` and `removed` each have their own exit. */
  "not_admissible",

  // --- carried out of `claim_new_client_waitlist_entry` (0189) -------------
  "not_waiting",
  "invalid_input",

  // --- carried out of `issue_scoped_new_client_waitlist_invitation` (0192) --
  /** No admission round is open for the studio. */
  "no_round_open",
  /** The open round's allowance is already consumed. */
  "round_full",
  "invalid_service",
  "invalid_scope_dates",
  "invalid_weekdays",
  /** The person declined a previous offer; 0192 forbids re-offering. */
  "already_declined_offer",

  // --- which 0192 in turn passes through from
  //     `issue_new_client_waitlist_invitation` (0188/0190) ------------------
  "already_invited",
  "invalid_ttl",
  "not_claimed",
] as const;

export type AdmitServerRefusal = (typeof ADMIT_SERVER_REFUSALS)[number];
export type AdmitServerResult = typeof ADMIT_SERVER_SUCCESS | AdmitServerRefusal;

/**
 * How each server refusal is shown to the practitioner.
 *
 * `Record<AdmitServerRefusal, …>` is load-bearing: a result added to the union
 * without a disposition here does not COMPILE. That is the property being
 * bought — not documentation, a build failure.
 *
 * SERVER EXHAUSTIVENESS AND PRACTITIONER COPY ARE SEPARATE. Several refusals
 * deliberately normalise to one practitioner outcome, because the practitioner's
 * recovery action — not the database's reason — is what the surface must
 * communicate.
 *
 * NORMALISATIONS THAT LOSE DETAIL, recorded rather than buried:
 * `no_round_open`, `round_full` and `already_declined_offer` are all definite,
 * well-understood refusals with no composer edit that fixes them, and they
 * currently land on `unavailable`, which reads as "try again". `round_full` and
 * `no_round_open` resolve on their own when a round opens, so a retry is at
 * least not wrong. `already_declined_offer` never resolves by retrying, and it
 * is the one normalisation here worth revisiting when this contract gains
 * practitioner copy — it is flagged, not silently dropped.
 */
export const ADMIT_REFUSAL_PRESENTATION: Record<AdmitServerRefusal, InviteToBookFailure> = {
  // Authority and identity failures the practitioner cannot act on.
  unknown_studio: "unavailable",
  not_admissible: "unavailable",
  // The entry moved under the practitioner between render and press; these have
  // exact counterparts the surface already knows how to explain.
  not_found: "not_found",
  not_waiting: "not_waiting",
  not_claimed: "not_claimed",
  already_invited: "already_invited",
  // A bug on this side of the wire.
  invalid_input: "invalid_input",
  invalid_ttl: "invalid_ttl",
  // THE COMPOSER CAN FIX THESE. What the practitioner expressed — the service,
  // the booking window, the allowed days — could not be honoured, which is
  // exactly what `scope_not_supported` exists to say.
  invalid_service: "scope_not_supported",
  invalid_scope_dates: "scope_not_supported",
  invalid_weekdays: "scope_not_supported",
  // Capacity and consent. See the note above: detail is lost here on purpose.
  no_round_open: "unavailable",
  round_full: "unavailable",
  already_declined_offer: "unavailable",
};

/**
 * Turn one raw server row into an outcome, failing closed on anything this
 * contract does not recognise.
 *
 * `result` is typed `string` ON PURPOSE: it arrives over the wire from
 * PostgREST, so the compiler has no say in what actually shows up, and a
 * function that accepted only the union would be describing a guarantee nobody
 * enforces at runtime. Everything unrecognised — a new server code, a null, a
 * number, a success with no expiry stamp — becomes a refusal.
 *
 * A SUCCESS IS NEVER SYNTHESISED. `admitted` without a usable `expires_at` is
 * malformed rather than successful: 0190's correction was that the window
 * belongs to the issuing instant, so a surface that invented one would be
 * showing a deadline the database never agreed to.
 */
export function admitResultToOutcome(
  result: unknown,
  expiresAt: unknown,
): InvitationOutcome {
  if (typeof result !== "string") return { ok: false, code: "unavailable" };

  if (result === ADMIT_SERVER_SUCCESS) {
    return typeof expiresAt === "string" && expiresAt.trim() !== ""
      ? { ok: true, expiresAt }
      : { ok: false, code: "unavailable" };
  }

  // `Object.prototype.hasOwnProperty` rather than a truthiness check, so a
  // result spelled `constructor` or `toString` cannot reach an inherited value.
  return Object.prototype.hasOwnProperty.call(ADMIT_REFUSAL_PRESENTATION, result)
    ? { ok: false, code: ADMIT_REFUSAL_PRESENTATION[result as AdmitServerRefusal] }
    : { ok: false, code: "unavailable" };
}

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
