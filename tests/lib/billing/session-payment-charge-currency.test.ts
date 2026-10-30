import { beforeEach, describe, expect, it, vi } from "vitest";

// #1035 Codex P1 #4369182087. THE CURRENCY SENT TO STRIPE IS THE PERSISTED
// ATTEMPT CURRENCY. The real runSessionPaymentCharge runs against a faked Stripe
// and admin client (same harness shape as stripe-error-outcome-charge.test.ts);
// the oracle is the params the faked paymentIntents.create received.
//   US studio: the USD amount is what Stripe is asked for.
//   CA studio: CAD.
//   An unreadable or unsupported stored currency is refused BEFORE any Stripe call.

const h = vi.hoisted(() => ({
  createParams: [] as Array<Record<string, unknown>>,
  rows: {} as Record<string, unknown>,
}));

const fakeStripe = {
  paymentIntents: {
    create: async (params: Record<string, unknown>) => {
      h.createParams.push(params);
      return {
        id: "pi_test", status: "succeeded", amount: params.amount, currency: params.currency,
        latest_charge: "ch_test", customer: "cus_test", livemode: false,
        metadata: params.metadata,
      };
    },
    retrieve: async () => { throw new Error("retrieve must not be reached"); },
    cancel: async () => { throw new Error("cancel must not be reached"); },
  },
};

vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false, getStripe: () => fakeStripe }));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({ getSessionPaymentStripe: () => fakeStripe }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {}, recordOpsAlertDurably: async () => true }));
vi.mock("@/lib/billing/charge-description", () => ({ buildChargeDescription: () => "desc" }));
vi.mock("@/lib/consent/current-card-authorization", () => {
  const signed = async () => ({ kind: "signed_current", signatureId: "sig-1", templateId: "tpl-1", templateVersion: 3, signedAt: "2026-08-01T00:00:00.000Z" });
  return { getChargeReadyCardAuthorizationStatus: signed, getCardAuthorizationStatus: signed };
});

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const PRACTITIONER = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const APPOINTMENT = "66666666-6666-4666-8666-666666666666";
const AMOUNT = 12000;

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      let isUpdate = false;
      const read = () => ({ data: h.rows[table] ?? null, error: null });
      q.select = () => (isUpdate ? Promise.resolve({ data: [{ id: ATTEMPT }], error: null }) : q);
      for (const m of ["eq", "is", "in", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => read();
      q.single = async () => read();
      q.then = (resolve: (v: unknown) => unknown) => resolve(isUpdate ? { data: [{ id: ATTEMPT }], error: null } : read());
      q.update = () => { isUpdate = true; return q; };
      q.insert = () => { throw new Error(`unexpected insert on ${table}`); };
      return q;
    },
    rpc: async (name: string) => {
      if (name !== "claim_session_payment_charge_attempt") return { data: null, error: null };
      const row = h.rows.payment_charge_attempts as Record<string, unknown>;
      return {
        data: [{
          result: "claimed", attempt_id: ATTEMPT, studio_id: STUDIO, client_id: CLIENT, session_id: SESSION,
          appointment_id: APPOINTMENT, charge_reason: "session_payment", amount_cents: AMOUNT, currency: row.currency,
          client_payment_method_id: "cpm-1", card_authorization_signature_id: "sig-1", stripe_account_id: "acct_test",
          stripe_customer_id: "cus_test", stripe_payment_method_id: "pm_test", stripe_payment_intent_id: null,
          stripe_idempotency_key: null, status_before_claim: "ready", updated_at: new Date().toISOString(),
        }],
        error: null,
      };
    },
  }),
}));

const { runSessionPaymentCharge } = await import("@/lib/billing/session-payment-charge");

function setup(attemptCurrency: unknown, jurisdiction: { payment_country: string; payment_currency: string }) {
  h.createParams = [];
  h.rows = {
    payment_charge_attempts: {
      id: ATTEMPT, studio_id: STUDIO, charge_reason: "session_payment", client_id: CLIENT, session_id: SESSION,
      appointment_id: APPOINTMENT, amount_cents: AMOUNT, currency: attemptCurrency, status: "ready",
      stripe_livemode: false, client_payment_method_id: "cpm-1", card_authorization_signature_id: "sig-1",
      stripe_account_id: "acct_test", stripe_customer_id: "cus_test", stripe_payment_method_id: "pm_test",
      stripe_payment_intent_id: null, stripe_idempotency_key: null, updated_at: "2026-08-01T00:00:00.000Z",
    },
    client_payment_methods: {
      id: "cpm-1", studio_id: STUDIO, client_id: CLIENT, status: "active", stripe_livemode: false,
      stripe_account_id: "acct_test", stripe_customer_id: "cus_test", stripe_payment_method_id: "pm_test",
      card_authorization_signature_id: "sig-1",
    },
    studio_payment_settings: {
      stripe_account_id: "acct_test", stripe_livemode: false, stripe_account_country: jurisdiction.payment_country,
      stripe_account_country_conflict: null,
    },
    studio_payment_jurisdictions: jurisdiction,
    client_stripe_customers: { stripe_customer_id: "cus_test" },
  };
}

const run = () => runSessionPaymentCharge({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: PRACTITIONER } as never);

beforeEach(() => { h.createParams = []; });

describe("the currency sent to Stripe is the persisted attempt currency", () => {
  it("US studio, usd attempt: Stripe is asked for exactly 12000 usd", async () => {
    setup("usd", { payment_country: "US", payment_currency: "usd" });
    const r = await run();
    expect(h.createParams).toHaveLength(1);
    expect(h.createParams[0]).toMatchObject({ amount: AMOUNT, currency: "usd" });
    expect(r).toMatchObject({ ok: true });
  });

  it("CA studio, cad attempt: Stripe is asked for exactly 12000 cad", async () => {
    setup("cad", { payment_country: "CA", payment_currency: "cad" });
    const r = await run();
    expect(h.createParams).toHaveLength(1);
    expect(h.createParams[0]).toMatchObject({ amount: AMOUNT, currency: "cad" });
    expect(r).toMatchObject({ ok: true });
  });

  it.each([["eur"], [null], ["USD"], [""], [undefined]])(
    "stored currency %j: blocked before any Stripe call",
    async (stored) => {
      setup(stored, { payment_country: "US", payment_currency: "usd" });
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "blocked" });
      expect(h.createParams).toHaveLength(0);
    },
  );
});
