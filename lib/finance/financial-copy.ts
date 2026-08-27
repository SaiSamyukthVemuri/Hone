// ===========================================================================
// FIN-01A — the sentences this surface is allowed to say
// ===========================================================================
//
// Every line the owner reads about provenance or absence lives here, as a
// constant, for two reasons.
//
//   * A GUARD CAN ASSERT A CONSTANT. Line-wrapping a sentence across a JSX text
//     node changes its whitespace, which silently breaks any test that pins the
//     wording — and these particular sentences are the only thing stopping this
//     screen being read as a revenue report.
//
//   * ONE PLACE TO GET IT RIGHT. The distinction between "nothing was recorded"
//     and "we could not read it" is the product. Spreading it across components
//     is how the two collapse into a shared "Not available".
//
// A Next.js `page.tsx` may only export the framework's own named exports, so
// these cannot live on the route file even though that is where they are used.

import type { FinancialUnknownCause } from "./financial-fact";

// ---------------------------------------------------------------------------
// Permanent framing — on screen always, never behind a disclosure
// ---------------------------------------------------------------------------

/**
 * The line that stops the anchor being read as revenue. Service value is a
 * PRICE: what the work was listed at. It is not money that moved, and the two
 * are not reconcilable to each other by arithmetic on this screen.
 */
export const SERVICE_VALUE_IS_NOT_MONEY =
  "Service value is what the work was priced at. It is not money collected.";

/**
 * The off-platform limitation, carried from the FIN-01A implementation brief
 * (operator decision 10: the limitation must remain VISIBLE in the UI).
 */
export const EXTERNAL_PAYMENTS_UNKNOWN_NOT_ZERO =
  "Payments taken outside Hone are unknown, not zero. Hone records no cash, no e-transfer and no payment taken outside Hone unless a practitioner writes it down.";

/**
 * The historical boundary.
 *
 * NO DATE IS ASSERTED, deliberately. `docs/production/migration-state.json`
 * records 0187 as applied with `hosted_applied_at: null`, stating that no
 * server-generated apply timestamp was ever captured and that what exists is an
 * operator-observed client-side window. Printing a date to a studio owner would
 * claim a precision the canonical record explicitly declines to claim, so this
 * sentence is phrased by CAPABILITY instead. If a server apply instant is ever
 * captured, this line — and only this line — can gain the date.
 */
export const HISTORY_BEFORE_OUTCOMES =
  "Before Hone could record cash, e-transfer and waived fees, no such record exists for a visit. Those visits are unknown, not zero.";

/**
 * What "Past, still confirmed" IS, and — more importantly — what it is NOT.
 *
 * The row counts appointments whose start has passed while the record still
 * says `confirmed`. That is the ONLY established truth about them. It is not
 * evidence that the visit happened, that it was missed, or that it was
 * cancelled: nothing in Hone writes a terminal status when an appointment
 * elapses, so the row means the record was never closed out and nothing more.
 *
 * The words "missed", "no-show", "completed" and "needs action" are all
 * DELIBERATELY ABSENT. Each is an outcome claim, and no authority on this
 * screen establishes any of them. Naming one would replace a true statement
 * about a record with a false statement about a person's visit.
 */
export const PAST_STILL_CONFIRMED_IS_A_RECORD_STATE =
  "Past, still confirmed counts appointments whose start time has passed while the record still says confirmed. That describes the record, not the visit: it does not mean the visit happened, was missed, or was cancelled.";

/** The three above, in reading order, for the one component that renders them. */
export const PERMANENT_LINES = [
  SERVICE_VALUE_IS_NOT_MONEY,
  EXTERNAL_PAYMENTS_UNKNOWN_NOT_ZERO,
  HISTORY_BEFORE_OUTCOMES,
] as const;

// ---------------------------------------------------------------------------
// One sentence per cause
// ---------------------------------------------------------------------------

/**
 * The short label that stands where a figure would be.
 *
 * None of these is "Not available", and none of them is a dash. "Not available"
 * was the wording the design review proposed and it is rejected here precisely
 * because it reads identically for a visit nobody has settled and for a query
 * that failed — one is the studio's state and the other is Hone's.
 */
export const UNKNOWN_LABEL: Record<FinancialUnknownCause, string> = {
  not_recorded: "Nothing recorded",
  unavailable: "Can't show this right now",
  unknowable: "Hone can't know this",
  not_yet_supported: "Not supported yet",
  not_enumerable: "Too much to total",
};

/** The sentence beneath the label, saying what it means and what to do. */
export const UNKNOWN_EXPLANATION: Record<FinancialUnknownCause, string> = {
  not_recorded:
    "Nobody has said what happened here yet. This is not zero, and it is not a free visit.",
  unavailable:
    "A read Hone depends on did not come back, so there is no figure to show. Nothing here is zero — Hone simply could not look.",
  unknowable:
    "No record of this was ever kept, so there is nothing to find and nothing for you to do.",
  not_yet_supported:
    "Hone can answer this and does not answer it yet. It is coming in a later release; it says nothing about your studio.",
  not_enumerable:
    "This period has more activity than one read can total, so no partial figure is shown. Choose a shorter period.",
};

/** What the owner can do about it, where there is anything. */
export const UNKNOWN_ACTION: Partial<Record<FinancialUnknownCause, string>> = {
  not_recorded: "Review these visits",
  unavailable: "Try again",
  not_enumerable: "Choose a shorter period",
};

// ---------------------------------------------------------------------------
// Slice boundaries — what this release does not answer, said plainly
// ---------------------------------------------------------------------------

export const DISPOSITION_CHAIN_NOT_YET =
  "How each completed visit was settled — paid by card, collected outside Hone, still owed, waived — is not on this screen yet.";

export const MONEY_BRIDGES_NOT_YET =
  "Card payments Hone verified, and what a practitioner recorded collecting outside Hone, are not on this screen yet. They are different measurements from the service value above and will be shown apart from it.";
