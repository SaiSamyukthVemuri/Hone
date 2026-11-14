import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { feeExecuteBlock, feePrepareBlock } from "@/lib/billing/manual-fee-one-per-appointment";

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
  createOpts: [] as Array<Record<string, unknown>>,
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
  holdNext: null as Promise<void> | null,
  clientError: null as unknown,
  order: [] as string[],
  heldSignal: (() => {}) as () => void,
}));

const fakeStripe = {
  paymentIntents: {
    create: async (_params: unknown, opts: { idempotencyKey: string }) => {
      h.createKeys.push(opts.idempotencyKey);
      h.createOpts.push(opts as unknown as Record<string, unknown>);
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
  getSessionPaymentStripe: () => {
    h.order.push("client");
    if (h.clientError) throw h.clientError;
    return fakeStripe;
  },
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
      q.maybeSingle = async () => {
        // Test hook: park the FIRST post-claim read of the account settings (canCreateInCurrentPaymentCountry).
        if (table === "studio_payment_settings" && h.holdNext && h.claimCalls >= 1) {
          const p = h.holdNext;
          h.holdNext = null;
          h.heldSignal();
          await p;
        }
        return read();
      };
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
      h.order.push("claim");
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
  h.createOpts = [];
  h.alerts = [];
  h.alertInputs = [];
  h.updates = [];
  h.claimResult = "claimed";
  h.legacyRule = false;
  h.siblings = [];
  h.siblingsError = null;
  h.claimCalls = 0;
  h.clientError = null;
  h.order = [];
  h.holdNext = null;
  h.heldSignal = () => {};
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
  it("a repeat of an ALREADY-PENDING fee never sends: no second create, the attempt stays pending and blocking", async () => {
    h.createError = new Stripe.errors.StripeConnectionError({ message: "synthetic" } as never);
    await run(); // uncertain outcome: pending_stripe, one create with the deterministic key
    h.siblings = [];
    h.claimResult = "already_pending";
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), status: "pending_stripe" } };
    const r = await run();
    expect(r).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.createKeys, "exactly one create ever: the claim winner is the only sender").toHaveLength(1);
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

// An ambiguous first request (it may have succeeded, the response was
// lost) followed by a refused REPLAY must never free the appointment. The replay reuses the same idempotency key. Stripe
// authenticates and authorises before it looks the key up, so a replay can be refused (401/403/400/429) even though the
// FIRST request created and charged a PaymentIntent. "No PaymentIntent exists" may therefore only be recorded for the
// first send (claim result "claimed"), never for a replay (already_pending).
describe("a refused REPLAY of an ambiguous first request never frees the appointment", () => {
  const raw = (over: Record<string, unknown> = {}) => ({ message: "synthetic", ...over });
  const NOW = new Date();
  // The stored row as the runner left it, fed back into the REAL gates used by prepare and execute.
  const rowAfter = (): Record<string, unknown> => {
    const merged: Record<string, unknown> = { status: "pending_stripe", stripe_payment_intent_id: null, stripe_status: null, charged_at: null };
    for (const u of h.updates) Object.assign(merged, u);
    return merged;
  };
  const asGateAttempt = (r: Record<string, unknown>) => ({
    id: ATTEMPT, charge_type: "no_show" as const, status: r.status as string, created_at: "2026-11-12T10:00:00.000Z",
    updated_at: NOW.toISOString(), failure_code: (r.failure_code as string) ?? null,
    stripe_payment_intent_id: (r.stripe_payment_intent_id as string) ?? null, stripe_status: (r.stripe_status as string) ?? null,
    charged_at: (r.charged_at as string) ?? null, stripe_charge_id: null,
  });
  const expectGateBlocked = () => {
    const att = asGateAttempt(rowAfter());
    expect(feePrepareBlock([att], "late_cancel", NOW), "prepare of the OTHER type").not.toBeNull();
    expect(feePrepareBlock([att], "no_show", NOW), "prepare of the SAME type").not.toBeNull();
    expect(feeExecuteBlock({ id: "other-attempt", created_at: "2026-11-12T11:00:00.000Z" }, [att], NOW), "execute of another attempt").not.toBeNull();
  };
  const lostFirst = async () => {
    h.createError = new Stripe.errors.StripeConnectionError(raw()); // (a) it may have succeeded; the response was lost
    await run();
    expect(h.updates.some((u) => u.status === "failed")).toBe(false);
    h.claimResult = "already_pending"; // the owner presses again: a REPLAY, same key
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), status: "pending_stripe" } };
  };
  const REPLAY_REFUSALS: Array<[string, () => unknown]> = [
    ["429 StripeRateLimitError", () => new Stripe.errors.StripeRateLimitError(raw({ statusCode: 429 }))],
    ["StripeIdempotencyError", () => new Stripe.errors.StripeIdempotencyError(raw({ type: "idempotency_error", statusCode: 400 }))],
    ["StripeAuthenticationError (key rotated between the two requests)", () => new Stripe.errors.StripeAuthenticationError(raw({ statusCode: 401 }))],
    ["StripePermissionError (account access changed between the two requests)", () => new Stripe.errors.StripePermissionError(raw({ statusCode: 403 }))],
    ["StripeInvalidRequestError (e.g. the connected account is gone)", () => new Stripe.errors.StripeInvalidRequestError(raw({ type: "invalid_request_error", statusCode: 400 }))],
    ["StripeCardError (declined replay)", () => new Stripe.errors.StripeCardError(raw({ code: "card_declined", type: "card_error", statusCode: 402 }))],
    ["StripeConnectionError again", () => new Stripe.errors.StripeConnectionError(raw())],
  ];
  for (const [name, make] of REPLAY_REFUSALS) {
    it(`(a)(b)(c)(d) ${name}: the replay is never sent, no 'no_intent_created' fact, the attempt stays unresolved, prepare and execute stay blocked`, async () => {
      await lostFirst();
      h.createError = make(); // (b) whatever Stripe would answer a replay with: it is never asked
      const before = h.updates.length;
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(h.createKeys, "the replay made no create").toHaveLength(1);
      expect(h.updates.length, "and wrote nothing").toBe(before);
      expect(h.updates.some((u) => u.stripe_status === "no_intent_created")).toBe(false); // (c)
      expectGateBlocked(); // (d)
    });
  }
  it("two replays racing, each refused or rate-limited: neither frees the gate", async () => {
    await lostFirst();
    const errs = [
      new Stripe.errors.StripeRateLimitError(raw({ statusCode: 429 })),
      new Stripe.errors.StripeAuthenticationError(raw({ statusCode: 401 })),
    ];
    let i = 0;
    h.createError = null;
    h.createReply = null;
    const fake = h as unknown as { createError: unknown };
    // each concurrent create call throws the next error
    Object.defineProperty(fake, "createError", { configurable: true, get: () => errs[i++ % errs.length], set: () => {} });
    await Promise.all([run(), run()]);
    Object.defineProperty(fake, "createError", { configurable: true, writable: true, value: null });
    expect(h.updates.some((u) => u.stripe_status === "no_intent_created")).toBe(false);
    expect(h.createKeys, "neither racing replay sent").toHaveLength(1);
    expectGateBlocked();
  });
  it("control: the FIRST send refused by Stripe (401) still records the fact and frees the appointment (provable: nothing was sent before)", async () => {
    h.createError = new Stripe.errors.StripeAuthenticationError(raw({ statusCode: 401 }));
    await run();
    expect(h.updates.some((u) => u.stripe_status === "no_intent_created")).toBe(true);
    const att = asGateAttempt(rowAfter());
    expect(feePrepareBlock([att], "late_cancel", NOW)).toBeNull();
  });
});

describe("a fee is sent once per call: no SDK-level resend with the same key", () => {
  it("the fee create carries maxNetworkRetries: 0 as a per-request option", async () => {
    h.createReply = OK_PI;
    await run();
    expect(h.createOpts).toHaveLength(1);
    expect(h.createOpts[0]).toMatchObject({ maxNetworkRetries: 0 });
  });
  for (const reason of ["late_cancellation_fee", "no_show_fee"]) {
    it(`${reason}: carries it too`, async () => {
      h.createReply = OK_PI;
      h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), charge_reason: reason } };
      await run();
      expect(h.createOpts[0]).toMatchObject({ maxNetworkRetries: 0 });
    });
  }
  it("session_payment keeps the SDK default (the option is absent), so the change is fee-only", async () => {
    h.createReply = OK_PI;
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), charge_reason: "session_payment" } };
    await run();
    expect(h.createOpts[0]).not.toHaveProperty("maxNetworkRetries");
  });
  it("a connection error on the FIRST send leaves the attempt unclear and blocking, never freed", async () => {
    h.createError = new Stripe.errors.StripeConnectionError({ message: "synthetic" } as never);
    await run();
    expect(h.updates.some((u) => u.status === "failed")).toBe(false);
    expect(h.updates.some((u) => u.stripe_status === "no_intent_created")).toBe(false);
    const att = { id: ATTEMPT, charge_type: "no_show" as const, status: "pending_stripe", created_at: "2026-11-12T10:00:00.000Z", updated_at: new Date().toISOString(), stripe_payment_intent_id: null, stripe_status: null, charged_at: null, stripe_charge_id: null };
    const now = new Date();
    expect(feePrepareBlock([att], "late_cancel", now)).not.toBeNull();
    expect(feePrepareBlock([att], "no_show", now)).not.toBeNull();
    expect(feeExecuteBlock({ id: "other", created_at: "2026-11-12T11:00:00.000Z" }, [att], now)).not.toBeNull();
  });
  it("negative control: remove the option and the first test fails", async () => {
    const src = readFileSync(join(__dirname, "../../../lib/billing/session-payment-charge.ts"), "utf8");
    expect(src).toMatch(/maxNetworkRetries: 0/);
    expect(src.match(/maxNetworkRetries/g)).toHaveLength(1);
  });
});

describe("one sender per fee attempt: the claim winner (P1 interleaving and a crashed winner)", () => {
  it("the winner is parked after its claim while a second invocation reaches already_pending: the second makes NO create; the winner is the only sender", async () => {
    let release!: () => void;
    h.holdNext = new Promise<void>((r) => { release = r; });
    const held = new Promise<void>((r) => { h.heldSignal = r; });
    h.createError = new Stripe.errors.StripeAuthenticationError({ message: "synthetic", statusCode: 401 } as never);
    const winner = run(); // claim result "claimed"; parked in the post-claim country check
    await held;
    expect(h.claimCalls).toBe(1);
    h.claimResult = "already_pending"; // the second invocation's claim sees the winner's pending row
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), status: "pending_stripe" } };
    const second = await run();
    expect(second).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.createKeys, "the second invocation did not call Stripe").toHaveLength(0);
    release();
    await winner;
    expect(h.createKeys, "exactly one create in total: the winner's").toHaveLength(1);
    // The winner's 401 is its own first and only send; the fact is sound ONLY because nobody else could have sent.
    expect(h.updates.filter((u) => u.stripe_status === "no_intent_created")).toHaveLength(1);
  });
  it("the same interleaving with a rate-limited or connection-lost winner: the second still never sends and nothing is freed", async () => {
    for (const make of [
      () => new Stripe.errors.StripeRateLimitError({ message: "synthetic", statusCode: 429 } as never),
      () => new Stripe.errors.StripeConnectionError({ message: "synthetic" } as never),
    ]) {
      h.updates = []; h.createKeys = []; h.claimCalls = 0; h.claimResult = "claimed";
      let release!: () => void;
      h.holdNext = new Promise<void>((r) => { release = r; });
      const held = new Promise<void>((r) => { h.heldSignal = r; });
      h.createError = make();
      const winner = run();
      await held;
      h.claimResult = "already_pending";
      await run();
      release();
      await winner;
      expect(h.createKeys).toHaveLength(1);
      expect(h.updates.some((u) => u.stripe_status === "no_intent_created" || u.status === "failed")).toBe(false);
    }
  });
  it("a CRASHED winner (claimed, never wrote an outcome): every later invocation is refused for manual review, none sends, the row blocks", async () => {
    // the winner died after the claim: the row is pending_stripe with no PaymentIntent id, and nothing was written
    h.claimResult = "already_pending";
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), status: "pending_stripe" } };
    for (let i = 0; i < 3; i++) {
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    }
    expect(h.createKeys).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(h.alerts.some((a) => a.severity === "critical" && a.event === "session_payment_needs_manual_review")).toBe(true);
    const recent = { id: ATTEMPT, charge_type: "no_show" as const, status: "pending_stripe", created_at: "2026-11-12T10:00:00.000Z", updated_at: new Date().toISOString(), stripe_payment_intent_id: null, stripe_status: null, charged_at: null, stripe_charge_id: null };
    const old = { ...recent, updated_at: "2026-11-01T00:00:00.000Z" };
    const now = new Date();
    for (const att of [recent, old]) {
      expect(feePrepareBlock([att], "late_cancel", now)).not.toBeNull();
      expect(feePrepareBlock([att], "no_show", now)).not.toBeNull();
      expect(feeExecuteBlock({ id: "other", created_at: "2026-11-12T11:00:00.000Z" }, [att], now)).not.toBeNull();
    }
  });
  it("session_payment still falls through to the same-key retry (unchanged)", async () => {
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), charge_reason: "session_payment" } };
    h.claimResult = "already_pending";
    h.createReply = OK_PI;
    await run();
    expect(h.createKeys).toHaveLength(1);
    expect(h.createKeys[0]).toBe(`hone:session_payment:${ATTEMPT}:v1`);
  });
  it("source pin: the fee guard sits before the same-key retry and names both fee reasons", () => {
    const src = readFileSync(join(__dirname, "../../../lib/billing/session-payment-charge.ts"), "utf8");
    const guard = src.indexOf("fee_pending_no_pi_single_sender");
    const retry = src.indexOf("to retry-create with the same idempotency key");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(retry);
    expect(src.slice(guard - 900, guard)).toMatch(/"late_cancellation_fee"[\s\S]*"no_show_fee"/);
  });
});

describe("the Stripe client is obtained BEFORE the claim: a client failure claims nothing and blocks nothing", () => {
  const asReason = (reason: string) => {
    h.rows = { ...h.rows, payment_charge_attempts: { ...(h.rows.payment_charge_attempts as object), charge_reason: reason } };
  };
  for (const reason of ["no_show_fee", "late_cancellation_fee", "session_payment"]) {
    it(`${reason}: getStripe throws -> no claim, no row change, no Stripe call, a clear error`, async () => {
      asReason(reason);
      h.clientError = new Error("STRIPE_SECRET_KEY is not set.");
      h.createReply = OK_PI;
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "blocked" });
      expect((r as { message: string }).message).toMatch(/temporarily unavailable\. This press sent nothing\. Refresh the page to see the attempt's current status/);
      expect((r as { message: string }).message, "no provider or key detail in the message").not.toMatch(/STRIPE_SECRET_KEY|sk_/);
      expect((r as { message: string }).message, "it must not read as 'this attempt is unpaid' or 'unchanged'").not.toMatch(/Nothing was charged|nothing was changed|unpaid/i);
      expect(h.claimCalls, "the attempt is never claimed").toBe(0);
      expect(h.updates, "no row is written").toEqual([]);
      expect(h.createKeys, "no PaymentIntent create").toHaveLength(0);
    });
    it(`${reason}: the normal path is unchanged (client first, then the claim, then one create)`, async () => {
      asReason(reason);
      h.createReply = OK_PI;
      const r = await run();
      expect(r).toMatchObject({ ok: true, outcome: "succeeded" });
      expect(h.order.slice(0, 2)).toEqual(["client", "claim"]);
      expect(h.claimCalls).toBe(1);
      expect(h.createKeys).toHaveLength(1);
    });
  }
  it("after a client failure the attempt is still ready and can be run again once the client works", async () => {
    h.clientError = new Error("boom");
    expect(await run()).toMatchObject({ ok: false, outcome: "blocked" });
    expect(h.claimCalls).toBe(0);
    h.clientError = null;
    h.createReply = OK_PI;
    expect(await run()).toMatchObject({ ok: true, outcome: "succeeded" });
    expect(h.claimCalls).toBe(1);
  });
});
