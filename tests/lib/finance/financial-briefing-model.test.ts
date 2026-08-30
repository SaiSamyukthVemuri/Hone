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
  summarizeDeliveredMoney,
  unreadableDeliveredMoney,
  type ChargeRow,
  type DeliveryRow,
  type ServicePriceRow,
  type SettlementRow,
} from "@/lib/finance/financial-briefing-model";

const TREATMENT = "svc-treatment";
const CONSULT = "svc-consult";
const SERVICES: ServicePriceRow[] = [
  { id: TREATMENT, price_cents: 15_000 },
  { id: CONSULT, price_cents: 0 },
];

/** One appointment. Defaults describe a delivered 60-minute treatment. */
function appt(over: Partial<DeliveryRow> & { id: string }): DeliveryRow {
  return {
    service_id: TREATMENT,
    status: "completed",
    starts_at: "2026-08-27T10:00:00.000Z",
    ends_at: "2026-08-27T11:00:00.000Z",
    duration_minutes: 60,
    // 60 booked + a 20-minute buffer.
    blocked_ends_at: "2026-08-27T11:20:00.000Z",
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
    unattributedCharges: 0,
    snapshot: NOW,
    ...over,
  });
}

/** Narrow for readability; a wrong branch fails loudly rather than silently. */
function value(fact: { known: boolean } & Record<string, unknown>): number {
  if (!fact.known) throw new Error(`expected a known fact, got cause ${String(fact.cause)}`);
  return fact.value as number;
}

describe("RULING 1 — what counts as delivered", () => {
  it("counts completed AND past-confirmed, because status alone measures admin behaviour", () => {
    // The share of elapsed appointments ever marked `completed` ran 0% -> 98.4%
    // across four months in production. A `completed`-only definition would
    // read that ramp as growth that did not happen.
    const c = census({
      appointments: [
        appt({ id: "a", status: "completed" }),
        appt({ id: "b", status: "confirmed" }),
      ],
    });
    expect(value(c.deliveredPaidVisits)).toBe(2);
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
    expect(value(c.deliveredPaidVisits)).toBe(0);
  });

  it("THE TIE: an appointment ending exactly at the snapshot has NOT finished", () => {
    // Half-open, matching the period window's own `[start, end)` convention.
    const c = census({
      appointments: [appt({ id: "a", ends_at: NOW.toISOString() })],
    });
    expect(value(c.deliveredPaidVisits)).toBe(0);
  });

  it("never counts cancelled or no-show, however long past", () => {
    const c = census({
      appointments: [
        appt({ id: "a", status: "cancelled" }),
        appt({ id: "b", status: "no_show" }),
      ],
    });
    expect(value(c.deliveredPaidVisits)).toBe(0);
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
    expect(value(c.deliveredPaidVisits)).toBe(0);
  });

  it("splits free consultations out of treatment, by price and not by name", () => {
    const c = census({
      appointments: [
        appt({ id: "a" }),
        appt({ id: "b", service_id: CONSULT, duration_minutes: 45 }),
      ],
    });
    expect(value(c.deliveredPaidVisits)).toBe(1);
    expect(value(c.consultationVisits)).toBe(1);
    // A free consultation contributes no service value.
    expect(value(c.serviceValueCents)).toBe(15_000);
  });
});

describe("the three evidence classes stay apart", () => {
  it("EXTERNAL MONEY IS UNKNOWN, NOT ZERO, when nothing has been attested", () => {
    // The single most damaging sentence this surface could print is a $0.00
    // next to cash for an owner who takes cash every week. Production holds one
    // settlement row in the entire database, and none for this studio.
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

  it("card money, attested money and service value are three separate figures", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [{ appointment_id: "a", amount_cents: 15_000 }],
      settlements: [{ appointment_id: "a", method: "paid_cash", amount_cents: 9_000 }],
    });
    expect(value(c.collectedGrossCents)).toBe(15_000);
    expect(value(c.externallyAttestedCents)).toBe(9_000);
    expect(value(c.serviceValueCents)).toBe(15_000);
    // There is no field on the census that adds any two of them.
    expect(Object.keys(c)).not.toContain("totalCollectedCents");
    expect(Object.keys(c)).not.toContain("totalMoneyCents");
  });

  it("gross money is summed WHOLE, even for a visit outside the delivered set", () => {
    // Money that moved is money that moved. Charges are windowed on charged_at,
    // delivery on starts_at; they are different populations by construction and
    // the census must not quietly reconcile them.
    const c = census({
      appointments: [],
      charges: [{ appointment_id: "not-in-window", amount_cents: 15_000 }],
    });
    expect(value(c.collectedGrossCents)).toBe(15_000);
    expect(value(c.cardPaidVisits)).toBe(0);
  });

  it("a refund is netted but NOT attributed to a visit", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [{ appointment_id: "a", amount_cents: 15_000 }],
      refunds: [{ refund_amount_cents: 200 }],
    });
    expect(value(c.collectedGrossCents)).toBe(15_000);
    expect(value(c.refundedCents)).toBe(200);
    expect(value(c.collectedNetCents)).toBe(14_800);
    // The visit still counts as card-paid: the refund does not un-deliver it.
    expect(value(c.cardPaidVisits)).toBe(1);
  });

  it("a refund with NO charge in the window still nets — the windows are independent", () => {
    const c = census({ refunds: [{ refund_amount_cents: 5_000 }] });
    expect(value(c.collectedGrossCents)).toBe(0);
    expect(value(c.collectedNetCents)).toBe(-5_000);
  });
});

describe("the bridge from delivered work to money", () => {
  it("the collection rate is a VISIT COUNT ratio", () => {
    const c = census({
      appointments: ["a", "b", "c", "d"].map((id) => appt({ id })),
      // Wildly different amounts: a dollar ratio would move, a count ratio does not.
      charges: [
        { appointment_id: "a", amount_cents: 200 },
        { appointment_id: "b", amount_cents: 99_000 },
        { appointment_id: "c", amount_cents: 15_000 },
      ],
    });
    expect(value(c.collectionRateBasisPoints)).toBe(7_500);
    expect(value(c.cardPaidVisits)).toBe(3);
  });

  it("a visit with a settlement is resolved, and is NOT counted as card-paid", () => {
    const c = census({
      appointments: ["a", "b"].map((id) => appt({ id })),
      charges: [{ appointment_id: "a", amount_cents: 15_000 }],
      settlements: [{ appointment_id: "b", method: "paid_cash", amount_cents: 15_000 }],
    });
    expect(value(c.cardPaidVisits)).toBe(1);
    expect(value(c.unresolvedVisits)).toBe(0);
  });

  it("UNRESOLVED means no evidence either way — never 'owed'", () => {
    const c = census({
      appointments: ["a", "b", "c"].map((id) => appt({ id })),
      charges: [{ appointment_id: "a", amount_cents: 15_000 }],
    });
    expect(value(c.unresolvedVisits)).toBe(2);
    expect(value(c.unresolvedServiceValueCents)).toBe(30_000);
    // Nothing was attested, so "still owed" remains unknowable — the unresolved
    // value must never leak into it.
    expect(c.stillOwedCents.known).toBe(false);
  });

  it("an empty window is a real zero, not an unknown", () => {
    const c = census();
    expect(value(c.deliveredPaidVisits)).toBe(0);
    expect(value(c.collectedGrossCents)).toBe(0);
    // ...except the ratios, which have nothing to divide by.
    expect(c.collectionRateBasisPoints.known).toBe(false);
    expect(c.collectedPerTreatmentHourBookedCents.known).toBe(false);
  });

  it("a settlement naming a visit outside the window is counted, not silently dropped", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      settlements: [{ appointment_id: "elsewhere", method: "paid_cash", amount_cents: 9_000 }],
    });
    expect(c.basis.settlementsOutsideWindow).toBe(1);
    expect(c.basis.complete).toBe(false);
    expect(value(c.externallyAttestedCents)).toBe(0);
  });
});

describe("time, and RULING 2", () => {
  it("booked time is with the client; blocked time includes the buffer", () => {
    const c = census({ appointments: [appt({ id: "a" })] });
    expect(value(c.treatmentBookedMinutes)).toBe(60);
    expect(value(c.treatmentBlockedMinutes)).toBe(80);
  });

  it("the buffer is taken per appointment, so a 15 and a 20 both land", () => {
    // Production carries both. A model recomputing from studios.buffer_minutes
    // would be wrong on every row booked under the other value.
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
    // 80 treatment, 65 consultation.
    expect(value(c.consultationBlockedMinutes)).toBe(65);
    expect(
      value(c.treatmentTimeShareBasisPoints) + value(c.consultationTimeShareBasisPoints),
    ).toBe(10_000);
  });

  it("RULING 2 divides net card money by treatment hours WITH THE CLIENT", () => {
    // Free consultations are not in the divisor: pooling them makes the
    // treatment work look far less productive than it is.
    const c = census({
      appointments: [
        appt({ id: "a" }),
        appt({ id: "b", service_id: CONSULT, duration_minutes: 45 }),
      ],
      charges: [{ appointment_id: "a", amount_cents: 15_000 }],
    });
    // $150.00 over 1.00 treatment hour.
    expect(value(c.collectedPerTreatmentHourBookedCents)).toBe(15_000);
  });

  it("reproduces the production August shape", () => {
    // 35 delivered treatment visits, 30 card-paid, 85.7%.
    const appointments = Array.from({ length: 35 }, (_, i) => appt({ id: `v${i}` }));
    const charges: ChargeRow[] = Array.from({ length: 30 }, (_, i) => ({
      appointment_id: `v${i}`,
      amount_cents: 12_783,
    }));
    const c = census({ appointments, charges });
    expect(value(c.deliveredPaidVisits)).toBe(35);
    expect(value(c.cardPaidVisits)).toBe(30);
    expect(value(c.collectionRateBasisPoints)).toBe(8_571);
    expect(value(c.unresolvedVisits)).toBe(5);
  });
});

describe("nothing unreadable is silently coerced", () => {
  it("an unreadable end time is counted, not filed as past OR future", () => {
    // `NaN < now` is false, so an unguarded comparison would call it undelivered
    // — a wrong answer that looks like a decision.
    const c = census({ appointments: [appt({ id: "a", ends_at: "not a date" })] });
    expect(c.basis.undatable).toBe(1);
    expect(value(c.deliveredPaidVisits)).toBe(0);
    expect(c.basis.complete).toBe(false);
  });

  it("a visit whose service price cannot be resolved is neither treatment nor consultation", () => {
    const c = census({
      appointments: [appt({ id: "a", service_id: "svc-unknown" }), appt({ id: "b", service_id: null })],
    });
    expect(c.basis.unpriced).toBe(2);
    expect(value(c.deliveredPaidVisits)).toBe(0);
    expect(value(c.consultationVisits)).toBe(0);
    expect(value(c.serviceValueCents)).toBe(0);
  });

  it("AN UNREADABLE AMOUNT IS EXCLUDED, NEVER ADDED AS ZERO", () => {
    const c = census({
      appointments: [appt({ id: "a" })],
      charges: [
        { appointment_id: "a", amount_cents: 15_000 },
        { appointment_id: "a", amount_cents: null },
      ],
    });
    expect(value(c.collectedGrossCents)).toBe(15_000);
    expect(c.basis.unreadableAmounts).toBe(1);
    expect(c.basis.complete).toBe(false);
  });

  it("an unreadable chair time withdraws completeness without zeroing the hours", () => {
    const c = census({
      appointments: [appt({ id: "a" }), appt({ id: "b", blocked_ends_at: null })],
    });
    expect(c.basis.unmeasurable).toBe(1);
    expect(value(c.treatmentBlockedMinutes)).toBe(80);
    // The visit still counts and is still valued; only its chair time is absent.
    expect(value(c.deliveredPaidVisits)).toBe(2);
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
      expect(facts.length).toBeGreaterThanOrEqual(20);
      for (const [name, fact] of facts) {
        expect((fact as { known: boolean }).known, name).toBe(false);
        expect((fact as { cause: string }).cause, name).toBe(cause);
      }
      expect(c.basis.complete).toBe(false);
    },
  );
});
