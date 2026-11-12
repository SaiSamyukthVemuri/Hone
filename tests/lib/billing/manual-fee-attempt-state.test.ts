import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FEE_PENDING_WINDOW_MS,
  FEE_UNCLEAR_MESSAGE,
  feeAttemptState,
  feeRefund,
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

describe("feeRefund (the shared R1 logic, mapped to labels)", () => {
  const base = { status: "succeeded", amount_cents: 5000 };
  it("says nothing for a charge never refunded, and for a charge that did not succeed", () => {
    expect(feeRefund(base).line).toBeNull();
    expect(feeRefund({ ...base, status: "failed", refund_status: "succeeded" }).line).toBeNull();
  });
  it("uses the SAME function as the session card: Refunded needs ours AND the provider to agree", () => {
    expect(feeRefund({ ...base, refund_status: "succeeded", refund_amount_cents: 5000, stripe_refund_status: "succeeded" }).line).toBe("Refunded");
    expect(feeRefund({ ...base, refund_status: "succeeded", refund_amount_cents: 5000, stripe_refund_status: "failed" }).line).toBe("Refund needs review");
  });
  it("processing never offers a new refund; a failed refund with no provider trace does", () => {
    const p = feeRefund({ ...base, refund_status: "pending_stripe" });
    expect(p.line).toBe("Refund processing");
    expect(p.display.mayStartRefund).toBe(false);
    const f = feeRefund({ ...base, refund_status: "failed" });
    expect(f.line).toBe("Refund did not go through; no money moved");
    expect(f.display.mayStartRefund).toBe(true);
  });
  it("a provider trace on a refund that did not complete is a review, never a retry", () => {
    const r = feeRefund({ ...base, refund_status: "failed", stripe_refund_id: "re_x", stripe_refund_status: "failed" });
    expect(r.line).toBe("Refund needs review");
    expect(r.display.mayStartRefund).toBe(false);
  });
  it("a provider refund that needs action shows the shared action heading", () => {
    expect(feeRefund({ ...base, refund_status: "pending_stripe", stripe_refund_status: "requires_action" }).line).toBe("Refund needs action at Stripe");
  });
  it("an unknown value is a review, never a guess", () => {
    expect(feeRefund({ ...base, refund_status: "weird" }).line).toBe("Refund needs review");
  });
  it("is the shared function, not a copy", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../lib/billing/manual-fee-attempt-state.ts"), "utf8");
    expect(src).toMatch(/refundDisplayState\(\{/);
    expect(src).toMatch(/from "@\/lib\/billing\/refund-display-state"/);
  });
});
