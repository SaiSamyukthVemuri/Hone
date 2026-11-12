import { describe, expect, it } from "vitest";
import {
  FEE_PENDING_WINDOW_MS,
  FEE_UNCLEAR_MESSAGE,
  feeAttemptState,
  feeRefundLine,
} from "@/lib/billing/manual-fee-attempt-state";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("feeAttemptState", () => {
  it("ready and succeeded block a new charge; cancelled does not", () => {
    expect(feeAttemptState({ status: "ready" }, NOW)).toMatchObject({ kind: "ready", blocksNewCharge: true });
    expect(feeAttemptState({ status: "succeeded" }, NOW)).toMatchObject({ kind: "succeeded", blocksNewCharge: true });
    expect(feeAttemptState({ status: "cancelled" }, NOW)).toMatchObject({ kind: "cancelled", blocksNewCharge: false });
  });
  it("pending_stripe is PENDING inside the window and may be refreshed", () => {
    const s = feeAttemptState({ status: "pending_stripe", updated_at: ago(60_000) }, NOW);
    expect(s).toMatchObject({ kind: "pending", blocksNewCharge: true, mayRefreshCharge: true });
  });
  it("pending_stripe past the window is UNCLEAR: no refresh, no new charge", () => {
    const s = feeAttemptState({ status: "pending_stripe", updated_at: ago(FEE_PENDING_WINDOW_MS + 1) }, NOW);
    expect(s).toMatchObject({ kind: "unclear", blocksNewCharge: true, mayRefreshCharge: false });
  });
  it("pending_stripe with no readable or a future time is UNCLEAR, never pending", () => {
    for (const updated_at of [null, undefined, "not a date", new Date(NOW.getTime() + 5 * 60_000).toISOString()]) {
      expect(feeAttemptState({ status: "pending_stripe", updated_at }, NOW).kind).toBe("unclear");
    }
  });
  it("an unrecognised or missing status is UNCLEAR, never a guess", () => {
    for (const status of ["blocked", "requires_action", "weird", "", null, undefined]) {
      const s = feeAttemptState({ status }, NOW);
      expect(s).toMatchObject({ kind: "unclear", blocksNewCharge: true, mayRefreshCharge: false });
    }
  });
  it("failed is failed; the requires_action cancel is its own state that says nothing was taken", () => {
    expect(feeAttemptState({ status: "failed", failure_code: "card_declined" }, NOW).kind).toBe("failed");
    const s = feeAttemptState({ status: "failed", failure_code: "requires_action_canceled" }, NOW);
    expect(s.kind).toBe("needs_action");
    expect(s.label).toMatch(/nothing was taken/);
  });
  it("the unclear message is the required wording", () => {
    expect(FEE_UNCLEAR_MESSAGE).toBe("Charge status is unclear. Do not charge again until this is checked.");
  });
  it("only a pending attempt may be refreshed", () => {
    for (const status of ["ready", "succeeded", "failed", "cancelled", "blocked", "x"]) {
      expect(feeAttemptState({ status, updated_at: ago(1000) }, NOW).mayRefreshCharge).toBe(false);
    }
  });
});

describe("feeRefundLine", () => {
  it("says nothing for a charge that was never refunded, and for a charge that did not succeed", () => {
    expect(feeRefundLine({ status: "succeeded" })).toBeNull();
    expect(feeRefundLine({ status: "failed", refund_status: "succeeded" })).toBeNull();
  });
  it("Refunded only when ours and the provider's both say succeeded", () => {
    expect(feeRefundLine({ status: "succeeded", refund_status: "succeeded", stripe_refund_status: "succeeded" })).toBe("Refunded");
  });
  it("processing while ours is pending and the provider is silent or pending", () => {
    expect(feeRefundLine({ status: "succeeded", refund_status: "pending_stripe" })).toBe("Refund processing");
    expect(feeRefundLine({ status: "succeeded", refund_status: "pending_stripe", stripe_refund_status: "pending" })).toBe("Refund processing");
  });
  it("never 'failed' and never 'refunded' on disagreement, an unknown value or a bare provider trace", () => {
    const unclear = "Refund status unclear. Do not refund again until this is checked.";
    for (const row of [
      { refund_status: "succeeded", stripe_refund_status: "failed" },
      { refund_status: "failed", stripe_refund_status: null },
      { refund_status: "failed", stripe_refund_status: "succeeded" },
      { refund_status: null, stripe_refund_status: "succeeded" },
      { refund_status: null, stripe_refund_id: "re_x" },
      { refund_status: "succeeded", stripe_refund_status: null },
      { refund_status: "weird" },
    ]) {
      expect(feeRefundLine({ status: "succeeded", ...row })).toBe(unclear);
    }
  });
});
