// "Booked manually": the closed result codes of the owner command and the plain sentence for each. Pure, and kept out of any "use server" file.
// No sentence carries a name, an email address or an id.

export const BOOKED_MANUALLY_RESULTS = [
  "booked",
  "already_booked",
  "not_owner",
  "not_found",
  "entry_removed",
  "appointment_not_found",
  "appointment_has_no_client",
  "appointment_not_bookable",
  "appointment_already_linked",
  "email_mismatch",
  "invitation_redeemed",
] as const;

// `invalid_request` is not a database code: it is the neutral answer to a malformed or missing id (never "only the owner can do this").
export type BookedManuallyResult = (typeof BOOKED_MANUALLY_RESULTS)[number] | "unavailable" | "invalid_request";

const KNOWN = new Set<string>(BOOKED_MANUALLY_RESULTS);
export const isBookedManuallyResult = (v: unknown): v is (typeof BOOKED_MANUALLY_RESULTS)[number] =>
  typeof v === "string" && KNOWN.has(v);

export const BOOKED_MANUALLY_COPY: Record<BookedManuallyResult, string> = {
  booked: "Marked as booked. They are no longer on the waiting list.",
  already_booked: "Already marked as booked.",
  not_owner: "Only the studio owner can do this.",
  not_found: "That waiting list entry could not be found.",
  entry_removed: "This entry was removed from the waiting list. Return it from Archived first if you need to.",
  appointment_not_found: "That appointment could not be found.",
  appointment_has_no_client: "That appointment has no client attached. Add the client to the booking first.",
  appointment_not_bookable: "That appointment is cancelled.",
  appointment_already_linked: "That appointment is already linked to another waiting list entry.",
  email_mismatch:
    "The email on that booking is different from the waiting list email. If it is the same person, tick the confirmation and try again.",
  invitation_redeemed: "This person already used their invitation to book. Open their booking instead.",
  invalid_request: "That couldn't be done.",
  unavailable: "That couldn't be done right now. Nothing was changed. Try again.",
};

/** The `?bm=` code the page reads back. Anything unrecognised reads as the generic failure, never as success. */
export function bookedManuallyNoticeFrom(code: unknown): BookedManuallyResult | null {
  if (code === undefined || code === null || code === "") return null;
  return isBookedManuallyResult(code) || code === "unavailable" || code === "invalid_request" ? (code as BookedManuallyResult) : "unavailable";
}

export const bookedManuallyOk = (r: BookedManuallyResult) => r === "booked" || r === "already_booked";

/** Off by default. The command exists only once the database change is applied; turning this on before then would fail every attempt closed. Exactly "1" enables it. */
export function waitlistBookedManuallyEnabled(): boolean {
  return process.env.WAITLIST_BOOKED_MANUALLY === "1";
}
