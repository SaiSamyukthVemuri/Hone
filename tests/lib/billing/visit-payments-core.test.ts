import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  canStartCharge, cardReduce, commandNote, historyLines, parseDollarsToCents, showCheckingStatus, visitBalance,
  type CardPhase, type VisitLedger,
} from "@/lib/billing/visit-payments-core";

const bill = { id: "b1", totalCents: 22500, currency: "cad" as const, referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "2026-11-27T10:00:00Z" };
const ledger = (over: Partial<VisitLedger> = {}): VisitLedger => ({ bill, cards: [], externals: [], refunds: [], ...over });

describe("parseDollarsToCents", () => {
  it("accepts plain dollars and cents and nothing else", () => {
    expect(parseDollarsToCents("75")).toBe(7500);
    expect(parseDollarsToCents("75.5")).toBe(7550);
    expect(parseDollarsToCents(" 75.05 ")).toBe(7505);
    for (const bad of ["", "0", "0.00", "-5", "5.", ".5", "1,000", "1.234", "$5", "5e2", "abc", "2001"]) expect(parseDollarsToCents(bad), bad).toBeNull();
    expect(parseDollarsToCents("2000")).toBe(200000);
    expect(parseDollarsToCents(75 as unknown)).toBeNull();
  });
});

describe("visitBalance mirrors the database position", () => {
  it("$100 card + $50 cash + $75 pending transfer on $225: nothing collectable, $75 still owed", () => {
    const b = visitBalance(ledger({
      cards: [{ kind: "card", id: "c", amountCents: 10000, status: "succeeded", at: "1", platformFeeCents: null }],
      externals: [
        { kind: "external", id: "e1", method: "paid_cash", amountCents: 5000, state: "confirmed", at: "2", note: null },
        { kind: "external", id: "e2", method: "paid_e_transfer", amountCents: 7500, state: "pending_confirmation", at: "3", note: null },
      ],
    }))!;
    expect(b).toMatchObject({ confirmedCents: 5000, pendingCents: 7500, cardCents: 10000, collectableCents: 0, owedCents: 7500 });
  });
  it("a void releases the reservation; failed and ready card rows and failed refunds count for nothing", () => {
    const b = visitBalance(ledger({
      cards: [{ kind: "card", id: "c", amountCents: 10000, status: "failed", at: "1", platformFeeCents: null }],
      externals: [{ kind: "external", id: "e2", method: "paid_e_transfer", amountCents: 7500, state: "voided", at: "3", note: null }],
      refunds: [{ id: "r", amountCents: 100, kind: "payment_reversal", status: "failed", attemptId: "c", externalPaymentId: null, reason: "x", at: "4", platformFeeReturnedCents: null }],
    }))!;
    expect(b.collectableCents).toBe(22500);
  });
  it("a payment_reversal raises what is collectable; a price_reduction (bill already lowered) leaves it unchanged", () => {
    const paid = { kind: "external" as const, id: "e", method: "paid_cash" as const, amountCents: 10000, state: "confirmed" as const, at: "1", note: null };
    const rev = visitBalance(ledger({ externals: [paid], refunds: [{ id: "r", amountCents: 4000, kind: "payment_reversal", status: "succeeded", attemptId: null, externalPaymentId: "e", reason: "x", at: "2", platformFeeReturnedCents: null }] }))!;
    expect(rev.collectableCents).toBe(22500 - 10000 + 4000);
    const red = visitBalance({ bill: { ...bill, totalCents: 19500 }, cards: [], externals: [paid], refunds: [{ id: "r", amountCents: 3000, kind: "price_reduction", status: "succeeded", attemptId: null, externalPaymentId: "e", reason: "x", at: "2", platformFeeReturnedCents: null }] })!;
    expect(red.collectableCents).toBe(22500 - 10000);
  });
  it("no bill, no balance (a legacy visit is read the old way)", () => expect(visitBalance({ bill: null, cards: [], externals: [], refunds: [] })).toBeNull());
});

describe("historyLines", () => {
  it("lists everything in order, keeps voided and failed visible, and skips a prepared-but-never-run card", () => {
    const lines = historyLines(ledger({
      cards: [
        { kind: "card", id: "c1", amountCents: 10000, status: "succeeded", at: "2026-11-27T10:01", platformFeeCents: null },
        { kind: "card", id: "c2", amountCents: 7500, status: "ready", at: "2026-11-27T10:02", platformFeeCents: null },
      ],
      externals: [{ kind: "external", id: "e", method: "paid_e_transfer", amountCents: 7500, state: "voided", at: "2026-11-27T10:03", note: null }],
      refunds: [{ id: "r", amountCents: 4000, kind: "price_reduction", status: "pending_stripe", attemptId: "c1", externalPaymentId: null, reason: "x", at: "2026-11-27T10:04", platformFeeReturnedCents: null }],
    }));
    expect(lines.map((l) => [l.label, l.status, l.direction])).toEqual([
      ["Card", "received", "in"], ["E-transfer", "voided", "in"], ["Price reduced, money returned (card)", "in_progress", "out"],
    ]);
  });
});

describe("commandNote", () => {
  it("the reserved refusal says what to do, and never exposes a code", () => {
    for (const code of ["PY001", "reserved_for_pending_transfer"]) {
      const n = commandNote(code);
      expect(n.tone).toBe("blocked");
      expect(n.message).toMatch(/^This amount is reserved for a pending transfer\./);
      expect(n.message).toMatch(/Confirm the transfer.*cancel it/);
    }
  });
  it("every refusal code has its own sentence; an unknown code is generic and says nothing changed", () => {
    const codes = ["exceeds_balance", "PY002", "exceeds_refundable", "exceeds_bill", "confirmed_is_final", "payment_not_refundable", "method_unavailable", "not_completed", "already_settled", "card_payment_exists", "price_missing", "no_bill", "split_payments_off", "not_owner", "not_found", "submission_reused", "invalid_input"];
    const seen = new Set(codes.map((c) => commandNote(c).message));
    expect(seen.size).toBe(codes.length - 1); // exceeds_balance and PY002 are the same sentence
    expect(commandNote("zzz").message).toMatch(/nothing was changed/);
    expect(codes.every((c) => !/[a-z]+_[a-z_]+/.test(commandNote(c).message))).toBe(true);
  });
  it("shows how much is still collectable when it knows", () => {
    expect(commandNote("exceeds_balance", { collectableCents: 7500, currency: "cad" }).message).toContain("$75.00");
  });
});

describe("the card phase never offers a second charge while the outcome is unknown", () => {
  it("a lost response leaves 'Checking payment status' and no charge control until Stripe's answer is known", () => {
    let s: CardPhase = { phase: "idle" };
    expect(canStartCharge(s)).toBe(true);
    s = cardReduce(s, { type: "submit" });
    s = cardReduce(s, { type: "prepared", attemptId: "a1" });
    s = cardReduce(s, { type: "lost_response" });
    expect(showCheckingStatus(s)).toBe(true);
    expect(canStartCharge(s)).toBe(false);
    expect(cardReduce(s, { type: "submit" })).toBe(s);                      // a second click does nothing
    s = cardReduce(s, { type: "status", outcome: "unknown" });
    expect(showCheckingStatus(s)).toBe(true);
    s = cardReduce(s, { type: "status", outcome: "succeeded" });
    expect(s).toEqual({ phase: "succeeded", attemptId: "a1" });
    // A payment that SUCCEEDED does not block the next one: a split visit still has a balance. (Whether more may be charged is the database's call.)
    expect(canStartCharge(s)).toBe(true);
    expect(cardReduce(s, { type: "submit" })).toEqual({ phase: "preparing" });
  });
  it("only a definite failure re-enables the charge", () => {
    let s: CardPhase = cardReduce(cardReduce(cardReduce({ phase: "idle" }, { type: "submit" }), { type: "prepared", attemptId: "a1" }), { type: "result", outcome: "failed", text: "Declined" });
    expect(s).toMatchObject({ phase: "failed", message: "Declined" });
    expect(canStartCharge(s)).toBe(true);
    s = cardReduce(cardReduce({ phase: "idle" }, { type: "submit" }), { type: "prepare_refused", text: "reserved" });
    expect(canStartCharge(s)).toBe(true);
  });
  it("events out of order change nothing", () => {
    const idle: CardPhase = { phase: "idle" };
    expect(cardReduce(idle, { type: "lost_response" })).toBe(idle);
    expect(cardReduce(idle, { type: "status", outcome: "succeeded" })).toBe(idle);
  });
});

import { billedOutstanding } from "@/lib/billing/visit-payments-core";
describe("billedOutstanding (dashboard outstanding view)", () => {
  const bill = { totalCents: 22500, currency: "cad", externals: [] as { amountCents: number; state: string }[], refunds: [] as { amountCents: number; status: string }[] };
  it("the $225 example: $100 card + $50 cash leaves $75; a pending $75 transfer is still owed until confirmed, then it is paid", () => {
    const cards = [{ status: "succeeded", amountCents: 10000, currency: "cad" }];
    const withCash = { ...bill, externals: [{ amountCents: 5000, state: "confirmed" }, { amountCents: 7500, state: "pending_confirmation" }] };
    expect(billedOutstanding(withCash, cards)).toMatchObject({ kind: "owed", outstandingCents: 7500 });
    const confirmed = { ...bill, externals: [{ amountCents: 5000, state: "confirmed" }, { amountCents: 7500, state: "confirmed" }] };
    expect(billedOutstanding(confirmed, cards)).toEqual({ kind: "paid" });
    const voided = { ...bill, externals: [{ amountCents: 5000, state: "confirmed" }, { amountCents: 7500, state: "voided" }] };
    expect(billedOutstanding(voided, cards)).toMatchObject({ kind: "owed", outstandingCents: 7500 });
  });
  it("a $40 payment reversal makes $40 due again; unknown money is unavailable, never zero", () => {
    const cards = [{ status: "succeeded", amountCents: 22500, currency: "cad" }];
    expect(billedOutstanding({ ...bill, refunds: [{ amountCents: 4000, status: "succeeded" }] }, cards)).toMatchObject({ kind: "owed", outstandingCents: 4000 });
    expect(billedOutstanding(bill, [{ status: "pending_stripe", amountCents: 100, currency: "cad" }])).toEqual({ kind: "amount_unavailable" });
    expect(billedOutstanding({ ...bill, refunds: [{ amountCents: 4000, status: "pending_stripe" }] }, cards)).toEqual({ kind: "amount_unavailable" });
    expect(billedOutstanding({ ...bill, currency: "eur" }, [])).toEqual({ kind: "amount_unavailable" });
  });
});

import { proportionalFeeReturn } from "@/lib/billing/visit-payments-core";
describe("proportionalFeeReturn (fee returned with a partial card refund)", () => {
  const base = { feeCents: 50, chargeCents: 10000, alreadyRefundedCents: 0, alreadyReturnedCents: 0 };
  it("a $40 refund of a $100 charge with a $0.50 fee returns $0.20", () => {
    expect(proportionalFeeReturn({ ...base, refundCents: 4000 })).toBe(20);
  });
  it("the last refund returns exactly what is left, so the total never exceeds the fee and a full refund returns it all", () => {
    expect(proportionalFeeReturn({ ...base, refundCents: 6000, alreadyRefundedCents: 4000, alreadyReturnedCents: 20 })).toBe(30);
    expect(proportionalFeeReturn({ ...base, refundCents: 10000 })).toBe(50);
    // three equal thirds of a $0.50 fee on a $100 charge: rounding down never over-returns, the remainder lands on the last one
    const a = proportionalFeeReturn({ ...base, refundCents: 3333 })!;
    const b = proportionalFeeReturn({ ...base, refundCents: 3333, alreadyRefundedCents: 3333, alreadyReturnedCents: a })!;
    const c = proportionalFeeReturn({ ...base, refundCents: 3334, alreadyRefundedCents: 6666, alreadyReturnedCents: a + b })!;
    expect(a + b + c).toBe(50);
  });
  it("no fee, no return", () => {
    expect(proportionalFeeReturn({ ...base, feeCents: null, refundCents: 4000 })).toBeNull();
    expect(proportionalFeeReturn({ ...base, feeCents: 0, refundCents: 4000 })).toBeNull();
  });
});

describe("a partial card payment is not 'Paid' on the roster", () => {
  it("$100 card on a $225 bill stays chargeable (Checkout stays open); fully paid is paid; unknown is unavailable", async () => {
    const { billedPaymentState } = await import("@/lib/billing/billed-visits");
    const bill = { totalCents: 22500, currency: "cad", externals: [], refunds: [] };
    expect(billedPaymentState(bill, [{ status: "succeeded", amount_cents: 10000 }])).toBe("chargeable");
    expect(billedPaymentState(bill, [{ status: "succeeded", amount_cents: 22500 }])).toBe("paid");
    expect(billedPaymentState(bill, [{ status: "pending_stripe", amount_cents: 10000 }])).toBe("unavailable");
    expect(billedPaymentState({ ...bill, externals: [{ amountCents: 22500, state: "pending_confirmation" }] }, [])).toBe("chargeable");
  });
});
