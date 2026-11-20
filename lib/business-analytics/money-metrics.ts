import { known, unknown, type Fact } from "@/lib/dashboard/owner-capacity-model";
import { COLLECTED_KINDS, type Statement, type StatementKind } from "@/lib/finance/statement";
import type { AssembleResult } from "@/lib/finance/statement-document-assemble";
import type { VisitState } from "@/lib/finance/statement-document";

import { bucketKeyFor, type LocalDate, type PeriodWindow } from "./period";
import { matchesPractitioner, type PractitionerFilter } from "./visit-metrics";

// ===========================================================================
// Business → Analytics: MONEY. PURE. It writes NO money rule.
// ===========================================================================
//
// Every cent here was classified ONCE, by lib/finance/statement.ts `buildStatement` (one kind per row, adjustments never netted into a collected
// line, a partial refund or an in-flight payment UNRESOLVED and not summed). This module only SPLITS the statement's collected total by the
// DOCUMENT ASSEMBLY'S OWN class of the booking it sits on (`assembleClientInputs`: its visits, its fee items by reason, its off-document money), picks a
// headline, and divides. Where the product has not decided the choice is a PARAMETER with a named default, so a decision changes one argument.
//
// The statement document's per-client total ("paidCents") already INCLUDES completed visits, fee items and payments on past bookings never
// marked complete. Only money on bookings the document leaves off (a booking still to come, a cancelled or no-show booking with no fee record,
// an unknown status) is outside it. A booking later today is one of those: its money is in Collected, on the "other bookings" line.
//
// The basis is VISIT DATE: money is grouped by the date of the appointment it belongs to, not the day it was paid. A payment-date
// basis is deliberately not offered; `MoneyBasis` has one member so a second one is a visible, reviewed addition.

export type MoneyBasis = "visit_date";
export const MONEY_BASIS: MoneyBasis = "visit_date";

/** One sentence under every money figure and chart (the same wording the Statements directory uses for its month). */
export const MONEY_BASIS_NOTE =
  "Grouped by visit date, the date of the appointment. A payment is counted with its visit, not on the day it was made.";

/** The class of a booking's money, taken from what the statement document ASSEMBLY produced (never from the appointment's status alone). */
export type MoneyClass = "completed_visit" | "fee" | "uncompleted_payment" | "other_booking";
/** appointment id → class. An appointment that carries money but is missing from the map is a refusal, never a guess. */
export type MoneyClassMap = ReadonlyMap<string, MoneyClass>;

/** The part of `assembleClientInputs` (lib/finance/statement-document-assemble.ts) this module reads. */
export type AssembledForSplit = Pick<AssembleResult, "visits" | "feeItems" | "statement">;

/**
 * Class of every appointment the assembly placed:
 *  - a document VISIT with eligibility `treatment` (or none) → `completed_visit`;
 *  - a FEE ITEM whose reason is `late_cancellation_fee`, `no_show_fee` or `cancelled_booking_payment` → `fee`;
 *  - a FEE ITEM whose reason is `uncompleted_booking_payment` → `uncompleted_payment` (its visit row is `not_completed` and carries no money on the document);
 *  - every other appointment the statement holds → `other_booking` (the document leaves it off: a booking still to come, including later today).
 */
export function classifyMoney(assembled: AssembledForSplit): MoneyClassMap {
  const out = new Map<string, MoneyClass>();
  for (const v of assembled.statement.visits) out.set(v.appointmentId, "other_booking");
  for (const v of assembled.visits) if (v.eligibility === undefined || v.eligibility === "treatment") out.set(v.appointmentId, "completed_visit");
  for (const f of assembled.feeItems) out.set(f.appointmentId, f.reason === "uncompleted_booking_payment" ? "uncompleted_payment" : "fee");
  return out;
}

export type CollectedSplit = {
  /** Money kept on completed visits (document visits). On the document. */
  completedVisitsCents: number;
  /** Money kept as a document fee item: `late_cancellation_fee`, `no_show_fee`, `cancelled_booking_payment`. On the document. */
  feesCents: number;
  /** Money kept as a document fee item with reason `uncompleted_booking_payment` (a past booking never marked complete). On the document. */
  uncompletedPaymentsCents: number;
  /** Money on bookings the document leaves off, including a booking later today. NOT on the document. */
  otherBookingsCents: number;
  /** completedVisits + fees + uncompletedPayments: what the per-client documents add up to. */
  onDocumentCents: number;
  /** The four lines. Always equals the Statements studio total, or the split is refused. */
  totalCents: number;
};

export type SplitFailure = "split_mismatch" | "unreadable_amount" | "unclassified_appointment";
export type SplitResult = { ok: true; split: CollectedSplit } | { ok: false; reason: SplitFailure };

const COLLECTED = new Set<StatementKind>(COLLECTED_KINDS);

/**
 * Split the statement's collected money four ways by the assembly's own classes. The parts are summed from the statement's visit lines and then
 * checked against `statement.all.collectedCents` (computed independently by `buildStatement`): a mismatch is REFUSED, never shown.
 */
export function splitCollected(assembled: AssembledForSplit, classes: MoneyClassMap = classifyMoney(assembled)): SplitResult {
  let visits = 0;
  let fees = 0;
  let uncompleted = 0;
  let other = 0;
  for (const v of assembled.statement.visits) {
    for (const line of v.lines) {
      if (!COLLECTED.has(line.kind)) continue;
      if (line.cents === null || !Number.isSafeInteger(line.cents)) return { ok: false, reason: "unreadable_amount" };
      const cls = classes.get(v.appointmentId);
      if (cls === undefined) return { ok: false, reason: "unclassified_appointment" };
      if (cls === "completed_visit") visits += line.cents;
      else if (cls === "fee") fees += line.cents;
      else if (cls === "uncompleted_payment") uncompleted += line.cents;
      else other += line.cents;
    }
  }
  const total = visits + fees + uncompleted + other;
  if (total !== assembled.statement.all.collectedCents) return { ok: false, reason: "split_mismatch" };
  return {
    ok: true,
    split: { completedVisitsCents: visits, feesCents: fees, uncompletedPaymentsCents: uncompleted, otherBookingsCents: other, onDocumentCents: visits + fees + uncompleted, totalCents: total },
  };
}

/**
 * Which money the headline "Collected" shows. `all_money` is the Statements studio total (it reconciles without explanation);
 * `completed_visits_only` is the reference's wording. The split is always shown beside it.
 */
export type CollectedScope = "all_money" | "completed_visits_only";
export const DEFAULT_COLLECTED_SCOPE: CollectedScope = "all_money";

export function headlineCollected(split: CollectedSplit, scope: CollectedScope = DEFAULT_COLLECTED_SCOPE): number {
  return scope === "all_money" ? split.totalCents : split.completedVisitsCents;
}

/** What the figure leaves out, said as counts (never summed into money): a screen prints these next to Collected. */
export type CollectedCaveats = {
  /** Card money fully refunded: on its own line, not in Collected. */
  refundedInFullCents: number;
  /** Rows that may or may not have moved money (a partial refund, an in-flight payment, a legacy fee): COUNT only. */
  unresolvedCount: number;
  /** Rows in another currency: COUNT only. */
  otherCurrencyCount: number;
  excludedCount: number;
  unreadableCount: number;
};

export function collectedCaveats(statement: Statement): CollectedCaveats {
  const k = statement.all.kinds;
  return {
    refundedInFullCents: k.refunded_card_session.cents + k.refunded_card_fee.cents,
    unresolvedCount: k.unresolved.count,
    otherCurrencyCount: k.other_currency.count,
    excludedCount: k.excluded.count,
    unreadableCount: k.unreadable.count,
  };
}

// ---------------------------------------------------------------------------
// Average paid per visit
// ---------------------------------------------------------------------------

/** A completed visit and what Statements says about its money. `paidCents` is money kept on it. */
export type PaidVisit = { appointmentId: string; state: VisitState; paidCents: number };

export type AveragePaid = {
  /** Whole cents, rounded half up; not available when there is nothing to divide by. */
  averageCents: Fact<number>;
  /** Money kept on the visits that are IN the average. The same set as `denominatorVisits`. */
  numeratorCents: number;
  denominatorVisits: number;
  /** Completed visits left out of BOTH sides because their payment is unknown. Always reported, so the figure is never silent about them. */
  excludedUnknownVisits: number;
  completedVisits: number;
};

/**
 * Money kept on completed visits ÷ completed visits whose payment can be established (paid, confirmed unpaid, adjusted, no charge). The two sides are
 * the SAME visit set: a visit in state `unknown` adds nothing to the numerator and is not counted in the denominator, and it is reported. A repeated
 * appointment id counts once. This is the only policy; the reference's "all completed visits" would treat an unknown payment as zero, which is
 * never acceptable, so it is not offered as an option.
 */
export function averagePaidPerVisit(visits: readonly PaidVisit[]): AveragePaid {
  const seen = new Set<string>();
  let num = 0;
  let den = 0;
  let unknownCount = 0;
  let total = 0;
  for (const v of visits) {
    if (seen.has(v.appointmentId)) continue;
    seen.add(v.appointmentId);
    total++;
    if (v.state === "unknown") {
      unknownCount++;
      continue;
    }
    num += v.paidCents;
    den++;
  }
  return {
    averageCents: den === 0 ? unknown("No completed visit has a payment that can be established.") : known(Math.floor((2 * num + den) / (2 * den))),
    numeratorCents: num,
    denominatorVisits: den,
    excludedUnknownVisits: unknownCount,
    completedVisits: total,
  };
}

// ---------------------------------------------------------------------------
// Series for the collections-and-visits chart
// ---------------------------------------------------------------------------

export type SeriesPoint = { key: string; collectedCents: number; completedVisits: number };

/**
 * One point per bucket of the window: money by VISIT date (the date of the appointment each statement line sits on) and completed visits.
 * Every bucket is present, zero where nothing happened, because a day with no visits really had none; the table repeats these numbers.
 */
export function collectionsSeries(args: {
  window: PeriodWindow;
  buckets: ReadonlyArray<{ key: string }>;
  statement: Statement;
  localDateByAppointment: ReadonlyMap<string, LocalDate>;
  classes: MoneyClassMap;
  scope?: CollectedScope;
}): { ok: true; points: SeriesPoint[] } | { ok: false; reason: "line_outside_window" | "unreadable_amount" | "unclassified_appointment" } {
  const scope = args.scope ?? DEFAULT_COLLECTED_SCOPE;
  const byKey = new Map<string, SeriesPoint>(args.buckets.map((b) => [b.key, { key: b.key, collectedCents: 0, completedVisits: 0 }]));
  for (const [id, date] of args.localDateByAppointment) {
    if (args.classes.get(id) !== "completed_visit") continue;
    const key = bucketKeyFor(date, args.window);
    if (key !== null) byKey.get(key)!.completedVisits++;
  }
  for (const v of args.statement.visits) {
    for (const line of v.lines) {
      if (!COLLECTED.has(line.kind)) continue;
      if (line.cents === null || !Number.isSafeInteger(line.cents)) return { ok: false, reason: "unreadable_amount" };
      const cls = args.classes.get(v.appointmentId);
      if (cls === undefined) return { ok: false, reason: "unclassified_appointment" };
      if (scope === "completed_visits_only" && cls !== "completed_visit") continue;
      const date = args.localDateByAppointment.get(v.appointmentId);
      const key = date === undefined ? null : bucketKeyFor(date, args.window);
      if (key === null) return { ok: false, reason: "line_outside_window" };
      byKey.get(key)!.collectedCents += line.cents;
    }
  }
  return { ok: true, points: args.buckets.map((b) => byKey.get(b.key)!) };
}

// ---------------------------------------------------------------------------
// Change against the comparison period
// ---------------------------------------------------------------------------

export type Change =
  | { kind: "percent"; percent: number }
  | { kind: "none_recorded" } // the previous figure is 0: a percentage would be infinite
  | { kind: "unavailable" }; // either figure is not known

/** Percent change. Never a percentage of zero, never of an unknown: those are stated as such. */
export function percentChange(now: number | null, previous: number | null): Change {
  if (now === null || previous === null || !Number.isFinite(now) || !Number.isFinite(previous)) return { kind: "unavailable" };
  if (previous === 0) return { kind: "none_recorded" };
  return { kind: "percent", percent: ((now - previous) / Math.abs(previous)) * 100 };
}

// ---------------------------------------------------------------------------
// Practitioner filter, reconciled against the statement's own byPractitioner
// ---------------------------------------------------------------------------

/**
 * Collected money for a practitioner filter, read from `Statement.byPractitioner` (grouped by the APPOINTMENT's practitioner, "Unattributed" for a null).
 * `all` is the studio total. A practitioner with no bucket collected nothing in the window, which is a known zero (they have no money rows),
 * not an unknown.
 */
export function collectedForFilter(statement: Statement, filter: PractitionerFilter): number {
  if (filter.kind === "all") return statement.all.collectedCents;
  const wantId = filter.kind === "unattributed" ? null : filter.practitionerId;
  const bucket = statement.byPractitioner.find((b) => matchesPractitioner({ practitionerId: b.practitionerId }, filter) && b.practitionerId === wantId);
  return bucket ? bucket.bucket.collectedCents : 0;
}

/** True when the buckets add up to the studio total (the statement's own invariant, checked rather than assumed). */
export function practitionerBucketsReconcile(statement: Statement): boolean {
  return statement.byPractitioner.reduce((n, b) => n + b.bucket.collectedCents, 0) === statement.all.collectedCents;
}
