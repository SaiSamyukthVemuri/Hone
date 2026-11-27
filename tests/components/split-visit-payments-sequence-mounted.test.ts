// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The REAL SplitVisitPayments, mounted. Only the server actions are stood in for. The $50 + $50 sequence (Codex P2): when the first $50 card payment's outcome was
// UNKNOWN and then settled by ANY path (the poll, the manual status check, or the ledger), the second $50 is a NEW command with a NEW submission id, never the first's.
const S = {
  prepareIds: [] as string[],
  runOutcomes: [] as Array<"unknown" | "succeeded">,
  attempts: 0,
};
vi.mock("@/app/(app)/visit-payment-actions", () => ({
  prepareSplitCardPaymentAction: vi.fn(async (fd: FormData) => {
    S.prepareIds.push(String(fd.get("submission_id")));
    S.attempts += 1;
    return { ok: true, attemptId: `att-${S.attempts}`, currency: "cad", amountCents: 5000 };
  }),
  runSplitCardPaymentAction: vi.fn(async () => ({ outcome: S.runOutcomes.shift() ?? "succeeded", state: null })),
  confirmTransferAction: vi.fn(), sendSplitCardReceiptAction: vi.fn(), refundCardPaymentAction: vi.fn(), recordExternalPaymentAction: vi.fn(),
  refundExternalPaymentAction: vi.fn(), voidTransferAction: vi.fn(), cancelSplitCardAttemptAction: vi.fn(), recheckCardRefundAction: vi.fn(),
  resolveRefundReviewAction: vi.fn(),
}));

import { SplitVisitPayments } from "@/components/split-visit-payments";
import { visitBalance, type VisitLedger } from "@/lib/billing/visit-payments-core";
import type { SplitState } from "@/app/(app)/visit-payment-actions";

const ledgerOf = (cards: VisitLedger["cards"]): VisitLedger => ({
  bill: { id: "b1", totalCents: 10000, currency: "cad", referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "2026-11-27T00:00:00Z" },
  cards, externals: [], refunds: [],
});
const card = (id: string, status: string) => ({ kind: "card" as const, id, amountCents: 5000, status, at: "2026-11-27T00:00:00Z", platformFeeCents: null });
const stateOf = (l: VisitLedger): SplitState => ({ ledger: l, balance: visitBalance(l) });

let root: Root | null = null;
let host: HTMLElement | null = null;
let setState: ((s: SplitState) => void) | null = null;

function Host({ initial }: { initial: SplitState }) {
  const [state, set] = useState(initial);
  setState = set;
  return createElement(SplitVisitPayments, { appointmentId: "22222222-2222-4222-8222-222222222222", currency: "cad", state, onChanged: (n: SplitState | null) => { if (n) set(n); } });
}
const mount = (initial: SplitState) => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(createElement(Host, { initial })));
};
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const amountInput = () => host!.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
const button = (re: RegExp) => [...host!.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""))!;
async function chargeFifty() {
  type(amountInput(), "50.00");
  await act(async () => { button(/Charge card/).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  S.prepareIds = []; S.runOutcomes = []; S.attempts = 0;
});
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null; setState = null;
  vi.useRealTimers();
});

describe("the $50 + $50 sequence after an unknown outcome", () => {
  it("settled by the POLL: the second $50 is a new command", async () => {
    S.runOutcomes = ["unknown", "succeeded"];
    mount(stateOf(ledgerOf([])));
    await chargeFifty();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(host!.querySelector('[data-testid="split-note"]')?.textContent).toMatch(/Card payment received/);
    act(() => setState!(stateOf(ledgerOf([card("att-1", "succeeded")]))));
    await chargeFifty();
    expect(S.prepareIds).toHaveLength(2);
    expect(S.prepareIds[1]).not.toBe(S.prepareIds[0]);
  });

  it("settled by the MANUAL status check: the second $50 is a new command (not 'success' with nothing collected)", async () => {
    // 40 unknown answers in a row exhaust the poll; the panel then offers "Check payment status again".
    S.runOutcomes = Array.from({ length: 40 }, () => "unknown" as const);
    mount(stateOf(ledgerOf([])));
    await chargeFifty();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100 * 41); });
    S.runOutcomes = ["succeeded"];
    await act(async () => { button(/Check payment status again/).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(host!.querySelector('[data-testid="split-note"]')?.textContent).toMatch(/Card payment received/);
    act(() => setState!(stateOf(ledgerOf([card("att-1", "succeeded")]))));
    await chargeFifty();
    expect(S.prepareIds).toHaveLength(2);
    expect(S.prepareIds[1]).not.toBe(S.prepareIds[0]);
  });

  it("settled by the LEDGER (restore effect, then settle): the second $50 is a new command", async () => {
    S.runOutcomes = ["unknown", "unknown"];
    mount(stateOf(ledgerOf([])));
    await chargeFifty();
    // the ledger now shows the attempt pending (restore effect checks it), then settled by another path
    act(() => setState!(stateOf(ledgerOf([card("att-1", "pending_stripe")]))));
    await flush();
    act(() => setState!(stateOf(ledgerOf([card("att-1", "succeeded")]))));
    await flush();
    // the first loop is still sleeping between checks (the screen stays busy until it ends); the next check ends it
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await chargeFifty();
    expect(S.prepareIds).toHaveLength(2);
    expect(S.prepareIds[1]).not.toBe(S.prepareIds[0]);
  });

  it("control: while the first answer is still unknown, a retry of the SAME charge keeps the id", async () => {
    S.runOutcomes = ["unknown", "unknown"];
    mount(stateOf(ledgerOf([])));
    await chargeFifty();
    expect(S.prepareIds).toHaveLength(1);
  });
});
