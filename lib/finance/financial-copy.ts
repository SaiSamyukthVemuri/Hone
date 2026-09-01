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
  records_incomplete: "Records too incomplete",
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
  records_incomplete:
    "Appointments in this period were often left open rather than closed out, so a figure over them would understate the work. Hone shows money from the point the records can carry it.",
};

/** What the owner can do about it, where there is anything. */
export const UNKNOWN_ACTION: Partial<Record<FinancialUnknownCause, string>> = {
  not_recorded: "Review these visits",
  unavailable: "Try again",
  not_enumerable: "Choose a shorter period",
};

// ---------------------------------------------------------------------------
// Slice 2 — delivered money
// ---------------------------------------------------------------------------

/**
 * THE THREE CLASSES, NAMED. This is the sentence that stops the screen being
 * read as one bank balance with parts missing.
 */
export const THREE_CLASSES_NEVER_ADD_UP =
  "These are three different kinds of evidence and Hone does not add them together. Card payments are ones Hone watched go through. Money collected outside Hone exists only if a practitioner wrote it down. Service value is a price, not money.";

/** What "delivered" counts, said before any figure computed from it. */
export const DELIVERED_MEANS =
  "Delivered counts visits that had finished by the time this page was built — whether or not anyone marked them completed afterwards.";

/** Why the money window can be shorter than the period the owner picked. */
export const MONEY_WINDOW_IS_NARROWER =
  "Money is shown from 1 August 2026 onwards. Before that, appointments were often left open rather than closed out, so figures over them would understate the work.";

/** The whole requested period sits below the floor. */
export const PERIOD_IS_BEFORE_MONEY_WINDOW =
  "This period ends before 1 August 2026, so there is no money figure Hone can stand behind for it. The calendar above is unaffected.";

/** The window reaches back past this studio's first verified card payment. */
export const WINDOW_PRECEDES_LEDGER =
  "This window reaches back before your first card payment through Hone, so part of it is time Hone was not collecting. A low figure here is not a quiet stretch.";

/** Collected money is gross. Processor cost is not knowable from this ledger. */
export const COLLECTED_IS_GROSS =
  "Card payments are shown before Stripe's fees. Hone's payment records carry no fee column, so what reached your bank is not something Hone can work out.";

/**
 * What "no payment recorded" IS and is NOT.
 *
 * NOT "owed", NOT "outstanding", NOT "unpaid". No settlement row exists for
 * these visits, so nothing establishes that money is owed — and telling an
 * owner a client owes money they may have already handed over in cash is a
 * client-relationship harm, not a rounding error. Production holds exactly one
 * settlement row in the entire database, and none for this studio.
 */
export const NO_PAYMENT_RECORDED_IS_NOT_OWED =
  "No payment recorded means nobody has written down what happened. It does not mean the visit is unpaid, and it does not mean money is owed.";

/** CONTRACT 1. What this figure is, and — load-bearing — what it is not. */
export const CASH_MOVEMENT_IS_NOT_EARNINGS =
  "This is card money that moved in this period: payments taken, less refunds sent back. A refund here can reverse a payment taken in an earlier period, so this is movement through your card payments, not what this period's work earned.";

/** CONTRACT 2. Numerator and denominator are the same visits, and it says so. */
export const COLLECTED_ON_DELIVERED_IS_ONE_POPULATION =
  "These figures cover one set of visits: treatment delivered in this window that was also paid by card in it. Each payment is counted after its own refund, whenever that refund happened, so the amount and the hours describe exactly the same visits.";

/** Why the per-hour figure covers a narrower set than delivered treatment. */
export const PER_HOUR_POPULATION =
  "Treatment delivered in this window and paid by card in it. Visits not yet paid, paid outside Hone, or paid in another period are not in either half of this figure.";

/** P2-D. All-time, and never dressed as a figure about the chosen period. */
export const UNATTRIBUTED_IS_ALL_TIME =
  "These card payments succeeded but carry no collection time, so Hone cannot place them in any period. The count is all time, not this period, and they are in none of the figures above.";

/**
 * The one place the screen's two paid-visit counts legitimately differ.
 *
 * Shown ONLY when it actually happens. A visit priced at nothing that was still
 * charged belongs in the service-period figures — money landed on it — and
 * outside the collection rate, because there was nothing to collect.
 */
export const PAID_BUT_NOTHING_TO_COLLECT =
  "A card payment landed on treatment that carried no price. Those visits are in the collected figures above, and outside the collection rate below, because there was nothing to collect on them.";

/**
 * A card payment that was refunded in full.
 *
 * NOT "collected", and NOT "no payment recorded". Both would be false: the
 * money moved and then moved back. The previous build counted these visits as
 * collected, so the screen showed a 100% collection rate beside $0.00
 * collected. Shown only when it actually happens.
 *
 * `lib/billing/payment-refund.ts` writes full reversals only, so this is the
 * shape of every refund Hone can currently issue.
 */
export const REFUNDED_TO_ZERO_EXPLAINED =
  "A card payment on these visits was refunded in full, so nothing was kept. They are not counted as collected, and they are not visits with no payment recorded — the payment was recorded, and then it was sent back.";

/**
 * Settlement rows the window's figures could not use.
 *
 * SAYS WHAT THE COUNT IS. The earlier sentence claimed each such row named a
 * visit "outside this window", which was false for a payment recorded against
 * a delivered consultation — the screen showed that consultation inside the
 * window on the same page.
 */
export const SETTLEMENTS_NOT_IN_THIS_WINDOW =
  "Some payments recorded outside Hone name a visit that is not one of the delivered visits in this window, so they are not counted here.";

/** A consultation is decided by the service, never by its price. */
export const CONSULTATION_IS_A_SERVICE_KIND =
  "Consultation or treatment is taken from the service itself, the same way the booking page decides it. A consultation you charge for is still a consultation, and a treatment you do not charge for is still treatment.";

/** A delivered visit whose service is gone cannot be classified at all. */
export const UNCLASSIFIED_VISITS_EXPLAINED =
  "These visits happened, but the service behind them is no longer on record, so Hone cannot tell whether they were treatment or consultation. They are counted here and left out of both.";

/** The collection rate is a count ratio, and says so. */
export const COLLECTION_RATE_IS_VISITS =
  "This counts visits, not dollars. A dollar version would divide an amount a practitioner typed at checkout by a price you can still edit, which is not a rate of anything. Only treatment with a price is counted: there is nothing to collect on a visit priced at nothing.";

/**
 * WHICH PRICE EACH VISIT IS VALUED AT.
 *
 * The sentence this replaces said "Hone does not keep the price a visit
 * carried at the time". That is FALSE wherever a visit was settled: migration
 * 0187 stores `quoted_amount_cents` — "THE PRICE AT THE TIME, SNAPSHOTTED" —
 * resolved by the same authoritative resolver the card path uses, and its own
 * column comment names this surface as the reason the column exists: "without
 * the snapshot, a service repriced in March silently rewrites what February's
 * completed visits were worth".
 *
 * Telling an owner Hone keeps no such record, on a screen reading that record,
 * is the same class of untrue sentence this file exists to prevent.
 */
export const SERVICE_VALUE_PRICE_BASIS =
  "Service value uses the price recorded when a visit was settled, wherever Hone has one. Every other visit uses today's price, because no record was kept of what it was priced at — so editing a service price changes this figure for those visits.";

/**
 * Shown ONLY when the two bases are actually mixed.
 *
 * A standing sentence about a distinction that does not apply is noise; an
 * unexplained figure that moves for some past visits and not others is a bug
 * report. Measured, like every other caveat on this screen.
 */
export const SOME_VISITS_PRICED_AT_THE_TIME =
  "Some of these visits are valued at the price recorded when they were settled. Repricing a service does not change what those were worth.";

/** Free consultations are a cost, and are excluded from the per-hour figure. */
export const CONSULTATIONS_ARE_UNPAID_TIME =
  "Consultations still take clinic time. They are kept out of the treatment figures and shown separately, so consultation time never reads as treatment earnings.";

/** What is still not on this screen. */
export const CAPACITY_NOT_YET =
  "How full your schedule is, and what an extra day would be worth, are not on this screen. Answering them needs your blocked-out time, which this release does not read.";
