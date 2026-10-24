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
      const read = () => ({ data: h.rows[table] ?? null, error: null });
      q.select = () => {
        if (isUpdate) {
          h.updates.push(payload ?? {});
          return Promise.resolve({ data: [{ id: ATTEMPT }], error: null });
        }
        return q;
      };
      for (const m of ["eq", "is", "in", "order", "limit"]) q[m] = () => q;
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
      return {
        data: [
          {
            result: h.claimResult,
            attempt_id: ATTEMPT,
            studio_id: STUDIO,
            client_id: CLIENT,
            session_id: SESSION,
            appointment_id: APPOINTMENT,
            charge_reason: "session_payment",
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
    client_stripe_customers: { stripe_customer_id: "cus_test" },
    // PAY-CCY-02's pre-charge country check (step 4, inside
    // loadCardAndVerifyLineage) reads studio_payment_jurisdictions.
    studio_payment_jurisdictions: { payment_country: "CA", payment_currency: "cad" },
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

// Stripe answered, and the answer was no. Terminal, exactly as before.
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

describe("HON-11 #1 charge: a DEFINITIVE refusal is still terminal (unchanged)", () => {
  for (const [name, make] of DEFINITIVE) {
    it(`${name}: failed, row written failed`, async () => {
      h.createError = make();
      const r = await run();
      expect(r).toMatchObject({ ok: false, outcome: "failed" });
      expect(wroteFailed()).toBe(true);
      expect(raisedManualReview()).toBe(false);
    });
  }

  it("authentication_required still shows its own message", async () => {
    h.createError = new Stripe.errors.StripeCardError(
      raw({ code: "authentication_required", type: "card_error", statusCode: 402 }),
    );
    const r = await run();
    expect(r).toMatchObject({ outcome: "failed", failureCode: "authentication_required" });
  });
});

describe("HON-11 #1 charge: an unknown outcome can never become a second charge", () => {
  it("a retry of the pending attempt reuses the SAME idempotency key, so Stripe cannot create a second charge", async () => {
    h.createError = new Stripe.errors.StripeConnectionError(raw());
    await run();
    // The practitioner presses Run again: the claim finds the row pending.
    h.claimResult = "already_pending";
    await run();
    expect(h.createKeys).toHaveLength(2);
    expect(new Set(h.createKeys).size).toBe(1);
    expect(h.createKeys[0]).toBe(`hone:session_payment:${ATTEMPT}:v1`);
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
      h.createError = make();
      const r = await run();
      expect(r).toMatchObject({ outcome: "failed" });
      expect(wroteFailed()).toBe(true);
    });
  }
});

describe("PAY-CCY-02: a MISSING jurisdiction row is fail-closed", () => {
  // 0214_studio_payment_jurisdiction.sql BACKFILLS a row for every existing
  // studio (:147) and adds an `after insert on public.studios` trigger for new
  // ones (:164-175), so with 0214 in the chain an absent row is an INTEGRITY
  // ANOMALY, not a legacy state. It was briefly exempted as chargeable on the
  // premise that every studio lacked a row; exempting it moves money through a
  // country and currency nobody has verified.
  //
  // This case exists because nothing pinned the behaviour: the two suites that
  // touch the table SEED it, so the absence was untested and the exemption
  // could return unnoticed.
  it("refuses BEFORE Stripe when the row 0214 guarantees is absent", async () => {
    delete (h.rows as Record<string, unknown>).studio_payment_jurisdictions;

    const r = await run();

    expect(r.ok).toBe(false);
    // The country check pushes its reason into loadCardAndVerifyLineage's list,
    // so the refusal surfaces as the lineage verdict.
    expect(r).toMatchObject({ outcome: "lineage_mismatch" });
    // AND NO MONEY MOVED: the provider was never called, so there is no
    // charge to reconcile and no idempotency key was spent.
    expect(h.createKeys).toHaveLength(0);
    expect(wroteFailed()).toBe(false);
  });

  it("CONTROL: the same attempt charges once the row is present", async () => {
    // Non-vacuity. Without this the case above would also pass if the fixture
    // were broken in some unrelated way that refused every charge.
    expect((h.rows as Record<string, unknown>).studio_payment_jurisdictions).toBeDefined();
    const r = await run();
    expect(r).not.toMatchObject({ outcome: "lineage_mismatch" });
    expect(h.createKeys.length).toBeGreaterThan(0);
  });
});

describe("source shape: the runner consults the classifier in its terminal branch", () => {
  const src = readFileSync(join(__dirname, "../../../lib/billing/session-payment-charge.ts"), "utf8");
  it("the terminal branch is gated on isDefinitiveStripeRefusal", () => {
    expect(src).toMatch(
      /if \(\s*err instanceof Stripe\.errors\.StripeError &&\s*isDefinitiveStripeRefusal\(err\)\s*\) \{/,
    );
    expect(src.match(/instanceof Stripe\.errors\.StripeError/g)).toHaveLength(1);
  });
});


// Runtime privacy regression: provider prose is untrusted even when its outcome
// classification is definitive. Keep the financial state and SDK count pinned.
describe("provider message privacy on the legacy charge producer", () => {
  for (const code of ["card_declined", "authentication_required"]) {
    it(`${code}: excludes provider prose from result, ledger, alerts and diagnostics`, async () => {
      const privateText = "synthetic-private@example.invalid token=synthetic-secret";
      const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        h.createError = new Stripe.errors.StripeCardError(raw({
          message: privateText, code, type: "card_error", statusCode: 402,
        }));
        const result = await run();
        expect(result).toMatchObject({ ok: false, outcome: "failed", failureCode: code });
        expect(wroteFailed()).toBe(true);
        expect(h.createKeys).toHaveLength(1);
        expect(h.alerts).toContainEqual({
          severity: code === "authentication_required" ? "critical" : "warning",
          event: "session_payment_charge_failed",
        });
        expect(JSON.stringify([result, h.updates, h.alertInputs, diagnostic.mock.calls]))
          .not.toContain(privateText);
      } finally {
        diagnostic.mockRestore();
      }
    });
  }

  it("unknown outcome keeps pending and one SDK call without logging provider prose", async () => {
    const privateText = "synthetic-private@example.invalid token=synthetic-secret";
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.createError = new Error(privateText);
      const result = await run();
      expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(wroteFailed()).toBe(false);
      expect(raisedManualReview()).toBe(true);
      expect(h.createKeys).toHaveLength(1);
      expect(JSON.stringify([result, h.updates, h.alertInputs, diagnostic.mock.calls]))
        .not.toContain(privateText);
    } finally {
      diagnostic.mockRestore();
    }
  });
});


it("known-original retrieve failure excludes provider prose and never creates another intent", async () => {
  const privateText = "synthetic-private@example.invalid token=synthetic-secret";
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    h.claimResult = "already_pending";
    h.claimPaymentIntentId = "pi_synthetic_original";
    h.rows.payment_charge_attempts = {
      ...ATTEMPT_ROW, status: "pending_stripe",
      stripe_payment_intent_id: h.claimPaymentIntentId,
    };
    h.retrieveError = new Error(privateText);
    const result = await run();
    expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(h.retrieveCalls).toBe(1);
    expect(h.createKeys).toHaveLength(0);
    expect(wroteFailed()).toBe(false);
    expect(raisedManualReview()).toBe(true);
    expect(JSON.stringify([result, h.updates, h.alertInputs, diagnostic.mock.calls]))
      .not.toContain(privateText);
  } finally {
    diagnostic.mockRestore();
  }
});


for (const path of ["create reply", "known-original reconciliation"]) {
  it(`${path}: canceled intent excludes last_payment_error prose without changing failed state`, async () => {
    const privateText = "synthetic-private@example.invalid token=synthetic-secret";
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reply = {
        id: "pi_synthetic_canceled", status: "canceled", amount: AMOUNT, currency: "cad",
        customer: "cus_test", livemode: false,
        last_payment_error: { code: "card_declined", message: privateText },
      };
      if (path === "create reply") {
        h.createReply = reply;
      } else {
        h.claimResult = "already_pending";
        h.claimPaymentIntentId = reply.id;
        h.rows.payment_charge_attempts = {
          ...ATTEMPT_ROW, status: "pending_stripe", stripe_payment_intent_id: reply.id,
        };
        h.retrieveReply = reply;
      }
      const result = await run();
      expect(result).toMatchObject({ ok: false, outcome: "failed", failureCode: "card_declined" });
      expect(h.updates).toContainEqual(expect.objectContaining({
        status: "failed", stripe_payment_intent_id: reply.id, stripe_status: "canceled",
      }));
      expect(h.createKeys).toHaveLength(path === "create reply" ? 1 : 0);
      expect(h.retrieveCalls).toBe(path === "create reply" ? 0 : 1);
      expect(h.alerts).toContainEqual({ severity: "warning", event: "session_payment_charge_failed" });
      expect(JSON.stringify([result, h.updates, h.alertInputs, diagnostic.mock.calls]))
        .not.toContain(privateText);
    } finally {
      diagnostic.mockRestore();
    }
  });
}
