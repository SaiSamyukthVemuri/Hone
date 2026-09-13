import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { addDays, localDateString } from "@/lib/booking/tz";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import {
  sendWaitlistInvitationEmail,
  type DeliveryStudio,
} from "@/lib/waitlist/delivery/send";
import {
  type BookingScope,
  type DefiniteInviteToBookRefusal,
  type EntryOnlyInput,
  type EntryOutcome,
  type InvitationDeliveryState,
  type InvitationOutcome,
  type InviteToBookFailure,
  type InviteToBookInput,
  type ResendInvitationInput,
  type WaitlistInvitationAdapter,
  ADMIT_REFUSAL_PRESENTATION,
  ADMIT_SERVER_SUCCESS,
  INDETERMINATE_ADMISSION,
  INVITE_TO_BOOK_FAILURES,
} from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT INTEGRATION-01 — THE PRACTITIONER INVITE-TO-BOOK ADAPTER
// ===========================================================================
//
// INTEGRATION-OWNED. #683 ships the contract and the presentation and binds to
// `NO_ADAPTER_BOUND`; #685 ships `admit_new_client_waitlist_entry` in 0193 and
// has no caller. They are siblings off production, so neither branch can hold
// this file — the same structural reason the proof-delivery binding lives here.
//
// ---------------------------------------------------------------------------
// WHAT THE PRACTITIONER SUPPLIES, AND WHAT THEY CANNOT
// ---------------------------------------------------------------------------
//
// SUPPLIED: entry, service, window, allowed weekdays, TTL. Product inputs only.
//
// NOT SUPPLIED, and unreachable from the browser through this module: studio
// authority, actor authority, round id, claim state, consumption count, and any
// recipient proof state. The studio and the acting practitioner are resolved
// HERE from the session, and `admit_` then RE-DERIVES membership and owner role
// in the database from (studio_id, auth user id). The route check is a clearer
// message, never the guarantee.
//
// NO CLAIM VOCABULARY CROSSES THIS BOUNDARY. `inviteToBook` accepts an entry
// that is `waiting` OR `claimed` and does not report which it was: from
// `waiting` the command claims-then-issues as one transaction, from `claimed`
// it issues alone. That is the whole product ruling expressed as a signature,
// and it is why this module exposes no claim method, no round id and no
// allowance count.
//
// ---------------------------------------------------------------------------
// CAPABILITIES ARE HONEST, AND THREE OF THEM ARE FALSE
// ---------------------------------------------------------------------------
//
// The contract's own `AdapterCapabilities` exists for exactly this: an adapter
// may implement part of the interface provided it SAYS SO, because the surface
// disables what is not advertised.
//
// 0193 gives ONE compound command, `admit_`. The other three compound
// operations the contract demands ATOMICALLY have no command:
//
//   resendInvitation     release + requeue + claim + issue   (4 hops)
//   returnToWaitlist     expire+requeue, or release+requeue  (2 hops, 2 paths)
//   removeFromWaitlist   expire + remove                     (2 hops)
//
// Implementing those as sequential RPCs would satisfy the TYPE and break the
// CONTRACT, whose header states every method either reaches its end state or
// leaves the entry exactly where it started. A crash between hops strands a
// row, and the contract's own capability docs warn that advertising a partial
// escape is worse than advertising none. So they report `false` and refuse,
// and the missing commands are reported as a dependency rather than faked.
//
// `cancelInvitation` IS single-hop (`release_new_client_waitlist_entry`), so it
// is implemented and advertised true.

/** Result codes the shipped commands may return, narrowed to the contract. */
const FAILURE_SET = new Set<string>(INVITE_TO_BOOK_FAILURES);

function asFailure(code: unknown): InviteToBookFailure {
  // An UNRECOGNISED code is `unavailable`, never a confident refusal. The
  // contract's test re-derives this union from the migrations, so a code that
  // reaches here unmapped is a drift signal, not a routine branch.
  return typeof code === "string" && FAILURE_SET.has(code)
    ? (code as InviteToBookFailure)
    : "unavailable";
}

type Session = {
  studioId: string;
  actorUserId: string;
  timezone: string;
  /** The sender identity the invitation email is sent AS. Server-resolved. */
  studio: DeliveryStudio;
};

/**
 * Studio and actor from the SESSION. Never parameters.
 *
 * Returns a typed refusal rather than throwing, so a practitioner whose role
 * changed under them sees the contract's own vocabulary instead of a 500.
 */
async function resolveSession(): Promise<
  { ok: true; session: Session } | { ok: false; code: InviteToBookFailure }
> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner") return { ok: false, code: "not_owner" };
    // `practitioners.user_id` is nullable in the schema — a row may exist for an
    // invited practitioner who has never signed in. This one came FROM a
    // session so it is present, narrowed explicitly rather than passed as null,
    // which the command would refuse as `invalid_input`.
    const actorUserId = practitioner.user_id;
    if (!actorUserId) return { ok: false, code: "not_a_member" };
    return {
      ok: true,
      session: {
        studioId: studio.id,
        actorUserId,
        timezone: studio.timezone ?? "UTC",
        studio: {
          id: studio.id,
          name: studio.name ?? null,
          // COMMS-01A: a client-facing send speaks as the studio and offers a
          // reply path. These ride along from a row already fetched.
          postcare_contact_email:
            (studio as { postcare_contact_email?: string | null }).postcare_contact_email ?? null,
          owner_email: (studio as { owner_email?: string | null }).owner_email ?? null,
        },
      },
    };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

/**
 * `windowDays` (a DURATION) -> the date pair `admit_` takes.
 *
 * WHY THIS CONVERSION IS A SEAM AND NOT A DETAIL. The contract deliberately
 * carries a duration because 0190 established that a window must be anchored to
 * the ISSUING instant; `admit_` deliberately takes absolute dates because scope
 * is stored as dates. Something has to convert, and the conversion is only
 * correct in the STUDIO'S timezone: `current_date` on a UTC server is a
 * different day from the studio's for part of every day, and an off-by-one here
 * silently grants or removes a bookable day.
 *
 * ANCHORED TO THE STUDIO'S TODAY, INCLUSIVE. `windowDays: 7` means today plus
 * the next six studio-local days — seven bookable days, not eight.
 *
 * CALENDAR DAYS, NOT 24-HOUR BLOCKS. An earlier revision advanced the INSTANT by
 * `(windowDays - 1) * 86_400_000` and then localised it. That is wrong wherever
 * a clock changes: a spring-forward day is 23 hours, so adding six 24-hour
 * blocks across it lands on the SEVENTH local date and the practitioner's
 * "7 days" silently became 8; a fall-back day is 25 hours, so the same sum lands
 * short and 7 became 6. The window the studio chose is a count of local calendar
 * DATES, and nothing about it is a duration in milliseconds.
 *
 * So the arithmetic happens entirely in the date domain: localise the issuing
 * instant ONCE to get the studio's calendar date, then advance by whole dates
 * with `addDays`, which is anchored at noon UTC precisely so no offset change
 * can move it. The inclusive count is then `windowDays` in every zone and on
 * every transition, which is what the controls below assert.
 *
 * RESIDUAL, RECORDED RATHER THAN HIDDEN: this computes the anchor microseconds
 * before the database issues the row, so an invitation created across a
 * studio-local midnight boundary is anchored to the day the practitioner was
 * looking at rather than the day the row was stamped. Closing that needs
 * `admit_` to accept a duration and derive the dates under its own lock. It is
 * a one-day edge at one instant per day, it always favours the day the operator
 * saw, and it is reported as a dependency — not papered over here.
 */
function windowToDates(
  scope: BookingScope,
  timezone: string,
  now: Date,
): { start: string; end: string } {
  const start = localDateString(now, timezone);
  return { start, end: addDays(start, scope.windowDays - 1) };
}

const NOT_IMPLEMENTED_ATOMICALLY: InviteToBookFailure = "unavailable";

function readString(row: unknown, key: string): string | null {
  const v = (row as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * A failure this side of the wire, expressed in the three-state contract.
 *
 * `unavailable` is NOT a refusal — it means "we could not find out" — so it maps
 * to `indeterminate`. Everything else is something we decided before the command
 * ran, which is a definite refusal: nothing committed.
 */
function refusedOrIndeterminate(code: InviteToBookFailure): InvitationOutcome {
  return code === "unavailable"
    ? INDETERMINATE_ADMISSION
    : { state: "refused", code: code as DefiniteInviteToBookRefusal };
}

/**
 * A result the SERVER gave, mapped through #683's total presentation table.
 *
 * `ADMIT_REFUSAL_PRESENTATION` is `Record<AdmitServerRefusal, …>`, so a result
 * added to that union without a disposition does not compile — the exhaustiveness
 * is bought by the type, not by this function. What this adds is the runtime
 * half: a result the table has never heard of is `indeterminate`, never a
 * confident refusal, because an unrecognised answer is one we could not read.
 *
 * The integration test in tests/db/ proves the table covers what the CURRENT
 * 0193 can actually return, which is the half #683 cannot check for itself.
 */
function refusalFromServer(result: unknown): InvitationOutcome {
  if (typeof result !== "string") return INDETERMINATE_ADMISSION;
  const mapped = (
    ADMIT_REFUSAL_PRESENTATION as Record<string, DefiniteInviteToBookRefusal | undefined>
  )[result];
  if (mapped) return { state: "refused", code: mapped };
  const authority = ADMIT_AUTHORITY_REFUSALS[result];
  if (authority) return { state: "refused", code: authority };
  return INDETERMINATE_ADMISSION;
}

/**
 * The authority refusals `admit_` PROPAGATES but #683's table does not enumerate.
 *
 * `admit_` resolves authority through `new_client_waitlist_resolve_owner` and,
 * when that answers anything but `ok`, returns its code VERBATIM. That command
 * can answer `not_owner`, `not_a_member` or `invalid_input`. Only the last is in
 * `ADMIT_SERVER_REFUSALS`, so without this the other two fall through to
 * `indeterminate` — telling a practitioner "we could not confirm whether the
 * invitation was created, go and check the waitlist" when the database gave a
 * flat, final No and nothing committed. That is a false alarm about state, and
 * it sends them looking for a row that does not exist.
 *
 * WHY IT LIVES HERE. The omission is real and component-owned — the presentation
 * table is #683's, and its own header calls the admit_ result list "A SNAPSHOT
 * ... NOT a live guarantee" precisely because 0193 is not an ancestor of that
 * branch. #689 is the first place both halves exist, so the gap is observable
 * here and nowhere else. This supplement makes the ASSEMBLED runtime truthful;
 * it is not a substitute for #683 enumerating them, and the integration test
 * asserts the union of the two tables covers the live vocabulary so the day
 * #683 adds them nothing here silently rots.
 *
 * NARROW AND DERIVED, NOT A CATCH-ALL. It lists exactly what ONE named command
 * can return, each identity-mapped onto the same word. It deliberately does NOT
 * fall back to "anything in INVITE_TO_BOOK_FAILURES", which would let a FUTURE
 * 0193 result that happens to share a name with an unrelated failure become a
 * confident refusal. Anything outside both tables stays indeterminate.
 */
const ADMIT_AUTHORITY_REFUSALS: Record<string, DefiniteInviteToBookRefusal | undefined> = {
  not_owner: "not_owner",
  not_a_member: "not_a_member",
};

/**
 * Spend the one raw token on #680's reviewed invitation send.
 *
 * DELIVERY CANNOT UN-INVITE ANYBODY. This returns only the delivery state; the
 * caller has already committed and says so regardless of what happens here.
 *
 * `delivered` maps straight across: `yes` -> accepted (the provider took
 * CUSTODY — it says nothing about receipt or opening), `no` -> refused,
 * `unknown` -> unknown. A throw is `unknown` too, never `refused`: an exception
 * on this side is not evidence the provider declined.
 */
async function deliverInvitation(args: {
  studio: DeliveryStudio;
  invitationId: string;
  recipientEmail: string;
  rawToken: string;
  issuedAt: Date;
  expiresAt: Date;
}): Promise<InvitationDeliveryState> {
  try {
    const origin = getRequiredAppOrigin();
    const result = await sendWaitlistInvitationEmail({
      studio: args.studio,
      invitationId: args.invitationId,
      recipientEmail: args.recipientEmail,
      // The token appears in exactly one place: the URL handed to the mail
      // constructor. It is built here and held nowhere else.
      invitationUrl: `${origin}/invitation/${args.rawToken}`,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
    });
    return deliveryStateFromDisposition(result.disposition.delivered);
  } catch {
    return "unknown";
  }
}

/**
 * #680's custody verdict in #683's three words.
 *
 * `yes` -> `accepted` means THE PROVIDER TOOK CUSTODY. It does not say the
 * person received or opened anything, and no copy built on it may.
 * `no` -> `refused`: the provider definitely did not take it. The invitation
 * still exists either way.
 * Anything else -> `unknown`, the fail-closed word, so an unreadable verdict can
 * never become a claim in either direction.
 */
function deliveryStateFromDisposition(delivered: unknown): InvitationDeliveryState {
  return delivered === "yes" ? "accepted" : delivered === "no" ? "refused" : "unknown";
}

/**
 * Product-input validation, PURE and exported.
 *
 * Separated from the adapter for two reasons. It is the only part of the send
 * path testable without a session — and it must stay SECOND, after authority.
 * An unauthenticated caller learning that its TTL was out of range has been told
 * something about a studio it has no standing to ask about; the ordering in
 * `inviteToBook` is therefore deliberate, and keeping the rules here means
 * proving them does not require weakening it.
 *
 * Returns the failure code, or null when the input is sendable.
 */
export function validateInviteInput(input: InviteToBookInput): InviteToBookFailure | null {
  // REFUSED, NOT WIDENED. The contract says `serviceId: null` means "any
  // bookable service", but `admit_` requires a service to scope the invitation.
  // Sending unscoped is the one thing `scope_not_supported` exists to prevent.
  if (input.scope.serviceId === null) return "scope_not_supported";
  // Bounds are the shipped command's own; out of range is refused, never
  // clamped — a clamped window is one the caller cannot see.
  if (
    !Number.isInteger(input.expiresInHours) ||
    input.expiresInHours < 1 ||
    input.expiresInHours > 168
  ) {
    return "invalid_ttl";
  }
  if (
    !Number.isInteger(input.scope.windowDays) ||
    input.scope.windowDays < 1 ||
    input.scope.windowDays > 365
  ) {
    return "invalid_input";
  }
  // An EMPTY weekday array authorises nothing and is refused rather than
  // stored: 0192 treats it as "no day permitted", which is an invitation that
  // cannot be redeemed. `null` means every day and is a different thing.
  const weekdays = input.scope.allowedWeekdays;
  if (weekdays !== null && weekdays.length === 0) return "invalid_input";
  if (weekdays !== null && weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return "invalid_input";
  }
  return null;
}

class AdmissionCommandAdapter implements WaitlistInvitationAdapter {
  readonly capabilities = {
    // `admit_` carries serviceId, the date window and allowedWeekdays into the
    // invitation row, and 0192's scope evaluator enforces them at the
    // recipient's booking surface AND again at the mutation.
    enforcesScope: true,
    canResend: false,
    canCancel: true,
    canReturnToWaitlist: false,
    canRemove: false,
  } as const;

  async inviteToBook(input: InviteToBookInput): Promise<InvitationOutcome> {
    const resolved = await resolveSession();
    if (!resolved.ok) return refusedOrIndeterminate(resolved.code);
    const { studioId, actorUserId, timezone, studio } = resolved.session;

    // AUTHORITY FIRST, INPUT SECOND. See `validateInviteInput`.
    const invalid = validateInviteInput(input);
    if (invalid) return refusedOrIndeterminate(invalid);
    const weekdays = input.scope.allowedWeekdays;

    const { start, end } = windowToDates(input.scope, timezone, new Date());
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("admit_new_client_waitlist_entry", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
      p_entry_id: input.entryId,
      p_service_id: input.scope.serviceId,
      p_start_date: start,
      p_end_date: end,
      p_allowed_weekdays: weekdays === null ? null : [...weekdays],
      p_ttl_hours: input.expiresInHours,
    });

    // A LOST ANSWER IS NOT A REFUSAL, AND THIS IS THE WHOLE REASON THE THIRD
    // STATE EXISTS.
    //
    // The request may have reached PostgreSQL, committed the admission, minted
    // the invitation and consumed the round's allowance, and then lost its HTTP
    // response. Reporting `refused` would claim an answer the database never
    // gave, and the practitioner — told it failed — presses the button again.
    // That retry is the expensive mistake: the invitation already exists, and
    // its one-time raw token went missing with the response, so a second attempt
    // burns capacity on a prospect who can no longer be handed their link.
    //
    // NO RECONCILIATION IS ATTEMPTED. "A live invitation now exists" does not
    // prove THIS attempt created it — a concurrent operator is enough to make
    // that inference wrong — and nothing here correlates an attempt with a row.
    // Until an attempt-correlated mechanism exists, indeterminate is the honest
    // answer and the copy sends the practitioner to look at the waitlist.
    if (error) return INDETERMINATE_ADMISSION;

    const row = Array.isArray(data) ? data[0] : data;
    const result = (row as { result?: unknown } | null)?.result;
    if (result !== ADMIT_SERVER_SUCCESS) {
      return refusalFromServer(result);
    }

    // --- The admission is COMMITTED from here down. -------------------------
    //
    // Nothing below may turn this into `refused`. Delivery is a separate truth
    // and travels in its own field.
    const expiresAt = readString(row, "expires_at");
    const issuedAt = readString(row, "issued_at");
    const rawToken = readString(row, "raw_token");
    const recipientEmail = readString(row, "delivery_email");
    const invitationId = readString(row, "invitation_id");

    // BOTH INSTANTS ARE THE DATABASE'S. `admit_` returns `issued_at` and
    // `expires_at` from the same committed row; neither is reconstructed from
    // the other, from the requested TTL, or from an application clock. That
    // reconstruction was adjudicated out for the proof challenge and the same
    // ruling governs here.
    if (!expiresAt || !issuedAt || !rawToken || !recipientEmail || !invitationId) {
      // The row committed but we cannot read what it returned, so we can neither
      // deliver nor describe the window. Not a refusal — the invitation exists.
      return { state: "committed", expiresAt: expiresAt ?? "", delivery: "unknown" };
    }

    // THE RAW TOKEN EXISTS EXACTLY ONCE, IN MEMORY, HERE. Only its digest is
    // persisted, so if this function returns without spending it the invitation
    // can never be delivered by any later process. It is passed straight into
    // #680's reviewed send path and into nothing else: not stored, not logged,
    // not returned, not attached to an error.
    const delivery = await deliverInvitation({
      studio,
      invitationId,
      recipientEmail,
      rawToken,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });

    return { state: "committed", expiresAt, delivery };
  }

  async cancelInvitation(input: EntryOnlyInput): Promise<EntryOutcome> {
    const resolved = await resolveSession();
    if (!resolved.ok) return { ok: false, code: resolved.code };
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("release_new_client_waitlist_entry", {
      p_studio_id: resolved.session.studioId,
      p_entry_id: input.entryId,
      p_actor_user_id: resolved.session.actorUserId,
    });
    if (error) return { ok: false, code: "unavailable" };
    const row = Array.isArray(data) ? data[0] : data;
    const result = (row as { result?: unknown } | null)?.result ?? data;
    return result === "released" ? { ok: true } : { ok: false, code: asFailure(result) };
  }

  // --- Unimplemented COMPOUND operations ------------------------------------
  //
  // Each needs an atomic multi-hop command 0193 does not provide. They refuse
  // rather than performing the hops in sequence, and `capabilities` reports
  // false so the surface never offers them. See the header.

  /**
   * UNREACHABLE BY CONSTRUCTION — `canResend` is false, so no surface offers it.
   *
   * `indeterminate` rather than a refusal code, and the reason is narrow: every
   * member of `DefiniteInviteToBookRefusal` names something the SERVER decided,
   * and no command ran here at all. Borrowing one would put a false reason in
   * front of a practitioner. `indeterminate`'s copy asks them to check the
   * waitlist, which is always safe advice about a state nothing has touched.
   */
  async resendInvitation(_input: ResendInvitationInput): Promise<InvitationOutcome> {
    void _input;
    return INDETERMINATE_ADMISSION;
  }

  async returnToWaitlist(_input: EntryOnlyInput): Promise<EntryOutcome> {
    void _input;
    return { ok: false, code: NOT_IMPLEMENTED_ATOMICALLY };
  }

  async removeFromWaitlist(_input: EntryOnlyInput): Promise<EntryOutcome> {
    void _input;
    return { ok: false, code: NOT_IMPLEMENTED_ATOMICALLY };
  }
}

/** The bound adapter. Server-only; never constructed in a client component. */
export const admissionCommandAdapter: WaitlistInvitationAdapter =
  new AdmissionCommandAdapter();

export { windowToDates as __windowToDatesForTest };
export { refusalFromServer as __refusalFromServerForTest };
export { ADMIT_AUTHORITY_REFUSALS };
export { deliveryStateFromDisposition as __deliveryStateFromDispositionForTest };
