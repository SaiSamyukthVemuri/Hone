import { describe, expect, it } from "vitest";
import { refundDisplayState, type RefundDisplayInput } from "@/lib/billing/refund-display-state";

const base: RefundDisplayInput = {
  chargeStatus: "succeeded",
  amountCents: 5000,
  refundStatus: null,
  refundAmountCents: null,
  providerRefundStatus: null,
};
const s = (o: Partial<RefundDisplayInput>) => refundDisplayState({ ...base, ...o });

describe("refundDisplayState (R1)", () => {
  it("no refund: may start, full amount remains", () => {
    expect(s({})).toEqual({ kind: "not_refunded", remainingRefundableCents: 5000, mayStartRefund: true });
  });
  it("a charge that did not succeed is not refundable", () => {
    expect(s({ chargeStatus: "failed" })).toEqual({ kind: "not_refunded", remainingRefundableCents: 0, mayStartRefund: false });
  });
  it("our pending claim with no provider answer is PENDING, never failed, and cannot be retried", () => {
    const r = s({ refundStatus: "pending_stripe" });
    expect(r.kind).toBe("pending");
    expect(r.mayStartRefund).toBe(false);
    expect(r.remainingRefundableCents).toBeNull();
  });
  it("pending claim + provider pending: pending", () => {
    expect(s({ refundStatus: "pending_stripe", providerRefundStatus: "pending" }).kind).toBe("pending");
  });
  it("pending claim + provider requires_action: needs_action", () => {
    expect(s({ refundStatus: "pending_stripe", providerRefundStatus: "requires_action" }).kind).toBe("needs_action");
  });
  it("pending claim + provider failed/canceled is a disagreement: unclear, no retry (D-3)", () => {
    for (const p of ["failed", "canceled"]) {
      const r = s({ refundStatus: "pending_stripe", providerRefundStatus: p });
      expect(r.kind).toBe("unclear");
      expect(r.mayStartRefund).toBe(false);
    }
  });
  it("succeeded (full): refunded, nothing remains, no new refund", () => {
    expect(s({ refundStatus: "succeeded", refundAmountCents: 5000, providerRefundStatus: "succeeded" })).toEqual({
      kind: "refunded",
      remainingRefundableCents: 0,
      mayStartRefund: false,
    });
  });
  it("succeeded with provider silent still reads refunded", () => {
    expect(s({ refundStatus: "succeeded", refundAmountCents: 5000 }).kind).toBe("refunded");
  });
  it("succeeded (partial amount recorded): remaining is server-computed, still no new refund in R1", () => {
    expect(s({ refundStatus: "succeeded", refundAmountCents: 2000 })).toEqual({
      kind: "refunded",
      remainingRefundableCents: 3000,
      mayStartRefund: false,
    });
  });
  it("we say succeeded but the provider says failed or canceled: UNCLEAR, never 'refunded'", () => {
    for (const p of ["failed", "canceled"]) {
      expect(s({ refundStatus: "succeeded", refundAmountCents: 5000, providerRefundStatus: p }).kind).toBe("unclear");
    }
  });
  it("we say succeeded, provider still pending / needs action: surfaced as such", () => {
    expect(s({ refundStatus: "succeeded", refundAmountCents: 5000, providerRefundStatus: "pending" }).kind).toBe("pending");
    expect(s({ refundStatus: "succeeded", refundAmountCents: 5000, providerRefundStatus: "requires_action" }).kind).toBe("needs_action");
  });
  it("succeeded with no readable amount, a negative one, or more than the charge: unclear", () => {
    expect(s({ refundStatus: "succeeded" }).kind).toBe("unclear");
    expect(s({ refundStatus: "succeeded", refundAmountCents: -1 }).kind).toBe("unclear");
    expect(s({ refundStatus: "succeeded", refundAmountCents: 5001 }).kind).toBe("unclear");
  });
  it("a terminal failure of ours (provider silent, failed or canceled): failed, retry allowed, money stayed", () => {
    for (const p of [null, "failed", "canceled"]) {
      expect(s({ refundStatus: "failed", providerRefundStatus: p })).toEqual({
        kind: "failed",
        remainingRefundableCents: 5000,
        mayStartRefund: true,
      });
    }
  });
  it("a provider refund that we never recorded (any non-failed state) is money we cannot place: unclear, no new refund", () => {
    for (const p of ["pending", "requires_action", "succeeded"]) {
      const r = s({ refundStatus: null, providerRefundStatus: p });
      expect(r.kind).toBe("unclear");
      expect(r.mayStartRefund).toBe(false);
    }
    expect(s({ refundStatus: "failed", providerRefundStatus: "succeeded" }).kind).toBe("unclear");
  });
  it("an unrecognised value on either side is unclear", () => {
    expect(s({ refundStatus: "weird" }).kind).toBe("unclear");
    expect(s({ providerRefundStatus: "weird" }).kind).toBe("unclear");
  });
  it("an unreadable charge amount never yields a remaining figure or a retry", () => {
    const r = s({ amountCents: null });
    expect(r.remainingRefundableCents).toBeNull();
    expect(r.mayStartRefund).toBe(false);
  });
  it("remaining is never negative", () => {
    for (const a of [0, 1, 5000]) {
      for (const st of [null, "succeeded", "failed", "pending_stripe"]) {
        const r = s({ amountCents: a, refundStatus: st, refundAmountCents: a });
        if (r.remainingRefundableCents !== null) expect(r.remainingRefundableCents).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// Wiring tripwires: the select, the mapping and the type carry the provider column (0240 columns the refund runner
// already reads), so the panel can never be fed only OUR column again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
describe("refund status wiring (R1)", () => {
  const root = join(__dirname, "../../..");
  const elig = readFileSync(join(root, "lib/billing/session-payment-eligibility.ts"), "utf8");
  const types = readFileSync(join(root, "lib/billing/session-payment-types.ts"), "utf8");
  it("the attempt select, mapping and type include stripe_refund_status", () => {
    expect(elig).toMatch(/"id, status, amount_cents[^"]*\bstripe_refund_status\b/);
    expect(elig).toMatch(/stripeRefundStatus:[\s\S]{0,80}row\.stripe_refund_status/);
    expect(types).toMatch(/stripeRefundStatus:\s*string \| null/);
  });
});
