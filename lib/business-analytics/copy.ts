// ===========================================================================
// Business → Analytics: fixed words. The screen, the print and the CSV say the same thing because they read these.
// ===========================================================================

/**
 * What the owner-only gate IS. It controls who is SHOWN the page. It is not a protection on the data: row-level security on
 * clients, appointments and session_blocks is studio-wide, so any practitioner of the studio can read those rows directly. Only the payment
 * tables are owner-only at the database. This sentence must stay true, and must appear on the page and in every pull request about it.
 */
export const ANALYTICS_ACCESS_NOTE =
  "Only the studio owner is shown this page. That is a choice about who is shown it, not a protection on the records: other practitioners in this studio can still read the same appointment and client records. Only payment records are restricted to the owner in the database.";

/** An unknown is said, never drawn as a zero. */
export const NOT_ENOUGH_HISTORY = "Not enough history yet";
export const NO_INTERVAL_REASON = "Needs at least two visit dates.";
export const FIRST_TIME_NOTE = "First-time means the first visit recorded in Hone. Visits from before a client was entered in Hone are not known.";
export const INTERVAL_NOTE = "Average visit interval is the average number of days between a client's completed visits. It is a historical pattern, not a forecast.";
/** The scope in the sentence is the scope in use: with no look-back it says so, and a look-back is named only when one is given. */
export function noNextBookingNote(lookbackMonths?: number): string {
  if (lookbackMonths === undefined) return "As of now: clients with a completed visit and no confirmed booking still to come with any practitioner.";
  const months = lookbackMonths === 1 ? "month" : "months";
  return `As of now: clients with a completed visit in the last ${lookbackMonths} ${months} and no booking still to come with any practitioner.`;
}
/** The factor in the sentence is the factor in use. */
export function beyondUsualNote(factor: number): string {
  return `More days since the last visit than ${factor} times the client's own average gap. Based only on that client's recorded visits.`;
}
export const RECONCILIATION_FAILED = "These figures do not match the Statements for the same visits, so no total is shown.";
export const TREATMENT_CONTEXT_NOTE = "Treatment context here is only how many treatments were recorded and the date of the latest. Notes stay on the client's chart.";

// ---------------------------------------------------------------------------
// The two money figures. Each has one label and one definition; they are never added together and neither is called anything else.
// ---------------------------------------------------------------------------

export const COLLECTED_LABEL = "Collected (by visit date)";
export const COLLECTED_DEFINITION =
  "Money recorded for the visits in this period, whatever the visit's status and whatever day it was paid. It counts card payments that succeeded, cash and e-transfer the owner recorded, and cancellation and no-show fees. A payment refunded in full is not counted. A partly refunded or still-pending payment, and money in another currency, is not added in.";

export const SERVICE_VALUE_LABEL = "Completed service value (by visit date)";
export const SERVICE_VALUE_DEFINITION =
  "What the work was priced at, for the completed visits in this period, using the price recorded for each visit and never today's price list. Each visit is counted under the kind of evidence it has. A price recorded when the visit was recorded is the price at that moment, which may not be the price on the day of the visit. A card payment or a fee is money, not a price, and is never used as one. Visits with no price evidence are counted and left out of the figure. A discount that was never recorded cannot be shown.";
export const NEVER_SUMMED_NOTE = "These are two different figures. Service value is what the work was priced at; collected is the money recorded. They are not added together, and the gap between them is explained below.";

export const EVIDENCE_LABELS = {
  recorded_at_visit: "Price when the visit was recorded",
  online_booking: "Price shown at online booking",
} as const;
export const MISSING_PRICE_EVIDENCE_LABEL = "Completed visits with no price evidence";

// ---------------------------------------------------------------------------
// Labels the Overview needs that are about people and unread sources. None of them is a name or an id.
// ---------------------------------------------------------------------------
export const UNATTRIBUTED_LABEL = "Unattributed";
export const FORMER_TEAM_MEMBER_LABEL = "Former team member";
export const UNNAMED_TEAM_MEMBER_LABEL = "Team member";
/** Said where a kind of price evidence could not be read. It is NOT a zero and NOT "no visit had this". */
export const EVIDENCE_NOT_READABLE_NOTE = "This kind of price evidence cannot be read yet, so it is not counted here. That is not a zero, and it does not mean no visit has it.";
