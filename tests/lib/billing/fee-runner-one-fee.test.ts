import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

// One manual fee per appointment at the POINT OF MONEY: the real runSessionPaymentCharge, with Stripe and the admin client
// faked (same harness shape as stripe-error-outcome-charge). A fee attempt whose appointment already holds another fee is
// refused BEFORE the claim and before any PaymentIntent create. Financial effects are counted on the fake: creates and claims.

const h = vi.hoisted(() => ({
  createError: null as unknown,
  createReply: null as Record<string, unknown> | null,
  retrieveReply: null as Record<string, unknown> | null,
  retrieveError: null as unknown,
  retrieveCalls: 0,
  claimPaymentIntentId: null as string | null,
  createKeys: [] as string[],
  alerts: [] as Array<{ severity: string; event: string }>,
  alertInputs: [] as unknown[],
  updates: [] as Array<Record<string, unknown>>,
  rows: {} as Record<string, unknown>,
  claimResult: "claimed" as string,
  /** Negative control: restore the pre-HON-11 rule. */
  legacyRule: false,
  siblings: [] as unknown[] | null,
  siblingsError: null as unknown,
  claimCalls: 0,
}));

const fakeStripe = {
  paymentIntents: {
    create: async (_params: unknown, opts: { idempotencyKey: string }) => {
      h.createKeys.push(opts.idempotencyKey);
      if (h.createReply) return h.createReply;
      throw h.createError;
    },
    retrieve: async () => {
      h.retrieveCalls += 1;
      if (h.retrieveReply) return h.retrieveReply;
      throw h.retrieveError ?? new Error("retrieve must not be reached");
    },
    cancel: async () => {
      throw new Error("cancel must not be reached");
    },
  },
};

vi.mock("@/lib/billing/stripe-error-outcome", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/billing/stripe-error-outcome")>();
  const { default: S } = await import("stripe");
  return {
    isDefinitiveStripeRefusal: (err: unknown) =>
      h.legacyRule ? err instanceof S.errors.StripeError : real.isDefinitiveStripeRefusal(err),
    isDefinitiveChargeRefusal: (err: unknown) =>
      h.legacyRule ? err instanceof S.errors.StripeError : real.isDefinitiveChargeRefusal(err),
  };
});
vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => false,
  getStripe: () => fakeStripe,
}));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({
  getSessionPaymentStripe: () => fakeStripe,
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (input: { severity: string; event: string }) => {
    h.alerts.push({ severity: input.severity, event: input.event });
    h.alertInputs.push(input);
  },
}));
vi.mock("@/lib/billing/charge-description", () => ({
  buildChargeDescription: () => "desc",
}));
vi.mock("@/lib/consent/current-card-authorization", () => {
  const signed = async () => ({
    kind: "signed_current",
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  });
  return {
    getChargeReadyCardAuthorizationStatus: signed,
    getCardAuthorizationStatus: signed,
  };
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
      let payload: Record<string, unknown> | null = null;
      let siblingQuery = false;
      const read = () =>
        table === "payment_charge_attempts" && siblingQuery
          ? { data: h.siblings, error: h.siblingsError }
          : { data: h.rows[table] ?? null, error: null };
      q.select = () => {
        if (isUpdate) {
          h.updates.push(payload ?? {});
          return Promise.resolve({ data: [{ id: ATTEMPT }], error: null });
        }
        return q;
      };
      for (const m of ["eq", "is", "in", "order", "limit"]) q[m] = () => q;
      q.neq = () => {
        siblingQuery = true;
        return q;
      };
      q.maybeSingle = async () => read();
      q.single = async () => read();
      q.then = (resolve: (v: unknown) => unknown) => {
        if (isUpdate) h.updates.push(payload ?? {});
        return resolve(isUpdate ? { data: [{ id: ATTEMPT }], error: null } : read());
      };
      q.update = (p: Record<string, unknown>) => {
        isUpdate = true;
        payload = p;
        return q;
      };
      q.insert = () => {
        throw new Error(`unexpected insert on ${table}`);
      };
      return q;
    },
    rpc: async (name: string) => {
      if (name !== "claim_session_payment_charge_attempt") return { data: null, error: null };
      h.claimCalls += 1;
      return {
        data: [
          {
            result: h.claimResult,
            attempt_id: ATTEMPT,
            studio_id: STUDIO,
            client_id: CLIENT,
            session_id: SESSION,
            appointment_id: APPOINTMENT,
            charge_reason: "no_show_fee",
            amount_cents: AMOUNT,
            currency: "cad",
            client_payment_method_id: "cpm-1",
            card_authorization_signature_id: "sig-1",
            stripe_account_id: "acct_test",
            stripe_customer_id: "cus_test",
            stripe_payment_method_id: "pm_test",
            stripe_payment_intent_id: h.claimPaymentIntentId,
            stripe_idempotency_key: null,
            status_before_claim: h.claimResult === "claimed" ? "ready" : "pending_stripe",
            // Recent, so an `already_pending` retry is inside the
            // reconciliation window and reaches paymentIntents.create.
            updated_at: new Date().toISOString(),
          },
        ],
        error: null,
      };
    },
  }),
}));

const { runSessionPaymentCharge } = await import("@/lib/billing/session-payment-charge");

const ATTEMPT_ROW = {
  id: ATTEMPT,
  studio_id: STUDIO,
  charge_reason: "no_show_fee",
  created_at: "2026-11-12T10:00:00.000Z",
  client_id: CLIENT,
  session_id: SESSION,
  appointment_id: APPOINTMENT,
  amount_cents: AMOUNT,
  currency: "cad",
  status: "ready",
  stripe_livemode: false,
  client_payment_method_id: "cpm-1",
  card_authorization_signature_id: "sig-1",
  stripe_account_id: "acct_test",
  stripe_customer_id: "cus_test",
  stripe_payment_method_id: "pm_test",
  stripe_payment_intent_id: null,
  stripe_idempotency_key: null,
  updated_at: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  h.createError = null;
  h.createReply = null;
  h.retrieveReply = null;
  h.retrieveError = null;
  h.retrieveCalls = 0;
  h.claimPaymentIntentId = null;
  h.createKeys = [];
  h.alerts = [];
  h.alertInputs = [];
  h.updates = [];
  h.claimResult = "claimed";
  h.legacyRule = false;
  h.siblings = [];
  h.siblingsError = null;
  h.claimCalls = 0;
  h.rows = {
    payment_charge_attempts: ATTEMPT_ROW,
    client_payment_methods: {
      id: "cpm-1",
      studio_id: STUDIO,
      client_id: CLIENT,
      status: "active",
      stripe_livemode: false,
      stripe_account_id: "acct_test",
      stripe_customer_id: "cus_test",
      stripe_payment_method_id: "pm_test",
      card_authorization_signature_id: "sig-1",
    },
    studio_payment_settings: { stripe_account_id: "acct_test", stripe_livemode: false },
    // Explicit verified synthetic configuration; no runtime country default.
    studio_payment_jurisdictions: { payment_country: "CA", payment_currency: "cad" },
    client_stripe_customers: { stripe_customer_id: "cus_test" },
  };
});

const run = () =>
  runSessionPaymentCharge({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: PRACTITIONER } as never);

const OK_PI = { id: "pi_ok", status: "succeeded", amount: AMOUNT, currency: "cad", latest_charge: "ch_ok" };
const sib = (over: Record<string, unknown>) => ({
  id: "77777777-7777-4777-8777-777777777777", charge_reason: "late_cancellation_fee", status: "succeeded",
  created_at: "2026-11-12T09:00:00.000Z", failure_code: null, stripe_payment_intent_id: "pi_other",
  charged_at: "2026-11-12T09:01:00.000Z", stripe_status: null, stripe_charge_id: null, updated_at: new Date().toISOString(), ...over,
});

describe("runner: the cross-type one-fee check runs before the claim and before any Stripe call", () => {
  it("control: no other fee -> the claim happens and Stripe is called once", async () => {
    h.createReply = OK_PI;
    await run();
    expect(h.claimCalls).toBe(1);
    expect(h.createKeys).toHaveLength(1);
  });
  for (const [name, row] of [
    ["a succeeded fee of the other type", sib({})],
    ["a refunded fee (still succeeded)", sib({ refund_status: "succeeded" })],
    ["an in-flight fee", sib({ status: "pending_stripe", charged_at: null })],
    ["an UNCERTAIN fee (pending, long ago)", sib({ status: "pending_stripe", charged_at: null, updated_at: "2026-11-01T00:00:00.000Z" })],
    ["an earlier ready fee", sib({ status: "ready", stripe_payment_intent_id: null, charged_at: null })],
  ] as const) {
    it(`${name}: refused, NO claim, NO PaymentIntent create`, async () => {
      h.createReply = OK_PI;
      h.siblings = [row];
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "blocked" });
      expect(h.claimCalls, "the claim must not be reached").toBe(0);
      expect(h.createKeys, "no Stripe create").toHaveLength(0);
    });
  }
  it("a definitively failed (or cancelled) other fee frees it: the charge runs", async () => {
    h.createReply = OK_PI;
    h.siblings = [sib({ status: "failed", failure_code: "card_declined", charged_at: null, stripe_status: "canceled", stripe_charge_id: null }), sib({ id: "88888888-8888-4888-8888-888888888888", status: "cancelled", stripe_payment_intent_id: null, charged_at: null })];
    await run();
    expect(h.claimCalls).toBe(1);
    expect(h.createKeys).toHaveLength(1);
  });
  for (const [first, second] of [["no_show_fee", "late_cancellation_fee"], ["late_cancellation_fee", "no_show_fee"]] as const) {
    it(`both orders: ${first} then ${second} -> exactly ONE PaymentIntent create in total`, async () => {
      const as = (reason: string) => ({ ...(h.rows.payment_charge_attempts as object), charge_reason: reason });
      h.createReply = OK_PI;
      h.rows = { ...h.rows, payment_charge_attempts: as(first) };
      expect(await run()).toBeDefined(); // the first fee runs
      // the second fee, of the OTHER type, now sees the first as a sibling that took the appointment
      h.rows = { ...h.rows, payment_charge_attempts: as(second) };
      h.siblings = [sib({ charge_reason: first, status: "succeeded" })];
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "blocked" });
      expect(h.createKeys, "one create across both fee types").toHaveLength(1);
    });
  }
  it("FAIL-CLOSED: an unreadable sibling history refuses before the claim", async () => {
    h.createReply = OK_PI;
    h.siblings = null;
    h.siblingsError = { code: "XX000" };
    const r = await run();
    expect(r).toMatchObject({ ok: false, outcome: "blocked" });
    expect(h.claimCalls).toBe(0);
    expect(h.createKeys).toHaveLength(0);
  });
  it("a retry of an ALREADY-PENDING attempt is not blocked by the check: same key, no second PaymentIntent", async () => {
    h.createError = new Stripe.errors.StripeConnectionError({ message: "synthetic" } as never);
    await run(); // uncertain outcome: pending_stripe, one create with the deterministic key
    h.siblings = [sib({ status: "ready", stripe_payment_intent_id: null, charged_at: null, created_at: "2026-11-12T11:00:00.000Z" })];
    h.claimResult = "already_pending";
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), status: "pending_stripe" } };
    await run();
    expect(h.createKeys).toHaveLength(2);
    expect(new Set(h.createKeys).size, "one idempotency key: Stripe cannot make a second charge").toBe(1);
    expect(h.createKeys[0]).toBe(`hone:no_show_fee:${ATTEMPT}:v1`);
  });
  it("session_payment is outside the check (no sibling read changes its result)", async () => {
    h.createReply = OK_PI;
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), charge_reason: "session_payment" } };
    h.siblings = [sib({})];
    await run();
    expect(h.claimCalls).toBe(1);
  });
});
