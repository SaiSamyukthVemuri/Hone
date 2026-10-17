import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";

// HON-11 #1, REFUND. Same split as the charge: only a Stripe error that PROVES
// Stripe refused the refund may be recorded as refund_status='failed'. A
// connection or API error may mean the money already went back, so the row stays
// 'pending_stripe' (the card says "Refund pending", never "Refund failed") until
// it is reconciled with the deterministic refund idempotency key.
//
// Drives the real refundPaymentChargeAttempt against one modelled row (same
// predicate-evaluating fake as payment-refund-receipt-mutual-serialization), and
// a negative control restores the retired "every StripeError is terminal" rule.

type Filter = { col: string; val: unknown };

const db = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  aux: {} as Record<string, { data: unknown; error: unknown }>,
  refundError: null as unknown,
  refundKeys: [] as string[],
  alerts: [] as Array<{ severity: string; event: string }>,
  legacyRule: false,
}));

vi.mock("@/lib/billing/stripe-error-outcome", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/billing/stripe-error-outcome")>();
  const { default: S } = await import("stripe");
  return {
    isDefinitiveStripeRefusal: (err: unknown) =>
      db.legacyRule ? err instanceof S.errors.StripeError : real.isDefinitiveStripeRefusal(err),
  };
});
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => true }));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (input: { severity: string; event: string }) => {
    db.alerts.push({ severity: input.severity, event: input.event });
  },
}));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({
  getSessionPaymentStripe: () => ({
    refunds: {
      create: async (_params: unknown, opts: { idempotencyKey: string }) => {
        db.refundKeys.push(opts.idempotencyKey);
        throw db.refundError;
      },
    },
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const filters: Filter[] = [];
      let op: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (p: Record<string, unknown>) => {
        op = "update";
        patch = p;
        return q;
      };
      q.eq = (col: string, val: unknown) => {
        filters.push({ col, val });
        return q;
      };
      q.is = (col: string, val: unknown) => {
        filters.push({ col, val });
        return q;
      };
      q.or = () => q;
      q.maybeSingle = async () =>
        table === "payment_charge_attempts"
          ? { data: { ...db.row }, error: null }
          : (db.aux[table] ?? { data: null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => {
        if (op === "update") {
          const matched =
            table === "payment_charge_attempts" && filters.every((f) => db.row[f.col] === f.val);
          if (matched) Object.assign(db.row, patch);
          return resolve({ data: matched ? [{ id: db.row.id }] : [], error: null });
        }
        return resolve(
          table === "payment_charge_attempts"
            ? { data: [{ ...db.row }], error: null }
            : (db.aux[table] ?? { data: null, error: null }),
        );
      };
      return q;
    },
  }),
}));

const { refundPaymentChargeAttempt } = await import("@/lib/billing/payment-refund");

const ATTEMPT = "att-1";
const STUDIO = "studio-1";
const CLIENT = "client-1";

beforeEach(() => {
  db.refundError = null;
  db.refundKeys = [];
  db.alerts = [];
  db.legacyRule = false;
  db.aux = { practitioners: { data: { role: "owner" }, error: null } };
  db.row = {
    id: ATTEMPT,
    studio_id: STUDIO,
    client_id: CLIENT,
    charge_reason: "session_payment",
    status: "succeeded",
    amount_cents: 12000,
    currency: "cad",
    stripe_livemode: true,
    stripe_account_id: "acct_1",
    stripe_payment_intent_id: "pi_1",
    stripe_charge_id: "ch_1",
    charged_at: "2026-08-14T10:00:00.000Z",
    client_payment_method_id: "cpm-1",
    refund_status: null,
    refund_amount_cents: null,
    refunded_at: null,
    stripe_refund_id: null,
    receipt_status: null,
  };
});

const refund = () =>
  refundPaymentChargeAttempt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p-1" });

const raw = (over: Record<string, unknown> = {}) => ({ message: "synthetic", ...over });

const AMBIGUOUS: Array<[string, () => unknown]> = [
  ["StripeConnectionError", () => new Stripe.errors.StripeConnectionError(raw())],
  ["StripeAPIError (5xx)", () => new Stripe.errors.StripeAPIError(raw({ statusCode: 500, type: "api_error" }))],
  ["an unrecognised StripeError subtype (TemporarySessionExpiredError)", () => new Stripe.errors.TemporarySessionExpiredError(raw())],
  ["a bare StripeError", () => new Stripe.errors.StripeError(raw())],
  ["StripeIdempotencyError (key reused; the earlier request may have succeeded)", () => new Stripe.errors.StripeIdempotencyError(raw({ type: "idempotency_error", statusCode: 400 }))],
];

const DEFINITIVE: Array<[string, () => unknown]> = [
  ["StripeCardError", () => new Stripe.errors.StripeCardError(raw({ code: "card_declined", statusCode: 402 }))],
  ["StripeInvalidRequestError (e.g. charge already refunded)", () => new Stripe.errors.StripeInvalidRequestError(raw({ code: "charge_already_refunded", statusCode: 400 }))],
  ["StripeAuthenticationError", () => new Stripe.errors.StripeAuthenticationError(raw({ statusCode: 401 }))],
  ["StripePermissionError", () => new Stripe.errors.StripePermissionError(raw({ statusCode: 403 }))],
  ["StripeRateLimitError", () => new Stripe.errors.StripeRateLimitError(raw({ statusCode: 429 }))],
];

describe("HON-11 #1 refund: an UNKNOWN outcome is never shown as 'refund failed'", () => {
  for (const [name, make] of AMBIGUOUS) {
    it(`${name}: needs_manual_review, refund_status stays pending_stripe, critical alert`, async () => {
      db.refundError = make();
      const r = await refund();
      expect(r).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(db.row.refund_status).toBe("pending_stripe");
      expect(db.alerts).toContainEqual({ severity: "critical", event: "payment_refund_stripe_unknown_outcome" });
      expect(db.alerts.some((a) => a.event === "payment_refund_failed")).toBe(false);
    });
  }
});

describe("HON-11 #1 refund: a DEFINITIVE refusal is still terminal (unchanged)", () => {
  for (const [name, make] of DEFINITIVE) {
    it(`${name}: failed, refund_status='failed'`, async () => {
      db.refundError = make();
      const r = await refund();
      expect(r).toMatchObject({ ok: false, outcome: "failed" });
      expect(db.row.refund_status).toBe("failed");
      expect(db.alerts.some((a) => a.event === "payment_refund_stripe_unknown_outcome")).toBe(false);
    });
  }
});

describe("HON-11 #1 refund: the pending row keeps the deterministic key", () => {
  it("the refund call used the attempt-scoped key a reconciliation re-queries with", async () => {
    db.refundError = new Stripe.errors.StripeConnectionError(raw());
    await refund();
    expect(db.refundKeys).toHaveLength(1);
    expect(db.refundKeys[0]).toContain(ATTEMPT);
  });

  it("a second refund request on the pending row is refused before Stripe is called", async () => {
    db.refundError = new Stripe.errors.StripeConnectionError(raw());
    await refund();
    const second = await refund();
    expect(second.ok).toBe(false);
    expect(db.refundKeys, "no second Stripe refund call").toHaveLength(1);
  });

  it("the card renders a pending refund as 'Refund pending', not 'Refund failed'", () => {
    const card = readFileSync(join(__dirname, "../../../components/session-payment-prepare-card.tsx"), "utf8");
    expect(card).toMatch(/const persistedPending = attempt\.refundStatus === "pending_stripe";/);
    expect(card).toMatch(/\{persistedPending && !localRefunded && \([\s\S]{0,400}Refund pending\./);
    expect(card).toMatch(/const persistedFailed = attempt\.refundStatus === "failed";/);
  });
});

describe("NEGATIVE CONTROL: the retired rule fails these tests", () => {
  for (const [name, make] of AMBIGUOUS.slice(0, 2)) {
    it(`with every StripeError terminal again, ${name} is written refund_status='failed'`, async () => {
      db.legacyRule = true;
      db.refundError = make();
      const r = await refund();
      expect(r).toMatchObject({ outcome: "failed" });
      expect(db.row.refund_status).toBe("failed");
    });
  }
});

describe("source shape: the refund runner consults the classifier in its terminal branch", () => {
  const src = readFileSync(join(__dirname, "../../../lib/billing/payment-refund.ts"), "utf8");
  it("the terminal branch is gated on isDefinitiveStripeRefusal", () => {
    expect(src).toMatch(
      /if \(\s*err instanceof Stripe\.errors\.StripeError &&\s*isDefinitiveStripeRefusal\(err\)\s*\) \{/,
    );
    expect(src.match(/instanceof Stripe\.errors\.StripeError/g)).toHaveLength(1);
  });
});
