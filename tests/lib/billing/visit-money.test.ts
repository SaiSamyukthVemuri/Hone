import { describe, expect, it } from "vitest";
import { MONEY_LABELS, REFUND_PENDING_LABEL, moneyRows, statementMoneySummary, visitMoneySummary } from "@/lib/billing/visit-money";
import type { LedgerCard, LedgerExternal, LedgerRefund, VisitLedger } from "@/lib/billing/visit-payments-core";

const bill = { id: "b", totalCents: 22500, currency: "cad" as const, referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "t" };
const card = (cents: number, status = "succeeded"): LedgerCard => ({ kind: "card", id: `c${cents}${status}`, amountCents: cents, status, at: "t", platformFeeCents: null });
const ext = (cents: number, state: LedgerExternal["state"], method: LedgerExternal["method"] = "paid_cash"): LedgerExternal => ({ kind: "external", id: `e${cents}${state}`, method, amountCents: cents, state, at: "t", note: null });
const refund = (cents: number, status: LedgerRefund["status"]): LedgerRefund => ({ id: `r${cents}${status}`, amountCents: cents, kind: "payment_reversal", status, attemptId: "c", externalPaymentId: null, reason: "x", at: "t", platformFeeReturnedCents: null });
const ledger = (o: Partial<VisitLedger>): VisitLedger => ({ bill, cards: [], externals: [], refunds: [], ...o });

// Sam's acceptance: the $225 visit, $100 card + $50 cash + $75 transfer, then a $40 card refund: Collected $225.00, Refunded $40.00, Net $185.00.
describe("visitMoneySummary: Collected / Refunded / Net", () => {
  const cases: Array<[string, VisitLedger, { collected: number; refunded: number; net: number; refundPending: number; waiting: number; final: boolean }]> = [
    ["gross: card + cash + confirmed transfer, no refund", ledger({ cards: [card(10000)], externals: [ext(5000, "confirmed"), ext(7500, "confirmed", "paid_e_transfer")] }), { collected: 22500, refunded: 0, net: 22500, refundPending: 0, waiting: 0, final: true }],
    ["the $225 case: a $40 partial refund on the card", ledger({ cards: [card(10000)], externals: [ext(5000, "confirmed"), ext(7500, "confirmed", "paid_e_transfer")], refunds: [refund(4000, "succeeded")] }), { collected: 22500, refunded: 4000, net: 18500, refundPending: 0, waiting: 0, final: true }],
    ["a transfer still waiting is not collected", ledger({ cards: [card(10000)], externals: [ext(5000, "confirmed"), ext(7500, "pending_confirmation", "paid_e_transfer")], refunds: [refund(4000, "succeeded")] }), { collected: 15000, refunded: 4000, net: 11000, refundPending: 0, waiting: 7500, final: true }],
    ["a pending refund is neither kept-reduced nor refunded: Net is not final", ledger({ cards: [card(10000)], externals: [ext(5000, "confirmed")], refunds: [refund(4000, "pending_stripe")] }), { collected: 15000, refunded: 0, net: 15000, refundPending: 4000, waiting: 0, final: false }],
    ["an open review (a dashboard refund) is pending too", ledger({ cards: [card(10000)], reviewOpen: true, reviews: [{ id: "rv", amountCents: 2500, settled: false }] }), { collected: 10000, refunded: 0, net: 10000, refundPending: 2500, waiting: 0, final: false }],
    ["a failed refund and a failed card count for nothing", ledger({ cards: [card(10000), card(3000, "failed")], refunds: [refund(4000, "failed")] }), { collected: 10000, refunded: 0, net: 10000, refundPending: 0, waiting: 0, final: true }],
    ["a voided transfer is nothing", ledger({ externals: [ext(7500, "voided", "paid_e_transfer")] }), { collected: 0, refunded: 0, net: 0, refundPending: 0, waiting: 0, final: true }],
  ];
  for (const [name, l, want] of cases) {
    it(name, () => {
      const m = visitMoneySummary(l);
      expect({ collected: m.collectedCents, refunded: m.refundedCents, net: m.netCents, refundPending: m.refundPendingCents, waiting: m.waitingCents, final: m.final }).toEqual(want);
    });
  }
  it("a prepared card attempt that was never charged (ready) is not collected: a $100 ready attempt reads Collected $0 (Codex P2 on #1827)", () => {
    expect(visitMoneySummary(ledger({ cards: [card(10000, "ready")] }))).toMatchObject({ collectedCents: 0, refundedCents: 0, netCents: 0 });
  });
  it("a card still with Stripe is not collected and makes Net not final", () => {
    const m = visitMoneySummary(ledger({ cards: [card(10000, "pending_stripe")] }));
    expect(m).toMatchObject({ collectedCents: 0, cardPendingCents: 10000, final: false });
  });
});

describe("moneyRows: the labels every screen shares", () => {
  it("always Collected, Refunded, Net, in that order, with Sam's exact words", () => {
    const { rows, notFinalNote } = moneyRows(visitMoneySummary(ledger({ cards: [card(10000)], externals: [ext(12500, "confirmed")], refunds: [refund(4000, "succeeded")] })));
    expect(rows.map((r) => [r.label, r.cents])).toEqual([["Collected", 22500], ["Refunded", 4000], ["Net", 18500]]);
    expect(MONEY_LABELS).toEqual({ collected: "Collected", refunded: "Refunded", net: "Net" });
    expect(notFinalNote).toBeNull();
  });
  it("a pending refund adds 'Refund pending $X' and says Net is not final", () => {
    const { rows, notFinalNote } = moneyRows(visitMoneySummary(ledger({ cards: [card(10000)], refunds: [refund(4000, "pending_stripe")] })));
    expect(rows.map((r) => [r.label, r.cents])).toEqual([["Collected", 10000], ["Refunded", 0], ["Net", 10000], [REFUND_PENDING_LABEL, 4000]]);
    expect(REFUND_PENDING_LABEL).toBe("Refund pending");
    expect(notFinalNote).toMatch(/Not counted in Refunded or Net until Stripe confirms it/);
  });
  it("an open review says so in its own words", () => {
    const { notFinalNote } = moneyRows(visitMoneySummary(ledger({ cards: [card(10000)], reviewOpen: true, reviews: [{ id: "r", amountCents: 100, settled: true }] })));
    expect(notFinalNote).toMatch(/waiting for you to confirm/);
  });
  it("a waiting transfer shows on checkout but not on the statement", () => {
    const m = visitMoneySummary(ledger({ externals: [ext(7500, "pending_confirmation", "paid_e_transfer")] }));
    expect(moneyRows(m).rows.map((r) => r.key)).toContain("waiting");
    expect(moneyRows(m, { statement: true }).rows.map((r) => r.key)).not.toContain("waiting");
  });
});

describe("statementMoneySummary: the same three figures from a statement's totals", () => {
  it("split ledger: a part-refunded payment stays inside paid, so Collected adds nothing back", () => {
    const m = statementMoneySummary({ paidCents: 22500, refundedCents: 4000 }, 4000, 0);
    expect([m.collectedCents, m.refundedCents, m.netCents, m.final]).toEqual([22500, 4000, 18500, true]);
  });
  it("legacy full card refund: taken out of paid, so Collected adds it back and Net is zero", () => {
    const m = statementMoneySummary({ paidCents: 0, refundedCents: 10000 }, 0, 0);
    expect([m.collectedCents, m.refundedCents, m.netCents]).toEqual([10000, 10000, 0]);
  });
  it("a visit awaiting confirmation makes the statement's Net not final", () => {
    expect(statementMoneySummary({ paidCents: 100, refundedCents: 0 }, 0, 1).final).toBe(false);
  });
});

describe("the statement and checkout agree on the $225 case", () => {
  it("both read Collected 225.00, Refunded 40.00, Net 185.00", () => {
    const a = visitMoneySummary(ledger({ cards: [card(10000)], externals: [ext(5000, "confirmed"), ext(7500, "confirmed", "paid_e_transfer")], refunds: [refund(4000, "succeeded")] }));
    const b = statementMoneySummary({ paidCents: 22500, refundedCents: 4000 }, 4000, 0);
    expect([a.collectedCents, a.refundedCents, a.netCents]).toEqual([b.collectedCents, b.refundedCents, b.netCents]);
  });
});

// Sam, 28 Nov 2026: in a LIVE studio the visit's Collected / Refunded / Net are REAL money only; test entries stay listed (labelled) but are in no total.
describe("visitMoneySummary in a live studio: the mixed example ($100 test charge, $40 test refund, $50 cash, $75 transfer)", () => {
  const bill = { id: "b", totalCents: 12500, currency: "cad" as const, referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "t" };
  const mixed = (studioLive?: boolean): VisitLedger => ({
    studioLive, bill,
    cards: [{ kind: "card", id: "c", amountCents: 10000, status: "succeeded", at: "t", platformFeeCents: null, test: true }],
    externals: [
      { id: "e1", method: "paid_cash", amountCents: 5000, state: "confirmed", at: "t" },
      { id: "e2", method: "paid_e_transfer", amountCents: 7500, state: "confirmed", at: "t" },
    ] as never,
    refunds: [{ id: "r", amountCents: 4000, kind: "payment_reversal", status: "succeeded", attemptId: "c", externalPaymentId: null, reason: "x", at: "t", platformFeeReturnedCents: null, test: true }],
  });
  it("live studio: Collected $125, Refunded $0, Net $125", () => {
    expect(visitMoneySummary(mixed(true))).toMatchObject({ collectedCents: 12500, refundedCents: 0, netCents: 12500 });
  });
  it("a studio that is not live yet (a trial): everything counts, as before ($225 / $40 / $185)", () => {
    for (const live of [false, undefined]) expect(visitMoneySummary(mixed(live))).toMatchObject({ collectedCents: 22500, refundedCents: 4000, netCents: 18500 });
  });
  it("a LIVE card and its refund in a live studio count in full", () => {
    const l = mixed(true);
    l.cards = [{ ...l.cards[0], test: undefined }]; l.refunds = [{ ...l.refunds[0], test: undefined }];
    expect(visitMoneySummary(l)).toMatchObject({ collectedCents: 22500, refundedCents: 4000, netCents: 18500 });
  });
  it("a pending TEST refund in a live studio is not 'refund pending' either", () => {
    const l = mixed(true); l.refunds = [{ ...l.refunds[0], status: "pending_stripe" }];
    expect(visitMoneySummary(l)).toMatchObject({ refundPendingCents: 0, final: true });
  });
});
