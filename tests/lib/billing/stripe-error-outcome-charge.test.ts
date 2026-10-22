import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";

// HON-11 #1, CHARGE. A Stripe error that does not prove "no money moved" must
// never be recorded as a terminal `failed`.
//
// THE DEFECT. runSessionPaymentCharge sent EVERY `Stripe.errors.StripeError`
// down the terminal branch. `StripeConnectionError` and `StripeAPIError` are
// subclasses, so a PaymentIntent create that Stripe accepted but whose response
// never arrived became `failed`. The card then re-offers Prepare, a new attempt
// is a new idempotency key (`hone:session_payment:<attemptId>:v1`), and running
// it can charge the client a second time. The same file already said why that
// is wrong (`session-payment-charge.ts`, the unknown-error branch): "a transient
// network error after Stripe accepted the request could have already moved
// money".
//
// WHY THIS DRIVES THE REAL RUNNER. A grep for the classifier cannot tell whether
// the runner REACHES it. So Stripe and the admin client are faked (same shape as
// payment-zero-row-concurrent-success) and the real runSessionPaymentCharge
// decides. The negative control swaps the classifier back to the retired rule
// ("every StripeError is terminal") and proves these same tests then fail.

const h = vi.hoisted(() => ({
  createError: null as unknown,
  retrieveError: null as unknown,
  retrieveReply: null as Record<string, unknown> | null,
  confirmReply: null as Record<string, unknown> | null,
  retrieveCalls: 0,
  createKeys: [] as string[],
  confirmKeys: [] as string[],
  trace: [] as string[],
  errorStage: "confirm" as "create" | "confirm",
  bindingAck: true,
  corruptOriginal: false,
  alerts: [] as Array<{ severity: string; event: string }>,
  alertInputs: [] as unknown[],
  updates: [] as Array<Record<string, unknown>>,
  rows: {} as Record<string, unknown>,
  claimResult: "claimed" as string,
  /** Negative control: restore the pre-HON-11 rule. */
  legacyRule: false,
}));

// Both SDK stages use the actual producer identity, money and metadata.
const originalIntent = () => ({
  id: "pi_test_original", livemode: false, amount: AMOUNT, currency: "cad",
  customer: "cus_test", payment_method: "pm_test",
  status: "requires_confirmation", confirmation_method: "manual",
  latest_charge: null, amount_received: 0, amount_capturable: 0,
  metadata: { hone_studio_id: STUDIO, hone_client_id: CLIENT,
    hone_session_id: SESSION, hone_appointment_id: APPOINTMENT,
    hone_session_payment_charge_attempt_id: ATTEMPT,
    hone_charge_reason: "session_payment", hone_card_authorization_signature_id: "sig-1",
    hone_environment: "test" },
});

const fakeStripe = {
  paymentIntents: {
    create: async (params: Record<string, unknown>, opts: { idempotencyKey: string; stripeAccount: string }) => {
      h.trace.push("create");
      h.createKeys.push(opts.idempotencyKey);
      expect(params).toMatchObject({ amount: AMOUNT, currency: "cad", customer: "cus_test",
        payment_method: "pm_test", confirm: false, confirmation_method: "manual",
        metadata: originalIntent().metadata });
      expect(opts.stripeAccount).toBe("acct_test");
      if (h.errorStage === "create") throw h.createError;
      return { ...originalIntent(), customer: h.corruptOriginal ? "cus_wrong" : "cus_test" };
    },
    confirm: async (id: string, params: unknown, opts: { idempotencyKey: string; stripeAccount: string }) => {
      h.trace.push("confirm");
      h.confirmKeys.push(opts.idempotencyKey);
      expect(id).toBe(originalIntent().id);
      expect(params).toEqual({ off_session: true });
      expect(opts.stripeAccount).toBe("acct_test");
      expect(h.trace).toEqual(["claim", "create", "bind", "read_bound", "confirm"]);
      expect(h.rows.payment_charge_attempts).toMatchObject({
        status: "pending_stripe", stripe_payment_intent_id: id,
        stripe_status: "requires_confirmation",
        stripe_idempotency_key: `hone:session_payment:${ATTEMPT}:v2:create`,
      });
      if (h.confirmReply) return h.confirmReply;
      throw h.createError;
    },
    retrieve: async () => { h.retrieveCalls += 1; if (h.retrieveReply) return h.retrieveReply; throw h.retrieveError ?? new Error("retrieve must not be reached"); },
    cancel: async () => { throw new Error("cancel must not be reached"); },
  },
};

vi.mock("@/lib/billing/stripe-error-outcome", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/billing/stripe-error-outcome")>();
  const { default: S } = await import("stripe");
  return {
    isDefinitiveStripeRefusal: (err: unknown) =>
      h.legacyRule ? err instanceof S.errors.StripeError : real.isDefinitiveStripeRefusal(err),
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
      let payload: Record<string, unknown> | null = null;
      const filters: Array<[string, unknown]> = [];
      const read = () => {
        const row = h.rows[table] as Record<string, unknown> | undefined;
        if (table === "payment_charge_attempts" && row?.stripe_payment_intent_id) h.trace.push("read_bound");
        return { data: row ? { ...row } : null, error: null };
      };
      const execute = () => {
        if (!payload) return read();
        const row = h.rows[table] as Record<string, unknown>;
        const matched = filters.every(([key, value]) => row[key] === value);
        if (!matched) return { data: [], error: null };
        if (payload.stripe_status === "requires_confirmation") {
          h.trace.push("bind");
          // Lost acknowledgement grants no confirmation, even if the write landed.
          Object.assign(row, payload);
          h.updates.push(payload);
          return { data: h.bindingAck ? [{ id: ATTEMPT }] : [], error: null };
        }
        h.updates.push(payload);
        Object.assign(row, payload);
        return { data: [{ id: ATTEMPT }], error: null };
      };
      q.select = () => q;
      for (const m of ["eq", "is"]) q[m] = (key: string, value: unknown) => { filters.push([key, value]); return q; };
      for (const m of ["in", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => read();
      q.single = async () => read();
      q.then = (resolve: (v: unknown) => unknown) => resolve(execute());
      q.update = (p: Record<string, unknown>) => { payload = p; return q; };
      q.insert = () => { throw new Error(`unexpected insert on ${table}`); };
      return q;
    },
    rpc: async (name: string, args: { p_idempotency_key: string }) => {
      if (name !== "claim_session_payment_charge_attempt") return { data: null, error: null };
      h.trace.push("claim");
      const row = h.rows.payment_charge_attempts as Record<string, unknown>;
      const before = row.status;
      if (h.claimResult === "claimed") Object.assign(row, {
        status: "pending_stripe", stripe_idempotency_key: args.p_idempotency_key,
        updated_at: new Date().toISOString(),
      });
      return { data: [{ ...row, result: h.claimResult, attempt_id: ATTEMPT,
        status_before_claim: before }], error: null };
    },
  }),
}));

const { runSessionPaymentCharge } = await import("@/lib/billing/session-payment-charge");

const ATTEMPT_ROW = {
  id: ATTEMPT,
  studio_id: STUDIO,
  charge_reason: "session_payment",
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
  stripe_charge_id: null,
  charged_at: null,
  updated_at: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  h.createError = null;
  h.retrieveError = null; h.retrieveReply = null; h.confirmReply = null; h.retrieveCalls = 0;
  h.createKeys = [];
  h.confirmKeys = [];
  h.trace = [];
  h.errorStage = "confirm";
  h.bindingAck = true;
  h.corruptOriginal = false;
  h.alerts = [];
  h.alertInputs = [];
  h.updates = [];
  h.claimResult = "claimed";
  h.legacyRule = false;
  h.rows = {
    payment_charge_attempts: { ...ATTEMPT_ROW },
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
    studio_payment_jurisdictions: { payment_country: "CA", payment_currency: "cad" },
    client_stripe_customers: { stripe_customer_id: "cus_test" },
  };
});

const run = () =>
  runSessionPaymentCharge({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: PRACTITIONER } as never);

const wroteFailed = () => h.updates.some((u) => u.status === "failed");
const raisedManualReview = () =>
  h.alerts.some((a) => a.severity === "critical" && a.event === "session_payment_needs_manual_review");

const raw = (over: Record<string, unknown> = {}) => ({ message: "synthetic", ...over });

// The outcome is UNKNOWN: Stripe may have processed the request.
const AMBIGUOUS: Array<[string, () => unknown]> = [
  ["StripeConnectionError (response lost after Stripe accepted)", () => new Stripe.errors.StripeConnectionError(raw())],
  ["StripeAPIError (5xx)", () => new Stripe.errors.StripeAPIError(raw({ statusCode: 500, type: "api_error" }))],
  ["an unrecognised StripeError subtype (TemporarySessionExpiredError)", () => new Stripe.errors.TemporarySessionExpiredError(raw())],
  ["a bare StripeError", () => new Stripe.errors.StripeError(raw())],
  ["StripeIdempotencyError (key reused; the earlier request may have succeeded)", () => new Stripe.errors.StripeIdempotencyError(raw({ type: "idempotency_error", statusCode: 400 }))],
];

// A definitive error alone is insufficient after staging. Attach a verified
// bound original proving refusal: canceled, or an ordinary card decline.
const withObservedRefusal = (err: unknown, cardDecline = false) => Object.assign(err as object, {
  payment_intent: { ...originalIntent(),
    status: cardDecline ? "requires_payment_method" : "canceled",
    last_payment_error: cardDecline ? { type: "card_error", code: "card_declined" } : null,
  },
});

// Stripe answered, and the original's full identity + terminal/refusal truth agree.
const DEFINITIVE: Array<[string, () => unknown]> = [
  ["StripeCardError (declined)", () => new Stripe.errors.StripeCardError(raw({ code: "card_declined", type: "card_error", statusCode: 402 }))],
  ["StripeInvalidRequestError", () => new Stripe.errors.StripeInvalidRequestError(raw({ type: "invalid_request_error", statusCode: 400 }))],
  ["StripeAuthenticationError", () => new Stripe.errors.StripeAuthenticationError(raw({ statusCode: 401 }))],
  ["StripePermissionError", () => new Stripe.errors.StripePermissionError(raw({ statusCode: 403 }))],
  ["StripeRateLimitError", () => new Stripe.errors.StripeRateLimitError(raw({ statusCode: 429 }))],
];

describe("HON-11 #1 charge: an UNKNOWN outcome stays pending for manual review", () => {
  for (const [name, make] of AMBIGUOUS) {
    it(`${name}: needs_manual_review, row NOT written failed, critical alert`, async () => {
      h.createError = make();
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(wroteFailed(), "the row must stay pending_stripe, never terminal failed").toBe(false);
      expect(raisedManualReview()).toBe(true);
    });
  }
});

describe("HON-11 #1 charge: a verified bound DEFINITIVE refusal still fails the attempt", () => {
  for (const [name, make] of DEFINITIVE) {
    it(`${name}: failed, row written failed`, async () => {
      h.createError = withObservedRefusal(make(), name.startsWith("StripeCardError"));
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "failed" });
      expect(wroteFailed()).toBe(true);
      expect(raisedManualReview()).toBe(false);
      expect(h.createKeys).toHaveLength(1);
      expect(h.confirmKeys).toEqual([`hone:session_payment:${ATTEMPT}:v2:confirm:pi_test_original`]);
    });
  }

  it("authentication_required still shows its own message", async () => {
    h.createError = withObservedRefusal(new Stripe.errors.StripeCardError(
      raw({ code: "authentication_required", type: "card_error", statusCode: 402 }),
    ), true);
    const r = await run();
    expect(r).toMatchObject({ outcome: "failed", failureCode: "authentication_required" });
  });
});

describe("HON-11 #1 charge: an unknown outcome can never become a second charge", () => {
  it("a retry after an UNKNOWN create cannot create or confirm again", async () => {
    h.errorStage = "create";
    h.createError = new Stripe.errors.StripeConnectionError(raw());
    expect(await run()).toMatchObject({ outcome: "needs_manual_review" });
    // The practitioner presses Run again: the durable row is pending without an original.
    h.claimResult = "already_pending";
    expect(await run()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.createKeys).toHaveLength(1);
    expect(h.confirmKeys).toHaveLength(0);
    expect(wroteFailed()).toBe(false);
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_payment_intent_id: null });
    expect(new Set(h.createKeys).size).toBe(1);
    expect(h.createKeys[0]).toBe(`hone:session_payment:${ATTEMPT}:v2:create`);
  });

  // Prepare is what would mint a new attempt (and so a new key). A
  // pending_stripe attempt blocks it twice over.
  const root = join(__dirname, "../../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("the card offers Prepare again only after failed / cancelled / blocked, never pending_stripe", () => {
    const card = read("components/session-payment-prepare-card.tsx");
    const m = card.match(/const TERMINAL_RETRY_STATUSES = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/pending_stripe/);
    expect(m![1]).toMatch(/"failed"/);
  });

  it("eligibility refuses a new attempt while one is pending_stripe", () => {
    const elig = read("lib/billing/session-payment-eligibility.ts");
    expect(elig).toMatch(/const blockingStatuses = new Set\(\[\s*"ready",\s*"pending_stripe",\s*"succeeded",?\s*\]\)/);
  });

  it("the database refuses a second active attempt while one is pending_stripe (0105 partial unique index)", () => {
    const sql = read("supabase/migrations/0105_mode_scoped_active_attempt_uniqueness.sql");
    expect(sql).toMatch(
      /create unique index payment_charge_attempts_active_session_payment_uniq[\s\S]*?status in \('ready', 'pending_stripe', 'succeeded'\)/,
    );
  });
});

describe("NEGATIVE CONTROL: the retired rule fails these tests", () => {
  for (const [name, make] of AMBIGUOUS.slice(0, 2)) {
    it(`with every StripeError terminal again, ${name} is written FAILED (the double-charge setup)`, async () => {
      h.legacyRule = true;
      h.createError = withObservedRefusal(make());
      const r = await run();
      expect(r).toMatchObject({ outcome: "failed" });
      expect(wroteFailed()).toBe(true);
    });
  }
});

describe("source shape: the runner consults the classifier in its terminal branch", () => {
  const src = readFileSync(join(__dirname, "../../../lib/billing/session-payment-charge.ts"), "utf8");
  it("the terminal branch is gated on isDefinitiveStripeRefusal", () => {
    expect(src).toMatch(
      /if \(boundPaymentIntentId && err instanceof Stripe\.errors\.StripeError\s*&&\s*isDefinitiveStripeRefusal\(err\)\) \{/,
    );
    expect(src.match(/instanceof Stripe\.errors\.StripeError/g)).toHaveLength(1);
  });
});


describe("staged refusal evidence and continuation controls", () => {
  for (const [name, make] of AMBIGUOUS.slice(0, 2)) {
    it(`${name}: even a refusal-shaped original cannot bypass the real classifier`, async () => {
      h.createError = withObservedRefusal(make());
      expect(await run()).toMatchObject({ outcome: "needs_manual_review" });
      expect(wroteFailed()).toBe(false);
      expect(raisedManualReview()).toBe(true);
      expect(h.confirmKeys).toHaveLength(1);
    });
  }
  for (const [name, make] of DEFINITIVE) {
    it(`${name}: unbound create error cannot claim a terminal original`, async () => {
      h.errorStage = "create";
      h.createError = withObservedRefusal(make());
      expect(await run()).toMatchObject({ outcome: "needs_manual_review" });
      expect(wroteFailed()).toBe(false);
      expect(raisedManualReview()).toBe(true);
      expect(h.createKeys).toHaveLength(1);
      expect(h.confirmKeys).toHaveLength(0);
      expect(h.rows.payment_charge_attempts).toMatchObject({ stripe_payment_intent_id: null });
    });
    it(`${name}: a bound error without observed refusal stays pending`, async () => {
      h.createError = make();
      expect(await run()).toMatchObject({ outcome: "needs_manual_review" });
      expect(wroteFailed()).toBe(false);
      expect(raisedManualReview()).toBe(true);
      expect(h.confirmKeys).toHaveLength(1);
      expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_payment_intent_id: "pi_test_original" });
    });
  }
  it("a binding write with lost acknowledgement cannot reach confirm", async () => {
    h.bindingAck = false;
    h.createError = withObservedRefusal(new Stripe.errors.StripeCardError(raw({ type: "card_error" })), true);
    expect(await run()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.createKeys).toHaveLength(1);
    expect(h.confirmKeys).toHaveLength(0);
    expect(wroteFailed()).toBe(false);
    expect(h.rows.payment_charge_attempts).toMatchObject({ status: "pending_stripe", stripe_payment_intent_id: "pi_test_original" });
  });
  it("wrong original customer refuses before binding or confirm", async () => {
    h.corruptOriginal = true;
    expect(await run()).toMatchObject({ outcome: "needs_manual_review" });
    expect(h.createKeys).toHaveLength(1);
    expect(h.confirmKeys).toHaveLength(0);
    expect(h.updates).toEqual([]);
  });
});


// Privacy controls use this future protocol's staged create/bind/confirm model.
describe("future provider prose boundary", () => {
  const privateText = "synthetic-private@example.invalid token=synthetic-secret";
  function pendingOriginal() {
    h.claimResult = "already_pending";
    h.rows.payment_charge_attempts = { ...ATTEMPT_ROW, status: "pending_stripe",
      stripe_payment_intent_id: originalIntent().id, stripe_status: "requires_confirmation",
      stripe_idempotency_key: `hone:session_payment:${ATTEMPT}:v2:create` };
  }
  it.each(["retrieve error", "canceled reply"])("known-original %s excludes provider prose without another create/confirm", async (path) => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      pendingOriginal();
      if (path === "retrieve error") h.retrieveError = new Error(privateText);
      else h.retrieveReply = { ...originalIntent(), status: "canceled",
        last_payment_error: { type: "card_error", code: "card_declined", message: privateText } };
      const result = await run();
      expect(result).toMatchObject({ ok: false, outcome: path === "retrieve error" ? "needs_manual_review" : "failed" });
      expect(h.retrieveCalls).toBe(1); expect(h.createKeys).toHaveLength(0); expect(h.confirmKeys).toHaveLength(0);
      expect(wroteFailed()).toBe(path === "canceled reply");
      expect(raisedManualReview()).toBe(path === "retrieve error");
      expect(JSON.stringify([result, h.updates, h.alertInputs, diagnostic.mock.calls])).not.toContain(privateText);
    } finally { diagnostic.mockRestore(); }
  });
  it("staged canceled confirmation reply retains its fixed-copy boundary", async () => {
    h.confirmReply = { ...originalIntent(), status: "canceled",
      last_payment_error: { type: "card_error", code: "card_declined", message: privateText } };
    const result = await run();
    expect(result).toMatchObject({ ok: false, outcome: "failed", failureCode: "card_declined" });
    expect(wroteFailed()).toBe(true); expect(h.createKeys).toHaveLength(1); expect(h.confirmKeys).toHaveLength(1);
    expect(h.trace).toEqual(["claim", "create", "bind", "read_bound", "confirm"]);
    expect(JSON.stringify([result, h.updates, h.alertInputs])).not.toContain(privateText);
  });
  it.each(["card_declined", "authentication_required"])("bound %s refusal excludes provider prose", async (code) => {
    h.createError = withObservedRefusal(new Stripe.errors.StripeCardError(raw({
      message: privateText, code, type: "card_error", statusCode: 402,
    })), true);
    const result = await run();
    expect(result).toMatchObject({ ok: false, outcome: "failed", failureCode: code });
    expect(wroteFailed()).toBe(true); expect(h.createKeys).toHaveLength(1); expect(h.confirmKeys).toHaveLength(1);
    expect(h.alerts).toContainEqual({
      severity: code === "authentication_required" ? "critical" : "warning",
      event: "session_payment_charge_failed",
    });
    expect(JSON.stringify([result, h.updates, h.alertInputs])).not.toContain(privateText);
  });
  // Production's unknown-outcome privacy control, adapted to the staged
  // create/bind/confirm model: an unclassified confirm error stays pending.
  it("unknown confirm outcome keeps pending and one create/confirm without logging provider prose", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.createError = new Error(privateText);
      const result = await run();
      expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(wroteFailed()).toBe(false);
      expect(raisedManualReview()).toBe(true);
      expect(h.createKeys).toHaveLength(1); expect(h.confirmKeys).toHaveLength(1);
      expect(JSON.stringify([result, h.updates, h.alertInputs, diagnostic.mock.calls])).not.toContain(privateText);
    } finally { diagnostic.mockRestore(); }
  });
});
