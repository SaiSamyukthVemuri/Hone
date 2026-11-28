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
import { visitBalance, type VisitLedger } from "@/lib/billing/visit-payments-core";
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

describe("an old test card never blocks genuine cash or a transfer (Sam, 28 Nov 2026)", () => {
  it("Still to collect is the full $100 (a test card never counts, in any studio) and REAL money is offered the full $100 (was Balance due $0 before Sam's 28 Nov rule)", () => {
    mount(ledger({}));
    expect(host!.querySelector('[data-testid="split-collectable"]')?.textContent).toMatch(/\$100\.00/);
    expect(help()).toMatch(/Up to \$100\.00/);
  });
  it("cash and transfer are offered the full $100 and can be submitted; there is no 'test card holds' note any more", () => {
    mount(ledger({}));
    pick(/Cash/);
    expect(help()).toMatch(/Up to \$100\.00/);
    expect(host!.querySelector('[data-testid="split-test-card-holds"]')).toBeNull();
    pick(/E-transfer/);
    expect(help()).toMatch(/Up to \$100\.00/);
  });
  it("real money already received reduces what cash may take: $60 cash received leaves $40, and a live card counts like cash", () => {
    const cash = { id: "e", method: "paid_cash", amountCents: 6000, state: "confirmed", at: "2026-11-27T00:00:00Z" } as never;
    mount(ledger({ externals: [cash] }));
    pick(/Cash/);
    expect(help()).toMatch(/Up to \$40\.00/);
    act(() => root?.unmount()); host?.remove();
    const live = { kind: "card" as const, id: "l", amountCents: 7000, status: "succeeded", at: "2026-11-27T00:00:00Z", platformFeeCents: null };
    mount(ledger({ cards: [{ ...live, id: "t", amountCents: 10000, test: true }, live] }));
    pick(/Cash/);
    expect(help()).toMatch(/Up to \$30\.00/);
  });
  it("a test deployment's card is a TEST row: no room for a second test card in a trial studio, while cash still is offered the full $100", () => {
    mount(ledger({ cardAssumesLive: false }));
    expect(visitBalance(ledger({ cardAssumesLive: false }))?.cardCollectableCents).toBe(0);
    pick(/Cash/);
    expect(help()).toMatch(/Up to \$100\.00/);
  });
});

describe("the refund selector in a live deployment (Codex P2: a test payment cannot be refunded from the live account)", () => {
  const toggle = () => [...host!.querySelectorAll("button")].find((b) => /Refund or reduce a payment/.test(b.textContent ?? ""));
  const refundOptions = () => {
    act(() => { toggle()?.click(); });
    return [...host!.querySelectorAll('[data-testid="split-refund-form"] option')].map((o) => o.textContent ?? "");
  };
  it("a succeeded TEST card is not offered; a live card is; in a test deployment the test card still is", () => {
    const live = { kind: "card" as const, id: "l", amountCents: 5000, status: "succeeded", at: "2026-11-27T00:00:00Z", platformFeeCents: null };
    const test = { ...live, id: "t", test: true };
    mount(ledger({ cards: [test], cardAssumesLive: true }));
    expect(toggle()).toBeUndefined();                                                // nothing refundable: no refund control at all
    act(() => root?.unmount()); host?.remove();
    mount(ledger({ cards: [test, live], cardAssumesLive: true }));
    expect(refundOptions().filter((t) => /Card/.test(t))).toHaveLength(1);
    act(() => root?.unmount()); host?.remove();
    mount(ledger({ cards: [test], cardAssumesLive: false }));
    expect(refundOptions().filter((t) => /Card/.test(t))).toHaveLength(1);
  });
});
