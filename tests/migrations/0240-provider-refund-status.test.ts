import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const action = readFileSync("lib/billing/payment-refund.ts", "utf8");
const route = readFileSync("app/api/stripe/webhook/route.ts", "utf8");
describe("0240 actual provider refund status", () => {
  it("routes action outcomes through the command and reads committed completion", () => {
    expect(action).toContain('p_event_type: "refund.observed"');
    expect(action).toContain('evidence_kind: "action_response"');
    const readerStart = action.indexOf("async function verifiedSavedRefundTimestamp(");
    expect(readerStart).toBeGreaterThan(-1);
    const reader = action.slice(readerStart, action.indexOf("const { data: observationRows", readerStart));
    expect(reader).toContain("!savedError && saved &&");
    expect(reader).toContain('saved.refund_status === "succeeded"');
    expect(reader).toContain("saved.stripe_refund_id === refundId");
    expect(reader).toContain("saved.refund_amount_cents === refundAmountCents");
    expect(reader).toContain("Number.isFinite(Date.parse(saved.refunded_at))");
    expect(action).toContain("const refundedAtIso = await verifiedSavedRefundTimestamp(attempt, refund.id)");
    expect(action).toMatch(/if \(!refundedAtIso\) \{[\s\S]*?outcome: "needs_manual_review"/);
    expect(action).toContain("providerCharge !== attempt.stripe_charge_id");
    expect(action).toContain("providerIntent !== attempt.stripe_payment_intent_id");
  });
  it("handles signed status events without initiating provider refunds", () => {
    for (const type of ["refund.created", "refund.updated", "refund.failed"]) expect(route).toContain(`case "${type}":`);
    expect(route).toContain("handleRefundStatusEvent(event, ctx)");
  });
});
