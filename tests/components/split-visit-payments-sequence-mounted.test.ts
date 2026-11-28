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
  // A fake database keyed by (submission id): a command COMMITS its row, then (when `lose` is set) the answer is lost, as a dropped connection would.
  lose: false,
  cash: new Map<string, string>(), refunds: new Map<string, string>(), prepared: new Map<string, string>(), sids: [] as string[],
};
const answer = (code: string, ok: boolean) => ({ ok, code, note: { tone: ok ? "ok" : "blocked", message: code }, state: null, id: "row" });
vi.mock("@/app/(app)/visit-payment-actions", () => ({
  prepareSplitCardPaymentAction: vi.fn(async (fd: FormData) => {
    const sid = String(fd.get("submission_id"));
    S.prepareIds.push(sid);
    if (!S.prepared.has(sid)) { S.attempts += 1; S.prepared.set(sid, `att-${S.attempts}`); } // the retry of the SAME id returns the one attempt
    if (S.lose) { S.lose = false; throw new Error("connection dropped after the commit"); }
    return { ok: true, attemptId: S.prepared.get(sid)!, currency: "cad", amountCents: 5000 };
  }),
  recordExternalPaymentAction: vi.fn(async (fd: FormData) => {
    const sid = String(fd.get("submission_id")); S.sids.push(sid);
    const had = S.cash.has(sid); if (!had) S.cash.set(sid, String(fd.get("method")));
    if (S.lose) { S.lose = false; return answer("unavailable", false); } // committed, answer lost
    return answer(had ? "already_recorded" : "recorded", true);
  }),
  refundExternalPaymentAction: vi.fn(async (fd: FormData) => {
    const sid = String(fd.get("submission_id")); S.sids.push(sid);
    const had = S.refunds.has(sid); if (!had) S.refunds.set(sid, String(fd.get("kind")));
    if (S.lose) { S.lose = false; return answer("unavailable", false); }
    return answer(had ? "already_requested" : "requested", true);
  }),
  runSplitCardPaymentAction: vi.fn(async () => ({ outcome: S.runOutcomes.shift() ?? "succeeded", state: null })),
  confirmTransferAction: vi.fn(), sendSplitCardReceiptAction: vi.fn(),
  refundCardPaymentAction: vi.fn(async (fd: FormData) => { S.sids.push(String(fd.get("submission_id"))); return { ...answer("requested", false), refundId: "rf-1", checking: false }; }),
  voidTransferAction: vi.fn(), cancelSplitCardAttemptAction: vi.fn(), recheckCardRefundAction: vi.fn(),
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
  S.prepareIds = []; S.runOutcomes = []; S.attempts = 0; S.lose = false; S.cash.clear(); S.refunds.clear(); S.prepared.clear(); S.sids = [];
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

// Insurance F1 / OPS: a command whose answer is LOST may already have committed. The retry must reuse the SAME id so the database replays the one row (never a second).
describe("a lost answer after the commit keeps the id: exactly one row", () => {
  const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await flush(); };
  const pick = async (label: RegExp) => { const l = [...host!.querySelectorAll("label")].find((x) => label.test(x.textContent ?? ""))!; await click(l.querySelector("input")!); };

  it.each([["cash", /^Cash$/, /Record cash received/], ["transfer", /^E-transfer$/, /Record transfer/]] as const)("%s", async (_n, tenderLabel, submit) => {
    mount(stateOf(ledgerOf([])));
    await pick(tenderLabel);
    type(amountInput(), "50.00");
    S.lose = true;
    await click(button(submit));
    expect(S.cash.size).toBe(1);
    await click(button(submit));
    expect(S.sids).toHaveLength(2);
    expect(S.sids[1]).toBe(S.sids[0]);
    expect(S.cash.size).toBe(1);
  });

  it.each([["external refund", /Return the payment/], ["price reduction", /Reduce the price/]] as const)("%s", async (_n, kindLabel) => {
    const ext = { kind: "external" as const, id: "ex-1", method: "paid_cash" as const, amountCents: 5000, state: "confirmed" as const, at: "2026-11-27T00:00:00Z", note: null };
    mount(stateOf({ ...ledgerOf([]), externals: [ext] }));
    await click(button(/Refund or reduce a payment/));
    await pick(kindLabel);
    const [refundAmount, reason] = [...host!.querySelectorAll<HTMLInputElement>('[data-testid="split-refund-form"] input:not([type="radio"])')];
    type(refundAmount, "20.00"); type(reason, "Customer asked for it back");
    S.lose = true;
    await click(button(/Record \$20\.00/));
    expect(S.refunds.size).toBe(1);
    await click(button(/Record \$20\.00/));
    expect(S.sids).toHaveLength(2);
    expect(S.sids[1]).toBe(S.sids[0]);
    expect(S.refunds.size).toBe(1);
  });

  it("cash answer lost, then an UNRELATED refund appears and clears: the retry still reuses the id (no second row)", async () => {
    mount(stateOf(ledgerOf([])));
    await pick(/^Cash$/);
    type(amountInput(), "50.00");
    S.lose = true;
    await click(button(/Record cash received/));
    const pending = { id: "rf-9", amountCents: 1000, kind: "payment_reversal" as const, status: "pending_stripe" as const };
    act(() => setState!(stateOf({ ...ledgerOf([]), refunds: [pending as never] })));
    await flush();
    act(() => setState!(stateOf(ledgerOf([]))));
    await flush();
    await click(button(/Record cash received/));
    expect(S.sids).toHaveLength(2);
    expect(S.sids[1]).toBe(S.sids[0]);
    expect(S.cash.size).toBe(1);
  });

  it("card prepare: the answer is lost after the attempt was created; the retry returns the same attempt", async () => {
    S.runOutcomes = ["succeeded"];
    mount(stateOf(ledgerOf([])));
    type(amountInput(), "50.00");
    S.lose = true;
    await act(async () => { button(/Charge card/).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(S.attempts).toBe(1);
    await act(async () => { button(/Charge card/).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(S.prepareIds).toHaveLength(2);
    expect(S.prepareIds[1]).toBe(S.prepareIds[0]);
    expect(S.attempts).toBe(1);
  });

  it("a BLOCKED card refund (code requested, ok:false: a pending row exists, Stripe was not asked) keeps its id", async () => {
    mount(stateOf(ledgerOf([card("att-1", "succeeded")])));
    await click(button(/Refund or reduce a payment/));
    const [refundAmount, reason] = [...host!.querySelectorAll<HTMLInputElement>('[data-testid="split-refund-form"] input:not([type="radio"])')];
    type(refundAmount, "20.00"); type(reason, "Customer asked for it back");
    await click(button(/Record \$20\.00/));
    await click(button(/Record \$20\.00/));
    expect(S.sids).toHaveLength(2);
    expect(S.sids[1]).toBe(S.sids[0]);
  });
});
