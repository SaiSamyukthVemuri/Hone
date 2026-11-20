import { describe, expect, it } from "vitest";

import { assembleClientInputs, type AssembleAppointment, type AssembleResult } from "@/lib/finance/statement-document-assemble";
import type { StatementCardRow } from "@/lib/finance/statement";
import {
  MONEY_BASIS,
  MONEY_BASIS_NOTE,
  averagePaidPerVisit,
  classifyMoney,
  collectedCaveats,
  collectedForFilter,
  collectionsSeries,
  headlineCollected,
  percentChange,
  practitionerBucketsReconcile,
  splitCollected,
  type PaidVisit,
} from "@/lib/business-analytics/money-metrics";
import { reconcileMonthSum, reconcileWithStatement, figureIfReconciled } from "@/lib/business-analytics/reconcile";
import { bucketsOf, resolvePeriod } from "@/lib/business-analytics/period";

// Business → Analytics. Synthetic appointments and money only. The money is classified by the REAL lib/finance code; this file pins how the
// Overview splits and reconciles it.

const NOW = "2026-11-19T15:00:00Z";
const appt = (id: string, status: string, startsAt: string, practitionerId: string | null, clientId = `c-${id}`): AssembleAppointment => ({
  id, clientId, startsAt, status, practitionerId, serviceId: null, durationMinutes: 60,
});
const card = (appointmentId: string, amountCents: number, over: Partial<StatementCardRow> = {}): StatementCardRow => ({
  appointmentId, chargeReason: "session_payment", status: "succeeded", amountCents, currency: "cad",
  refundStatus: null, refundAmountCents: null, providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true, ...over,
});
const cash = (appointmentId: string, amountCents: number, method = "paid_cash") => ({ appointmentId, method, amountCents, currency: "cad", quotedAmountCents: null });

// One booking of EACH class, plus refund, in-flight and other-currency money that must never be summed.
const appointments: AssembleAppointment[] = [
  appt("done", "completed", "2026-11-05T15:00:00Z", "p1"), //        completed visit: card 10000
  appt("noshow", "no_show", "2026-11-06T15:00:00Z", "p1"), //        fee item no_show_fee: card 5000
  appt("cancelled", "cancelled", "2026-11-07T15:00:00Z", "p2"), //   fee item cancelled_booking_payment: cash 3000
  appt("unfinished", "confirmed", "2026-11-08T15:00:00Z", "p2"), //  fee item uncompleted_booking_payment: cash 2000
  appt("later", "confirmed", "2026-11-25T15:00:00Z", null), //       off the document (a booking to come): e-transfer 1500
  appt("refunded", "completed", "2026-11-09T15:00:00Z", "p1"), //    full refund: not collected
  appt("inflight", "completed", "2026-11-10T15:00:00Z", "p1"), //    refund in flight: unresolved
  appt("usd", "completed", "2026-11-11T15:00:00Z", "p2"), //         other currency: never summed
];
const cardRows: StatementCardRow[] = [
  card("done", 10000),
  card("noshow", 5000, { chargeReason: "no_show_fee" }),
  card("refunded", 8000, { refundStatus: "succeeded", refundAmountCents: 8000, providerRefundStatus: "succeeded" }),
  card("inflight", 7000, { refundStatus: "pending_stripe" }),
  card("usd", 6000, { currency: "usd" }),
];
const settlementRows = [cash("cancelled", 3000), cash("unfinished", 2000), cash("later", 1500, "paid_e_transfer")];

const assemble = (over: Partial<Parameters<typeof assembleClientInputs>[0]> = {}): AssembleResult =>
  assembleClientInputs({
    studioCurrency: "cad", timezone: "America/Toronto", nowIso: NOW, appointments, cardRows, settlementRows, legacyFeeRows: [],
    serviceNames: new Map(), practitionerNames: new Map(), ...over,
  });

describe("basis", () => {
  it("is visit date, with one fixed sentence", () => {
    expect(MONEY_BASIS).toBe("visit_date");
    expect(MONEY_BASIS_NOTE).toContain("Grouped by visit date");
    expect(MONEY_BASIS_NOTE).toContain("not on the day it was made");
  });
});

describe("the four-way split (one booking of each class)", () => {
  const a = assemble();
  it("classifies each booking from the assembly's own outputs", () => {
    const c = classifyMoney(a);
    expect(c.get("done")).toBe("completed_visit");
    expect(c.get("noshow")).toBe("fee");
    expect(c.get("cancelled")).toBe("fee");
    expect(c.get("unfinished")).toBe("uncompleted_payment");
    expect(c.get("later")).toBe("other_booking");
  });
  it("the document has the fee reasons the split is keyed on", () => {
    expect(Object.fromEntries(a.feeItems.map((f) => [f.appointmentId, f.reason]))).toEqual({
      noshow: "no_show_fee", cancelled: "cancelled_booking_payment", unfinished: "uncompleted_booking_payment",
    });
  });
  it("the four lines sum to studio collected, and the identity holds", () => {
    const r = splitCollected(a);
    if (!r.ok) throw new Error(r.reason);
    expect(r.split).toEqual({
      completedVisitsCents: 10000, feesCents: 8000, uncompletedPaymentsCents: 2000, otherBookingsCents: 1500, onDocumentCents: 20000, totalCents: 21500,
    });
    expect(r.split.totalCents).toBe(a.statement.all.collectedCents);
    expect(a.offDocumentCollectedCents).toBe(r.split.otherBookingsCents);
    // Statements' identity: sum of per-client document money + off-document money = studio total.
    expect(r.split.onDocumentCents + a.offDocumentCollectedCents).toBe(a.statement.all.collectedCents);
  });
  it("a booking later today is in Collected on the 'other bookings' line, not on a visit", () => {
    const r = splitCollected(a);
    if (!r.ok) throw new Error(r.reason);
    expect(headlineCollected(r.split)).toBe(21500);
    expect(headlineCollected(r.split, "completed_visits_only")).toBe(10000);
  });
  it("refund, in-flight and other-currency money is never summed", () => {
    expect(a.statement.all.collectedCents).toBe(21500); // 8000 + 7000 + 6000 are in none of it
    const k = collectedCaveats(a.statement);
    expect(k.refundedInFullCents).toBe(8000);
    expect(k.unresolvedCount).toBe(1);
    expect(k.otherCurrencyCount).toBe(1);
  });
  it("refuses a split that does not add up, and an appointment it cannot class", () => {
    const tampered: AssembleResult = { ...a, statement: { ...a.statement, all: { ...a.statement.all, collectedCents: a.statement.all.collectedCents + 1 } } };
    expect(splitCollected(tampered)).toEqual({ ok: false, reason: "split_mismatch" });
    expect(splitCollected(a, new Map([["done", "completed_visit"]]))).toEqual({ ok: false, reason: "unclassified_appointment" });
  });
});

describe("reconciliation with Statements", () => {
  const a = assemble();
  const split = (() => {
    const r = splitCollected(a);
    if (!r.ok) throw new Error(r.reason);
    return r.split;
  })();
  const base = { statement: a.statement, overviewCollectedCents: 21500, split, clientsSpendCents: 20000, offDocumentCollectedCents: a.offDocumentCollectedCents };
  it("reconciles when clients + off-document = the studio total", () => {
    const r = reconcileWithStatement(base);
    expect(r).toEqual({ reconciled: true, studioCollectedCents: 21500 });
    expect(figureIfReconciled(r, 21500)).toEqual({ known: true, value: 21500 });
  });
  it("a wrong headline, a wrong client sum or a wrong off-document figure each fail and show no figure", () => {
    expect(reconcileWithStatement({ ...base, overviewCollectedCents: 21499 })).toMatchObject({ reconciled: false, reason: "overview_differs_from_statements", differenceCents: -1 });
    expect(reconcileWithStatement({ ...base, clientsSpendCents: 19999 })).toMatchObject({ reconciled: false, reason: "clients_and_other_differ_from_statements", differenceCents: -1 });
    expect(reconcileWithStatement({ ...base, offDocumentCollectedCents: 1400 })).toMatchObject({ reconciled: false, reason: "split_differs_from_statements" });
    expect(figureIfReconciled(reconcileWithStatement({ ...base, clientsSpendCents: 1 }), 21500).known).toBe(false);
  });
  it("money on an appointment with no client has its own named place in the identity", () => {
    expect(reconcileWithStatement({ ...base, clientsSpendCents: 18000, noClientCents: 2000 }).reconciled).toBe(true);
  });
  it("an unreadable amount is refused, not coerced", () => {
    expect(reconcileWithStatement({ ...base, overviewCollectedCents: Number.NaN })).toEqual({ reconciled: false, reason: "unreadable_amount", differenceCents: null });
  });
  it("a window of whole months equals the sum of its Statements months, to the cent", () => {
    expect(reconcileMonthSum({ windowCollectedCents: 30000, monthCollectedCents: [10000, 20000] }).reconciled).toBe(true);
    expect(reconcileMonthSum({ windowCollectedCents: 30001, monthCollectedCents: [10000, 20000] })).toMatchObject({ reconciled: false, differenceCents: 1 });
  });
});

describe("the practitioner filter reconciles against the statement's byPractitioner", () => {
  const a = assemble();
  it("each practitioner's figure is their own bucket, Unattributed is the null bucket, all is the studio total", () => {
    expect(collectedForFilter(a.statement, { kind: "all" })).toBe(21500);
    expect(collectedForFilter(a.statement, { kind: "one", practitionerId: "p1" })).toBe(15000); // done 10000 + noshow 5000
    expect(collectedForFilter(a.statement, { kind: "one", practitionerId: "p2" })).toBe(5000); // cancelled 3000 + unfinished 2000
    expect(collectedForFilter(a.statement, { kind: "unattributed" })).toBe(1500); // the booking to come has no practitioner
    expect(collectedForFilter(a.statement, { kind: "one", practitionerId: "nobody" })).toBe(0);
  });
  it("the buckets add up to the studio total", () => {
    expect(practitionerBucketsReconcile(a.statement)).toBe(true);
    const bad = { ...a.statement, byPractitioner: a.statement.byPractitioner.slice(1) };
    expect(practitionerBucketsReconcile(bad)).toBe(false);
  });
});

describe("average paid per visit: one visit set for both sides", () => {
  const pv = (id: string, state: PaidVisit["state"], paidCents: number): PaidVisit => ({ appointmentId: id, state, paidCents });
  it("an unknown-state visit is in neither the numerator nor the denominator, and is counted", () => {
    const r = averagePaidPerVisit([pv("1", "paid", 10000), pv("2", "unknown", 5000), pv("3", "confirmed_unpaid", 0), pv("4", "paid", 5000)]);
    expect(r).toMatchObject({ numeratorCents: 15000, denominatorVisits: 3, excludedUnknownVisits: 1, completedVisits: 4 });
    expect(r.averageCents).toEqual({ known: true, value: 5000 });
  });
  it("rounds half up to a whole cent, and a repeated id counts once", () => {
    expect(averagePaidPerVisit([pv("1", "paid", 1), pv("2", "paid", 2)]).averageCents).toEqual({ known: true, value: 2 }); // 1.5 -> 2
    expect(averagePaidPerVisit([pv("1", "paid", 100), pv("1", "paid", 100)]).denominatorVisits).toBe(1);
  });
  it("nothing to divide by is not available, never 0", () => {
    expect(averagePaidPerVisit([]).averageCents.known).toBe(false);
    expect(averagePaidPerVisit([pv("1", "unknown", 0)]).averageCents.known).toBe(false);
  });
});

describe("the collections-and-visits series", () => {
  const a = assemble();
  const period = (() => {
    const r = resolvePeriod({ kind: "custom", today: "2026-11-30", from: "2026-11-01", to: "2026-11-30" });
    if (!r.ok) throw new Error(r.error);
    return r.period;
  })();
  const { buckets } = bucketsOf(period.current);
  const dates = new Map(appointments.map((x) => [x.id, new Date(x.startsAt).toISOString().slice(0, 10)]));
  it("puts money and visits on the visit's date; every bucket is present; the points add up to the totals", () => {
    const r = collectionsSeries({ window: period.current, buckets, statement: a.statement, localDateByAppointment: dates, classes: classifyMoney(a) });
    if (!r.ok) throw new Error(r.reason);
    expect(r.points).toHaveLength(30);
    expect(r.points.find((p) => p.key === "2026-11-05")).toEqual({ key: "2026-11-05", collectedCents: 10000, completedVisits: 1 });
    expect(r.points.find((p) => p.key === "2026-11-25")).toEqual({ key: "2026-11-25", collectedCents: 1500, completedVisits: 0 });
    expect(r.points.reduce((n, p) => n + p.collectedCents, 0)).toBe(21500);
    expect(r.points.reduce((n, p) => n + p.completedVisits, 0)).toBe(4); // done, refunded, inflight, usd
  });
  it("the reference's completed-visits-only scope drops fees and other bookings", () => {
    const r = collectionsSeries({ window: period.current, buckets, statement: a.statement, localDateByAppointment: dates, classes: classifyMoney(a), scope: "completed_visits_only" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.points.reduce((n, p) => n + p.collectedCents, 0)).toBe(10000);
  });
  it("a payment on an appointment that was not supplied makes the series unavailable, never a short chart", () => {
    const orphan = assemble({ cardRows: [...cardRows, card("not-supplied", 4000)] });
    expect(orphan.statement.all.collectedCents).toBe(25500); // the statement counts it
    const r = collectionsSeries({ window: period.current, buckets, statement: orphan.statement, localDateByAppointment: dates, classes: classifyMoney(orphan) });
    expect(r).toEqual({ ok: false, reason: "series_differs_from_collected" });
    // the completed-visits-only scope never includes that money, so it is not refused
    const only = collectionsSeries({ window: period.current, buckets, statement: orphan.statement, localDateByAppointment: dates, classes: classifyMoney(orphan), scope: "completed_visits_only" });
    expect(only.ok).toBe(true);
  });
  it("money outside the window is refused, not dropped", () => {
    const narrow = resolvePeriod({ kind: "custom", today: "2026-11-30", from: "2026-11-01", to: "2026-11-19" });
    if (!narrow.ok) throw new Error(narrow.error);
    const r = collectionsSeries({ window: narrow.period.current, buckets: bucketsOf(narrow.period.current).buckets, statement: a.statement, localDateByAppointment: dates, classes: classifyMoney(a) });
    expect(r).toEqual({ ok: false, reason: "line_outside_window" });
  });
});

describe("change against the comparison period", () => {
  it("never a percentage of zero or of an unknown", () => {
    expect(percentChange(150, 100)).toEqual({ kind: "percent", percent: 50 });
    expect(percentChange(50, 100)).toEqual({ kind: "percent", percent: -50 });
    expect(percentChange(5, 0)).toEqual({ kind: "none_recorded" });
    expect(percentChange(null, 100)).toEqual({ kind: "unavailable" });
    expect(percentChange(100, null)).toEqual({ kind: "unavailable" });
    expect(percentChange(Number.NaN, 1)).toEqual({ kind: "unavailable" });
  });
});
