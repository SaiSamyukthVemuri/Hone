import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { localDateString } from "@/lib/booking/tz";
import {
  type BookingScope,
  type EntryOnlyInput,
  type EntryOutcome,
  type InvitationOutcome,
  type InviteToBookFailure,
  type InviteToBookInput,
  type ResendInvitationInput,
  type WaitlistInvitationAdapter,
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

type Session = { studioId: string; actorUserId: string; timezone: string };

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
  const endMs = now.getTime() + (scope.windowDays - 1) * 86_400_000;
  return { start, end: localDateString(new Date(endMs), timezone) };
}

const NOT_IMPLEMENTED_ATOMICALLY: InviteToBookFailure = "unavailable";

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
    if (!resolved.ok) return { ok: false, code: resolved.code };
    const { studioId, actorUserId, timezone } = resolved.session;

    // AUTHORITY FIRST, INPUT SECOND. See `validateInviteInput`.
    const invalid = validateInviteInput(input);
    if (invalid) return { ok: false, code: invalid };
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
    if (error) return { ok: false, code: "unavailable" };
    const row = Array.isArray(data) ? data[0] : data;
    const result = (row as { result?: unknown } | null)?.result;
    if (result !== "admitted" && result !== "invited") {
      return { ok: false, code: asFailure(result) };
    }
    const expiresAt = (row as { expires_at?: unknown } | null)?.expires_at;
    // THE SERVER STAMPS THE WINDOW. A success without a server expiry is IN
    // DOUBT rather than ok: the surface would otherwise have to compute one,
    // which is precisely the anchoring error 0190 removed.
    if (typeof expiresAt !== "string") return { ok: false, code: "unavailable" };
    // The raw token is deliberately read and DISCARDED here. Delivery of the
    // invitation belongs to #680's send path, and this adapter returning it
    // would put a bearer credential into a practitioner-surface return value.
    return { ok: true, expiresAt };
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

  async resendInvitation(_input: ResendInvitationInput): Promise<InvitationOutcome> {
    void _input;
    return { ok: false, code: NOT_IMPLEMENTED_ATOMICALLY };
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
