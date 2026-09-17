/**
 * The result vocabulary of migration 0195's `create_waitlist_public_appointment`,
 * and the one place it is translated for the public booking action.
 *
 * WHY A TRANSLATION AND NOT A SECOND HANDLER. 0195 composes
 * `create_public_appointment`; it does not replace it. When the nested command
 * refuses, 0195 rolls its own work back and re-emits that refusal PREFIXED —
 * `appointment:time_unavailable` — so the caller can tell a booking refusal from
 * an invitation one. Unwrapping the prefix here lets the action's existing
 * refusal mapping keep working unchanged, which is the whole point: ordinary
 * booking semantics are preserved rather than reimplemented beside themselves.
 *
 * The success word differs too. 0195 answers `created_and_converted`, because
 * it did both; downstream code only ever asked "did the appointment commit",
 * and the answer to that is still yes.
 */

/** Everything 0195 can return, derived by reading the migration, not a comment.
 *  A test re-derives this list from the SQL so a new result cannot be added
 *  without this union noticing. */
export const WAITLIST_BOOKING_RESULTS = [
  // Success: appointment + mandatory audit + conversion, one transaction.
  "created_and_converted",
  // Refusals 0195 decides itself, before the nested booking runs.
  "invalid_input",
  "entry_not_found",
  "client_not_found",
  "not_redeemed",
  "recipient_mismatch",
  "scope_ambiguous",
  "scope_service_not_offered",
  "scope_date_out_of_range",
  "scope_weekday_not_allowed",
] as const;

export type WaitlistBookingResult = (typeof WAITLIST_BOOKING_RESULTS)[number];

/** The prefixes 0195 uses when it re-emits a nested command's own word through
 *  its private WA002 sentinel. */
export const NESTED_APPOINTMENT_PREFIX = "appointment:";
export const NESTED_CONVERSION_PREFIX = "conversion:";
/** 0195's own name for "the nested command said created and gave no id". */
export const INCONSISTENT_APPOINTMENT = "inconsistent:appointment_without_id";

/** What the public booking action's existing logic should see. */
export type NormalizedBookingResult =
  | { kind: "created" }
  /** A refusal the action already knows how to render — the nested booking
   *  command's own vocabulary, unwrapped. */
  | { kind: "booking_refusal"; code: string }
  /** A refusal that belongs to the invitation, not to the calendar. */
  | { kind: "invitation_refusal"; code: WaitlistBookingResult }
  /** Anything this contract does not recognise, INCLUDING a conversion failure
   *  and the inconsistency sentinel. Never a success. */
  | { kind: "unrecognised"; code: string };

/**
 * Translate one 0195 result.
 *
 * FAILS CLOSED BY CONSTRUCTION. There is no default that yields `created`: an
 * unknown word becomes `unrecognised`, which the caller treats as "no
 * appointment from this invocation". A result added to 0195 without being added
 * here therefore refuses rather than being waved through as a booking.
 */
export function normalizeWaitlistBookingResult(
  result: string | null,
): NormalizedBookingResult {
  if (result === null) return { kind: "unrecognised", code: "no_result" };

  if (result === "created_and_converted") return { kind: "created" };

  if (result.startsWith(NESTED_APPOINTMENT_PREFIX)) {
    // The nested command's own refusal, re-emitted. Its semantics are the
    // ordinary booking ones and are deliberately handled by the ordinary path.
    return {
      kind: "booking_refusal",
      code: result.slice(NESTED_APPOINTMENT_PREFIX.length),
    };
  }

  if ((WAITLIST_BOOKING_RESULTS as ReadonlyArray<string>).includes(result)) {
    return { kind: "invitation_refusal", code: result as WaitlistBookingResult };
  }

  // `conversion:*` and `inconsistent:*` land here on purpose. Both mean the
  // transaction rolled back, and neither is a word the visitor-facing mapping
  // should try to explain.
  return { kind: "unrecognised", code: result };
}
