import { describe, expect, it } from "vitest";
import { assembleClientInputs, statementCollectedCents, type AssembleAppointment, type AssembleInput } from "@/lib/finance/statement-document-assemble";
import { buildStatementDocument } from "@/lib/finance/statement-document";
import type { StatementCardRow } from "@/lib/finance/statement";

// Synthetic rows only. Amounts are chosen per test.
const NOW = "2026-11-19T18:00:00Z";
const TZ = "America/Toronto";
let n = 0;
const appt = (over: Partial<AssembleAppointment> = {}): AssembleAppointment => {
  n += 1;
  return { id: `a${n}`, clientId: "c1", startsAt: "2026-11-03T15:00:00Z", status: "completed", practitionerId: "p1", serviceId: "svc1", durationMinutes: 30, ...over };
};
const card = (appointmentId: string, over: Partial<StatementCardRow> = {}): StatementCardRow => ({
  appointmentId, chargeReason: "session_payment", status: "succeeded", amountCents: 5000, currency: "cad", refundStatus: null, refundAmountCents: null,
  providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true, ...over,
});
const base = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  studioCurrency: "cad", timezone: TZ, nowIso: NOW, appointments: [], cardRows: [], settlementRows: [], legacyFeeRows: [],
  serviceNames: new Map([["svc1", "Service A"]]), practitionerNames: new Map([["p1", "Practitioner One"]]), ...over,
});
const settle = (appointmentId: string, over = {}) => ({ appointmentId, method: "paid_cash", amountCents: 4000, currency: "cad", quotedAmountCents: 4000, ...over });

describe("eligibility on real rows (the one function, applied)", () => {
  it("completed visits, a fee-bearing no-show, a Not completed booking and a future booking land where the rules say", () => {
    const done = appt({ status: "completed" });
    const noShow = appt({ status: "no_show", startsAt: "2026-11-05T15:00:00Z" });
    const freeCancel = appt({ status: "cancelled", startsAt: "2026-11-06T15:00:00Z" });
    const open = appt({ status: "confirmed", startsAt: "2026-11-07T15:00:00Z" });
    const future = appt({ status: "confirmed", startsAt: "2026-12-07T15:00:00Z" });
    const r = assembleClientInputs(base({
      appointments: [done, noShow, freeCancel, open, future],
      cardRows: [card(done.id), card(noShow.id, { chargeReason: "no_show_fee", amountCents: 3000 })],
    }));
    expect(r.visits.map((v) => [v.appointmentId, v.eligibility])).toEqual([[done.id, "treatment"], [open.id, "not_completed"]]);
    expect(r.feeItems.map((f) => [f.appointmentId, f.reason])).toEqual([[noShow.id, "no_show_fee"]]);
    expect(r.offDocumentWithMoney).toBe(0);
  });
  it("money is never lost: a past unfinished booking with a payment stays Not completed and its payment is a separate line; a future booking with a payment stays off but is COUNTED", () => {
    const paidOpen = appt({ status: "confirmed", startsAt: "2026-11-07T15:00:00Z" });
    const paidFuture = appt({ status: "confirmed", startsAt: "2026-12-07T15:00:00Z" });
    const r = assembleClientInputs(base({ appointments: [paidOpen, paidFuture], cardRows: [card(paidOpen.id), card(paidFuture.id)] }));
    expect(r.visits.map((v) => [v.appointmentId, v.eligibility])).toEqual([[paidOpen.id, "not_completed"]]);
    expect(r.feeItems.map((f) => [f.appointmentId, f.reason])).toEqual([[paidOpen.id, "uncompleted_booking_payment"]]);
    expect(r.offDocumentWithMoney).toBe(1);
  });
  it("a cancelled booking with ANY recorded money is a line item (a session payment there is a neutral payment line)", () => {
    const c = appt({ status: "cancelled" });
    const r = assembleClientInputs(base({ appointments: [c], cardRows: [card(c.id, { amountCents: 2000 })] }));
    expect(r.feeItems.map((f) => f.reason)).toEqual(["cancelled_booking_payment"]);
  });
  it("an EXCLUDED-only row (a failed attempt) creates no fee line, no payment line and no off-document count, on cancelled, no-show, unfinished and future bookings", () => {
    const failed = (id: string) => card(id, { status: "failed" });
    const cancelled = appt({ status: "cancelled" });
    const noShow = appt({ status: "no_show", startsAt: "2026-11-05T15:00:00Z" });
    const unfinished = appt({ status: "confirmed", startsAt: "2026-11-07T15:00:00Z" });
    const future = appt({ status: "confirmed", startsAt: "2026-12-07T15:00:00Z" });
    const r = assembleClientInputs(base({ appointments: [cancelled, noShow, unfinished, future], cardRows: [cancelled, noShow, unfinished, future].map((a) => failed(a.id)) }));
    expect(r.feeItems).toEqual([]);
    expect(r.visits.map((v) => [v.appointmentId, v.eligibility])).toEqual([[unfinished.id, "not_completed"]]);
    expect(r.offDocumentWithMoney).toBe(0);
    const d = buildStatementDocument({ studioId: "s", identity: { studioName: "S", legalEntityName: null, address: null, contactEmail: null }, client: { id: "c1", name: "C" }, scope: { kind: "full_history" }, currency: "cad", preparedOn: "2026-11-19", visits: r.visits, feeItems: r.feeItems });
    expect(d.ok && d.document.balanceDue).toEqual({ kind: "established", cents: 0 });
  });
  it("a session payment on a cancelled or no-show booking is a neutral payment line, never a fee label; a real fee row keeps its fee label", () => {
    const c = appt({ status: "cancelled" });
    const ns = appt({ status: "no_show", startsAt: "2026-11-05T15:00:00Z" });
    const f = appt({ status: "cancelled", startsAt: "2026-11-06T15:00:00Z" });
    const r = assembleClientInputs(base({ appointments: [c, ns, f], cardRows: [card(c.id), card(ns.id), card(f.id, { chargeReason: "late_cancellation_fee", amountCents: 1500 })] }));
    expect(r.feeItems.map((x) => x.reason)).toEqual(["cancelled_booking_payment", "cancelled_booking_payment", "late_cancellation_fee"]);
  });
  it("low edge: a session payment PLUS a legacy fee on a cancelled booking is a fee line, and the balance is not established", () => {
    const c = appt({ status: "cancelled" });
    const r = assembleClientInputs(base({
      appointments: [c],
      cardRows: [card(c.id, { amountCents: 4000 })],
      legacyFeeRows: [{ appointmentId: c.id, status: "succeeded", amountCents: 2500, currency: "cad", stripeLivemode: true }],
    }));
    expect(r.feeItems.map((f) => f.reason)).toEqual(["late_cancellation_fee"]);
    const d = buildStatementDocument({ studioId: "s", identity: { studioName: "S", legalEntityName: null, address: null, contactEmail: null }, client: { id: "c1", name: "C" }, scope: { kind: "full_history" }, currency: "cad", preparedOn: "2026-11-19", visits: r.visits, feeItems: r.feeItems });
    expect(d.ok && d.document.balanceDue.kind).toBe("not_established");
  });
  it("a cancellation fee takes its reason from the card row, else from the status", () => {
    const c = appt({ status: "cancelled" });
    const r = assembleClientInputs(base({ appointments: [c], legacyFeeRows: [{ appointmentId: c.id, status: "succeeded", amountCents: 2500, currency: "cad", stripeLivemode: true }] }));
    expect(r.feeItems[0].reason).toBe("late_cancellation_fee");
    expect(r.feeItems[0].feeCandidates).toEqual([{ source: "legacy_fee", cents: 2500 }]);
  });
});

describe("fee candidates come only from stored records", () => {
  it("a settlement quote is a candidate; with a card part AND a cash part the card amount is NOT the fee", () => {
    const a = appt();
    const r = assembleClientInputs(base({ appointments: [a], cardRows: [card(a.id, { amountCents: 3000 })], settlementRows: [settle(a.id, { quotedAmountCents: 5000, amountCents: 2000 })] }));
    expect(r.visits[0].feeCandidates).toEqual([{ source: "settlement_quote", cents: 5000 }]);
  });
  it("a card amount is a candidate only when it is the visit's ONLY money row", () => {
    const sole = appt();
    expect(assembleClientInputs(base({ appointments: [sole], cardRows: [card(sole.id, { amountCents: 7000 })] })).visits[0].feeCandidates).toEqual([{ source: "card_attempt", cents: 7000 }]);
  });
  it("a visit with no stored amount has no candidate, so its fee reads 'not recorded' (never the menu price)", () => {
    const a = appt();
    const r = assembleClientInputs(base({ appointments: [a] }));
    expect(r.visits[0].feeCandidates).toEqual([]);
    const d = buildStatementDocument({ studioId: "s", identity: { studioName: "S", legalEntityName: null, address: null, contactEmail: null }, client: { id: "c1", name: "C" }, scope: { kind: "full_history" }, currency: "cad", preparedOn: "2026-11-19", visits: r.visits });
    expect(d.ok && d.document.visits[0].fee).toEqual({ state: "not_recorded", ambiguous: false });
  });
  it("a record in another currency is not a candidate", () => {
    const a = appt();
    expect(assembleClientInputs(base({ appointments: [a], cardRows: [card(a.id, { currency: "usd", amountCents: 9000 })] })).visits[0].feeCandidates).toEqual([]);
  });
});

describe("local date and time use the STUDIO timezone", () => {
  it("23:30 on 30 Nov local is still 30 Nov, though it is 1 Dec in UTC; DST edges follow the zone", () => {
    const late = appt({ startsAt: "2026-12-01T04:30:00Z" }); // 23:30 Toronto, 30 Nov
    const r = assembleClientInputs(base({ appointments: [late] }));
    expect(r.visits[0].localDate).toBe("2026-11-30");
    expect(r.visits[0].localTime).toBe("23:30");
    const other = assembleClientInputs(base({ timezone: "UTC", appointments: [late] }));
    expect(other.visits[0].localDate).toBe("2026-12-01");
  });
});

describe("studio reconcile: the clients' documents add up to the studio statement", () => {
  // Three clients, split payments, a fee, a refund, a waiver, other currency, a no-payment visit.
  const rows = () => {
    const a1 = appt({ clientId: "c1" }), a2 = appt({ clientId: "c1", startsAt: "2026-11-04T15:00:00Z" });
    const b1 = appt({ clientId: "c2", startsAt: "2026-11-05T15:00:00Z" }), b2 = appt({ clientId: "c2", status: "no_show", startsAt: "2026-11-06T15:00:00Z" });
    const d1 = appt({ clientId: "c3", startsAt: "2026-11-07T15:00:00Z" }), d2 = appt({ clientId: "c3", startsAt: "2026-11-08T15:00:00Z" });
    return {
      appointments: [a1, a2, b1, b2, d1, d2],
      cardRows: [
        card(a1.id, { amountCents: 3000 }),
        card(b1.id, { amountCents: 4000, status: "succeeded", refundStatus: "succeeded", providerRefundStatus: "succeeded", cumulativeFullRefundVerified: true, stripeRefundId: "re_x", refundAmountCents: 4000 }),
        card(b2.id, { chargeReason: "no_show_fee", amountCents: 2500 }),
        card(d1.id, { amountCents: 6000, currency: "usd" }),
      ],
      settlementRows: [settle(a1.id, { amountCents: 2000, quotedAmountCents: 5000 }), settle(d2.id, { method: "waived", amountCents: 1500, quotedAmountCents: 1500 })],
    };
  };
  it("sum of the clients' total spend equals the studio statement's collected total, and every row is placed exactly once", () => {
    const r = rows();
    const whole = assembleClientInputs(base(r));
    let spend = 0, waived = 0, refunded = 0;
    for (const cid of ["c1", "c2", "c3"]) {
      const mine = r.appointments.filter((a) => a.clientId === cid);
      const ids = new Set(mine.map((a) => a.id));
      const part = assembleClientInputs(base({ appointments: mine, cardRows: r.cardRows.filter((c) => ids.has(c.appointmentId)), settlementRows: r.settlementRows.filter((s) => ids.has(s.appointmentId)) }));
      const doc = buildStatementDocument({ studioId: "s", identity: { studioName: "S", legalEntityName: null, address: null, contactEmail: null }, client: { id: cid, name: cid }, scope: { kind: "full_history" }, currency: "cad", preparedOn: "2026-11-19", visits: part.visits, feeItems: part.feeItems });
      if (!doc.ok) throw new Error(doc.error);
      spend += doc.document.totals.paidCents; waived += doc.document.totals.waivedCents; refunded += doc.document.totals.refundedCents;
    }
    expect(spend).toBe(statementCollectedCents(whole.statement));
    expect(spend).toBe(3000 + 2000 + 2500);
    expect(refunded).toBe(4000);
    expect(waived).toBe(1500);
    expect(whole.statement.reconciliation.rowsIn).toBe(whole.statement.reconciliation.rowsClassified);
    expect(whole.offDocumentWithMoney).toBe(0);
  });
});

describe("Sam's rule end to end: one unfinished booking with a confirmed payment", () => {
  const ident = { studioName: "S", legalEntityName: null, address: null, contactEmail: null };
  const docFor = (r: ReturnType<typeof assembleClientInputs>) => {
    const d = buildStatementDocument({ studioId: "s", identity: ident, client: { id: "c1", name: "C" }, scope: { kind: "full_history" }, currency: "cad", preparedOn: "2026-11-19", visits: r.visits, feeItems: r.feeItems });
    if (!d.ok) throw new Error(d.error);
    return d.document;
  };
  it("0 completed visits, total spend equal to the payment, no service line; completed later: spend is still the same, no double count", () => {
    const a = appt({ status: "confirmed", startsAt: "2026-11-02T15:00:00Z" });
    const rows = { cardRows: [card(a.id, { amountCents: 6000 })] };
    const open = docFor(assembleClientInputs(base({ appointments: [a], ...rows })));
    expect(open.totals.visitCount).toBe(0);
    expect(open.totals.paidCents).toBe(6000);
    expect(open.visits).toEqual([]);
    expect(open.notCompleted).toHaveLength(1);
    expect(open.feeItems.map((f) => f.reason)).toEqual(["uncompleted_booking_payment"]);
    const done = docFor(assembleClientInputs(base({ appointments: [{ ...a, status: "completed" }], ...rows })));
    expect(done.totals.visitCount).toBe(1);
    expect(done.totals.paidCents).toBe(6000);
    expect(done.feeItems).toEqual([]);
    expect(done.notCompleted).toEqual([]);
  });
});

describe("only REAL rows are fee candidates", () => {
  it("a failed session-payment attempt followed by a successful retry is ONE card payment, so its amount is the recorded fee", () => {
    const a = appt();
    const r = assembleClientInputs(base({ appointments: [a], cardRows: [card(a.id, { status: "failed", amountCents: 9999 }), card(a.id, { amountCents: 5000 })] }));
    expect(r.visits[0].feeCandidates).toEqual([{ source: "card_attempt", cents: 5000 }]);
  });
  it("two real card payments are still not a sole payment: neither amount is the fee", () => {
    const a = appt();
    const r = assembleClientInputs(base({ appointments: [a], cardRows: [card(a.id, { amountCents: 3000 }), card(a.id, { amountCents: 2000 })] }));
    expect(r.visits[0].feeCandidates).toEqual([]);
  });
  it("a failed or test-mode attempt alone is no candidate at all", () => {
    const a = appt();
    const b = appt();
    const r = assembleClientInputs(base({ appointments: [a, b], cardRows: [card(a.id, { status: "failed" }), card(b.id, { stripeLivemode: false })] }));
    expect(r.visits.map((v) => v.feeCandidates)).toEqual([[], []]);
  });
  it("a failed or test-mode LEGACY attempt is not a candidate and does not stop a real sole card payment being the fee", () => {
    const a = appt();
    const b = appt();
    const legacy = (id: string, over = {}) => ({ appointmentId: id, status: "succeeded", amountCents: 9000, currency: "cad", stripeLivemode: true, ...over });
    const r = assembleClientInputs(base({ appointments: [a, b], cardRows: [card(a.id, { amountCents: 5000 }), card(b.id, { amountCents: 5000 })], legacyFeeRows: [legacy(a.id, { status: "failed" }), legacy(b.id, { stripeLivemode: false })] }));
    expect(r.visits.map((v) => v.feeCandidates)).toEqual([[{ source: "card_attempt", cents: 5000 }], [{ source: "card_attempt", cents: 5000 }]]);
  });
  it("a REAL legacy fee still blocks the sole-card rule and is a candidate", () => {
    const a = appt();
    const r = assembleClientInputs(base({ appointments: [a], cardRows: [card(a.id, { amountCents: 5000 })], legacyFeeRows: [{ appointmentId: a.id, status: "succeeded", amountCents: 9000, currency: "cad", stripeLivemode: true }] }));
    expect(r.visits[0].feeCandidates).toEqual([{ source: "legacy_fee", cents: 9000 }]);
  });
  it("on a cancelled booking the fee label comes only from REAL rows: a failed cancellation-fee attempt beside a successful session payment is a neutral payment, not a fee", () => {
    const c = appt({ status: "cancelled" });
    const r = assembleClientInputs(base({ appointments: [c], cardRows: [card(c.id, { amountCents: 5000 }), card(c.id, { chargeReason: "late_cancellation_fee", status: "failed", amountCents: 3000 })] }));
    expect(r.feeItems).toHaveLength(1);
    expect(r.feeItems[0].reason).toBe("cancelled_booking_payment");
  });
  it("a failed LEGACY attempt does not make a cancelled booking's payment a fee either", () => {
    const c = appt({ status: "cancelled" });
    const r = assembleClientInputs(base({ appointments: [c], cardRows: [card(c.id, { amountCents: 5000 })], legacyFeeRows: [{ appointmentId: c.id, status: "failed", amountCents: 3000, currency: "cad", stripeLivemode: true }] }));
    expect(r.feeItems[0].reason).toBe("cancelled_booking_payment");
  });
  it("a settlement quote in ANOTHER currency is not a candidate; a quote with no currency or the studio's currency is", () => {
    const a = appt();
    const b = appt();
    const c = appt();
    const r = assembleClientInputs(base({ appointments: [a, b, c], settlementRows: [settle(a.id, { currency: "usd", quotedAmountCents: 7000 }), settle(b.id, { currency: null, quotedAmountCents: 6000 }), settle(c.id, { currency: "CAD", quotedAmountCents: 5000 })] }));
    expect(r.visits.map((v) => v.feeCandidates)).toEqual([[], [{ source: "settlement_quote", cents: 6000 }], [{ source: "settlement_quote", cents: 5000 }]]);
  });
});
