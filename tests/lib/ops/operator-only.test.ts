import { describe, expect, it } from "vitest";
import { isMemberSensitiveAlert, routeOperatorOnly } from "@/lib/ops/operator-only";

// HON-125. ops_alerts_member_read lets any member of a studio read every column of a studio-scoped row. An alert that carries
// money, a Stripe/attempt id or a client id must be written operator-only (studio_id NULL), keeping the ids for the operator.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "33333333-3333-4333-8333-333333333333";

describe("routeOperatorOnly", () => {
  it("routes a studio-scoped alert that names a client", () => {
    const r = routeOperatorOnly({ studioId: STUDIO, clientId: CLIENT, safeDetails: { reason: "x" } });
    expect(r).toEqual({ studioId: null, clientId: null, safeDetails: { reason: "x", studio_id: STUDIO, client_id: CLIENT } });
  });

  it.each([
    ["a Stripe event id", { stripeEventId: "evt_1" }],
    ["a payment intent id", { stripePaymentIntentId: "pi_1" }],
    ["a manual fee attempt id", { manualFeeAttemptId: "a1" }],
  ])("routes an alert carrying %s", (_n, extra) => {
    expect(routeOperatorOnly({ studioId: STUDIO, ...extra }).studioId).toBeNull();
  });

  it.each([
    "amount", "amount_cents", "amount_refunded", "currency", "stripe_charge_id", "stripeChargeId", "stripe_refund_id",
    "refund_idempotency_key", "attempt_id", "attemptId", "payment_intent_id", "setupIntentId", "stripe_customer_id",
    "receipt_email_to", "dispute_id", "charge_reason", "pending_fee",
    // HON-125 Privacy conditions: contact details, balances and free text
    "phone", "recipient_phone", "phoneNumber", "email", "client_email", "name", "client_name", "display_name", "balance", "balance_due",
    "total", "total_cents", "owed", "amount_owed", "paid", "paid_at", "deposit", "deposit_cents", "tip", "tip_amount", "tips",
  ])("routes an alert whose details carry %s", (key) => {
    const r = routeOperatorOnly({ studioId: STUDIO, safeDetails: { [key]: "v" } });
    expect(r.studioId, key).toBeNull();
    expect(r.safeDetails).toMatchObject({ studio_id: STUDIO });
  });

  it("looks inside nested details", () => {
    expect(routeOperatorOnly({ studioId: STUDIO, safeDetails: { outer: { amount_cents: 5 } } }).studioId).toBeNull();
  });

  it.each(["error", "provider_error", "error_safe", "err_message", "errorMessage", "error_message"])(
    "routes an alert whose details hold provider free text (%s), which can echo a phone number",
    (key) => {
      const r = routeOperatorOnly({ studioId: STUDIO, safeDetails: { [key]: "Invalid number +1 555 0100" } });
      expect(r.studioId, key).toBeNull();
      expect(r.safeDetails).toMatchObject({ studio_id: STUDIO });
    },
  );

  it.each([
    "attempt_count", "attempt_number", "reason", "sms_message_id", "purpose", "imageId", "provider_error_code", "reminder_type", "failure_class", "dead_count", "checked_at", "studio_id", "event_type", "code", "channel", "retryable",
  ])("leaves a delivery/ops detail (%s) studio-scoped", (key) => {
    const input = { studioId: STUDIO, appointmentId: "a", safeDetails: { [key]: "v" } };
    expect(isMemberSensitiveAlert(input)).toBe(false);
    expect(routeOperatorOnly(input)).toEqual({ studioId: STUDIO, clientId: null, safeDetails: { [key]: "v" } });
  });

  it("an alert with no studio is unchanged (already operator-only)", () => {
    const r = routeOperatorOnly({ studioId: null, clientId: CLIENT, stripePaymentIntentId: "pi_1", safeDetails: { amount: 1 } });
    expect(r).toEqual({ studioId: null, clientId: CLIENT, safeDetails: { amount: 1 } });
  });

  it("never overwrites a studio_id or client_id the caller already put in the details", () => {
    const r = routeOperatorOnly({ studioId: STUDIO, clientId: CLIENT, safeDetails: { studio_id: "kept", client_id: "kept2" } });
    expect(r.safeDetails).toEqual({ studio_id: "kept", client_id: "kept2" });
  });

  it("does not mutate the caller's details", () => {
    const details = { amount: 1 };
    routeOperatorOnly({ studioId: STUDIO, safeDetails: details });
    expect(details).toEqual({ amount: 1 });
  });
});
