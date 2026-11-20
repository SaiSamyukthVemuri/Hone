// ===========================================================================
// Business → Analytics: fixed words. The screen, the print and the CSV say the same thing because they read these.
// ===========================================================================

/**
 * What the owner-only gate IS (Privacy A1). It controls who is SHOWN the page. It is not a protection on the data: row-level security on
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
export const NO_NEXT_BOOKING_NOTE = "As of now: clients with a completed visit in the last 12 months and no booking still to come.";
export const BEYOND_USUAL_NOTE = "More days since the last visit than 1.5 times the client's own average gap. Based only on that client's recorded visits.";
export const RECONCILIATION_FAILED = "These figures do not match the Statements for the same visits, so no total is shown.";
export const TREATMENT_CONTEXT_NOTE = "Treatment context here is only how many treatments were recorded and the date of the latest. Notes stay on the client's chart.";
