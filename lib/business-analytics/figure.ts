// ===========================================================================
// Business → Analytics: PER-FIGURE AVAILABILITY. PURE.
// ===========================================================================
//
// Each figure on the Overview comes from its own read. When one read cannot be completed (a window over the reader's cap, a failed query, a currency not
// set) THAT figure is "unavailable" with a reason, and every other figure still shows. It is never blank and never zero: an unknown value is never treated as zero. The readers that feed this are fail-closed: a partial answer is never returned as a whole one.

export type ReadFailure = "too_many_appointments" | "read_failed" | "currency_unknown" | "not_reconciled" | "no_evidence_read";

export type FigureRead<T> = { ok: true; value: T } | { ok: false; reason: ReadFailure };
export type Figure<T> = { available: true; value: T } | { available: false; reason: ReadFailure };

export function figureFrom<T, U>(read: FigureRead<T>, pick: (v: T) => U): Figure<U> {
  return read.ok ? { available: true, value: pick(read.value) } : { available: false, reason: read.reason };
}

/** Plain-English reason for a figure that is not shown. Fixed words, shared by screen, print and CSV. */
export const FIGURE_UNAVAILABLE_COPY: Record<ReadFailure, string> = {
  too_many_appointments: "Too many appointments to summarise this at once.",
  read_failed: "This figure could not be read right now.",
  currency_unknown: "The studio's payment currency is not set.",
  not_reconciled: "These figures do not match the Statements for the same visits, so no total is shown.",
  no_evidence_read: "No kind of price evidence could be read, so no service value is shown.",
};

/** What a CSV or a table cell says for a figure that is not available: words, never an empty cell and never 0. */
export function unavailableText(reason: ReadFailure): string {
  return `Unavailable: ${FIGURE_UNAVAILABLE_COPY[reason]}`;
}
