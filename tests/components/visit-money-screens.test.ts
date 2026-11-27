import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VisitMoneyBlock } from "@/components/visit-money-block";
import { SplitVisitPayments } from "@/components/split-visit-payments";
import { visitBalance, type VisitLedger } from "@/lib/billing/visit-payments-core";
import { visitMoneySummary } from "@/lib/billing/visit-money";

vi.mock("@/app/(app)/visit-payment-actions", () => ({
  prepareSplitCardPaymentAction: vi.fn(), recordExternalPaymentAction: vi.fn(), refundExternalPaymentAction: vi.fn(), runSplitCardPaymentAction: vi.fn(),
  confirmTransferAction: vi.fn(), sendSplitCardReceiptAction: vi.fn(), getSplitStateAction: vi.fn(), startSplitBillAction: vi.fn(),
  requestSplitCardRefundAction: vi.fn(), resolveRefundReviewAction: vi.fn(), refundSplitCardAction: vi.fn(), pollSplitCardAction: vi.fn(),
}));

// Sam's acceptance: the $225 visit ($100 card, $50 cash, $75 transfer, then a $40 card refund) reads Collected $225.00, Refunded $40.00, Net $185.00 on checkout and on the
// visit page, from the SAME helper, with the same three labels. The statement is pinned in statements-client-statement-restyle.test.ts.
const base: VisitLedger = {
  bill: { id: "b", totalCents: 22500, currency: "cad", referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "t" },
  cards: [{ kind: "card", id: "c1", amountCents: 10000, status: "succeeded", at: "t", platformFeeCents: null }],
  externals: [
    { kind: "external", id: "e1", method: "paid_cash", amountCents: 5000, state: "confirmed", at: "t", note: null },
    { kind: "external", id: "e2", method: "paid_e_transfer", amountCents: 7500, state: "confirmed", at: "t", note: null },
  ],
  refunds: [{ id: "r1", amountCents: 4000, kind: "payment_reversal", status: "succeeded", attemptId: "c1", externalPaymentId: null, reason: "x", at: "t", platformFeeReturnedCents: null }],
};
const checkout = (ledger: VisitLedger) => renderToStaticMarkup(createElement(SplitVisitPayments as never, { appointmentId: "a", currency: "cad", country: "CA", state: { ledger, balance: visitBalance(ledger) }, onChanged: () => undefined } as never));
const visitPage = (ledger: VisitLedger) => renderToStaticMarkup(createElement(VisitMoneyBlock, { summary: visitMoneySummary(ledger), currency: "cad" }));
const cell = (html: string, id: string) => new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html)?.[1];
const labels = (html: string) => [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1]);

describe("checkout panel", () => {
  it("shows Collected $225.00, Refunded $40.00, Net $185.00 and no 'Received'", () => {
    const out = checkout(base);
    expect([cell(out, "money-collected"), cell(out, "money-refunded"), cell(out, "money-net")]).toEqual(["$225.00 CAD", "$40.00 CAD", "$185.00 CAD"]);
    expect(labels(out).slice(0, 4)).toEqual(["Bill total", "Collected", "Refunded", "Net"]);
    expect(labels(out)).not.toContain("Received");
    expect(labels(out)).toContain("Still to collect");
  });
  it("PRODUCT RULE: a refunded, fully paid visit has Still to collect $0.00 on checkout", () => {
    const out = checkout(base);
    expect(cell(out, "split-collectable")).toBe("$0.00 CAD");
  });
  it("a genuinely unpaid bill still shows what is owed: $225 bill, $185 received -> Still to collect $40.00", () => {
    const unpaid: VisitLedger = { ...base, externals: [base.externals[0], { ...base.externals[1], amountCents: 3500 }], refunds: [] };
    const out = checkout(unpaid);
    expect([cell(out, "money-collected"), cell(out, "money-refunded"), cell(out, "money-net"), cell(out, "split-collectable")]).toEqual(["$185.00 CAD", "$0.00 CAD", "$185.00 CAD", "$40.00 CAD"]);
  });
  it("an unpaid bill WITH a reversal is told apart: the reversal leaves what is owed unchanged", () => {
    const unpaidRefunded: VisitLedger = { ...base, externals: [base.externals[0], { ...base.externals[1], amountCents: 3500 }] };
    const out = checkout(unpaidRefunded);
    expect([cell(out, "money-collected"), cell(out, "money-refunded"), cell(out, "money-net"), cell(out, "split-collectable")]).toEqual(["$185.00 CAD", "$40.00 CAD", "$145.00 CAD", "$40.00 CAD"]);
  });
  it("a pending refund shows 'Refund pending $40.00' and says Net is not final, and Refunded stays $0.00", () => {
    const out = checkout({ ...base, refunds: [{ ...base.refunds[0], status: "pending_stripe" }] });
    expect(cell(out, "money-refunded")).toBe("$0.00 CAD");
    expect(cell(out, "money-refund_pending")).toBe("$40.00 CAD");
    expect(labels(out)).toContain("Refund pending");
    expect(out).toContain("Not counted in Refunded or Net until Stripe confirms it.");
  });
  it("a transfer still waiting is shown as Waiting, not as Collected", () => {
    const out = checkout({ ...base, externals: [base.externals[0], { ...base.externals[1], state: "pending_confirmation" }] });
    expect(cell(out, "money-collected")).toBe("$150.00 CAD");
    expect(cell(out, "money-waiting")).toBe("$75.00 CAD");
  });
  it("an open review says so", () => {
    const out = checkout({ ...base, reviewOpen: true, reviews: [{ id: "rv", amountCents: 1000, settled: false }] });
    expect(out).toContain("waiting for you to confirm");
    expect(cell(out, "money-refund_pending")).toBe("$10.00 CAD");
  });
});

describe("visit page (session payment card)", () => {
  it("shows the same three labels and figures", () => {
    const out = visitPage(base);
    expect(labels(out)).toEqual(["Collected", "Refunded", "Net"]);
    expect([cell(out, "visit-money-collected"), cell(out, "visit-money-refunded"), cell(out, "visit-money-net")]).toEqual(["$225.00 CAD", "$40.00 CAD", "$185.00 CAD"]);
    expect(out).not.toMatch(/Paid/);
  });
  it("shows Still to collect under Net when given: $0.00 after a refund of a fully paid visit, $40.00 for the unpaid bill", () => {
    const render = (c: number) => renderToStaticMarkup(createElement(VisitMoneyBlock, { summary: visitMoneySummary(base), currency: "cad", stillToCollectCents: c }));
    expect(cell(render(0), "visit-money-still_to_collect")).toBe("$0.00 CAD");
    expect(cell(render(4000), "visit-money-still_to_collect")).toBe("$40.00 CAD");
    expect(visitPage(base)).not.toContain("Still to collect");
  });
  it("a pending refund is its own line and Net is flagged not final", () => {
    const out = visitPage({ ...base, refunds: [{ ...base.refunds[0], status: "pending_stripe" }] });
    expect(labels(out)).toEqual(["Collected", "Refunded", "Net", "Refund pending"]);
    expect(out).toContain("Not counted in Refunded or Net until Stripe confirms it.");
  });
  it("checkout and the visit page cannot disagree: the same summary feeds both", () => {
    const a = checkout(base), b = visitPage(base);
    expect([cell(a, "money-collected"), cell(a, "money-refunded"), cell(a, "money-net")]).toEqual([cell(b, "visit-money-collected"), cell(b, "visit-money-refunded"), cell(b, "visit-money-net")]);
  });
});
