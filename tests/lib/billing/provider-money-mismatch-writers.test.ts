import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createFakeStripe, getFakeStripeCalls, resetFakeStripeState } from "@/lib/stripe/e2e-fake-stripe";

// ===========================================================================
// PAY-CCY-01 (#824) — EVERY LEDGER WRITER CHECKS THE PROVIDER'S MONEY FIRST
// ===========================================================================
//
// A payment_charge_attempts row fixes its amount_cents and currency when it is
// prepared. Six writers later record a Stripe object onto it: the synchronous
// charge, the reconcile re-read, the refund, and the succeeded / failed /
// refunded webhooks. Each now refuses to record an object whose amount or
// currency differs from the row's: critical alert, no ledger write.
//
// This file drives the REAL writers with a scripted admin client and a fake
// Stripe, because the question is whether each writer actually REACHES the
// check before it writes, which a source grep cannot answer. Every refusal has
// a matching-money control in the same block proving the writer still writes
// when the money agrees, in CAD and in USD alike.

class Tripwire extends Error {}

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  rpcCalls: [] as string[],
  updateAttempts: [] as Array<{ payload: Record<string, unknown>; filters: Array<{ column: string; value: unknown }>; matched: boolean }>,
  afterRetrieve: null as null | (() => void),
  recheckReadError: false,
  alerts: [] as Array<{ severity: string; event: string; details: Record<string, unknown> }>,
  claim: {} as Record<string, unknown>,
  pi: {} as Record<string, unknown>,
  createError: null as unknown,
  useExistingAdapter: false,
  confirmError: null as unknown,
  beforeBind: null as null | (() => void),
  afterBind: null as null | (() => void),
  beforeConfirm: null as null | (() => void | Promise<void>),
  createOverride: {} as Record<string, unknown>,
  ackMode: "ok" as string,
  claimDynamic: false,
  requests: [] as Array<{ method: string; id?: string; params: Record<string, unknown>; key: string; account: string }>,
  cache: new Map<string, { params: string; result: Record<string, unknown> }>(),
  cancelStatus: "canceled" as string,
  failedWriteZero: false,
  pendingWriteZero: false,
  refund: {} as Record<string, unknown>,
  stripeCalls: [] as string[],
}));

const fakeStripe = {
  paymentIntents: {
    create: async (params: Record<string, unknown>, options: { stripeAccount: string; idempotencyKey: string }) => {
      h.stripeCalls.push("pi_create");
      h.requests.push({ method: "create", params, key: options.idempotencyKey, account: options.stripeAccount });
      if (h.createError) throw h.createError;
      const scope = `${options.stripeAccount}:POST:/v1/payment_intents:${options.idempotencyKey}`;
      const prior = h.cache.get(scope);
      if (prior && prior.params !== JSON.stringify(params)) throw new Error("idempotency parameter mismatch");
      const result = prior?.result ?? (params.confirm === false ? {
        id: PI_ID, amount: params.amount, currency: params.currency, customer: params.customer,
        payment_method: params.payment_method, livemode: false, status: "requires_confirmation",
        confirmation_method: "manual", amount_received: 0, amount_capturable: 0, latest_charge: null,
        ...h.createOverride,
      } : h.pi);
      h.cache.set(scope, { params: JSON.stringify(params), result });
      h.beforeBind?.();
      return result;
    },
    confirm: async (id: string, params: Record<string, unknown>, options: { stripeAccount: string; idempotencyKey: string }) => {
      h.stripeCalls.push("pi_confirm");
      h.requests.push({ method: "confirm", id, params, key: options.idempotencyKey, account: options.stripeAccount });
      const row = h.rows.payment_charge_attempts as Record<string, unknown>;
      if (row.stripe_payment_intent_id !== id || row.status !== "pending_stripe") throw new Tripwire("money before binding");
      await h.beforeConfirm?.();
      if (h.confirmError) throw h.confirmError;
      const scope = `${options.stripeAccount}:POST:/v1/payment_intents/${id}/confirm:${options.idempotencyKey}`;
      const prior = h.cache.get(scope);
      if (prior && prior.params !== JSON.stringify(params)) throw new Error("idempotency parameter mismatch");
      const result = prior?.result ?? { customer: "cus_test", payment_method: "pm_test", livemode: false, ...h.pi };
      h.cache.set(scope, { params: JSON.stringify(params), result });
      return result;
    },
    retrieve: async () => {
      h.stripeCalls.push("pi_retrieve");
      h.afterRetrieve?.();
      return h.pi;
    },
    // Recorded, not forbidden: a SAME-money requires_action intent is still
    // cancelled (PR #320); a money-mismatched one must never be (P1 4253998912).
    cancel: async (id: string) => {
      h.stripeCalls.push("pi_cancel");
      return { ...h.pi, id, status: h.cancelStatus };
    },
  },
  refunds: {
    create: async () => {
      h.stripeCalls.push("refund_create");
      return h.refund;
    },
  },
};

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => false,
  getStripe: () => fakeStripe,
}));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({
  getSessionPaymentStripe: () => h.useExistingAdapter ? createFakeStripe() : fakeStripe,
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: {
    severity: string;
    event: string;
    safeDetails?: Record<string, unknown>;
  }) => {
    h.alerts.push({ severity: a.severity, event: a.event, details: a.safeDetails ?? {} });
  },
}));
vi.mock("@/lib/billing/charge-description", () => ({
  buildChargeDescription: () => "desc",
}));
vi.mock("@/lib/consent/current-card-authorization", () => ({
  getChargeReadyCardAuthorizationStatus: async () => ({
    kind: "signed_current",
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
}));

// A scripted admin client. Reads answer from `h.rows[table]`; every UPDATE is
// recorded and reports one affected row, so a writer that gets past its checks
// visibly writes. Inserts and deletes are never part of these flows.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      let updatePayload: Record<string, unknown> | null = null;
      const filters: Array<{ column: string; value: unknown }> = [];
      const read = () => ({ data: h.rows[table] && typeof h.rows[table] === "object" ? { ...(h.rows[table] as Record<string, unknown>) } : h.rows[table] ?? null, error: h.recheckReadError ? { code: "XX000" } : null });
      q.select = () => {
        if (updatePayload) {
          const row = h.rows[table] as Record<string, unknown> | undefined;
          const forced = (h.pendingWriteZero && updatePayload.stripe_status && updatePayload.status === undefined)
            || (h.failedWriteZero && updatePayload.status === "failed");
          const matched = !forced && !!row && filters.every((filter) => row[filter.column] === filter.value);
          h.updateAttempts.push({ payload: updatePayload, filters: [...filters], matched });
          if (matched) {
            h.updates.push({ table, payload: updatePayload });
            Object.assign(row!, updatePayload);
          }
          const binding = updatePayload.stripe_status === "requires_confirmation" && updatePayload.status === undefined;
          if (binding && matched) h.afterBind?.();
          if (binding && h.ackMode === "throw") throw new Error("lost binding response");
          return Promise.resolve({ data: binding && h.ackMode === "empty" ? [] : matched ? [{ id: row!.id }] : [],
            error: binding && h.ackMode === "error" ? { code: "XX000" } : null });
        }
        return q;
      };
      for (const m of ["eq", "is"]) q[m] = (column: string, value: unknown) => { filters.push({ column, value }); return q; };
      for (const m of ["in", "or", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => read();
      q.single = async () => read();
      q.then = (resolve: (v: unknown) => unknown) => resolve(read());
      q.update = (payload: Record<string, unknown>) => {
        updatePayload = payload;
        return q;
      };
      q.insert = () => {
        throw new Tripwire(`unexpected insert on ${table}`);
      };
      q.delete = () => {
        throw new Tripwire(`unexpected delete on ${table}`);
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      h.rpcCalls.push(name);
      if (name === "claim_session_payment_charge_attempt") {
        const row = h.rows.payment_charge_attempts as Record<string, unknown> | undefined;
        if (h.claimDynamic && row?.status === "pending_stripe") {
          return { data: [{ ...h.claim, result: "already_pending", stripe_payment_intent_id: row.stripe_payment_intent_id }], error: null };
        }
        if (row && ["claimed", "already_pending"].includes(String(h.claim.result))) {
          row.status = "pending_stripe";
          if (h.claim.result === "claimed") {
            h.claim.stripe_idempotency_key = args.p_idempotency_key;
            row.stripe_idempotency_key = args.p_idempotency_key;
            row.updated_at = h.claim.updated_at;
          }
          if (h.claim.stripe_payment_intent_id) row.stripe_payment_intent_id = h.claim.stripe_payment_intent_id;
        }
        return { data: [h.claim], error: null };
      }
      if (name === "reconcile_card_payment_succeeded") {
        const row = h.rows.payment_charge_attempts as Record<string, unknown>;
        if (row.status === "pending_stripe" && row.stripe_payment_intent_id === args.p_stripe_payment_intent_id) {
          Object.assign(row, { status: "succeeded", stripe_payment_intent_id: args.p_stripe_payment_intent_id,
            stripe_charge_id: args.p_stripe_charge_id, stripe_status: "succeeded", charged_at: new Date().toISOString() });
        }
        return { data: [{ result: "reconciled", status_before: "pending_stripe" }], error: null };
      }
      throw new Tripwire(`unexpected rpc ${name}`);
    },
  }),
}));

const { runSessionPaymentCharge } = await import("@/lib/billing/session-payment-charge");
const { refundPaymentChargeAttempt } = await import("@/lib/billing/payment-refund");
const {
  handlePaymentIntentSucceeded,
  handlePaymentIntentPaymentFailed,
  handleChargeRefunded,
} = await import("@/lib/billing/payment-webhook-reconciliation");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const PI_ID = "pi_ccy_0001";
const CHARGE_ID = "ch_ccy_0001";
const AMOUNT = 15000;

function attemptRow(currency: "cad" | "usd", over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT,
    studio_id: STUDIO,
    client_id: CLIENT,
    charge_reason: "session_payment",
    session_id: "sess-1",
    appointment_id: "appt-1",
    amount_cents: AMOUNT,
    currency,
    status: "ready",
    stripe_livemode: false,
    client_payment_method_id: "cpm-1",
    card_authorization_signature_id: "sig-1",
    stripe_account_id: "acct_test",
    stripe_customer_id: "cus_test",
    stripe_payment_method_id: "pm_test",
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    stripe_idempotency_key: null,
    charged_at: null,
    cancelled_at: null,
    refund_status: null,
    refund_amount_cents: null,
    refunded_at: null,
    stripe_refund_id: null,
    updated_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function claimFor(currency: "cad" | "usd", over: Record<string, unknown> = {}) {
  return {
    result: "claimed",
    attempt_id: ATTEMPT,
    studio_id: STUDIO,
    client_id: CLIENT,
    session_id: "sess-1",
    appointment_id: "appt-1",
    charge_reason: "session_payment",
    amount_cents: AMOUNT,
    currency,
    client_payment_method_id: "cpm-1",
    card_authorization_signature_id: "sig-1",
    stripe_account_id: "acct_test",
    stripe_customer_id: "cus_test",
    stripe_payment_method_id: "pm_test",
    stripe_payment_intent_id: null,
    stripe_idempotency_key: "idem-1",
    status_before_claim: "ready",
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function seedLineage(currency: "cad" | "usd") {
  h.rows = {
    payment_charge_attempts: attemptRow(currency),
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
    client_stripe_customers: { stripe_customer_id: "cus_test" },
    practitioners: { role: "owner" },
  };
}

const charge = () =>
  runSessionPaymentCharge({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: OWNER });

const succeededWrites = () =>
  h.updates.filter(
    (u) => u.table === "payment_charge_attempts" && u.payload.status === "succeeded",
  );
const critical = (event: string) =>
  h.alerts.filter((a) => a.severity === "critical" && a.event === event);

beforeEach(() => {
  h.rows = {};
  h.updates = [];
  h.rpcCalls = [];
  h.updateAttempts = [];
  h.afterRetrieve = null;
  h.recheckReadError = false;
  h.alerts = [];
  h.stripeCalls = [];
  h.claim = {};
  h.pi = {};
  h.createError = null;
  h.useExistingAdapter = false;
  h.confirmError = null;
  h.beforeBind = null;
  h.afterBind = null;
  h.beforeConfirm = null;
  h.createOverride = {};
  h.ackMode = "ok";
  h.claimDynamic = false;
  h.requests = [];
  h.cache = new Map();
  h.cancelStatus = "canceled";
  h.failedWriteZero = false;
  h.pendingWriteZero = false;
  h.refund = {};
});

// ---------------------------------------------------------------------------
// 1. The synchronous charge
// ---------------------------------------------------------------------------
describe("synchronous charge: a succeeded PI is recorded only for the prepared money", () => {
  it.each(["cad", "usd"] as const)(
    "%s: matching amount and currency is recorded as succeeded (control)",
    async (currency) => {
      seedLineage(currency);
      h.claim = claimFor(currency);
      h.pi = { id: PI_ID, status: "succeeded", amount: AMOUNT, currency, latest_charge: CHARGE_ID };

      const result = await charge();

      expect(result).toMatchObject({ ok: true, outcome: "succeeded", stripePaymentIntentId: PI_ID });
      expect(succeededWrites()).toHaveLength(1);
      expect(h.alerts.filter((a) => a.severity === "critical")).toEqual([]);
    },
  );

  it.each([
    ["a USD PI on a CAD attempt", "cad", { amount: AMOUNT, currency: "usd" }, ["currency_mismatch"]],
    ["a CAD PI on a USD attempt", "usd", { amount: AMOUNT, currency: "cad" }, ["currency_mismatch"]],
    ["a different amount", "cad", { amount: AMOUNT + 1, currency: "cad" }, ["amount_mismatch"]],
    ["no stated money at all", "usd", {}, ["amount_unreadable", "currency_unreadable"]],
  ] as const)(
    "%s: no outcome is recorded, the bound row stays pending, a critical alert names it",
    async (_label, rowCurrency, piMoney, mismatches) => {
      seedLineage(rowCurrency);
      h.claim = claimFor(rowCurrency);
      h.pi = { id: PI_ID, status: "succeeded", latest_charge: CHARGE_ID, ...piMoney };

      const result = await charge();

      expect(result).toMatchObject({
        ok: false,
        outcome: "needs_manual_review",
        stripePaymentIntentId: PI_ID,
        attemptId: ATTEMPT,
      });
      expect(succeededWrites()).toEqual([]);
      const [alert] = critical("session_payment_provider_money_mismatch");
      expect(alert).toBeDefined();
      expect(alert.details).toMatchObject({
        attempt_id: ATTEMPT,
        money_mismatches: mismatches,
        prepared_amount_cents: AMOUNT,
        prepared_currency: rowCurrency,
      });
    },
  );

  it("the reconcile re-read applies the same rule to a retrieved PI", async () => {
    seedLineage("usd");
    h.claim = claimFor("usd", {
      result: "already_pending",
      stripe_payment_intent_id: PI_ID,
    });
    h.pi = { id: PI_ID, status: "succeeded", amount: AMOUNT, currency: "cad", latest_charge: CHARGE_ID };

    const result = await charge();

    expect(h.stripeCalls).toEqual(["pi_retrieve"]);
    expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(succeededWrites()).toEqual([]);
    expect(critical("session_payment_provider_money_mismatch")).toHaveLength(1);
  });

  it("…and still records a retrieved PI whose money matches (control)", async () => {
    seedLineage("usd");
    h.claim = claimFor("usd", { result: "already_pending", stripe_payment_intent_id: PI_ID });
    h.pi = { id: PI_ID, status: "succeeded", amount: AMOUNT, currency: "usd", latest_charge: CHARGE_ID };

    const result = await charge();

    expect(result).toMatchObject({ ok: true, outcome: "succeeded" });
    expect(succeededWrites()).toHaveLength(1);
  });

  it("the PI is created with the ROW's amount and currency, never another", async () => {
    seedLineage("usd");
    h.claim = claimFor("usd");
    const seen: Array<Record<string, unknown>> = [];
    const original = fakeStripe.paymentIntents.create;
    fakeStripe.paymentIntents.create = (async (params: Record<string, unknown>) => {
      seen.push(params);
      return { id: PI_ID, status: "succeeded", amount: AMOUNT, currency: "usd", latest_charge: CHARGE_ID };
    }) as never;
    try {
      await charge();
    } finally {
      fakeStripe.paymentIntents.create = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ amount: AMOUNT, currency: "usd" });
  });
});

// ---------------------------------------------------------------------------
// 1b. Codex P1 4253998912: MONEY FIRST, STATUS SECOND — every status, both paths
// ---------------------------------------------------------------------------
// A PaymentIntent whose money is not the prepared attempt's must not drive ANY
// status branch: no `succeeded` write, no requires_action CANCELLATION, no
// `failed` write. The row stays pending_stripe and a person is told. Matching
// intents take exactly their old paths (controls).
describe("money is checked before any status branch (P1 4253998912)", () => {
  // Binding records trusted original identity before confirmation; these
  // assertions forbid outcome writes driven by mismatched confirmed money.
  const attemptWrites = () => h.updates.filter((u) => u.table === "payment_charge_attempts"
    && u.payload.stripe_status !== "requires_confirmation");
  const failedWrites = () => attemptWrites().filter((u) => u.payload.status === "failed");
  const cancels = () => h.stripeCalls.filter((c) => c === "pi_cancel");

  // The reconcile path re-reads a PI already bound to a pending row; the
  // synchronous path receives the PI from create (an idempotent replay
  // returns whatever Stripe holds for the key).
  const PATHS = {
    reconcile: (currency: "cad" | "usd") =>
      claimFor(currency, { result: "already_pending", stripe_payment_intent_id: PI_ID }),
    create: (currency: "cad" | "usd") => claimFor(currency),
  } as const;
  const STATUSES = ["succeeded", "requires_action", "requires_payment_method", "processing", "canceled"] as const;

  for (const [path, claim] of Object.entries(PATHS)) {
    it.each(STATUSES)(`${path}: a mismatched %s intent writes no outcome and cancels nothing`, async (status) => {
      seedLineage("usd");
      h.claim = claim("usd");
      h.pi = { id: PI_ID, status, amount: AMOUNT, currency: "cad", latest_charge: CHARGE_ID };

      const result = await charge();

      expect(result).toMatchObject({
        ok: false,
        outcome: "needs_manual_review",
        stripePaymentIntentId: PI_ID,
        attemptId: ATTEMPT,
      });
      expect(cancels()).toEqual([]);
      expect(attemptWrites()).toEqual([]);
      const [alert] = critical("session_payment_provider_money_mismatch");
      expect(alert?.details).toMatchObject({
        attempt_id: ATTEMPT,
        attempted_status: status,
        money_mismatches: ["currency_mismatch"],
      });
    });

    it(`${path}: a different AMOUNT on a requires_action intent is not cancelled either`, async () => {
      seedLineage("cad");
      h.claim = claim("cad");
      h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT + 500, currency: "cad" };

      const result = await charge();

      expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(cancels()).toEqual([]);
      expect(attemptWrites()).toEqual([]);
    });

    it(`${path}: an intent with no readable money is refused before any branch`, async () => {
      seedLineage("usd");
      h.claim = claim("usd");
      h.pi = { id: PI_ID, status: "requires_payment_method" };

      const result = await charge();

      expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(attemptWrites()).toEqual([]);
      expect(critical("session_payment_provider_money_mismatch")[0]?.details).toMatchObject({
        money_mismatches: ["amount_unreadable", "currency_unreadable"],
      });
    });

    // ----- MATCHING CONTROLS: the old behaviour, unchanged -----
    it(`${path} CONTROL: a same-money requires_action intent is still cancelled and recorded failed`, async () => {
      seedLineage("usd");
      h.claim = claim("usd");
      h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT, currency: "usd" };

      const result = await charge();

      expect(cancels()).toEqual(["pi_cancel"]);
      expect(failedWrites()).toHaveLength(1);
      expect(result.ok).toBe(false);
      expect(critical("session_payment_provider_money_mismatch")).toEqual([]);
    });

    it(`${path} CONTROL: a same-money requires_payment_method intent remains pending, not cancelled`, async () => {
      seedLineage("cad");
      h.claim = claim("cad");
      h.pi = {
        id: PI_ID,
        status: "requires_payment_method",
        amount: AMOUNT,
        currency: "cad",
        last_payment_error: { code: "card_declined", message: "Your card was declined." },
      };

      const result = await charge();

      expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review", stripePaymentIntentId: PI_ID });
      expect(cancels()).toEqual([]);
      expect(failedWrites()).toHaveLength(0);
      expect(critical("session_payment_provider_money_mismatch")).toEqual([]);
    });

    it(`${path} CONTROL: a same-money succeeded intent is recorded succeeded`, async () => {
      seedLineage("usd");
      h.claim = claim("usd");
      h.pi = { id: PI_ID, status: "succeeded", amount: AMOUNT, currency: "usd", latest_charge: CHARGE_ID };

      const result = await charge();

      expect(result).toMatchObject({ ok: true, outcome: "succeeded" });
      expect(succeededWrites()).toHaveLength(1);
      expect(cancels()).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The refund
// ---------------------------------------------------------------------------
describe("refund: Stripe's refund is recorded only when it is the claimed refund", () => {
  function seedSucceeded(currency: "cad" | "usd") {
    seedLineage(currency);
    h.rows.payment_charge_attempts = attemptRow(currency, {
      status: "succeeded",
      stripe_payment_intent_id: PI_ID,
      stripe_charge_id: CHARGE_ID,
      charged_at: "2026-10-01T00:00:00.000Z",
    });
  }
  const refundSucceededWrites = () =>
    h.updates.filter((u) => u.payload.refund_status === "succeeded");
  const refund = () =>
    refundPaymentChargeAttempt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: OWNER });

  it.each(["cad", "usd"] as const)("%s: a matching refund is recorded (control)", async (currency) => {
    seedSucceeded(currency);
    h.refund = { id: "re_1", status: "succeeded", amount: AMOUNT, currency };

    const result = await refund();

    expect(result).toMatchObject({ ok: true, outcome: "succeeded", refundAmountCents: AMOUNT });
    expect(refundSucceededWrites()).toHaveLength(1);
  });

  it.each([
    ["in another currency", { amount: AMOUNT, currency: "cad" }, "usd"],
    ["for another amount", { amount: AMOUNT - 100, currency: "usd" }, "usd"],
    ["stating no money", {}, "cad"],
  ] as const)("a refund %s is NOT recorded; it stays pending for review", async (_l, money, rowCurrency) => {
    seedSucceeded(rowCurrency);
    h.refund = { id: "re_1", status: "succeeded", ...money };

    const result = await refund();

    expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    // The claim (pending_stripe) was written; the success never was.
    expect(h.updates.some((u) => u.payload.refund_status === "pending_stripe")).toBe(true);
    expect(refundSucceededWrites()).toEqual([]);
    expect(critical("payment_refund_provider_money_mismatch")).toHaveLength(1);
  });
});

// PAY-004: only provider terminal truth may retire a prepared payment attempt.
describe("PAY-004 nonterminal PaymentIntents", () => {
  const paths = ["create", "retrieve"] as const;
  for (const path of paths) {
    it.each(["processing", "requires_capture", "requires_confirmation", "requires_payment_method"])(`${path} %s stays pending with its original PI id`, async (status) => {
      seedLineage("cad");
      h.claim = claimFor("cad", path === "retrieve" ? { result: "already_pending", stripe_payment_intent_id: PI_ID } : {});
      h.pi = { id: PI_ID, status, amount: AMOUNT, currency: "cad" };
      const result = await charge();
      expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(h.updates.filter((write) => write.payload.status === "failed")).toEqual([]);
      expect(h.updates.some((write) => write.payload.stripe_payment_intent_id === PI_ID)).toBe(true);
      expect(h.stripeCalls).toEqual(path === "create" ? ["pi_create", "pi_confirm"] : ["pi_retrieve"]);
    });
  }
  it("does not call a successful cancel response terminal unless its actual status is canceled", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT, currency: "cad" };
    h.cancelStatus = "processing";
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.updates.filter((write) => write.payload.status === "failed")).toEqual([]);
    expect(h.stripeCalls).toEqual(["pi_create", "pi_confirm", "pi_cancel"]);
  });
  it("does not report terminal failure when the canceled-state write matched no row", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT, currency: "cad" };
    h.failedWriteZero = true;
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_confirm", "pi_cancel"]);
    expect(critical("session_payment_failed_write_zero_rows")).toHaveLength(1);
  });
  it("the next execution retrieves the retained intent instead of creating another", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "processing", amount: AMOUNT, currency: "cad" };
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    const retained = h.updates.find((write) => write.payload.stripe_payment_intent_id === PI_ID && write.payload.stripe_status === "processing");
    expect(retained?.payload).toMatchObject({ stripe_payment_intent_id: PI_ID, stripe_status: "processing" });
    h.rows.payment_charge_attempts = attemptRow("cad", { status: "pending_stripe", ...retained!.payload });
    h.claim = claimFor("cad", { result: "already_pending", stripe_payment_intent_id: retained!.payload.stripe_payment_intent_id });
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_confirm", "pi_retrieve"]);
    expect(h.updates.filter((write) => write.payload.status === "failed")).toEqual([]);
  });
  it("does not cancel when the pending identity write was refused", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT, currency: "cad" };
    h.pendingWriteZero = true;
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]);
    expect(h.updateAttempts[0].matched).toBe(false);
    expect(h.stripeCalls).not.toContain("pi_confirm");
  });
  it("does not cancel a retrieved intent whose ID differs from the pending claim", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad", { result: "already_pending", stripe_payment_intent_id: PI_ID });
    h.pi = { id: "pi_other", status: "requires_action", amount: AMOUNT, currency: "cad" };
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_retrieve"]);
    expect(h.updates.filter((write) => write.payload.status === "failed")).toEqual([]);
    expect(critical("session_payment_provider_identity_mismatch")).toHaveLength(1);
  });
  it("a definitive SDK error with a still-actionable intent does not falsely retire it", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.createError = Object.assign(new Stripe.errors.StripeCardError({ type: "card_error", code: "authentication_required", message: "synthetic authentication" }),
      { payment_intent: { id: PI_ID, status: "requires_action" } });
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.updates.filter((write) => write.payload.status === "failed")).toEqual([]);
    expect(h.stripeCalls).toEqual(["pi_create"]);
  });
});

describe("PRIVACY PAY-004 retrieved identity across terminal branches", () => {
  it.each(["canceled", "succeeded"])("a matching %s retrieval still finalizes under its original-ID predicate", async (status) => {
    seedLineage("cad");
    h.claim = claimFor("cad", { result: "already_pending", stripe_payment_intent_id: PI_ID });
    h.pi = { id: PI_ID, status, amount: AMOUNT, currency: "cad", latest_charge: CHARGE_ID };
    const result = await charge();
    expect(result).toMatchObject(status === "succeeded" ? { ok: true, outcome: "succeeded" } : { ok: false, outcome: "failed" });
    expect(h.stripeCalls).toEqual(["pi_retrieve"]);
    expect(h.updateAttempts[0]?.matched).toBe(true);
    expect(h.updateAttempts[0]?.filters).toContainEqual({ column: "stripe_payment_intent_id", value: PI_ID });
    expect((h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id).toBe(PI_ID);
  });
  it.each(["canceled", "succeeded"])("wrong retrieved ID with %s cannot write or cancel", async (status) => {
    seedLineage("cad");
    h.claim = claimFor("cad", { result: "already_pending", stripe_payment_intent_id: PI_ID });
    h.pi = { id: "pi_other", status, amount: AMOUNT, currency: "cad", latest_charge: CHARGE_ID };
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.updates).toEqual([]);
    expect(h.updateAttempts).toEqual([]);
    expect(h.stripeCalls).toEqual(["pi_retrieve"]);
    expect((h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id).toBe(PI_ID);
  });
  it.each(["canceled", "succeeded"])("a concurrent identity replacement after matching %s retrieval cannot be overwritten", async (status) => {
    seedLineage("cad");
    h.claim = claimFor("cad", { result: "already_pending", stripe_payment_intent_id: PI_ID });
    h.pi = { id: PI_ID, status, amount: AMOUNT, currency: "cad", latest_charge: CHARGE_ID };
    h.afterRetrieve = () => { (h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id = "pi_concurrent"; };
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.updates).toEqual([]);
    expect(h.stripeCalls).toEqual(["pi_retrieve"]);
    expect((h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id).toBe("pi_concurrent");
    expect(h.updateAttempts[0]?.matched).toBe(false);
    expect(h.updateAttempts[0]?.filters).toContainEqual({ column: "stripe_payment_intent_id", value: PI_ID });
  });
});

// ---------------------------------------------------------------------------
// 3. The webhooks
// ---------------------------------------------------------------------------
function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: "evt_1", type, account: "acct_test", livemode: false, data: { object: { ...(type === "payment_intent.payment_failed" ? { status: "requires_payment_method" } : {}), customer: "cus_test", ...(type.startsWith("charge.") ? { payment_intent: PI_ID } : {}), ...object } } } as unknown as Stripe.Event;
}
const META = {
  hone_payment_charge_attempt_id: ATTEMPT,
  hone_studio_id: STUDIO,
  hone_client_id: CLIENT,
  hone_charge_reason: "session_payment",
};
const CTX = { studioId: STUDIO, stripeAccountId: "acct_test", livemode: false };

describe("payment_intent.succeeded webhook", () => {
  it.each(["cad", "usd"] as const)("%s: matching money reconciles (control)", async (currency) => {
    h.rows = { payment_charge_attempts: attemptRow(currency, { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    const out = await handlePaymentIntentSucceeded(
      event("payment_intent.succeeded", {
        id: PI_ID,
        amount: AMOUNT,
        currency,
        latest_charge: CHARGE_ID,
        metadata: META,
      }),
      CTX,
    );
    expect(h.rpcCalls).toContain("reconcile_card_payment_succeeded");
    expect(out.reconciledFromStatus).toBe("pending_stripe");
  });

  it("different money: no command, no write, a critical alert", async () => {
    h.rows = { payment_charge_attempts: attemptRow("usd", { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    const out = await handlePaymentIntentSucceeded(
      event("payment_intent.succeeded", {
        id: PI_ID,
        amount: AMOUNT,
        currency: "cad",
        latest_charge: CHARGE_ID,
        metadata: META,
      }),
      CTX,
    );
    expect(out.moneyMismatch).toBe(true);
    expect(h.rpcCalls).toEqual([]);
    expect(h.updates).toEqual([]);
    const [alert] = critical("stripe_webhook_money_mismatch");
    expect(alert.details).toMatchObject({
      target_event: "payment_intent.succeeded",
      money_mismatches: ["currency_mismatch"],
    });
  });

  it("an already-succeeded row does not borrow a charge id from different money", async () => {
    h.rows = {
      payment_charge_attempts: attemptRow("cad", { status: "succeeded", stripe_payment_intent_id: PI_ID, stripe_charge_id: null }),
    };
    const out = await handlePaymentIntentSucceeded(
      event("payment_intent.succeeded", {
        id: PI_ID,
        amount: 999,
        currency: "cad",
        latest_charge: CHARGE_ID,
        metadata: META,
      }),
      CTX,
    );
    expect(out.moneyMismatch).toBe(true);
    expect(h.updates).toEqual([]);
  });
});

describe("payment_intent.payment_failed webhook", () => {
  it("matching money still flips pending_stripe to failed (control)", async () => {
    h.rows = { payment_charge_attempts: attemptRow("usd", { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    const out = await handlePaymentIntentPaymentFailed(
      event("payment_intent.payment_failed", {
        id: PI_ID,
        amount: AMOUNT,
        currency: "usd",
        metadata: META,
        last_payment_error: { type: "card_error", code: "card_declined", message: "declined" },
      }),
      CTX,
    );
    expect(out.reconciledFromStatus).toBe("pending_stripe");
    expect(h.updates.filter((u) => u.payload.status === "failed")).toHaveLength(1);
  });

  it("different money never retires the prepared attempt", async () => {
    h.rows = { payment_charge_attempts: attemptRow("usd", { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    const out = await handlePaymentIntentPaymentFailed(
      event("payment_intent.payment_failed", {
        id: PI_ID,
        amount: AMOUNT,
        currency: "cad",
        metadata: META,
        last_payment_error: { type: "card_error", code: "card_declined", message: "declined" },
      }),
      CTX,
    );
    expect(out.moneyMismatch).toBe(true);
    expect(h.updates).toEqual([]);
    expect(critical("stripe_webhook_money_mismatch")).toHaveLength(1);
  });
});

describe("charge.refunded webhook", () => {
  function refundedCharge(money: Record<string, unknown>) {
    return event("charge.refunded", {
      id: CHARGE_ID,
      refunded: true,
      amount_refunded: money.amount,
      refunds: { data: [{ id: "re_1" }] },
      metadata: META,
      ...money,
    });
  }

  it.each(["cad", "usd"] as const)(
    "%s: a full refund of the prepared charge reconciles (control)",
    async (currency) => {
      h.rows = {
        payment_charge_attempts: attemptRow(currency, {
          status: "succeeded", stripe_payment_intent_id: PI_ID,
          stripe_charge_id: CHARGE_ID,
        }),
      };
      const out = await handleChargeRefunded(refundedCharge({ amount: AMOUNT, currency }), CTX);
      expect(out.outOfBandReconciled).toBe(true);
      expect(h.updates.filter((u) => u.payload.refund_status === "succeeded")).toHaveLength(1);
    },
  );

  it("a refunded charge in another currency is not this payment's refund", async () => {
    h.rows = {
      payment_charge_attempts: attemptRow("cad", {
        status: "succeeded", stripe_payment_intent_id: PI_ID,
        stripe_charge_id: CHARGE_ID,
      }),
    };
    const out = await handleChargeRefunded(
      refundedCharge({ amount: AMOUNT, currency: "usd" }),
      CTX,
    );
    expect(out.moneyMismatch).toBe(true);
    expect(h.updates).toEqual([]);
    const [alert] = critical("stripe_webhook_money_mismatch");
    expect(alert.details).toMatchObject({
      target_event: "charge.refunded",
      stripe_charge_id: CHARGE_ID,
    });
  });

  it("a charge of a different amount is caught before the partial/full decision", async () => {
    h.rows = {
      payment_charge_attempts: attemptRow("cad", {
        status: "succeeded", stripe_payment_intent_id: PI_ID,
        stripe_charge_id: CHARGE_ID,
      }),
    };
    // Stripe's own two numbers agree (a "full" refund of 999), which the
    // partial/full check alone would have accepted as this payment's refund.
    const out = await handleChargeRefunded(refundedCharge({ amount: 999, currency: "cad" }), CTX);
    expect(out.moneyMismatch).toBe(true);
    expect(out.partialRefundIgnored).toBeUndefined();
    expect(h.updates).toEqual([]);
  });
});


describe("PAY004 identical concurrent canceled failure", () => {
  function prepareRace(over: Record<string, unknown> = {}, readError = false) {
    seedLineage("cad");
    h.claim = claimFor("cad", { result: "already_pending", stripe_payment_intent_id: PI_ID });
    h.pi = { id: PI_ID, status: "canceled", amount: AMOUNT, currency: "cad" };
    h.afterRetrieve = () => {
      Object.assign(h.rows.payment_charge_attempts as Record<string, unknown>, {
        status: "failed", stripe_status: "canceled", stripe_payment_intent_id: PI_ID,
        cancelled_at: null, failure_code: "canceled", failed_at: "2026-10-21T04:00:00.000Z", ...over,
      });
      h.recheckReadError = readError;
    };
  }
  it("identical already-persisted terminal row returns failed without critical/manual-review noise", async () => {
    prepareRace();
    expect(await charge()).toMatchObject({ ok: false, outcome: "failed", failureCode: "canceled" });
    expect(h.updates).toEqual([]);
    expect(h.stripeCalls).toEqual(["pi_retrieve"]);
    expect(critical("session_payment_failed_write_zero_rows")).toEqual([]);
  });
  it.each([
    { id: "different-attempt" }, { studio_id: "different-studio" }, { client_id: "different-client" },
    { stripe_livemode: true }, { stripe_payment_intent_id: "pi_different" },
    { stripe_account_id: "acct_different" }, { stripe_customer_id: "cus_different" },
    { amount_cents: AMOUNT + 1 }, { currency: "usd" }, { charge_reason: "no_show_fee" },
    { status: "succeeded" }, { stripe_status: "processing" }, { failure_code: "different" },
    { failed_at: null }, { cancelled_at: "2026-10-21T03:00:00Z" },
    { refund_status: "pending_stripe" }, { charged_at: "2026-10-21T03:00:00Z" }, { stripe_charge_id: CHARGE_ID },
  ])("conflicting concurrent terminal evidence stays manual review: %j", async (over) => {
    prepareRace(over);
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(critical("session_payment_failed_write_zero_rows")).toHaveLength(1);
    expect(h.updates).toEqual([]);
    expect(h.stripeCalls).toEqual(["pi_retrieve"]);
  });
  it("an unreadable terminal row stays manual review", async () => {
    prepareRace({}, true);
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(critical("session_payment_failed_write_zero_rows")).toHaveLength(1);
    expect(h.updates).toEqual([]);
  });
});


describe("staged producer original binding", () => {
  const setup = () => {
    seedLineage("usd"); h.claim = claimFor("usd");
    h.pi = { id: PI_ID, status: "succeeded", amount: AMOUNT, currency: "usd", latest_charge: CHARGE_ID };
  };
  it("creates unconfirmed, positively binds and verifies before confirming the exact original", async () => {
    setup();
    expect(await charge()).toMatchObject({ ok: true, outcome: "succeeded" });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_confirm"]);
    expect(h.requests[0].params).toMatchObject({ confirm: false, confirmation_method: "manual" });
    expect(h.requests[0].params).not.toHaveProperty("off_session");
    expect(h.requests[1]).toMatchObject({ id: PI_ID, params: { off_session: true }, account: "acct_test" });
    expect(h.requests[0].key).not.toBe(h.requests[1].key);
    expect(h.updateAttempts[0].filters).toContainEqual({ column: "stripe_payment_intent_id", value: null });
    expect(h.updateAttempts[0].filters).toContainEqual({ column: "updated_at", value: h.claim.updated_at });
    expect(h.updateAttempts.at(-1)?.filters).toContainEqual({ column: "stripe_payment_intent_id", value: PI_ID });
  });
  it.each(["empty", "error", "throw"])("lost binding ACK %s never confirms even when the row committed", async (mode) => {
    setup(); h.ackMode = mode;
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]);
    expect((h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id).toBe(PI_ID);
  });
  it("read failure after a positive ACK never grants confirmation", async () => {
    setup(); h.afterBind = () => { h.recheckReadError = true; };
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]);
  });
  it.each([
    ["stripe_account_id", "acct_other"], ["stripe_customer_id", "cus_other"],
    ["stripe_payment_method_id", "pm_other"], ["amount_cents", AMOUNT + 1],
    ["currency", "cad"], ["stripe_livemode", true], ["client_id", "other"],
    ["studio_id", "other"], ["session_id", null], ["appointment_id", null],
    ["charge_reason", "no_show_fee"], ["card_authorization_signature_id", "sig_other"],
    ["client_payment_method_id", "cpm_other"], ["status", "failed"],
    ["stripe_idempotency_key", "legacy"], ["updated_at", "2026-10-21T14:00:00.000001Z"],
    ["stripe_payment_intent_id", "pi_other"], ["stripe_charge_id", "ch_other"],
    ["charged_at", "2026-10-21T00:00:00Z"],
  ])("frozen %s drift refuses binding and confirmation", async (key, value) => {
    setup(); h.beforeBind = () => { (h.rows.payment_charge_attempts as Record<string, unknown>)[key as string] = value; };
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]);
    expect(h.updateAttempts[0].matched).toBe(false);
  });
  it("preserves raw microsecond claim time without rounding", async () => {
    setup(); h.claim.updated_at = new Date(Date.now() - 1000).toISOString().replace("Z", "001Z");
    expect(await charge()).toMatchObject({ ok: true });
    expect(h.updateAttempts[0].filters).toContainEqual({ column: "updated_at", value: h.claim.updated_at });
  });
  it("post-bind tuple drift refuses confirmation despite a positive ACK", async () => {
    setup(); h.afterBind = () => { (h.rows.payment_charge_attempts as Record<string, unknown>).amount_cents = AMOUNT + 1; };
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]);
  });
  it.each([{ status: "succeeded" }, { livemode: true }, { amount: AMOUNT + 1 },
    { customer: "cus_other" }, { payment_method: "pm_other" }, { confirmation_method: "automatic" },
    { latest_charge: CHARGE_ID }, { amount_received: 1 }, { amount_capturable: 1 }, { id: "" }])(
    "untrusted or already active create result %j never binds", async (override) => {
      setup(); h.createOverride = override;
      expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
      expect(h.updates).toEqual([]); expect(h.stripeCalls).toEqual(["pi_create"]);
    });
  it("create error retains pending without binding or confirmation; retry never creates", async () => {
    setup(); h.createError = new Error("synthetic lost create ACK"); h.claimDynamic = true;
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    h.createError = null;
  h.useExistingAdapter = false;
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]); expect(h.updates).toEqual([]);
  });
  it("two simultaneous claim callers obtain only one create and confirmation", async () => {
    setup(); h.claimDynamic = true;
    const results = await Promise.all([charge(), charge()]);
    expect(results.some(r => r.ok)).toBe(true);
    expect(h.stripeCalls.filter(c => c === "pi_create")).toHaveLength(1);
    expect(h.stripeCalls.filter(c => c === "pi_confirm")).toHaveLength(1);
  });
  it.each(["hone:session_payment:legacy:v1", "hone:session_payment:new:v2:create"])(
    "pending unknown %s never replays", async (key) => {
      setup(); h.claim = claimFor("usd", { result: "already_pending", stripe_idempotency_key: key });
      expect(await charge()).toMatchObject({ outcome: "needs_manual_review" }); expect(h.stripeCalls).toEqual([]);
    });
  it("lost confirm response retains bound original and never creates or confirms on retry", async () => {
    setup(); h.confirmError = new Error("synthetic lost confirm ACK"); h.claimDynamic = true;
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect((h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id).toBe(PI_ID);
    h.confirmError = null; h.pi.status = "requires_confirmation";
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_confirm", "pi_retrieve"]);
  });
  it.each(["processing", "requires_confirmation", "requires_capture"])("active confirm result %s remains pending", async (status) => {
    setup(); h.pi.status = status;
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect((h.rows.payment_charge_attempts as Record<string, unknown>).status).toBe("pending_stripe");
  });
  it("full verified ordinary decline fails the attempt while retaining its original", async () => {
    setup(); h.confirmError = Object.assign(new Stripe.errors.StripeCardError({ type: "card_error", code: "card_declined", message: "private fake" }),
      { payment_intent: { ...h.pi, customer: "cus_test", payment_method: "pm_test", livemode: false,
        status: "requires_payment_method", last_payment_error: { type: "card_error" } } });
    expect(await charge()).toMatchObject({ outcome: "failed" });
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "failed", stripe_payment_intent_id: PI_ID });
    expect(h.alerts.filter(a => a.event === "session_payment_charge_failed")).toMatchObject([{ severity: "warning" }]);
  });
  it.each([undefined, { id: PI_ID, status: "requires_payment_method" },
    { id: PI_ID, status: "processing", amount: AMOUNT, currency: "usd", customer: "cus_test", payment_method: "pm_test", livemode: false }])(
    "partial/unknown/active decline %j cannot fail the attempt", async (attached) => {
      setup(); h.confirmError = Object.assign(new Stripe.errors.StripeCardError({ type: "card_error", code: "card_declined", message: "private fake" }), { payment_intent: attached });
      expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
      expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_payment_intent_id: PI_ID });
    });
  it.each([{ id: "pi_other" }, { livemode: true }, { amount: AMOUNT + 1 }, { currency: "cad" },
    { customer: "cus_other" }, { payment_method: "pm_other" }])("confirm identity/money %j never writes success", async (override) => {
      setup(); Object.assign(h.pi, override);
      expect(await charge()).toMatchObject({ outcome: "needs_manual_review" }); expect(succeededWrites()).toEqual([]);
    });
  it("readback cannot invent an ACK after a losing null CAS", async () => {
    setup(); h.beforeBind = () => { (h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id = PI_ID; };
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]); expect(h.updateAttempts[0].matched).toBe(false);
  });
  it("a signed success callback can win after binding without a false manual outcome", async () => {
    setup();
    h.beforeConfirm = async () => {
      const result = await handlePaymentIntentSucceeded(event("payment_intent.succeeded", {
        ...h.pi, customer: "cus_test", livemode: false, metadata: META }), CTX);
      expect(result.reconciledFromStatus).toBe("pending_stripe");
    };
    expect(await charge()).toMatchObject({ ok: true, concurrentlyReconciled: true });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_confirm"]);
    expect(critical("session_payment_succeeded_write_zero_rows")).toEqual([]);
  });
  it("a returned ordinary decline also fails only the bound attempt", async () => {
    setup(); h.pi.status = "requires_payment_method"; h.pi.last_payment_error = { type: "card_error", code: "card_declined", message: "synthetic private processor diagnostic" };
    expect(await charge()).toMatchObject({ outcome: "failed", message: "The saved card could not be charged." });
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "failed", stripe_payment_intent_id: PI_ID });
    expect(JSON.stringify(h.updates)).not.toContain("synthetic private processor diagnostic");
    expect(h.stripeCalls).toEqual(["pi_create", "pi_confirm"]);
  });
  it.each(["unknown_result", "not_ready"])("claim %s cannot fall through to any provider write", async (result) => {
    setup(); h.claim.result = result;
    const response = await charge(); expect(response.ok).toBe(false); expect(h.stripeCalls).toEqual([]);
  });
  it.each([{ client_id: "other" }, { amount_cents: AMOUNT + 1 },
    { updated_at: "2020-01-01T00:00:00Z" }, { updated_at: "invalid" },
    { updated_at: "2999-01-01T00:00:00Z" }, { stripe_payment_intent_id: "pi_other" }])(
    "unverified claim %j never creates", async (override) => {
      setup(); Object.assign(h.claim, override);
      expect(await charge()).toMatchObject({ outcome: "needs_manual_review" }); expect(h.stripeCalls).toEqual([]);
    });
  it("a crash after binding leaves a known unconfirmed original and no confirm grant on retry", async () => {
    setup(); h.claimDynamic = true; h.afterBind = () => { throw new Error("synthetic process boundary"); };
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.rows.payment_charge_attempts).toMatchObject({ stripe_payment_intent_id: PI_ID, status: "pending_stripe" });
    h.afterBind = null; h.pi.status = "requires_confirmation";
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_retrieve"]);
  });
  it("the fake scopes idempotency by method path and connected account", async () => {
    setup();
    const params = { amount: AMOUNT, currency: "usd", customer: "cus_test", payment_method: "pm_test", confirm: false };
    const options = { stripeAccount: "acct_test", idempotencyKey: "same-key" };
    expect(await fakeStripe.paymentIntents.create(params, options)).toMatchObject({ status: "requires_confirmation" });
    (h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id = PI_ID;
    (h.rows.payment_charge_attempts as Record<string, unknown>).status = "pending_stripe";
    // Stripe permits the same key on a distinct endpoint; production still uses
    // separate stable keys. Do not invent a global cross-method collision.
    expect(await fakeStripe.paymentIntents.confirm(PI_ID, { off_session: true }, options)).toMatchObject({ status: "succeeded" });
    await expect(fakeStripe.paymentIntents.create({ ...params, amount: AMOUNT + 1 }, options)).rejects.toThrow("parameter mismatch");
    await expect(fakeStripe.paymentIntents.create({ ...params, amount: AMOUNT + 1 }, { ...options, stripeAccount: "acct_other" })).resolves.toMatchObject({ amount: AMOUNT + 1 });
  });

  it("even duplicate claimed snapshots and replayed create results grant only one NULL-binding winner", async () => {
    setup();
    const results = await Promise.all([charge(), charge()]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(h.stripeCalls.filter(c => c === "pi_create")).toHaveLength(2);
    expect(h.stripeCalls.filter(c => c === "pi_confirm")).toHaveLength(1);
    expect(h.cache.size).toBe(2); // one create scope, one confirmation scope
    expect(h.updateAttempts.filter(u => u.payload.stripe_status === "requires_confirmation").map(u => u.matched)).toEqual([true, false]);
  });

  it.each(["legacy:v1", ""])("ready rows with preexisting key %j cannot enter the new protocol", async (key) => {
    setup(); (h.rows.payment_charge_attempts as Record<string, unknown>).stripe_idempotency_key = key;
    expect(await charge()).toMatchObject({ outcome: "needs_manual_review" }); expect(h.stripeCalls).toEqual([]);
  });

  it("a verified canceled authentication refusal preserves its critical failure alert", async () => {
    setup(); h.confirmError = Object.assign(new Stripe.errors.StripeCardError({ type: "card_error", code: "authentication_required", message: "private fake" }),
      { payment_intent: { ...h.pi, customer: "cus_test", payment_method: "pm_test", livemode: false, status: "canceled" } });
    expect(await charge()).toMatchObject({ outcome: "failed", failureCode: "authentication_required" });
    expect(critical("session_payment_charge_failed")).toHaveLength(1);
    expect(JSON.stringify(h.alerts)).not.toContain("private fake");
  });

});


describe("existing E2E fake adapter through the real staged producer", () => {
  const RUN = "run-producer-adapter-123";
  it.each([false, true])("actual adapter preserves binding-before-money (lost ACK=%s)", async (lostAck) => {
    const previous = process.env.HONE_E2E_RUN_ID;
    process.env.HONE_E2E_RUN_ID = RUN; resetFakeStripeState(RUN);
    try {
      seedLineage("usd"); h.claim = claimFor("usd"); h.claimDynamic = true; h.useExistingAdapter = true;
      if (lostAck) h.ackMode = "error";
      const result = await charge();
      if (!lostAck) {
        expect(result).toMatchObject({ ok: true, outcome: "succeeded" });
        expect(h.rows.payment_charge_attempts).toMatchObject({ status: "succeeded", amount_cents: AMOUNT, currency: "usd" });
        expect(getFakeStripeCalls(RUN).map(c => c.method)).toEqual(["pi_create", "pi_confirm"]);
      } else {
        expect(result).toMatchObject({ outcome: "needs_manual_review" });
        expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_status: "requires_confirmation" });
        expect(await charge()).toMatchObject({ outcome: "needs_manual_review" });
        expect(getFakeStripeCalls(RUN).map(c => c.method)).toEqual(["pi_create", "pi_retrieve"]);
        expect(getFakeStripeCalls(RUN).filter(c => c.method === "pi_confirm")).toEqual([]);
        expect(succeededWrites()).toEqual([]);
      }
    } finally {
      resetFakeStripeState(RUN);
      if (previous === undefined) delete process.env.HONE_E2E_RUN_ID; else process.env.HONE_E2E_RUN_ID = previous;
    }
  });
});


describe("bound PI active-or-unknown failed-event retirement", () => {
  it.each(["requires_action", "requires_confirmation", "processing", "succeeded", undefined])("%s does not permit terminal local failure/new-attempt authority", async (status) => {
    h.rows = { payment_charge_attempts: attemptRow("cad", { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    const out = await handlePaymentIntentPaymentFailed(event("payment_intent.payment_failed", {
      id: PI_ID, status, amount: AMOUNT, currency: "cad", metadata: META,
      last_payment_error: { code: "card_declined", message: "synthetic refusal" },
    }), CTX);
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_payment_intent_id: PI_ID });
    expect(h.updates).toEqual([]);
    expect(out.providerOutcomeUnresolved).toBe(true);
    expect(critical("session_payment_needs_manual_review")).toHaveLength(1);
    expect(h.stripeCalls).toEqual([]);
  });
  it("a verified canceled original intent is a terminal control", async () => {
    h.rows = { payment_charge_attempts: attemptRow("cad", { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    await handlePaymentIntentPaymentFailed(event("payment_intent.payment_failed", {
      id: PI_ID, status: "canceled", amount: AMOUNT, currency: "cad", metadata: META,
      last_payment_error: { code: "card_declined", message: "synthetic refusal" },
    }), CTX);
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "failed", stripe_payment_intent_id: PI_ID });
    expect(h.stripeCalls).toEqual([]);
  });
  it("ordinary authenticated card decline finishes the failed attempt without a false manual alert", async () => {
    h.rows = { payment_charge_attempts: attemptRow("cad", { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    await handlePaymentIntentPaymentFailed(event("payment_intent.payment_failed", {
      id: PI_ID, status: "requires_payment_method", amount: AMOUNT, currency: "cad", metadata: META,
      last_payment_error: { type: "card_error", code: "card_declined", message: "synthetic refusal" },
    }), CTX);
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "failed", stripe_payment_intent_id: PI_ID });
    expect(critical("session_payment_needs_manual_review")).toEqual([]);
    expect(h.stripeCalls).toEqual([]);
  });
  it.each([null, { type: "api_error", code: "api_error" }])("requires_payment_method without card-decline evidence (%j) stays unresolved", async (error) => {
    h.rows = { payment_charge_attempts: attemptRow("cad", { status: "pending_stripe", stripe_payment_intent_id: PI_ID }) };
    await handlePaymentIntentPaymentFailed(event("payment_intent.payment_failed", {
      id: PI_ID, status: "requires_payment_method", amount: AMOUNT, currency: "cad", metadata: META, last_payment_error: error,
    }), CTX);
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_payment_intent_id: PI_ID });
    expect(h.updates).toEqual([]);
    expect(critical("session_payment_needs_manual_review")).toHaveLength(1);
    expect(h.stripeCalls).toEqual([]);
  });

  it.each([null, "pi_other"])("ordinary decline cannot retire an unbound or different original (%s)", async (original) => {
    h.rows = { payment_charge_attempts: attemptRow("cad", { status: "pending_stripe", stripe_payment_intent_id: original }) };
    const pending = handlePaymentIntentPaymentFailed(event("payment_intent.payment_failed", {
      id: PI_ID, status: "requires_payment_method", amount: AMOUNT, currency: "cad", metadata: META,
      last_payment_error: { type: "card_error", code: "card_declined" },
    }), CTX);
    if (original === null) {
      const { PaymentOriginalBindingPendingError } = await import("@/lib/billing/payment-webhook-reconciliation");
      await expect(pending).rejects.toBeInstanceOf(PaymentOriginalBindingPendingError);
    } else expect((await pending).identityMismatch).toBe(true);
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_payment_intent_id: original });
    expect(h.updates).toEqual([]);
    expect(critical("stripe_webhook_payment_identity_mismatch")).toHaveLength(original === null ? 0 : 1);
    expect(h.stripeCalls).toEqual([]);
  });

});
