import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { collectedMoneyLines, type CollectedMoneyRow } from "@/lib/finance/collected-money-lines";

// Sam's ruling on fees in owner totals, pinned. Synthetic rows only.
const ROOT = path.resolve(__dirname, "../../..");
const row = (over: Partial<CollectedMoneyRow> = {}): CollectedMoneyRow => ({
  chargeReason: "no_show_fee", status: "succeeded", amountCents: 5000, currency: "cad",
  refundStatus: null, refundAmountCents: null, providerRefundStatus: null, stripeRefundId: null, ...over,
});
const fee = (rows: CollectedMoneyRow[]) => collectedMoneyLines(rows, "cad").cancellationNoShowFees;
const session = (rows: CollectedMoneyRow[]) => collectedMoneyLines(rows, "cad").sessionPayments;

describe("a fee counts only when it was collected (one test per status)", () => {
  it("succeeded: included, on its own line", () => {
    expect(fee([row()])).toMatchObject({ collectedCents: 5000, excluded: 0 });
  });
  for (const status of ["ready", "pending_stripe", "failed", "cancelled", "blocked", "requires_action", "weird", null]) {
    it(`${String(status)}: excluded from collected revenue`, () => {
      const l = fee([row({ status })]);
      expect(l.collectedCents).toBe(0);
      expect(l.excluded).toBe(1);
    });
  }
  it("both fee reasons are fees; another reason is counted nowhere", () => {
    const l = collectedMoneyLines([row({ chargeReason: "late_cancellation_fee" }), row({ chargeReason: "some_future_reason" }), row({ chargeReason: null })], "cad");
    expect(l.cancellationNoShowFees.collectedCents).toBe(5000);
    expect(l.sessionPayments.collectedCents).toBe(0);
  });
});

describe("refunds reduce the total accurately; unprovable refunds are not guessed", () => {
  it("a fully refunded fee counts 0 and shows the refunded amount", () => {
    const l = fee([row({ refundStatus: "succeeded", refundAmountCents: 5000, providerRefundStatus: "succeeded" })]);
    expect(l).toMatchObject({ collectedCents: 0, refundedCents: 5000 });
  });
  it("a refund that failed with no provider trace left the money in place", () => {
    expect(fee([row({ refundStatus: "failed" })]).collectedCents).toBe(5000);
  });
  for (const [name, over] of [
    ["in flight", { refundStatus: "pending_stripe" }],
    ["needs action at the provider", { refundStatus: "pending_stripe", providerRefundStatus: "requires_action" }],
    ["ours succeeded, provider failed", { refundStatus: "succeeded", refundAmountCents: 5000, providerRefundStatus: "failed" }],
    ["a bare provider trace", { providerRefundStatus: "succeeded" }],
    ["an unknown value", { refundStatus: "weird" }],
  ] as const) {
    it(`${name}: unresolved, neither collected nor refunded`, () => {
      const l = fee([row(over)]);
      expect(l).toMatchObject({ collectedCents: 0, refundedCents: 0, unresolved: { count: 1, cents: 5000 } });
    });
  }
  it("a PARTIAL refund is not supported: the charge is unresolved, never netted by guesswork", () => {
    const l = fee([row({ refundStatus: "succeeded", refundAmountCents: 2000, providerRefundStatus: "succeeded" })]);
    expect(l.collectedCents).toBe(0);
    expect(l.unresolved.count).toBe(1);
    expect(collectedMoneyLines([], "cad").partialRefundsSupported).toBe(false);
  });
});

describe("amounts and currency", () => {
  it("sums several collected fees", () => {
    expect(fee([row(), row({ amountCents: 2500 })]).collectedCents).toBe(7500);
  });
  it("money in another currency is never summed", () => {
    const l = fee([row({ currency: "usd" }), row()]);
    expect(l).toMatchObject({ collectedCents: 5000, otherCurrency: { count: 1 } });
  });
  it("a missing or invalid amount is unresolved, never zero collected silently", () => {
    for (const amountCents of [null, -1, 12.5]) expect(fee([row({ amountCents: amountCents as number })]).unresolved.count).toBe(1);
  });
});

describe("the session-payment line is unchanged by fees", () => {
  const sessions = [row({ chargeReason: "session_payment", amountCents: 12000 }), row({ chargeReason: "session_payment", amountCents: 8000, refundStatus: "succeeded", refundAmountCents: 8000, providerRefundStatus: "succeeded" })];
  it("adding fee rows of any status leaves the session line identical", () => {
    const base = session(sessions);
    const withFees = session([...sessions, row(), row({ status: "failed" }), row({ chargeReason: "late_cancellation_fee", refundStatus: "pending_stripe" })]);
    expect(withFees).toEqual(base);
    expect(base).toMatchObject({ collectedCents: 12000, refundedCents: 8000 });
  });
  it("fee money never appears in the session line, and the reverse", () => {
    const l = collectedMoneyLines([row(), row({ chargeReason: "session_payment", amountCents: 100 })], "cad");
    expect(l.cancellationNoShowFees.collectedCents).toBe(5000);
    expect(l.sessionPayments.collectedCents).toBe(100);
  });
});

describe("placement: the no-money screens cannot reach this module", () => {
  const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
  it("neither /financials nor the dashboard snapshot imports it, so their no-money oracles stand unchanged", () => {
    for (const rel of ["lib/finance/financial-briefing-model.ts", "lib/finance/financial-briefing.ts", "lib/finance/financial-fact.ts", "app/(app)/financials/page.tsx", "app/(app)/financials/financial-spine.tsx", "app/(app)/dashboard/practice-snapshot.tsx"]) {
      expect(code(rel), rel).not.toContain("collected-money-lines");
    }
  });
});
