import { beforeEach, describe, expect, it, vi } from "vitest";
import { metadataDigest } from "@/e2e-payment/helpers/fake-stripe-metadata-digest";

// The fake webhook transport must name the attempt's Stripe Customer on the
// objects it signs. The webhook's identity check compares the event's
// pi.customer / charge.customer with payment_charge_attempts.stripe_customer_id
// and refuses a mismatch ("customer"), so an event without one is refused
// though nothing about the payment is wrong (#908 run 39877169098,
// willow/FAKE-STRIPE-WEBHOOK-IDENTITY-END.json). The fake ledger records no
// client identity, so the customer comes from the row, and only from it.

// local-env refuses the unit lane's hosted placeholder env at import.
vi.mock("@/e2e/helpers/local-env", () => ({
  E2E_APP_ORIGIN: "http://127.0.0.1:3000",
  E2E_WEB_SERVER_ENV: { STRIPE_WEBHOOK_SECRET: "whsec_unit" },
}));

let row: Record<string, unknown>;
const selects: string[] = [];
// Projects the row to the columns the helper's SELECT names, so a column the
// query forgets is absent exactly as it would be from Postgres.
vi.mock("@/tests/db/helpers/harness", () => ({
  adminQuery: async (sql: string) => {
    selects.push(sql);
    const list = /select([\s\S]*?)from/i.exec(sql)?.[1] ?? "";
    const cols = list.split(",").map((c) => c.trim()).filter(Boolean);
    return { rows: [Object.fromEntries(cols.map((c) => [c, row[c]]))] };
  },
}));

let calls: unknown[];
vi.mock("@/e2e-payment/helpers/fake-stripe-ledger-e2e", () => ({
  activeRunId: () => "unitrun",
  readFakeStripeCalls: () => calls,
}));

const { paymentIntentSucceededEvent, chargeRefundedEvent } = await import(
  "@/e2e-payment/helpers/fake-stripe-webhook"
);

const ACCOUNT = "acct_unit_studio";
const CUSTOMER = "cus_unit_attempt";
const PI = "pi_test_e2e_unitrun_1";
const CHARGE = "ch_test_e2e_unitrun_1";
const ATTEMPT = "attempt-unit-1";

function baseRow(): Record<string, unknown> {
  return {
    id: ATTEMPT,
    studio_id: "studio-unit",
    client_id: "client-unit",
    session_id: "session-unit",
    appointment_id: null,
    charge_reason: "session_payment",
    card_authorization_signature_id: null,
    stripe_account_id: ACCOUNT,
    stripe_customer_id: CUSTOMER,
    stripe_payment_intent_id: PI,
    stripe_charge_id: CHARGE,
    stripe_idempotency_key: "hone:charge:unit:v1",
  };
}

function sentMetadata(r: Record<string, unknown>): Record<string, string> {
  return {
    hone_studio_id: String(r.studio_id),
    hone_client_id: String(r.client_id),
    hone_session_id: String(r.session_id ?? ""),
    hone_appointment_id: String(r.appointment_id ?? ""),
    hone_session_payment_charge_attempt_id: String(r.id),
    hone_charge_reason: String(r.charge_reason),
    hone_card_authorization_signature_id: String(r.card_authorization_signature_id ?? ""),
    hone_environment: "test",
  };
}

function ledger(r: Record<string, unknown>, account = ACCOUNT) {
  return [
    {
      method: "pi_create",
      idempotencyKey: r.stripe_idempotency_key,
      stripeAccount: account,
      amountCents: 12000,
      currency: "usd",
      resultId: PI,
      chargeId: CHARGE,
      metadataDigest: metadataDigest(sentMetadata(r)),
      replay: false,
    },
    {
      method: "refund_create",
      idempotencyKey: `hone:payment_refund:${ATTEMPT}:v1`,
      stripeAccount: account,
      amountCents: 12000,
      currency: "usd",
      resultId: "re_test_e2e_unitrun_1",
      chargeId: CHARGE,
      replay: false,
    },
  ];
}

beforeEach(() => {
  row = baseRow();
  calls = ledger(row);
  selects.length = 0;
});

describe("fake Stripe webhook names the attempt's customer", () => {
  it("payment_intent.succeeded carries the attempt's stripe_customer_id", async () => {
    const event = await paymentIntentSucceededEvent(ATTEMPT);
    expect(event.data.object).toMatchObject({ object: "payment_intent", id: PI, customer: CUSTOMER });
    expect(selects[0]).toMatch(/\bstripe_customer_id\b/);
  });

  it("charge.refunded carries the attempt's stripe_customer_id", async () => {
    const event = await chargeRefundedEvent(ATTEMPT);
    expect(event.data.object).toMatchObject({ object: "charge", id: CHARGE, customer: CUSTOMER });
  });
});

describe("anti-overreach: the customer is the row's, never invented, and nothing else moves", () => {
  it("a row without a customer yields customer null on both events, so the app's refusal stays visible", async () => {
    row.stripe_customer_id = null;
    const succeeded = await paymentIntentSucceededEvent(ATTEMPT);
    const refunded = await chargeRefundedEvent(ATTEMPT);
    expect((succeeded.data.object as { customer: unknown }).customer).toBeNull();
    expect((refunded.data.object as { customer: unknown }).customer).toBeNull();
  });

  it("a different row customer is passed through as-is, not normalised to any fixed value", async () => {
    row.stripe_customer_id = "cus_unit_other";
    const event = await paymentIntentSucceededEvent(ATTEMPT);
    expect((event.data.object as { customer: unknown }).customer).toBe("cus_unit_other");
  });

  it("only the object gains customer: the envelope, the account and the nested refund are unchanged", async () => {
    const event = await chargeRefundedEvent(ATTEMPT);
    expect(event).not.toHaveProperty("customer");
    expect(event.account).toBe(ACCOUNT);
    const refund = (event.data.object as { refunds: { data: Record<string, unknown>[] } }).refunds.data[0];
    expect(refund).not.toHaveProperty("customer");
    expect(event.data.object).toHaveProperty("customer", CUSTOMER);
  });

  it("provider lineage is still refused: an account the processor did not create on builds no event", async () => {
    calls = ledger(row, "acct_unit_elsewhere");
    await expect(paymentIntentSucceededEvent(ATTEMPT)).rejects.toThrow(/provider lineage broken/);
    await expect(chargeRefundedEvent(ATTEMPT)).rejects.toThrow(/provider lineage broken/);
  });
});
