import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { buildChargeRefundHistoryEvidence } from "@/lib/billing/refund-history";

// HON-49 (0358): the evidence the webhook sends to record_charge_refund_history is built from the SIGNED charge only: the identity fields come from the signed event's own charge, never from the stored attempt.

const refund = (over: Record<string, unknown> = {}) => ({ object: "refund", id: "re_1", amount: 2000, currency: "cad", charge: "ch_1", payment_intent: "pi_1", status: "succeeded", ...over });
const charge = (over: Record<string, unknown> = {}) => ({
  object: "charge", id: "ch_1", amount: 5000, currency: "cad", customer: "cus_1", payment_intent: "pi_1", amount_refunded: 2000,
  refunds: { object: "list", has_more: false, data: [refund()] }, ...over,
}) as unknown as Stripe.Charge;
const EVENT = { id: "evt_1", created: 1770000000 };

describe("buildChargeRefundHistoryEvidence", () => {
  it("builds the object from the signed charge and its complete refund list", () => {
    expect(buildChargeRefundHistoryEvidence(EVENT, charge())).toEqual({
      customer_id: "cus_1", payment_intent_id: "pi_1", charge_id: "ch_1", amount_cents: 5000, currency: "cad", event_created: 1770000000,
      evidence_kind: "signed_event", charge_amount_refunded: 2000, charge_refund_list_complete: true,
      components: [{ refund_id: "re_1", amount_cents: 2000, currency: "cad", refund_status: "succeeded", charge_id: "ch_1", payment_intent_id: "pi_1" }],
    });
  });

  it("takes every identity field from the event's own objects (expanded customer / payment intent / charge objects are read by id)", () => {
    const e = buildChargeRefundHistoryEvidence(EVENT, charge({ customer: { id: "cus_x" }, payment_intent: { id: "pi_x" } }));
    expect(e).toMatchObject({ customer_id: "cus_x", payment_intent_id: "pi_x" });
  });

  it("a field the signed charge does not carry stays null (never filled in): the command then refuses the identity", () => {
    expect(buildChargeRefundHistoryEvidence(EVENT, charge({ customer: null }))).toMatchObject({ customer_id: null });
    expect(buildChargeRefundHistoryEvidence(EVENT, charge({ payment_intent: undefined }))).toMatchObject({ payment_intent_id: null });
  });

  it("an incomplete, absent or empty refund list builds nothing (a truncated list says nothing about the refunds it hides)", () => {
    expect(buildChargeRefundHistoryEvidence(EVENT, charge({ refunds: { object: "list", has_more: true, data: [refund()] } }))).toBeNull();
    expect(buildChargeRefundHistoryEvidence(EVENT, charge({ refunds: undefined }))).toBeNull();
    expect(buildChargeRefundHistoryEvidence(EVENT, charge({ refunds: { object: "list", has_more: false, data: [] } }))).toBeNull();
    expect(buildChargeRefundHistoryEvidence(EVENT, charge({ refunds: { object: "list", data: [refund()] } }))).toBeNull(); // has_more absent
  });

  it("builds nothing for an unusable event time or refunded total", () => {
    expect(buildChargeRefundHistoryEvidence({ id: "evt_1", created: -1 }, charge())).toBeNull();
    expect(buildChargeRefundHistoryEvidence({ id: " ", created: 1 }, charge())).toBeNull();
    expect(buildChargeRefundHistoryEvidence(EVENT, charge({ amount_refunded: 1.5 }))).toBeNull();
  });

  it("every status the provider reports is carried as it is (the command, not the app, decides what a status means)", () => {
    const e = buildChargeRefundHistoryEvidence(EVENT, charge({ refunds: { object: "list", has_more: false, data: [refund({ status: "pending" }), refund({ id: "re_2", status: "requires_action" })] } }));
    expect((e!.components as Array<{ refund_status: string }>).map((c) => c.refund_status)).toEqual(["pending", "requires_action"]);
  });
});

describe("source guard: the identity fields never come from the stored attempt, so the builder cannot read it", () => {
  // Comments explain the rule in words; the guard reads the CODE only.
  const src = readFileSync("lib/billing/refund-history.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  it("takes no attempt argument and names no attempt column", () => {
    expect(src).not.toMatch(/\battempt\b\s*[:,)]/i);
    expect(src).not.toMatch(/stripe_customer_id|stripe_payment_intent_id|stripe_charge_id|amount_cents\s*:\s*attempt|attempt\./);
  });
  it("is the only place that builds the history evidence, and the webhook passes it the signed charge", () => {
    const hook = readFileSync("lib/billing/payment-webhook-reconciliation.ts", "utf8");
    expect(hook).toMatch(/buildChargeRefundHistoryEvidence\(\{ id: event\.id, created: event\.created \}, charge, kind\)/);
    expect(hook).toMatch(/rpc\("record_charge_refund_history"/);
  });
});
