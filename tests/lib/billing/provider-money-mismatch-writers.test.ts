import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

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
  alertThrows: false,
  claim: {} as Record<string, unknown>,
  pi: {} as Record<string, unknown>,
  createError: null as unknown,
  cancelStatus: "canceled" as string,
  failedWriteZero: false,
  pendingWriteZero: false,
  refund: {} as Record<string, unknown>,
  stripeCalls: [] as string[],
}));

const fakeStripe = {
  paymentIntents: {
    create: async () => {
      h.stripeCalls.push("pi_create");
      if (h.createError) throw h.createError;
      return h.pi;
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
  getSessionPaymentStripe: () => fakeStripe,
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: {
    severity: string;
    event: string;
    safeDetails?: Record<string, unknown>;
  }) => {
    h.alerts.push({ severity: a.severity, event: a.event, details: a.safeDetails ?? {} });
    if (h.alertThrows) throw new Error("synthetic diagnostic sink failure");
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
          return Promise.resolve({ data: matched ? [{ id: "row" }] : [], error: null });
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
    rpc: async (name: string) => {
      h.rpcCalls.push(name);
      if (name === "claim_session_payment_charge_attempt") {
        const row = h.rows.payment_charge_attempts as Record<string, unknown> | undefined;
        if (row && ["claimed", "already_pending"].includes(String(h.claim.result))) {
          row.status = "pending_stripe";
          if (h.claim.stripe_payment_intent_id) row.stripe_payment_intent_id = h.claim.stripe_payment_intent_id;
        }
        return { data: [h.claim], error: null };
      }
      if (name === "reconcile_card_payment_succeeded") {
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
  h.alertThrows = false;
  h.stripeCalls = [];
  h.claim = {};
  h.pi = {};
  h.createError = null;
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
    "%s: nothing is recorded, the row stays pending, a critical alert names it",
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
  const attemptWrites = () => h.updates.filter((u) => u.table === "payment_charge_attempts");
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
    it.each(STATUSES)(`${path}: a mismatched %s intent writes nothing and cancels nothing`, async (status) => {
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
    h.refund = { id: "re_1", status: "succeeded", amount: AMOUNT, currency, charge: CHARGE_ID, payment_intent: PI_ID };

    const result = await refund();

    expect(result).toMatchObject({ ok: true, outcome: "succeeded", refundAmountCents: AMOUNT });
    expect(refundSucceededWrites()).toHaveLength(1);
  });

  // The SDK can expand charge/payment_intent; only their original IDs bind
  // a successful refund to this attempt. Matching money is insufficient.
  for (const currency of ["cad", "usd"] as const) {
    it(`${currency}: matching expanded charge and intent bind to the original (control)`, async () => {
      seedSucceeded(currency);
      h.refund = { id: "re_1", status: "succeeded", amount: AMOUNT, currency,
        charge: { id: CHARGE_ID }, payment_intent: { id: PI_ID } };
      expect(await refund()).toMatchObject({ ok: true, outcome: "succeeded" });
      expect(refundSucceededWrites()).toHaveLength(1);
      expect(h.stripeCalls).toEqual(["refund_create"]);
    });
    it.each([
      ["missing refund ID", { id: undefined }],
      ["null refund ID", { id: null }],
      ["blank refund ID", { id: "  " }],
      ["non-string refund ID", { id: 7 }],
      ["missing charge", { charge: undefined }],
      ["null charge", { charge: null }],
      ["wrong charge", { charge: "ch_foreign" }],
      ["expanded wrong charge", { charge: { id: "ch_foreign" } }],
      ["expanded malformed charge", { charge: { id: 7 } }],
      ["missing known intent", { payment_intent: undefined }],
      ["null known intent", { payment_intent: null }],
      ["wrong known intent", { payment_intent: "pi_foreign" }],
      ["expanded wrong intent", { payment_intent: { id: "pi_foreign" } }],
      ["expanded malformed intent", { payment_intent: { id: 7 } }],
    ])(`${currency}: %s cannot complete a matching-money succeeded refund`, async (_label, override) => {
      seedSucceeded(currency);
      h.refund = { id: "re_1", status: "succeeded", amount: AMOUNT, currency,
        charge: CHARGE_ID, payment_intent: PI_ID, ...(override as Record<string, unknown>) };
      const result = await refund();
      expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(h.stripeCalls).toEqual(["refund_create"]);
      expect(refundSucceededWrites()).toEqual([]);
      expect(h.updates.filter((u) => u.payload.refund_status === "pending_stripe")).toHaveLength(1);
      expect(h.updates.some((u) => u.payload.refund_status === "failed")).toBe(false);
      expect(critical("payment_refund_provider_money_mismatch")).toEqual([]);
    });
  }

  it.each(["cad", "usd"] as const)("%s: a legacy row without an original intent never adopts the refund's intent", async (currency) => {
    seedSucceeded(currency);
    (h.rows.payment_charge_attempts as Record<string, unknown>).stripe_payment_intent_id = null;
    h.refund = { id: "re_1", status: "succeeded", amount: AMOUNT, currency,
      charge: CHARGE_ID, payment_intent: PI_ID };
    expect(await refund()).toMatchObject({ ok: false, outcome: "missing_payment_intent_id" });
    expect(h.stripeCalls).toEqual([]);
    expect(refundSucceededWrites()).toEqual([]);
    expect(h.updates).toEqual([]);
  });
  it.each(["stripe_charge_id", "stripe_payment_intent_id"])("blank known original %s is never treated as verified identity", async (field) => {
    seedSucceeded("cad");
    (h.rows.payment_charge_attempts as Record<string, unknown>)[field] = "  ";
    h.refund = { id: "re_1", status: "succeeded", amount: AMOUNT, currency: "cad",
      charge: field === "stripe_charge_id" ? "  " : CHARGE_ID,
      payment_intent: field === "stripe_payment_intent_id" ? "  " : PI_ID };
    expect(await refund()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["refund_create"]);
    expect(refundSucceededWrites()).toEqual([]);
    expect(h.updates.filter((u) => u.payload.refund_status === "pending_stripe")).toHaveLength(1);
  });

  it("a throwing identity diagnostic cannot complete or rearm a mismatched refund", async () => {
    seedSucceeded("cad");
    h.refund = { id: "re_1", status: "succeeded", amount: AMOUNT, currency: "cad",
      charge: "ch_foreign", payment_intent: PI_ID };
    h.alertThrows = true;
    expect(await refund()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["refund_create"]);
    expect(refundSucceededWrites()).toEqual([]);
    expect(h.updates.filter((u) => u.payload.refund_status === "pending_stripe")).toHaveLength(1);
  });

  // Matching money is not proof that the refund has actually succeeded.
  // Exercise the real writer; keep both currency success controls above.
  for (const currency of ["cad", "usd"] as const) {
    it.each(["pending", "requires_action", "failed", "canceled", undefined])(
      `${currency}: refund status %s never becomes a succeeded ledger outcome`, async (status) => {
        seedSucceeded(currency);
        h.refund = {
          id: "re_synthetic_unresolved", amount: AMOUNT, currency, charge: CHARGE_ID, payment_intent: PI_ID,
          ...(status === undefined ? {} : { status }),
        };
        const result = await refund();
        expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
        expect(h.stripeCalls).toEqual(["refund_create"]);
        expect(refundSucceededWrites()).toEqual([]);
        expect(h.updates.filter((u) => u.payload.refund_status === "pending_stripe")).toHaveLength(1);
        expect(h.updates.some((u) => u.payload.refund_status === "failed")).toBe(false);
        expect(critical("payment_refund_provider_money_mismatch")).toEqual([]);
      },
    );
  }

  it("a throwing status diagnostic retains manual review, pending claim and one refund call", async () => {
    seedSucceeded("cad");
    h.refund = { id: "re_synthetic_unresolved", status: "pending", amount: AMOUNT, currency: "cad", charge: CHARGE_ID, payment_intent: PI_ID };
    h.alertThrows = true;
    const result = await refund();
    expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["refund_create"]);
    expect(refundSucceededWrites()).toEqual([]);
    expect(h.updates.filter((u) => u.payload.refund_status === "pending_stripe")).toHaveLength(1);
    expect(h.updates.some((u) => u.payload.refund_status === "failed")).toBe(false);
    expect(critical("payment_refund_provider_status_unresolved")).toHaveLength(1);
  });

  it.each([
    ["in another currency", { amount: AMOUNT, currency: "cad" }, "usd"],
    ["for another amount", { amount: AMOUNT - 100, currency: "usd" }, "usd"],
    ["stating no money", {}, "cad"],
  ] as const)("a refund %s is NOT recorded; it stays pending for review", async (_l, money, rowCurrency) => {
    seedSucceeded(rowCurrency);
    h.refund = { id: "re_1", status: "succeeded", charge: CHARGE_ID, payment_intent: PI_ID, ...money };

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
      expect(h.stripeCalls).toEqual([path === "create" ? "pi_create" : "pi_retrieve"]);
    });
  }
  it("does not call a successful cancel response terminal unless its actual status is canceled", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT, currency: "cad" };
    h.cancelStatus = "processing";
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.updates.filter((write) => write.payload.status === "failed")).toEqual([]);
    expect(h.stripeCalls).toEqual(["pi_create", "pi_cancel"]);
  });
  it("does not report terminal failure when the canceled-state write matched no row", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT, currency: "cad" };
    h.failedWriteZero = true;
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_cancel"]);
    expect(critical("session_payment_failed_write_zero_rows")).toHaveLength(1);
  });
  it("the next execution retrieves the retained intent instead of creating another", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "processing", amount: AMOUNT, currency: "cad" };
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    const retained = h.updates.find((write) => write.payload.stripe_payment_intent_id === PI_ID);
    expect(retained?.payload).toMatchObject({ stripe_payment_intent_id: PI_ID, stripe_status: "processing" });
    h.rows.payment_charge_attempts = attemptRow("cad", { status: "pending_stripe", ...retained!.payload });
    h.claim = claimFor("cad", { result: "already_pending", stripe_payment_intent_id: retained!.payload.stripe_payment_intent_id });
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create", "pi_retrieve"]);
    expect(h.updates.filter((write) => write.payload.status === "failed")).toEqual([]);
  });
  it("does not cancel when the pending identity write was refused", async () => {
    seedLineage("cad");
    h.claim = claimFor("cad");
    h.pi = { id: PI_ID, status: "requires_action", amount: AMOUNT, currency: "cad" };
    h.pendingWriteZero = true;
    expect(await charge()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.stripeCalls).toEqual(["pi_create"]);
    expect(critical("session_payment_nonterminal_write_refused")).toHaveLength(1);
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
  return { id: "evt_1", type, account: "acct_test", livemode: false, data: { object: { customer: "cus_test", ...(type.startsWith("charge.") ? { payment_intent: PI_ID } : {}), ...(type === "payment_intent.payment_failed" ? { status: "requires_payment_method" } : {}), ...object } } } as unknown as Stripe.Event;
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


// ===========================================================================
// PAY-002 — the charge.refunded WEBHOOK must not complete a refund that the
// provider has not confirmed. Fake provider only; no live refund.
//
// The direct refund path is pinned above ("refund status %s never becomes a
// succeeded ledger outcome", pending / requires_action / failed / canceled /
// absent). These cases put the SAME question to the webhook writer. At
// production 8a87e476 handleChargeRefunded decides completion from the
// charge's aggregate fields (refunded === true, amount_refunded ===
// amount) and never reads the refund object's own status. The fix lands with
// the held 0240 refund-status protocol (#1035).
//
// Each case is `it.fails` with a "KNOWN DEFECT" name: it PASSES while the
// defect exists and goes RED the moment the webhook stops completing an
// unconfirmed refund. Whoever fixes it converts these to `it` (and keeps them).
// ===========================================================================
describe("PAY-002 charge.refunded never completes an unconfirmed refund", () => {
  function refundedChargeWith(refunds: unknown) {
    return event("charge.refunded", {
      id: CHARGE_ID,
      payment_intent: PI_ID,
      refunded: true,
      amount: AMOUNT,
      amount_refunded: AMOUNT,
      currency: "cad",
      metadata: META,
      ...(refunds === undefined ? {} : { refunds }),
    });
  }
  const succeededWrites = () =>
    h.updates.filter((u) => u.payload.refund_status === "succeeded");

  // Hone's own refund left the row pending because Stripe answered `pending`
  // or `requires_action` (the direct path's documented refusal). Stripe then
  // sends charge.refunded for that same refund.
  const heldPendingRow = () =>
    attemptRow("cad", {
      status: "succeeded",
      stripe_payment_intent_id: PI_ID,
      stripe_charge_id: CHARGE_ID,
      refund_status: "pending_stripe",
      refund_amount_cents: AMOUNT,
    });

  for (const status of ["pending", "requires_action"] as const) {
    it.fails(
      `KNOWN DEFECT PAY-002: a held pending_stripe row is completed by charge.refunded whose refund is ${status}`,
      async () => {
        h.rows = { payment_charge_attempts: heldPendingRow() };
        await handleChargeRefunded(
          refundedChargeWith({ data: [{ id: "re_1", status, amount: AMOUNT, currency: "cad" }] }),
          CTX,
        );
        expect(succeededWrites()).toEqual([]);
      },
    );

    it.fails(
      `KNOWN DEFECT PAY-002: an out-of-band charge.refunded whose refund is ${status} is recorded as succeeded`,
      async () => {
        h.rows = {
          payment_charge_attempts: attemptRow("cad", {
            status: "succeeded",
            stripe_payment_intent_id: PI_ID,
            stripe_charge_id: CHARGE_ID,
          }),
        };
        await handleChargeRefunded(
          refundedChargeWith({ data: [{ id: "re_1", status, amount: AMOUNT, currency: "cad" }] }),
          CTX,
        );
        expect(succeededWrites()).toEqual([]);
      },
    );
  }

  // Stripe API 2026-04-22 (lib/stripe/server.ts) does not embed `refunds` on a
  // Charge unless expanded, so a real event carries NO refund object at all:
  // no id and no status. Completion then rests on aggregates alone.
  it.fails(
    "KNOWN DEFECT PAY-002: charge.refunded with no refund object (default payload) completes a held refund with no status evidence",
    async () => {
      h.rows = { payment_charge_attempts: heldPendingRow() };
      await handleChargeRefunded(refundedChargeWith(undefined), CTX);
      expect(succeededWrites()).toEqual([]);
    },
  );

  // Control, and the anti-vacuity proof for the cases above: the harness DOES
  // record a succeeded write when the provider says succeeded, so an empty
  // list above is never produced by a writer that cannot write.
  it("control: a refund the provider reports succeeded is completed, with its refund id", async () => {
    h.rows = { payment_charge_attempts: heldPendingRow() };
    await handleChargeRefunded(
      refundedChargeWith({ data: [{ id: "re_1", status: "succeeded", amount: AMOUNT, currency: "cad" }] }),
      CTX,
    );
    expect(succeededWrites()).toHaveLength(1);
    expect(succeededWrites()[0].payload.stripe_refund_id).toBe("re_1");
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
