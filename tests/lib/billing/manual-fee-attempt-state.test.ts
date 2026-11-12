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
    const P = { has_payment_intent: true, stripe_status: "canceled" };
    expect(feeAttemptState({ status: "failed", failure_code: "card_declined", ...P }, NOW)).toMatchObject({ kind: "failed", blocksNewCharge: false });
    const s = feeAttemptState({ status: "failed", failure_code: "requires_action_canceled", ...P }, NOW);
    expect(s).toMatchObject({ kind: "needs_action", blocksNewCharge: false });
    expect(s.label).toMatch(/nothing was taken/);
    // F3: without the provider object, or with a capture time, the claim is not supported: unclear, no charge.
    for (const extra of [{ has_payment_intent: false, stripe_status: "canceled" }, { has_payment_intent: true, stripe_status: "canceled", charged_at: "2026-11-01T10:00:00Z" }, {}]) {
      const u = feeAttemptState({ status: "failed", failure_code: "requires_action_canceled", ...extra }, NOW);
      expect(u).toMatchObject({ kind: "unclear", blocksNewCharge: true });
      expect(u.label).not.toMatch(/nothing was taken/);
    }
  });
  describe("Sam's needs-action ruling: free ONLY on provider-proven canceled + uncaptured; the label alone never frees", () => {
    const PROVEN = { status: "failed", failure_code: "requires_action_canceled", has_payment_intent: true, stripe_status: "canceled", charged_at: null, stripe_charge_id: null };
    it("canceled + same PaymentIntent on the attempt + no capture frees the appointment", () => {
      expect(feeAttemptState(PROVEN, NOW).blocksNewCharge).toBe(false);
      expect(feeAttemptState({ ...PROVEN, failure_code: "card_declined" }, NOW).blocksNewCharge).toBe(false);
    });
    it("every still-collectable or unknown provider status BLOCKS (requires_action, requires_payment_method, processing, requires_capture, null, odd)", () => {
      for (const stripe_status of ["requires_action", "requires_payment_method", "requires_confirmation", "processing", "requires_capture", "succeeded", null, undefined, "", "weird"]) {
        const s = feeAttemptState({ ...PROVEN, stripe_status }, NOW);
        expect(s, String(stripe_status)).toMatchObject({ kind: "unclear", blocksNewCharge: true });
        expect(s.label).not.toMatch(/nothing was taken/);
      }
    });
    it("a failed LABEL with missing or contradictory provider fields BLOCKS", () => {
      for (const over of [{ has_payment_intent: false }, { charged_at: "2026-11-01T10:00:00Z" }, { stripe_charge_id: "ch_x" }, { stripe_status: undefined, has_payment_intent: undefined }]) {
        expect(feeAttemptState({ ...PROVEN, ...over }, NOW), JSON.stringify(over)).toMatchObject({ blocksNewCharge: true });
      }
      expect(feeAttemptState({ status: "failed", failure_code: "card_declined" }, NOW).blocksNewCharge).toBe(true);
    });
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
    expect(f.line).toBe("Refund did not go through");
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
