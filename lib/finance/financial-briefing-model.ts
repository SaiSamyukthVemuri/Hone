// ===========================================================================
// FIN-01A — the derivations behind /financials, with no I/O
// ===========================================================================
//
// TWO CENSUSES, DELIBERATELY SEPARATE.
//
//   summarizeCalendar        SLICE 1. The calendar only: how many appointments
//                            a studio-local period holds and how they divide
//                            across the four statuses. Knows nothing of money.
//
//   summarizeDeliveredMoney  SLICE 2. Delivered work and the money against it,
//                            over a NARROWER window. See its own header.
//
// They are not merged and neither is derived from the other. The calendar
// census answers "what was on the books", windowed on `starts_at` across the
// whole requested period. The money census answers "what was delivered and what
// was collected", windowed on `charged_at` / `refunded_at` for money and
// floored at the date from which the studio's record-keeping supports the
// question at all. Those windows are different by construction, so a figure
// from one is not a subtotal of the other and must never be presented as one.
//
// Slice 1's anchor stays counted in VISITS. Its value now has its own section
// rather than being folded into it, because service value is a PRICE and the
// anchor is WORK, and a single figure cannot be both.

import { known, unknownBecause, type Fact, type FinancialUnknownCause } from "./financial-fact";

/**
 * The appointment status vocabulary, as migration 0010's CHECK constrains it.
 *
 * Held as a closed list so an unrecognised value is DETECTED rather than
 * silently discarded. A status this build has never heard of is not evidence of
 * anything — but dropping it would quietly shrink the partition below and make
 * a total look like it balances when it does not.
 */
export const APPOINTMENT_STATUSES = [
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
] as const;

export type AppointmentStatusName = (typeof APPOINTMENT_STATUSES)[number];

function isKnownStatus(value: string): value is AppointmentStatusName {
  return (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * One appointment, reduced to the two fields this slice reasons about.
 *
 * `starts_at` is here because STATUS ALONE CANNOT SAY WHETHER SOMETHING IS
 * STILL TO HAPPEN. `confirmed` means "on the calendar, not closed out either
 * way" — it says nothing about whether the appointment's start has passed, and
 * nothing in this system writes a terminal status when one elapses. Read as
 * "still to happen", a stale `confirmed` row reports a visit as upcoming
 * forever. Measured on production 2026-08-27: 29 of Willow's appointments were
 * past and still confirmed, the oldest from 2026-05-17.
 *
 * The wire shape is PostgREST's, so the column name is kept verbatim.
 */
export type CensusRow = { readonly status: string; readonly starts_at: string };

/**
 * THE PARTITION CLAIM.
 *
 * `closed` is an assertion the screen is allowed to print, not a sum the
 * renderer recomputes. It is true only when every appointment read fell into
 * exactly one of the four known statuses — so an unrecognised status makes the
 * claim FALSE while leaving the four counts themselves perfectly true, which is
 * the honest description of that state.
 */
export type PartitionClaim = {
  readonly closed: boolean;
  readonly unrecognisedStatuses: readonly string[];
  /**
   * Confirmed rows whose `starts_at` could not be read as an instant.
   *
   * They are counted in NEITHER temporal bucket, because neither answer is
   * established: "still to happen" and "past, still confirmed" are both claims
   * about a start time this row did not supply. Silently letting them fall to
   * one side is the specific fail-open this field exists to prevent —
   * `new Date("nonsense").getTime()` is `NaN`, and every comparison against
   * `NaN` is false, so an unguarded `>=` would have quietly called each one
   * PAST. Same treatment as an unrecognised status: the counts stay true, and
   * the completeness claim is withdrawn rather than the row being dropped.
   */
  readonly undatableConfirmed: number;
};

export type CalendarCensus = {
  /**
   * Every appointment record starting inside the period, whatever became of it.
   *
   * `rows.length`, with NO status filter anywhere on the path: the query
   * narrows by studio and the half-open window only, and this count is taken
   * independently of the classification loop below. So it includes cancelled,
   * no-show, AND rows whose status this build does not recognise — which is
   * exactly why the loop's `continue` statements cannot shrink it.
   *
   * THE FIELD IS NAMED `booked`; THE OWNER-FACING LABEL IS NOT, and the
   * difference is deliberate. Rendered as "Booked in this period" it read as
   * work the studio had on, while 18 of August's 92 were cancelled — the label
   * quietly overstated the month by a fifth. The screen now says "Appointments
   * in this period", which claims only what this count is. The field keeps its
   * name because renaming it is a refactor with no owner-facing truth in it;
   * this comment is here so the next author does not read `booked` and
   * reintroduce the word on screen.
   */
  readonly booked: Fact<number>;
  /** `confirmed` AND starting at or after the reference instant. */
  readonly stillToHappen: Fact<number>;
  /**
   * `confirmed` but already started. A FACT ABOUT THE RECORD, NOT ABOUT THE
   * VISIT: the only established truth is that a past appointment is still
   * marked confirmed. It is not evidence that the visit happened, was missed,
   * or was cancelled, and nothing here may imply otherwise.
   */
  readonly pastConfirmed: Fact<number>;
  /** `completed` — Direction B's anchor: the work that actually happened. */
  readonly completed: Fact<number>;
  readonly cancelled: Fact<number>;
  readonly noShow: Fact<number>;
  readonly partition: PartitionClaim;
};

/**
 * PURE. Counts one period's appointments by status, splitting `confirmed` on
 * time.
 *
 * THE REFERENCE INSTANT IS A PARAMETER, NOT A CLOCK READ. A pure function that
 * calls `new Date()` cannot be tested at the boundary it is most likely to get
 * wrong, and the tie rule below would be untestable by construction. The caller
 * reads the clock ONCE and passes the same instant that anchored the period
 * window, so the window and the split can never disagree with each other.
 *
 * THE TIE RULE, PINNED: `starts_at === referenceInstant` counts as STILL TO
 * HAPPEN. An appointment starting exactly now has not yet passed, and the
 * boundary matches the half-open `[start, end)` convention the period window
 * already uses — `>=` opens the interval, `<` closes it.
 *
 * An empty period returns `known(0)` for every line, and that is correct: the
 * read succeeded and the answer is genuinely nothing. This is the ONLY route by
 * which a zero reaches this screen — every other absence goes through
 * `unreadableCalendar` and arrives carrying a cause.
 */
export function summarizeCalendar(
  rows: readonly CensusRow[],
  referenceInstant: Date,
): CalendarCensus {
  const reference = referenceInstant.getTime();
  const byStatus = new Map<AppointmentStatusName, number>();
  const unrecognised = new Set<string>();
  let stillToHappen = 0;
  let pastConfirmed = 0;
  let undatableConfirmed = 0;

  for (const row of rows) {
    if (!isKnownStatus(row.status)) {
      unrecognised.add(row.status);
      continue;
    }
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    if (row.status !== "confirmed") continue;

    // Guarded explicitly rather than by comparison. `NaN >= reference` is
    // false, so a bare `>=` would silently file every unreadable start under
    // PAST — a wrong answer that looks like a decision.
    const startsAt = Date.parse(row.starts_at);
    if (Number.isNaN(startsAt)) {
      undatableConfirmed += 1;
      continue;
    }
    if (startsAt >= reference) stillToHappen += 1;
    else pastConfirmed += 1;
  }

  const count = (status: AppointmentStatusName) => known(byStatus.get(status) ?? 0);

  return {
    booked: known(rows.length),
    stillToHappen: known(stillToHappen),
    pastConfirmed: known(pastConfirmed),
    completed: count("completed"),
    cancelled: count("cancelled"),
    noShow: count("no_show"),
    partition: {
      closed: unrecognised.size === 0 && undatableConfirmed === 0,
      unrecognisedStatuses: [...unrecognised].sort(),
      undatableConfirmed,
    },
  };
}

/**
 * A census that could not be established, with every line carrying the SAME
 * cause.
 *
 * Deliberately not a partial result. A read that failed or was truncated tells
 * us nothing about any individual status, so publishing four zeroes and one
 * unknown — or the statuses that happened to arrive before the ceiling — is how
 * a confident, understated screen gets in front of an owner. The partition is
 * refused too: there is nothing to claim balance over.
 */
export function unreadableCalendar(cause: FinancialUnknownCause): CalendarCensus {
  const absent = unknownBecause<number>(cause);
  return {
    booked: absent,
    stillToHappen: absent,
    pastConfirmed: absent,
    completed: absent,
    cancelled: absent,
    noShow: absent,
    partition: { closed: false, unrecognisedStatuses: [], undatableConfirmed: 0 },
  };
}

// ===========================================================================
// FIN-01A SLICE 2 — August-onward delivered-money truth
// ===========================================================================
//
// SCOPE. Present-tense observable facts over one studio-local window. No
// forecast, no scenario, no client projection, no capacity ratio, and no
// utilisation: those need block ingestion, interval merging and an elapsed
// denominator, which are Slice 3's mechanisms and are absent here rather than
// approximated.
//
// THE THREE EVIDENCE CLASSES ARE MODELLED APART AND NEVER SUMMED.
//
//   PROVIDER-VERIFIED    payment_charge_attempts. Hone watched the card move.
//   STUDIO-ATTESTED      appointment_settlements. A practitioner wrote it down.
//   SERVICE VALUE        services.price_cents. A price, not money.
//
// There is deliberately NO field on the census that adds any two of them, and
// no caller can make one without writing the addition itself in the open. A
// single "total money" field is the whole defect this shape exists to prevent:
// card money is verified, external money is attested and mostly absent, and
// service value is not money at all.
//
// ---------------------------------------------------------------------------
// RULING 1 — WHAT "DELIVERED" MEANS
// ---------------------------------------------------------------------------
//
//   status IN ('completed','confirmed') AND ends_at < snapshot
//
// NOT `status = 'completed'`. Nothing in Hone writes a terminal status when an
// appointment elapses, so `completed` measures ADMIN BEHAVIOUR as much as
// delivery, and that behaviour changed sharply: the share of elapsed
// appointments marked completed ran 0.0% -> 20.8% -> 82.6% -> 98.4% over
// 2026-05..2026-08 in production.
//
// The inclusive definition has the opposite bias — it counts a past `confirmed`
// row as delivered when it may have been an unrecorded no-show. Measured on
// production: of the past-confirmed paid visits, 14 carried no clinical
// session, no card charge and no settlement, so nothing corroborates them.
//
// BOTH BIASES VANISH INSIDE THE REPORTED WINDOW, which is why the window floor
// below is not a nicety but the precondition for this whole module. Restricted
// to 2026-08 the three candidate definitions — `completed` only, `completed` or
// a clinical session, and the inclusive one — returned 35, 35 and 35. Not close:
// identical. Outside that window they disagree by twenty points of collection
// rate, and no choice among them would be safe.
//
// ---------------------------------------------------------------------------
// RULING 2 — WHAT "PER TREATMENT HOUR" MEANS
// ---------------------------------------------------------------------------
//
//   numerator    live-mode net collected in the window
//   denominator  duration_minutes of DELIVERED PAID-SERVICE visits in the window
//
// Fixed here because the metric is otherwise undefined rather than merely
// imprecise. Holding the numerator still and moving only the denominator across
// its four defensible choices spans roughly 4x, and every point of that span is
// arguable. Free consultations are excluded from the denominator and reported
// separately: they are 43.6% of delivered clinical time at a $0.00 price, and
// pooling them makes the treatment work look far less productive than it is.
//
// The BLOCKED-time variant is deliberately not offered. One ruling, one number.

/** The settlement vocabulary migration 0187 closes by CHECK. No card, no Hone. */
export const SETTLEMENT_METHODS = [
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
  "waived",
  "still_owes",
] as const;

export type SettlementMethodName = (typeof SETTLEMENT_METHODS)[number];

const EXTERNALLY_COLLECTED: ReadonlySet<string> = new Set([
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
]);

/** Wire shapes. PostgREST column names kept verbatim. */
export type ServicePriceRow = {
  readonly id: string;
  readonly price_cents: number | null;
};

export type DeliveryRow = {
  readonly id: string;
  readonly service_id: string | null;
  readonly status: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly duration_minutes: number | null;
  readonly blocked_ends_at: string | null;
};

export type ChargeRow = {
  readonly appointment_id: string | null;
  readonly amount_cents: number | null;
};

export type RefundRow = { readonly refund_amount_cents: number | null };

export type SettlementRow = {
  readonly appointment_id: string | null;
  readonly method: string;
  readonly amount_cents: number | null;
};

/**
 * What the census could NOT account for.
 *
 * Same discipline as PartitionClaim: the counts stay true and the completeness
 * claim is withdrawn, rather than a row being dropped to keep a total tidy.
 */
export type DeliveryBasis = {
  readonly complete: boolean;
  /** `ends_at` unreadable, so "has it elapsed" is unanswerable. */
  readonly undatable: number;
  /** No service row, or a null price: the visit cannot be classed or valued. */
  readonly unpriced: number;
  /** `blocked_ends_at` unreadable, so chair time is unmeasurable. */
  readonly unmeasurable: number;
  /** Settlement rows naming an appointment outside this window. */
  readonly settlementsOutsideWindow: number;
  /**
   * Money or duration columns that did not arrive as a finite number.
   *
   * NOT COERCED TO ZERO AND NOT ADDED. A `?? 0` here would be the exact defect
   * this whole module is shaped against: an amount nobody could read would
   * silently become an amount of nothing, and the sum would look complete. The
   * row is excluded from the sum and counted here instead, so the figures stay
   * true for what was readable while the completeness claim is withdrawn.
   *
   * Schema says these columns are NOT NULL, so this should always be 0. It is
   * measured rather than assumed, because "should always" is how a confident
   * wrong total gets shipped.
   */
  readonly unreadableAmounts: number;
};

export type DeliveredMoneyCensus = {
  // --- delivered work -----------------------------------------------------
  readonly deliveredPaidVisits: Fact<number>;
  readonly consultationVisits: Fact<number>;

  // --- SERVICE VALUE (a price, never money) -------------------------------
  readonly serviceValueCents: Fact<number>;

  // --- PROVIDER-VERIFIED card money ---------------------------------------
  readonly collectedGrossCents: Fact<number>;
  readonly refundedCents: Fact<number>;
  readonly collectedNetCents: Fact<number>;
  readonly chargeCount: Fact<number>;
  /** Succeeded rows carrying NO collection time, so they fall in NO period. */
  readonly unattributedCharges: Fact<number>;

  // --- STUDIO-ATTESTED external money -------------------------------------
  readonly externallyAttestedCents: Fact<number>;
  readonly waivedCents: Fact<number>;
  readonly stillOwedCents: Fact<number>;

  // --- the bridge between delivered work and card money -------------------
  readonly cardPaidVisits: Fact<number>;
  readonly collectionRateBasisPoints: Fact<number>;
  readonly unresolvedVisits: Fact<number>;
  readonly unresolvedServiceValueCents: Fact<number>;

  // --- time ---------------------------------------------------------------
  readonly treatmentBookedMinutes: Fact<number>;
  readonly treatmentBlockedMinutes: Fact<number>;
  readonly consultationBlockedMinutes: Fact<number>;
  readonly treatmentTimeShareBasisPoints: Fact<number>;
  readonly consultationTimeShareBasisPoints: Fact<number>;

  // --- Ruling 2 -----------------------------------------------------------
  readonly collectedPerTreatmentHourBookedCents: Fact<number>;

  readonly basis: DeliveryBasis;
};

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Finite numbers only. A null or a NaN is an absent measurement, not a zero. */
function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * PURE. The whole money census for one window.
 *
 * THE SNAPSHOT IS A PARAMETER. Every "has it elapsed" decision on this screen
 * resolves against the SAME instant the period window was anchored to, so no
 * two panels can disagree about what has happened yet. Production moved under
 * this measurement while it was being taken — delivered August visits went
 * 63 -> 64 and card-paid 34 -> 35 inside twenty-six minutes — so two reads
 * minutes apart legitimately disagree, and only a pinned instant makes one
 * report internally consistent.
 */
export function summarizeDeliveredMoney(input: {
  readonly services: readonly ServicePriceRow[];
  readonly appointments: readonly DeliveryRow[];
  readonly charges: readonly ChargeRow[];
  readonly refunds: readonly RefundRow[];
  readonly settlements: readonly SettlementRow[];
  readonly unattributedCharges: number;
  readonly snapshot: Date;
}): DeliveredMoneyCensus {
  const at = input.snapshot.getTime();
  const priceOf = new Map<string, number | null>();
  for (const s of input.services) priceOf.set(s.id, finite(s.price_cents));

  let undatable = 0;
  let unpriced = 0;
  let unmeasurable = 0;
  let unreadableAmounts = 0;

  const deliveredPaid = new Set<string>();
  let consultationVisits = 0;
  let serviceValueCents = 0;
  let treatmentBookedMinutes = 0;
  let treatmentBlockedMinutes = 0;
  let consultationBlockedMinutes = 0;
  const valueOfPaidVisit = new Map<string, number>();

  for (const row of input.appointments) {
    if (row.status !== "completed" && row.status !== "confirmed") continue;

    // Guarded explicitly. `NaN < at` is false, so a bare comparison would
    // silently file every unreadable end time as NOT delivered — an answer
    // that looks like a decision.
    const endsAt = parseInstant(row.ends_at);
    if (endsAt === null) {
      undatable += 1;
      continue;
    }
    if (endsAt >= at) continue; // has not elapsed: not delivered, not a defect

    const price = row.service_id === null ? null : priceOf.get(row.service_id) ?? null;
    if (price === null) {
      unpriced += 1;
      continue;
    }

    const startsAt = parseInstant(row.starts_at);
    const blockedEndsAt = parseInstant(row.blocked_ends_at);
    const blockedMinutes =
      startsAt === null || blockedEndsAt === null || blockedEndsAt < startsAt
        ? null
        : (blockedEndsAt - startsAt) / 60_000;
    if (blockedMinutes === null) unmeasurable += 1;

    if (price === 0) {
      consultationVisits += 1;
      if (blockedMinutes !== null) consultationBlockedMinutes += blockedMinutes;
      continue;
    }

    deliveredPaid.add(row.id);
    serviceValueCents += price;
    valueOfPaidVisit.set(row.id, price);
    const booked = finite(row.duration_minutes);
    if (booked === null) unreadableAmounts += 1;
    else treatmentBookedMinutes += booked;
    if (blockedMinutes !== null) treatmentBlockedMinutes += blockedMinutes;
  }

  // --- PROVIDER-VERIFIED ----------------------------------------------------
  // Windowed on `charged_at` by the caller and summed WHOLE: money that moved
  // is money that moved, whether or not its appointment falls in this window.
  // It is never reconciled against service value by arithmetic here.
  let collectedGrossCents = 0;
  const cardPaid = new Set<string>();
  for (const c of input.charges) {
    const amount = finite(c.amount_cents);
    if (amount === null) unreadableAmounts += 1;
    else collectedGrossCents += amount;
    if (c.appointment_id !== null && deliveredPaid.has(c.appointment_id)) {
      cardPaid.add(c.appointment_id);
    }
  }
  // Windowed on `refunded_at` INDEPENDENTLY: a refund can fall in a different
  // period from the charge it reverses, and netting it against this window's
  // gross would move money between periods.
  let refundedCents = 0;
  for (const r of input.refunds) {
    const amount = finite(r.refund_amount_cents);
    if (amount === null) unreadableAmounts += 1;
    else refundedCents += amount;
  }

  // --- STUDIO-ATTESTED ------------------------------------------------------
  let externallyAttestedCents = 0;
  let waivedCents = 0;
  let stillOwedCents = 0;
  let settlementsOutsideWindow = 0;
  const settled = new Set<string>();
  for (const s of input.settlements) {
    if (s.appointment_id === null || !deliveredPaid.has(s.appointment_id)) {
      settlementsOutsideWindow += 1;
      continue;
    }
    settled.add(s.appointment_id);
    const amount = finite(s.amount_cents);
    if (amount === null) {
      unreadableAmounts += 1;
      continue;
    }
    if (EXTERNALLY_COLLECTED.has(s.method)) externallyAttestedCents += amount;
    else if (s.method === "waived") waivedCents += amount;
    else if (s.method === "still_owes") stillOwedCents += amount;
  }

  // NOTHING ATTESTED IS NOT NOTHING COLLECTED. An absent settlement row means
  // nobody wrote it down, which is exactly the state production is in: one row
  // in the entire database, and none for this studio. Rendering 0 here would
  // tell an owner who takes cash every week that she took none — the single
  // most damaging sentence this surface could print. Operator decision 4.
  const nothingAttested = input.settlements.length === 0;
  const attested = (cents: number): Fact<number> =>
    nothingAttested ? unknownBecause<number>("not_recorded") : known(cents);

  // --- the bridge -----------------------------------------------------------
  let unresolvedVisits = 0;
  let unresolvedServiceValueCents = 0;
  // Iterated over the VALUE MAP rather than the id set, so the visit and its
  // price come from the same entry. Looking the price up by id would need a
  // fallback for a miss that cannot happen, and a `?? 0` fallback in a money
  // sum is indistinguishable from a real zero at the point it is read.
  for (const [id, value] of valueOfPaidVisit) {
    if (cardPaid.has(id) || settled.has(id)) continue;
    unresolvedVisits += 1;
    unresolvedServiceValueCents += value;
  }

  const deliveredCount = deliveredPaid.size;
  // VISIT COUNT ON BOTH SIDES. Never dollars: the numerator would be an
  // operator-authored till total and the denominator a mutable menu price, and
  // that quotient is not a rate of anything.
  const collectionRateBasisPoints =
    deliveredCount === 0
      ? unknownBecause<number>("not_recorded")
      : known(Math.round((cardPaid.size / deliveredCount) * 10_000));

  const clinicalMinutes = treatmentBlockedMinutes + consultationBlockedMinutes;
  const share = (part: number): Fact<number> =>
    clinicalMinutes === 0
      ? unknownBecause<number>("not_recorded")
      : known(Math.round((part / clinicalMinutes) * 10_000));

  const collectedNetCents = collectedGrossCents - refundedCents;
  const collectedPerTreatmentHourBookedCents =
    treatmentBookedMinutes === 0
      ? unknownBecause<number>("not_recorded")
      : known(Math.round(collectedNetCents / (treatmentBookedMinutes / 60)));

  return {
    deliveredPaidVisits: known(deliveredCount),
    consultationVisits: known(consultationVisits),

    serviceValueCents: known(serviceValueCents),

    collectedGrossCents: known(collectedGrossCents),
    refundedCents: known(refundedCents),
    collectedNetCents: known(collectedNetCents),
    chargeCount: known(input.charges.length),
    unattributedCharges: known(input.unattributedCharges),

    externallyAttestedCents: attested(externallyAttestedCents),
    waivedCents: attested(waivedCents),
    stillOwedCents: attested(stillOwedCents),

    cardPaidVisits: known(cardPaid.size),
    collectionRateBasisPoints,
    unresolvedVisits: known(unresolvedVisits),
    unresolvedServiceValueCents: known(unresolvedServiceValueCents),

    treatmentBookedMinutes: known(treatmentBookedMinutes),
    treatmentBlockedMinutes: known(treatmentBlockedMinutes),
    consultationBlockedMinutes: known(consultationBlockedMinutes),
    treatmentTimeShareBasisPoints: share(treatmentBlockedMinutes),
    consultationTimeShareBasisPoints: share(consultationBlockedMinutes),

    collectedPerTreatmentHourBookedCents,

    basis: {
      complete:
        undatable === 0 &&
        unpriced === 0 &&
        unmeasurable === 0 &&
        settlementsOutsideWindow === 0 &&
        unreadableAmounts === 0,
      undatable,
      unpriced,
      unmeasurable,
      settlementsOutsideWindow,
      unreadableAmounts,
    },
  };
}

/**
 * A money census that could not be established, EVERY line carrying the same
 * cause.
 *
 * Deliberately not partial. A failed or truncated read tells us nothing about
 * any individual figure, and publishing the lines that happened to arrive is
 * how a confident, understated money screen reaches an owner.
 */
export function unreadableDeliveredMoney(
  cause: FinancialUnknownCause,
): DeliveredMoneyCensus {
  const absent = unknownBecause<number>(cause);
  return {
    deliveredPaidVisits: absent,
    consultationVisits: absent,
    serviceValueCents: absent,
    collectedGrossCents: absent,
    refundedCents: absent,
    collectedNetCents: absent,
    chargeCount: absent,
    unattributedCharges: absent,
    externallyAttestedCents: absent,
    waivedCents: absent,
    stillOwedCents: absent,
    cardPaidVisits: absent,
    collectionRateBasisPoints: absent,
    unresolvedVisits: absent,
    unresolvedServiceValueCents: absent,
    treatmentBookedMinutes: absent,
    treatmentBlockedMinutes: absent,
    consultationBlockedMinutes: absent,
    treatmentTimeShareBasisPoints: absent,
    consultationTimeShareBasisPoints: absent,
    collectedPerTreatmentHourBookedCents: absent,
    basis: {
      complete: false,
      undatable: 0,
      unpriced: 0,
      unmeasurable: 0,
      settlementsOutsideWindow: 0,
      unreadableAmounts: 0,
    },
  };
}
