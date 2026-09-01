import { describe, expect, it } from "vitest";

import {
  summarizeCalendar,
  unreadableCalendar,
  type CensusRow,
} from "@/lib/finance/financial-briefing-model";

/**
 * A FIXED reference instant. Nothing in these tests reads the clock, so the tie
 * rule and both sides of the split are pinned rather than sampled.
 */
const NOW = new Date("2026-08-27T12:00:00.000Z");
const AN_HOUR_BEFORE = "2026-08-27T11:00:00.000Z";
const AN_HOUR_AFTER = "2026-08-27T13:00:00.000Z";
const EXACTLY_NOW = "2026-08-27T12:00:00.000Z";

/**
 * Status-only rows, every one starting in the FUTURE.
 *
 * Deliberate: it keeps every pre-existing expectation about `stillToHappen`
 * meaning what it meant before the temporal split, so those tests still assert
 * the thing they were written to assert.
 */
const rows = (...statuses: string[]): CensusRow[] =>
  statuses.map((status) => ({ status, starts_at: AN_HOUR_AFTER }));

/** One row, placed in time explicitly. */
const at = (status: string, starts_at: string): CensusRow => ({ status, starts_at });

describe("summarizeCalendar — the period's appointments, by status", () => {
  it("counts the four statuses and totals them as booked", () => {
    const c = summarizeCalendar(
      rows("completed", "completed", "cancelled", "no_show", "confirmed", "completed"),
      NOW,
    );
    expect(c.booked).toEqual({ known: true, value: 6 });
    expect(c.completed).toEqual({ known: true, value: 3 });
    expect(c.cancelled).toEqual({ known: true, value: 1 });
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.stillToHappen).toEqual({ known: true, value: 1 });
  });

  it("AN EMPTY PERIOD IS A KNOWN ZERO, because the read succeeded", () => {
    // This is the ONLY route by which a zero reaches this screen. A studio with
    // a quiet week genuinely had nothing, and saying so is not the same as
    // failing to find out.
    const c = summarizeCalendar([], NOW);
    for (const fact of [c.booked, c.completed, c.cancelled, c.noShow, c.stillToHappen, c.pastConfirmed]) {
      expect(fact).toEqual({ known: true, value: 0 });
    }
    expect(c.partition.closed).toBe(true);
  });

  it("the five parts account for every booking, and the claim says so", () => {
    const c = summarizeCalendar(rows("completed", "cancelled", "no_show", "confirmed"), NOW);
    expect(c.partition.closed).toBe(true);
    expect(c.partition.unrecognisedStatuses).toEqual([]);
    if (
      c.booked.known && c.completed.known && c.cancelled.known &&
      c.noShow.known && c.stillToHappen.known && c.pastConfirmed.known
    ) {
      expect(
        c.completed.value + c.cancelled.value + c.noShow.value +
          c.stillToHappen.value + c.pastConfirmed.value,
      ).toBe(c.booked.value);
    }
  });

  it("AN UNRECOGNISED STATUS IS DETECTED, NOT DROPPED — the counts stay true and the claim is withdrawn", () => {
    // Dropping the row would leave four correct-looking counts that no longer
    // account for what was booked, and the screen would print "balanced".
    const c = summarizeCalendar(rows("completed", "rescheduled", "confirmed"), NOW);
    expect(c.booked).toEqual({ known: true, value: 3 });
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.partition.closed).toBe(false);
    expect(c.partition.unrecognisedStatuses).toEqual(["rescheduled"]);
  });

  it("reports each unrecognised status once, sorted, however often it appears", () => {
    const c = summarizeCalendar(rows("zeta", "alpha", "zeta", "completed"), NOW);
    expect(c.partition.unrecognisedStatuses).toEqual(["alpha", "zeta"]);
  });
});

describe("STILL TO HAPPEN is a claim about TIME, not only about status", () => {
  // Why this exists: `confirmed` says "not closed out either way". Nothing
  // writes a terminal status when an appointment elapses, so read as "still to
  // happen" a stale row reports a visit as upcoming forever. Measured on
  // production 2026-08-27: 29 of Willow's appointments were past and still
  // confirmed, the oldest from 2026-05-17.

  it("A — a FUTURE confirmed appointment is still to happen", () => {
    const c = summarizeCalendar([at("confirmed", AN_HOUR_AFTER)], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("B — a PAST confirmed appointment is NOT still to happen", () => {
    const c = summarizeCalendar([at("confirmed", AN_HOUR_BEFORE)], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 1 });
    // ...and it is not reinterpreted as an outcome. The row says the record was
    // never closed out; it is not evidence the visit happened or was missed.
    expect(c.completed).toEqual({ known: true, value: 0 });
    expect(c.noShow).toEqual({ known: true, value: 0 });
    expect(c.cancelled).toEqual({ known: true, value: 0 });
    // Still counted. A past-confirmed row is never dropped from the total.
    expect(c.booked).toEqual({ known: true, value: 1 });
  });

  it("C — THE TIE: starting exactly at the reference instant is STILL TO HAPPEN", () => {
    // Pinned deliberately. `>=` opens the interval, matching the half-open
    // [start, end) convention the period window already uses, and an
    // appointment starting exactly now has not yet passed.
    const c = summarizeCalendar([at("confirmed", EXACTLY_NOW)], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("D — a past COMPLETED appointment counts as completed only", () => {
    const c = summarizeCalendar([at("completed", AN_HOUR_BEFORE)], NOW);
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
  });

  it("E — a FUTURE cancelled appointment is cancelled, never still to happen", () => {
    const c = summarizeCalendar([at("cancelled", AN_HOUR_AFTER)], NOW);
    expect(c.cancelled).toEqual({ known: true, value: 1 });
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("F — a past NO-SHOW counts as no-show only", () => {
    const c = summarizeCalendar([at("no_show", AN_HOUR_BEFORE)], NOW);
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("G — MIXED CENSUS: every row is accounted for exactly once", () => {
    const c = summarizeCalendar(
      [
        at("confirmed", AN_HOUR_AFTER),
        at("confirmed", AN_HOUR_AFTER),
        at("confirmed", EXACTLY_NOW),
        at("confirmed", AN_HOUR_BEFORE),
        at("completed", AN_HOUR_BEFORE),
        at("completed", AN_HOUR_BEFORE),
        at("cancelled", AN_HOUR_AFTER),
        at("no_show", AN_HOUR_BEFORE),
      ],
      NOW,
    );
    expect(c.stillToHappen).toEqual({ known: true, value: 3 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 1 });
    expect(c.completed).toEqual({ known: true, value: 2 });
    expect(c.cancelled).toEqual({ known: true, value: 1 });
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.booked).toEqual({ known: true, value: 8 });
    expect(c.partition.closed).toBe(true);
    expect(c.partition.undatableConfirmed).toBe(0);
    if (
      c.booked.known && c.completed.known && c.cancelled.known &&
      c.noShow.known && c.stillToHappen.known && c.pastConfirmed.known
    ) {
      expect(
        c.stillToHappen.value + c.pastConfirmed.value + c.completed.value +
          c.cancelled.value + c.noShow.value,
      ).toBe(c.booked.value);
    }
  });

  it("AN UNREADABLE START IS NOT SILENTLY 'PAST' — it withdraws the claim", () => {
    // `Date.parse("nonsense")` is NaN and `NaN >= reference` is false, so an
    // unguarded comparison would have filed every unreadable start under PAST:
    // a wrong answer wearing the shape of a decision. Neither bucket is
    // established, so neither is credited and the completeness claim goes.
    const c = summarizeCalendar([at("confirmed", "not-a-timestamp")], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
    expect(c.partition.undatableConfirmed).toBe(1);
    expect(c.partition.closed).toBe(false);
    // The row is still counted in the total, and its status is still true.
    expect(c.booked).toEqual({ known: true, value: 1 });
    expect(c.partition.unrecognisedStatuses).toEqual([]);
  });

  it("an unreadable start on a NON-confirmed row changes nothing", () => {
    // Only `confirmed` is split on time, so only `confirmed` can be undatable.
    const c = summarizeCalendar([at("completed", "not-a-timestamp")], NOW);
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.partition.undatableConfirmed).toBe(0);
    expect(c.partition.closed).toBe(true);
  });
});

describe("THE TOTAL counts every appointment record, whatever became of it", () => {
  // The arithmetic these pin is UNCHANGED by FIN-01B — that ticket repaired the
  // owner-facing LABEL, which called this figure "Booked in this period" while
  // it counted cancellations too. These controls exist so the label and the
  // count can never drift apart again: if someone later makes the total exclude
  // cancelled or no-show, the screen's new wording stops being true and this
  // fails.

  it("a CANCELLED appointment is still counted in the total", () => {
    const c = summarizeCalendar([at("cancelled", AN_HOUR_AFTER)], NOW);
    expect(c.booked).toEqual({ known: true, value: 1 });
    expect(c.cancelled).toEqual({ known: true, value: 1 });
    // ...and it is on no other line.
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
    expect(c.completed).toEqual({ known: true, value: 0 });
    expect(c.noShow).toEqual({ known: true, value: 0 });
  });

  it("a NO-SHOW appointment is still counted in the total", () => {
    const c = summarizeCalendar([at("no_show", AN_HOUR_BEFORE)], NOW);
    expect(c.booked).toEqual({ known: true, value: 1 });
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
    expect(c.completed).toEqual({ known: true, value: 0 });
    expect(c.cancelled).toEqual({ known: true, value: 0 });
  });

  it("THE PROPORTION THE LABEL WAS HIDING: cancellations can be a large share", () => {
    // Production shape, 2026-08-27: August held 92 appointments of which 18
    // were cancelled. Rendered as "Booked in this period: 92" that read as a
    // month's work; roughly a fifth of it had been called off. The total is
    // deliberately unchanged — the label is what was wrong.
    const rows: CensusRow[] = [
      ...Array.from({ length: 18 }, () => at("cancelled", AN_HOUR_BEFORE)),
      ...Array.from({ length: 54 }, () => at("completed", AN_HOUR_BEFORE)),
      ...Array.from({ length: 19 }, () => at("confirmed", AN_HOUR_AFTER)),
      at("no_show", AN_HOUR_BEFORE),
    ];
    const c = summarizeCalendar(rows, NOW);
    expect(c.booked).toEqual({ known: true, value: 92 });
    expect(c.cancelled).toEqual({ known: true, value: 18 });
    expect(c.completed).toEqual({ known: true, value: 54 });
    expect(c.stillToHappen).toEqual({ known: true, value: 19 });
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.partition.closed).toBe(true);
  });

  it("a row whose status this build does not recognise is counted in the total too", () => {
    // It reaches no category line, so the total is strictly larger than the sum
    // of the five — which is exactly when the completeness claim is withdrawn.
    const c = summarizeCalendar(
      [at("rescheduled", AN_HOUR_AFTER), at("completed", AN_HOUR_BEFORE)],
      NOW,
    );
    expect(c.booked).toEqual({ known: true, value: 2 });
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.partition.closed).toBe(false);
  });

  it("FIN-01B CHANGED NO ARITHMETIC: the temporal split from #650 is intact", () => {
    // Guards the previous repair against being undone by a copy change.
    const c = summarizeCalendar(
      [
        at("confirmed", AN_HOUR_AFTER),
        at("confirmed", EXACTLY_NOW),
        at("confirmed", AN_HOUR_BEFORE),
      ],
      NOW,
    );
    expect(c.stillToHappen).toEqual({ known: true, value: 2 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 1 });
    expect(c.booked).toEqual({ known: true, value: 3 });
  });
});

describe("unreadableCalendar — an absence never becomes a partial answer", () => {
  it("A FAILED READ IS NOT A ZERO on any line", () => {
    const c = unreadableCalendar("unavailable");
    for (const fact of [c.booked, c.completed, c.cancelled, c.noShow, c.stillToHappen, c.pastConfirmed]) {
      expect(fact.known).toBe(false);
      expect(fact).not.toHaveProperty("value");
      if (!fact.known) expect(fact.cause).toBe("unavailable");
    }
  });

  it("A TRUNCATED READ IS NOT A TOTAL, and carries its own distinct cause", () => {
    const c = unreadableCalendar("not_enumerable");
    expect(c.booked.known).toBe(false);
    if (!c.booked.known) expect(c.booked.cause).toBe("not_enumerable");
  });

  it("refuses the partition claim, because there is nothing to claim balance over", () => {
    expect(unreadableCalendar("unavailable").partition.closed).toBe(false);
    expect(unreadableCalendar("not_enumerable").partition.closed).toBe(false);
  });

  it("does not publish the statuses that happened to arrive before the failure", () => {
    // A partial census is how a confident, understated screen reaches an owner.
    expect(unreadableCalendar("unavailable").partition.unrecognisedStatuses).toEqual([]);
  });
});

// ===========================================================================
// SLICE 2 — summarizeDeliveredMoney
// ===========================================================================

import {
  classifyService,
  summarizeDeliveredMoney,
  unreadableDeliveredMoney,
  type ChargeRow,
  type DeliveryRow,
  type ServiceRow,
  type SettlementRow,
} from "@/lib/finance/financial-briefing-model";

const WINDOW_START = "2026-08-01T04:00:00.000Z";
const WINDOW_END = "2026-09-01T04:00:00.000Z";

const TREATMENT = "svc-treatment";
const CONSULT = "svc-consult";
const PAID_CONSULT = "svc-paid-consult";
const FREE_TREATMENT = "svc-free-treatment";
const NAMED_CONSULT = "svc-named-consult";

/**
 * Services chosen to separate KIND from PRICE on both axes at once, because
 * that separation is the whole point of P2-A:
 *
 *   consultation, free      the ordinary case
 *   consultation, PAID      kind survives a price
 *   treatment, FREE         a price of nothing is not a consultation
 *   consultation by NAME    the shared predicate's documented fallback
 */
const SERVICES: ServiceRow[] = [
  { id: TREATMENT, name: "60 minute session", modality: "electrolysis", price_cents: 15_000 },
  { id: CONSULT, name: "NEW CLIENT Consultation", modality: "consultation", price_cents: 0 },
  { id: PAID_CONSULT, name: "Extended assessment", modality: "consultation", price_cents: 5_000 },
  { id: FREE_TREATMENT, name: "Complimentary redo", modality: "electrolysis", price_cents: 0 },
  { id: NAMED_CONSULT, name: "Underarm Consultation Follow-up", modality: null, price_cents: 0 },
];

/** One appointment. Defaults describe a delivered 60-minute treatment. */
function appt(over: Partial<DeliveryRow> & { id: string }): DeliveryRow {
  return {
    service_id: TREATMENT,
    status: "completed",
    starts_at: "2026-08-27T10:00:00.000Z",
    ends_at: "2026-08-27T11:00:00.000Z",
    duration_minutes: 60,
    blocked_ends_at: "2026-08-27T11:20:00.000Z", // 60 booked + a 20-minute buffer
    ...over,
  };
}

/** A charge. Defaults describe a full, unrefunded payment. */
function charge(over: Partial<ChargeRow>): ChargeRow {
  return {
    appointment_id: null,
    amount_cents: 15_000,
    refund_amount_cents: null,
    refund_status: null,
    ...over,
  };
}

function census(over: Partial<Parameters<typeof summarizeDeliveredMoney>[0]> = {}) {
  return summarizeDeliveredMoney({
    services: SERVICES,
    appointments: [],
    charges: [],
    refunds: [],
    settlements: [],
    snapshot: NOW,
    windowStartUtc: WINDOW_START,
    windowEndUtc: WINDOW_END,
    ...over,
  });
}

/** Narrow for readability; a wrong branch fails loudly rather than silently. */
function value(fact: { known: boolean } & Record<string, unknown>): number {
  if (!fact.known) throw new Error(`expected a known fact, got cause ${String(fact.cause)}`);
  return fact.value as number;
}

// ---------------------------------------------------------------------------
// P2-A — consultation is a SERVICE KIND, never a price
// ---------------------------------------------------------------------------

describe("P2-A — classification comes from the shared predicate, not from price", () => {
  it("a FREE consultation is a consultation", () => {
    const c = census({ appointments: [appt({ id: "a", service_id: CONSULT })] });
    expect(value(c.consultationVisits)).toBe(1);
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
  });

  it("a PAID consultation is STILL a consultation", () => {
    // The defect this replaces: `price_cents === 0` called this treatment,
    // which put consultation money into a treatment-yield figure and inflated
    // treatment hours.
    const c = census({ appointments: [appt({ id: "a", service_id: PAID_CONSULT })] });
    expect(value(c.consultationVisits)).toBe(1);
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
    // Its value is kept, and kept APART from treatment value.
    expect(value(c.consultationServiceValueCents)).toBe(5_000);
    expect(value(c.treatmentServiceValueCents)).toBe(0);
  });

  it("a ZERO-DOLLAR NON-CONSULT service is NOT automatically a consultation", () => {
    // The mirror defect: a comp or a redo is real clinical work, and calling it
    // a consultation removed it from treatment time entirely.
    const c = census({ appointments: [appt({ id: "a", service_id: FREE_TREATMENT })] });
    expect(value(c.deliveredTreatmentVisits)).toBe(1);
    expect(value(c.consultationVisits)).toBe(0);
    expect(value(c.treatmentBookedMinutes)).toBe(60);
  });

  it("a zero-dollar treatment has NOTHING TO COLLECT, so it is outside the rate", () => {
    // It is delivered treatment; it is not a collection failure. Counting it in
    // the denominator would understate the rate for work nobody owed anything on.
    const c = census({
      appointments: [
        appt({ id: "paid" }),
        appt({ id: "free", service_id: FREE_TREATMENT }),
      ],
      charges: [charge({ appointment_id: "paid" })],
    });
    expect(value(c.deliveredTreatmentVisits)).toBe(2);
    expect(value(c.chargeableTreatmentVisits)).toBe(1);
    expect(value(c.collectionRateBasisPoints)).toBe(10_000);
    expect(value(c.unresolvedVisits)).toBe(0);
  });

  it("honours the predicate's NAME fallback when modality is unset", () => {
    const c = census({ appointments: [appt({ id: "a", service_id: NAMED_CONSULT })] });
    expect(value(c.consultationVisits)).toBe(1);
  });

  it("a visit whose service is gone is UNKNOWN — never silently treatment", () => {
    // `service_id` is nullable and a service row can be deleted. That state
    // carries neither modality nor name, which are the only two things the
    // predicate reads, so the classification genuinely cannot be made.
    const c = census({
      appointments: [appt({ id: "a", service_id: null }), appt({ id: "b", service_id: "gone" })],
    });
    expect(value(c.unclassifiedVisits)).toBe(2);
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
    expect(value(c.consultationVisits)).toBe(0);
    expect(c.basis.unclassifiable).toBe(2);
    expect(c.basis.complete).toBe(false);
  });

  it("classifyService is the SAME predicate, exposed for the loader and pinned here", () => {
    expect(classifyService(SERVICES[0])).toBe("treatment");
    expect(classifyService(SERVICES[1])).toBe("consultation");
    expect(classifyService(SERVICES[2])).toBe("consultation");
    expect(classifyService(SERVICES[3])).toBe("treatment");
    expect(classifyService(SERVICES[4])).toBe("consultation");
    expect(classifyService(null)).toBe("unknown");
    expect(classifyService(undefined)).toBe("unknown");
  });

  it("a card payment on a PRICELESS treatment reconciles the two paid-visit counts", () => {
    // The two counts on the screen legitimately differ here, and this is the
    // field that explains the gap rather than leaving it to be read as a bug:
    // the visit is in the service-period figures (money landed on it) and
    // outside the collection rate (there was nothing to collect).
    const c = census({
      appointments: [appt({ id: "paid" }), appt({ id: "free", service_id: FREE_TREATMENT })],
      charges: [charge({ appointment_id: "paid" }), charge({ appointment_id: "free", amount_cents: 2_000 })],
    });
    expect(value(c.collectedOnDeliveredVisits)).toBe(2); // money landed on both
    expect(value(c.cardPaidVisits)).toBe(1); // only one had something to collect
    expect(value(c.cardPaidWithoutAPrice)).toBe(1); // and this is the difference
    expect(value(c.collectedOnDeliveredVisits) - value(c.cardPaidVisits)).toBe(
      value(c.cardPaidWithoutAPrice),
    );
    // The rate is still over the chargeable set only, and is still 100%.
    expect(value(c.collectionRateBasisPoints)).toBe(10_000);
  });

  it("is ZERO when every card-paid treatment carried a price", () => {
    // The screen shows the reconciliation line only when it is non-zero, so a
    // false positive here would put a standing caveat on an ordinary period.
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [charge({ appointment_id: "a" })],
    });
    expect(value(c.cardPaidWithoutAPrice)).toBe(0);
    expect(value(c.collectedOnDeliveredVisits)).toBe(value(c.cardPaidVisits));
  });

  it("the reconciliation is EXACT only while nothing was unreadable", () => {
    // The boundary, recorded rather than assumed. `cardPaidWithoutAPrice`
    // explains the gap in ONE direction — money on a priceless visit. A
    // card-paid visit whose chair time could not be read drops out of the
    // service-period count in the OTHER direction, so the plain subtraction no
    // longer lands on it. That second case is disclosed by `basis`, not by the
    // reconciling sentence, and the copy deliberately does not claim to be the
    // whole difference.
    const c = census({
      appointments: [appt({ id: "a" }), appt({ id: "b", duration_minutes: null })],
      charges: [charge({ appointment_id: "a" }), charge({ appointment_id: "b" })],
    });
    expect(value(c.cardPaidVisits)).toBe(2); // both had something to collect
    expect(value(c.collectedOnDeliveredVisits)).toBe(1); // one has no divisor
    expect(value(c.cardPaidWithoutAPrice)).toBe(0); // and neither was priceless
    // So the subtraction does NOT equal the reconciling field here...
    expect(value(c.collectedOnDeliveredVisits) - value(c.cardPaidVisits)).not.toBe(
      value(c.cardPaidWithoutAPrice),
    );
    // ...and the reason is carried by the basis instead.
    expect(c.basis.unreadableAmounts).toBe(1);
    expect(c.basis.complete).toBe(false);
  });

  it("THE PAYMENTS COUNT DESCRIBES THE SAME SET THE GROSS SUMS", () => {
    // Counting the returned ROWS would print "2 payments" beside a total that
    // summed one of them.
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [charge({ appointment_id: "a" }), charge({ appointment_id: "a", amount_cents: null })],
    });
    expect(value(c.movedInGrossCents)).toBe(15_000);
    expect(value(c.chargeCount)).toBe(1);
    expect(c.basis.unreadableAmounts).toBe(1);
    expect(c.basis.complete).toBe(false);
  });

  it("a delivered TREATMENT with no price is counted but not valued", () => {
    const c = census({
      services: [...SERVICES, { id: "svc-null", name: "Session", modality: "electrolysis", price_cents: null }],
      appointments: [appt({ id: "a", service_id: "svc-null" })],
    });
    expect(value(c.deliveredTreatmentVisits)).toBe(1);
    expect(value(c.treatmentServiceValueCents)).toBe(0);
    expect(value(c.chargeableTreatmentVisits)).toBe(0);
    expect(c.basis.unvalued).toBe(1);
    expect(c.basis.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2-B / P2-C — two money contracts, named apart
// ---------------------------------------------------------------------------

describe("P2-B — the per-hour rate has ONE population on both sides", () => {
  it("numerator and denominator cover exactly the same visits", () => {
    const c = census({
      appointments: [appt({ id: "paid" }), appt({ id: "unpaid" })],
      charges: [charge({ appointment_id: "paid" })],
    });
    // Only the PAID visit is in either half. The unpaid visit's hour must not
    // enlarge the denominator while contributing nothing to the numerator.
    expect(value(c.collectedOnDeliveredVisits)).toBe(1);
    expect(value(c.collectedOnDeliveredMinutes)).toBe(60);
    expect(value(c.collectedOnDeliveredCents)).toBe(15_000);
    expect(value(c.perTreatmentHourCents)).toBe(15_000);
    // ...while delivered treatment time still counts BOTH visits.
    expect(value(c.treatmentBookedMinutes)).toBe(120);
  });

  it("a charge for a visit OUTSIDE the delivered set never reaches the rate", () => {
    // It is real cash movement, so it belongs in contract 1 and nowhere else.
    const c = census({
      appointments: [appt({ id: "here" })],
      charges: [charge({ appointment_id: "elsewhere", amount_cents: 99_000 })],
    });
    expect(value(c.movedInGrossCents)).toBe(99_000);
    expect(value(c.collectedOnDeliveredCents)).toBe(0);
    expect(c.perTreatmentHourCents.known).toBe(false);
  });

  it("A CONSULTATION PAYMENT NEVER INFLATES THE TREATMENT RATE", () => {
    // The concrete harm P2-A and P2-B combine to prevent: consultation money
    // over treatment hours.
    const c = census({
      appointments: [
        appt({ id: "t" }),
        appt({ id: "pc", service_id: PAID_CONSULT, duration_minutes: 45 }),
      ],
      charges: [
        charge({ appointment_id: "t" }),
        charge({ appointment_id: "pc", amount_cents: 5_000 }),
      ],
    });
    expect(value(c.movedInGrossCents)).toBe(20_000); // both moved
    expect(value(c.collectedOnDeliveredCents)).toBe(15_000); // treatment only
    expect(value(c.collectedOnDeliveredMinutes)).toBe(60);
    expect(value(c.perTreatmentHourCents)).toBe(15_000);
  });

  it("a paid visit whose booked time is unreadable joins NEITHER half", () => {
    // Its money over no time would inflate the rate without bound.
    const c = census({
      appointments: [appt({ id: "a", duration_minutes: null })],
      charges: [charge({ appointment_id: "a" })],
    });
    expect(value(c.collectedOnDeliveredVisits)).toBe(0);
    expect(c.perTreatmentHourCents.known).toBe(false);
    expect(c.basis.unreadableAmounts).toBe(1);
  });

  it("the rate is UNKNOWN, never zero, when nothing was both delivered and paid", () => {
    const c = census({ appointments: [appt({ id: "a" })] });
    expect(c.perTreatmentHourCents.known).toBe(false);
  });
});

describe("P2-C — cash movement and service-period collection are DIFFERENT metrics", () => {
  it("a refund is netted against ITS OWN charge in the service-period figure", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [
        charge({ appointment_id: "a", refund_amount_cents: 5_000, refund_status: "succeeded" }),
      ],
    });
    // Service period: the visit collected $100 net, over one hour.
    expect(value(c.collectedOnDeliveredCents)).toBe(10_000);
    expect(value(c.perTreatmentHourCents)).toBe(10_000);
  });

  it("an UNSUCCESSFUL refund does not reduce the service-period figure", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [
        charge({ appointment_id: "a", refund_amount_cents: 5_000, refund_status: "pending" }),
      ],
    });
    expect(value(c.collectedOnDeliveredCents)).toBe(15_000);
  });

  it("a refund reversing an EARLIER period is counted, not silently netted away", () => {
    // The economically false statement this prevents: "you collected less this
    // month" when what happened is a refund of last month's payment.
    const c = census({
      refunds: [
        { refund_amount_cents: 9_000, charged_at: "2026-06-15T12:00:00.000Z" },
        { refund_amount_cents: 1_000, charged_at: "2026-08-14T12:00:00.000Z" },
      ],
    });
    expect(value(c.movedOutRefundedCents)).toBe(10_000);
    expect(value(c.refundsReversingOtherPeriods)).toBe(1);
  });

  it("a refund with NO readable charge time counts as cross-period", () => {
    // Fails toward disclosure: an unplaceable reversal is exactly the case the
    // owner most needs told about.
    const c = census({ refunds: [{ refund_amount_cents: 500, charged_at: null }] });
    expect(value(c.refundsReversingOtherPeriods)).toBe(1);
  });

  it("cash movement and service-period collection are separate fields, never merged", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [charge({ appointment_id: "a" })],
      refunds: [{ refund_amount_cents: 4_000, charged_at: "2026-05-01T12:00:00.000Z" }],
    });
    // Movement is dragged down by an old period's reversal...
    expect(value(c.netMovementCents)).toBe(11_000);
    // ...while what this window's delivered work collected is untouched by it.
    expect(value(c.collectedOnDeliveredCents)).toBe(15_000);
    expect(value(c.perTreatmentHourCents)).toBe(15_000);
  });

  it("there is NO field that adds the two contracts together", () => {
    const c = census();
    for (const forbidden of ["totalCollectedCents", "totalMoneyCents", "collectedNetCents"]) {
      expect(Object.keys(c)).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// carried forward from the first round — still true after the repair
// ---------------------------------------------------------------------------

describe("RULING 1 — what counts as delivered", () => {
  it("counts completed AND past-confirmed, because status alone measures admin behaviour", () => {
    const c = census({
      appointments: [
        appt({ id: "a", status: "completed" }),
        appt({ id: "b", status: "confirmed" }),
      ],
    });
    expect(value(c.deliveredTreatmentVisits)).toBe(2);
  });

  it("EXCLUDES an appointment that has not finished, in either status", () => {
    const future = {
      starts_at: "2026-08-27T13:00:00.000Z",
      ends_at: "2026-08-27T14:00:00.000Z",
      blocked_ends_at: "2026-08-27T14:20:00.000Z",
    };
    const c = census({
      appointments: [
        appt({ id: "a", status: "confirmed", ...future }),
        appt({ id: "b", status: "completed", ...future }),
      ],
    });
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
  });

  it("THE TIE: an appointment ending exactly at the snapshot has NOT finished", () => {
    const c = census({ appointments: [appt({ id: "a", ends_at: NOW.toISOString() })] });
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
  });

  it("never counts cancelled or no-show, however long past", () => {
    const c = census({
      appointments: [
        appt({ id: "a", status: "cancelled" }),
        appt({ id: "b", status: "no_show" }),
      ],
    });
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
  });

  it("is DEFINED ON ends_at, not starts_at — a visit that began has not finished", () => {
    const c = census({
      appointments: [
        appt({
          id: "a",
          starts_at: "2026-08-27T11:30:00.000Z",
          ends_at: "2026-08-27T12:30:00.000Z",
          blocked_ends_at: "2026-08-27T12:50:00.000Z",
        }),
      ],
    });
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
  });
});

describe("the three evidence classes stay apart", () => {
  it("EXTERNAL MONEY IS UNKNOWN, NOT ZERO, when nothing has been attested", () => {
    const c = census({ appointments: [appt({ id: "a" })], settlements: [] });
    expect(c.externallyAttestedCents.known).toBe(false);
    expect(c.waivedCents.known).toBe(false);
    expect(c.stillOwedCents.known).toBe(false);
    if (!c.externallyAttestedCents.known) {
      expect(c.externallyAttestedCents.cause).toBe("not_recorded");
    }
  });

  it("attested money becomes KNOWN the moment a practitioner records one", () => {
    const settlements: SettlementRow[] = [
      { appointment_id: "a", method: "paid_cash", amount_cents: 9_000 },
      { appointment_id: "b", method: "paid_e_transfer", amount_cents: 6_000 },
      { appointment_id: "c", method: "waived", amount_cents: 15_000 },
      { appointment_id: "d", method: "still_owes", amount_cents: 12_000 },
    ];
    const c = census({
      appointments: ["a", "b", "c", "d"].map((id) => appt({ id })),
      settlements,
    });
    expect(value(c.externallyAttestedCents)).toBe(15_000);
    expect(value(c.waivedCents)).toBe(15_000);
    expect(value(c.stillOwedCents)).toBe(12_000);
  });

  it("a settlement naming a visit outside the window is counted, not silently dropped", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      settlements: [{ appointment_id: "elsewhere", method: "paid_cash", amount_cents: 9_000 }],
    });
    expect(c.basis.settlementsOutsideWindow).toBe(1);
    expect(c.basis.complete).toBe(false);
    // AND IT DOES NOT MAKE THIS WINDOW A CONFIDENT ZERO. The earlier build
    // gated on the studio's ALL-TIME row count, so this row — which says
    // nothing whatever about this window — turned the three figures into
    // `known(0)`. That printed "Cash, e-transfer or other: $0.00" at an owner
    // who had simply not settled anything here yet.
    expect(c.externallyAttestedCents.known).toBe(false);
    if (!c.externallyAttestedCents.known) {
      expect(c.externallyAttestedCents.cause).toBe("not_recorded");
    }
  });

  it("a settlement on a delivered CONSULTATION is attested money, not a dropped row", () => {
    // Narrowing settlements to the TREATMENT set dropped this $50 from the
    // external total and then reported the loss as a row naming a visit
    // outside the window — false, on a screen already showing the
    // consultation inside it.
    const c = census({
      appointments: [appt({ id: "c1", service_id: PAID_CONSULT })],
      settlements: [{ appointment_id: "c1", method: "paid_cash", amount_cents: 5_000 }],
    });
    expect(value(c.consultationVisits)).toBe(1);
    expect(value(c.externallyAttestedCents)).toBe(5_000);
    expect(c.basis.settlementsOutsideWindow).toBe(0);
    expect(c.basis.complete).toBe(true);
  });

  it("a settlement on an UNCLASSIFIABLE delivered visit is still attested money", () => {
    // A missing service row says nothing about whether somebody was paid.
    const c = census({
      appointments: [appt({ id: "x", service_id: null })],
      settlements: [{ appointment_id: "x", method: "paid_e_transfer", amount_cents: 4_000 }],
    });
    expect(value(c.unclassifiedVisits)).toBe(1);
    expect(value(c.externallyAttestedCents)).toBe(4_000);
    expect(c.basis.settlementsOutsideWindow).toBe(0);
  });

  it("a settlement whose AMOUNT is unreadable does not open the gate either", () => {
    // It is evidence that something was attested, never evidence of an amount.
    const c = census({
      appointments: [appt({ id: "a" })],
      settlements: [{ appointment_id: "a", method: "paid_cash", amount_cents: null }],
    });
    expect(c.externallyAttestedCents.known).toBe(false);
    expect(c.basis.unreadableAmounts).toBe(1);
    expect(c.basis.complete).toBe(false);
  });
});

describe("a card payment that was REFUNDED IN FULL is not a collection", () => {
  // lib/billing/payment-refund.ts writes full reversals only — "v1 sets
  // refund_amount_cents = amount_cents always" — so this is the shape of every
  // refund Hone can currently issue, not an exotic one.
  const fullyRefunded = () =>
    census({
      appointments: [appt({ id: "a" })],
      charges: [
        charge({
          appointment_id: "a",
          amount_cents: 15_000,
          refund_amount_cents: 15_000,
          refund_status: "succeeded",
        }),
      ],
    });

  it("leaves the collection rate, instead of reporting 100% beside $0.00", () => {
    const c = fullyRefunded();
    expect(value(c.collectedOnDeliveredCents)).toBe(0);
    expect(value(c.cardPaidVisits)).toBe(0);
    expect(value(c.collectionRateBasisPoints)).toBe(0);
  });

  it("is NOT 'no payment recorded' — the payment was recorded, then sent back", () => {
    const c = fullyRefunded();
    expect(value(c.unresolvedVisits)).toBe(0);
    expect(value(c.unresolvedServiceValueCents)).toBe(0);
    expect(value(c.refundedToZeroVisits)).toBe(1);
  });

  it("is invisible to Contract 1 when the refund lands in a LATER period", () => {
    // The refunds read is windowed on refunded_at, so a September reversal of
    // an August charge returns nothing for August. Movement is right; only the
    // service-period reading of the visit can carry the reversal, and it does.
    const c = fullyRefunded();
    expect(value(c.movedInGrossCents)).toBe(15_000);
    expect(value(c.movedOutRefundedCents)).toBe(0);
    expect(value(c.netMovementCents)).toBe(15_000);
    expect(value(c.refundedToZeroVisits)).toBe(1);
  });

  it("a PARTIAL refund still leaves the visit collected", () => {
    // The direction matters: money that stayed is a collection.
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [
        charge({ appointment_id: "a", refund_amount_cents: 5_000, refund_status: "succeeded" }),
      ],
    });
    expect(value(c.cardPaidVisits)).toBe(1);
    expect(value(c.collectionRateBasisPoints)).toBe(10_000);
    expect(value(c.refundedToZeroVisits)).toBe(0);
    expect(value(c.collectedOnDeliveredCents)).toBe(10_000);
  });

  it("a visit whose net is UNKNOWABLE joins neither the rate nor the unresolved", () => {
    // A succeeded refund with an unreadable amount. Counting it either way
    // would assert something no row establishes.
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [
        charge({ appointment_id: "a", refund_amount_cents: null, refund_status: "succeeded" }),
      ],
    });
    expect(value(c.cardPaidVisits)).toBe(0);
    expect(value(c.refundedToZeroVisits)).toBe(0);
    expect(value(c.unresolvedVisits)).toBe(0);
    expect(c.basis.unreadableAmounts).toBe(1);
    expect(c.basis.complete).toBe(false);
  });
});

describe("the bridge from delivered work to money", () => {
  it("the collection rate is a VISIT COUNT ratio", () => {
    const c = census({
      appointments: ["a", "b", "c", "d"].map((id) => appt({ id })),
      // Wildly different amounts: a dollar ratio would move, a count ratio does not.
      charges: [
        charge({ appointment_id: "a", amount_cents: 200 }),
        charge({ appointment_id: "b", amount_cents: 99_000 }),
        charge({ appointment_id: "c", amount_cents: 15_000 }),
      ],
    });
    expect(value(c.collectionRateBasisPoints)).toBe(7_500);
    expect(value(c.cardPaidVisits)).toBe(3);
  });

  it("a visit with a settlement is resolved, and is NOT counted as card-paid", () => {
    const c = census({
      appointments: ["a", "b"].map((id) => appt({ id })),
      charges: [charge({ appointment_id: "a" })],
      settlements: [{ appointment_id: "b", method: "paid_cash", amount_cents: 15_000 }],
    });
    expect(value(c.cardPaidVisits)).toBe(1);
    expect(value(c.unresolvedVisits)).toBe(0);
  });

  it("UNRESOLVED means no evidence either way — never 'owed'", () => {
    const c = census({
      appointments: ["a", "b", "c"].map((id) => appt({ id })),
      charges: [charge({ appointment_id: "a" })],
    });
    expect(value(c.unresolvedVisits)).toBe(2);
    expect(value(c.unresolvedServiceValueCents)).toBe(30_000);
    expect(c.stillOwedCents.known).toBe(false);
  });

  it("an empty window is a real zero, not an unknown", () => {
    const c = census();
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
    expect(value(c.movedInGrossCents)).toBe(0);
    // ...except the ratios, which have nothing to divide by.
    expect(c.collectionRateBasisPoints.known).toBe(false);
    expect(c.perTreatmentHourCents.known).toBe(false);
  });
});

describe("time", () => {
  it("booked time is with the client; blocked time includes the buffer", () => {
    const c = census({ appointments: [appt({ id: "a" })] });
    expect(value(c.treatmentBookedMinutes)).toBe(60);
    expect(value(c.treatmentBlockedMinutes)).toBe(80);
  });

  it("the buffer is taken per appointment, so a 15 and a 20 both land", () => {
    const c = census({
      appointments: [
        appt({ id: "a", blocked_ends_at: "2026-08-27T11:20:00.000Z" }),
        appt({ id: "b", blocked_ends_at: "2026-08-27T11:15:00.000Z" }),
      ],
    });
    expect(value(c.treatmentBlockedMinutes)).toBe(155);
  });

  it("time share is computed on BLOCKED time and covers both kinds", () => {
    const c = census({
      appointments: [
        appt({ id: "a" }),
        appt({
          id: "b",
          service_id: CONSULT,
          duration_minutes: 45,
          ends_at: "2026-08-27T10:45:00.000Z",
          blocked_ends_at: "2026-08-27T11:05:00.000Z",
        }),
      ],
    });
    expect(value(c.consultationBlockedMinutes)).toBe(65);
    expect(
      value(c.treatmentTimeShareBasisPoints) + value(c.consultationTimeShareBasisPoints),
    ).toBe(10_000);
  });

  it("reproduces the production August shape", () => {
    // 35 delivered treatment visits, 30 card-paid, 85.7%.
    const appointments = Array.from({ length: 35 }, (_, i) => appt({ id: `v${i}` }));
    const charges = Array.from({ length: 30 }, (_, i) =>
      charge({ appointment_id: `v${i}`, amount_cents: 12_783 }),
    );
    const c = census({ appointments, charges });
    expect(value(c.deliveredTreatmentVisits)).toBe(35);
    expect(value(c.cardPaidVisits)).toBe(30);
    expect(value(c.collectionRateBasisPoints)).toBe(8_571);
    expect(value(c.unresolvedVisits)).toBe(5);
  });
});

describe("nothing unreadable is silently coerced", () => {
  it("an unreadable end time is counted, not filed as past OR future", () => {
    const c = census({ appointments: [appt({ id: "a", ends_at: "not a date" })] });
    expect(c.basis.undatable).toBe(1);
    expect(value(c.deliveredTreatmentVisits)).toBe(0);
    expect(c.basis.complete).toBe(false);
  });

  it("AN UNREADABLE AMOUNT IS EXCLUDED, NEVER ADDED AS ZERO", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [charge({ appointment_id: "a" }), charge({ appointment_id: "a", amount_cents: null })],
    });
    expect(value(c.movedInGrossCents)).toBe(15_000);
    expect(c.basis.unreadableAmounts).toBe(1);
    expect(c.basis.complete).toBe(false);
  });

  it("an unreadable chair time withdraws completeness without zeroing the hours", () => {
    const c = census({
      appointments: [appt({ id: "a" }), appt({ id: "b", blocked_ends_at: null })],
    });
    expect(c.basis.unmeasurable).toBe(1);
    expect(value(c.treatmentBlockedMinutes)).toBe(80);
    expect(value(c.deliveredTreatmentVisits)).toBe(2);
  });

  it("a clean window claims completeness", () => {
    const c = census({ appointments: [appt({ id: "a" })] });
    expect(c.basis.complete).toBe(true);
  });
});

describe("a failed read withdraws EVERY figure, with one cause", () => {
  it.each(["unavailable", "not_enumerable", "records_incomplete"] as const)(
    "%s leaves no figure known and no zero behind",
    (cause) => {
      const c = unreadableDeliveredMoney(cause);
      const facts = Object.entries(c).filter(([k]) => k !== "basis");
      expect(facts.length).toBeGreaterThanOrEqual(25);
      for (const [name, fact] of facts) {
        expect((fact as { known: boolean }).known, name).toBe(false);
        expect((fact as { cause: string }).cause, name).toBe(cause);
      }
      expect(c.basis.complete).toBe(false);
    },
  );
});
