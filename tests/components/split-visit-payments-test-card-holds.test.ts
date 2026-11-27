// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Not-yet-live studio, $100 bill fully covered by a $100 TEST card, on a LIVE deployment. A real card is offered the full $100 (the card wall judges a live row as if the studio had
// gone live); cash and transfers use the database's own position, so they are offered $0 and the screen says why, instead of letting the database refuse them.
vi.mock("@/app/(app)/visit-payment-actions", () => ({
  prepareSplitCardPaymentAction: vi.fn(), recordExternalPaymentAction: vi.fn(), refundExternalPaymentAction: vi.fn(), runSplitCardPaymentAction: vi.fn(), confirmTransferAction: vi.fn(),
  sendSplitCardReceiptAction: vi.fn(), refundCardPaymentAction: vi.fn(), voidTransferAction: vi.fn(), cancelSplitCardAttemptAction: vi.fn(), recheckCardRefundAction: vi.fn(), resolveRefundReviewAction: vi.fn(),
}));
import { SplitVisitPayments } from "@/components/split-visit-payments";
import { TEST_CARD_HOLDS_NOTE, visitBalance, type VisitLedger } from "@/lib/billing/visit-payments-core";
import type { SplitState } from "@/app/(app)/visit-payment-actions";

const ledger = (over: Partial<VisitLedger>): VisitLedger => ({
  bill: { id: "b1", totalCents: 10000, currency: "cad", referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "2026-11-27T00:00:00Z" },
  cards: [{ kind: "card", id: "t", amountCents: 10000, status: "succeeded", at: "2026-11-27T00:00:00Z", platformFeeCents: null, test: true }],
  externals: [], refunds: [], studioLive: false, cardAssumesLive: true, ...over,
});
let root: Root | null = null; let host: HTMLElement | null = null;
const mount = (l: VisitLedger) => {
  const state: SplitState = { ledger: l, balance: visitBalance(l) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(createElement(SplitVisitPayments, { appointmentId: "22222222-2222-4222-8222-222222222222", currency: "cad", state, onChanged: () => {} })));
};
const pick = (name: RegExp) => act(() => { [...host!.querySelectorAll("label")].find((l) => name.test(l.textContent ?? ""))!.querySelector("input")!.click(); });
const help = () => host!.querySelector("#split-amount-help")?.textContent ?? "";
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

describe("a test card still holds the bill until the studio's first real card", () => {
  it("Balance due is the database position ($0) and a real card is offered the full $100", () => {
    mount(ledger({}));
    expect(host!.querySelector('[data-testid="split-collectable"]')?.textContent).toMatch(/\$0\.00/);
    expect(help()).toMatch(/Up to \$100\.00/);
    expect(host!.querySelector('[data-testid="split-test-card-holds"]')).toBeNull();
  });
  it("cash and transfer are offered $0, say why, and cannot be submitted", () => {
    mount(ledger({}));
    pick(/Cash/);
    expect(help()).toMatch(/Up to \$0\.00/);
    expect(host!.querySelector('[data-testid="split-test-card-holds"]')?.textContent).toContain(TEST_CARD_HOLDS_NOTE);
    expect([...host!.querySelectorAll("button")].find((b) => /Record cash/.test(b.textContent ?? ""))!.disabled).toBe(true);
    pick(/E-transfer/);
    expect(host!.querySelector('[data-testid="split-test-card-holds"]')).not.toBeNull();
  });
  it("a test deployment has no such note: nothing is offered anywhere", () => {
    mount(ledger({ cardAssumesLive: false }));
    expect(host!.querySelector('[data-testid="split-test-card-holds"]')).toBeNull();
  });
});
