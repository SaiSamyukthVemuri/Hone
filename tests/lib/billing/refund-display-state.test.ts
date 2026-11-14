import { describe, expect, it } from "vitest";
import { refundDisplayState, type RefundDisplayInput } from "@/lib/billing/refund-display-state";

const base: RefundDisplayInput = {
  chargeStatus: "succeeded",
  amountCents: 5000,
  refundStatus: null,
  refundAmountCents: null,
  providerRefundStatus: null,
  stripeRefundId: null,
  cumulativeFullRefundVerified: false,
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
  it("a terminal failure of ours with NO provider trace: failed, retry allowed, money stayed", () => {
    expect(s({ refundStatus: "failed" })).toEqual({ kind: "failed", remainingRefundableCents: 5000, mayStartRefund: true });
  });
  it("ANY provider trace blocks a new attempt (the runner returns needs_manual_review): needs_review, no retry (Insurance F1)", () => {
    for (const o of [null, "failed"]) {
      for (const p of ["failed", "canceled"]) {
        expect(s({ refundStatus: o, providerRefundStatus: p })).toEqual({
          kind: "needs_review",
          remainingRefundableCents: 5000,
          mayStartRefund: false,
        });
      }
      // an object id with no status is a trace too
      expect(s({ refundStatus: o, stripeRefundId: "re_x" }).kind).toBe("needs_review");
      expect(s({ refundStatus: o, stripeRefundId: "re_x" }).mayStartRefund).toBe(false);
    }
  });
  it("a new attempt is offered ONLY when provider status and refund id are both null", () => {
    const rows = [
      [null, null, null, true],
      ["failed", null, null, true],
      [null, "failed", null, false],
      [null, null, "re_1", false],
      ["failed", "canceled", "re_1", false],
    ] as const;
    for (const [o, p, id, may] of rows) {
      expect(s({ refundStatus: o, providerRefundStatus: p, stripeRefundId: id }).mayStartRefund, `${o}/${p}/${id}`).toBe(may);
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
  // Codex P2 on #1427 (lib/billing/refund-display-state.ts): 0240 reconcile_bound_payment_event sets refund_status='succeeded' with the
  // FULL amount from a signed cumulative receipt (stripe_charge_refund_event_id) and leaves stripe_refund_status untouched. Mirrors the
  // DB test "0240 prior actual single failed|succeeded identity does not block or get rewritten by cumulative full truth".
  describe("verified cumulative full refund beside a prior single refund (0240)", () => {
    const cumulative = { refundStatus: "succeeded", refundAmountCents: 5000, cumulativeFullRefundVerified: true };
    it.each(["failed", "canceled"])("a prior single refund %s, then a verified cumulative full refund: REFUNDED, no new refund", (single) => {
      expect(s({ ...cumulative, providerRefundStatus: single, stripeRefundId: "re_prior" })).toEqual({
        kind: "refunded", remainingRefundableCents: 0, mayStartRefund: false,
      });
    });
    it("a prior single refund that SUCCEEDED, then the cumulative receipt: refunded (unchanged)", () => {
      expect(s({ ...cumulative, providerRefundStatus: "succeeded" }).kind).toBe("refunded");
    });
    it.each(["pending", "requires_action"])("a prior single refund %s beside the verified full receipt is still completed (the receipt is monotonic)", (single) => {
      expect(s({ ...cumulative, providerRefundStatus: single }).kind).toBe("refunded");
    });
    it("WITHOUT the receipt the same columns stay unclear (the disagreement rule is unchanged)", () => {
      expect(s({ ...cumulative, cumulativeFullRefundVerified: false, providerRefundStatus: "failed" }).kind).toBe("unclear");
    });
    it("the receipt never completes a refund whose recorded amount is not the whole charge", () => {
      expect(s({ ...cumulative, refundAmountCents: 4999, providerRefundStatus: "failed" }).kind).toBe("unclear");
      expect(s({ ...cumulative, refundAmountCents: null, providerRefundStatus: "failed" }).kind).toBe("unclear");
      expect(s({ ...cumulative, refundAmountCents: 5001, providerRefundStatus: "failed" }).kind).toBe("unclear");
    });
    it("an unprovable amount (fractional or negative) is never completed by the receipt", () => {
      expect(s({ ...cumulative, amountCents: 50.5, refundAmountCents: 50.5, providerRefundStatus: "failed" }).kind).toBe("unclear");
      expect(s({ ...cumulative, amountCents: -5, refundAmountCents: -5, providerRefundStatus: "failed" }).kind).toBe("unclear");
    });
    it("the receipt never turns our failed/none/pending claim into a completed refund", () => {
      for (const ours of [null, "failed", "pending_stripe"]) {
        expect(s({ refundStatus: ours, refundAmountCents: 5000, cumulativeFullRefundVerified: true, providerRefundStatus: "failed" }).kind).not.toBe("refunded");
      }
    });
    it("an unknown value still wins: unclear", () => {
      expect(s({ ...cumulative, providerRefundStatus: "weird" }).kind).toBe("unclear");
      expect(s({ ...cumulative, refundStatus: "weird" }).kind).toBe("unclear");
    });
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
  it("the cumulative receipt reaches the display as a boolean only: selected, derived on the server, never sent as an id", () => {
    expect(elig).toMatch(/"id, status, amount_cents[^"]*\bstripe_charge_refund_event_id\b/);
    expect(elig).toMatch(/cumulativeFullRefundVerified:[\s\S]{0,160}row\.stripe_charge_refund_event_id/);
    expect(types).toMatch(/cumulativeFullRefundVerified:\s*boolean/);
    expect(types).not.toMatch(/stripeChargeRefundEventId/);
    for (const f of ["components/session-payment-prepare-card.tsx", "lib/payments/payment-summary-presenter.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      const calls = src.match(/refundDisplayState\(\{[\s\S]*?\}\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c).toMatch(/cumulativeFullRefundVerified:\s*\w+\.cumulativeFullRefundVerified/);
    }
  });
});
