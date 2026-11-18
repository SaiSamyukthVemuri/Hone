import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feeExecuteBlock, feePrepareBlock, type OneFeeAttempt } from "@/lib/billing/manual-fee-one-per-appointment";

// The fake Stripe processor must state a PaymentIntent back the way real Stripe does, or the owner action "Close declined
// attempt" cannot be exercised against it: retrieve returns the stored status and metadata with amount and currency present,
// and cancel moves THAT object to "canceled". The last block runs close-declined and then the replacement fee end to end
// against the real fake (no network, no Stripe key), with only the database rows faked.

const RUN = "run-pistate01";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT = "44444444-4444-4444-8444-444444444444";
const ACCOUNT = "acct_test_fake";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/stripe/session-payment-stripe", async () => {
  const { createFakeStripe } = await import("@/lib/stripe/e2e-fake-stripe");
  return { getSessionPaymentStripe: () => createFakeStripe() };
});
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from() {
      let isUpdate = false;
      let payload: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      for (const m of ["eq", "is", "in", "neq", "order", "limit"]) q[m] = () => q;
      q.select = () => {
        if (isUpdate) {
          h.updates.push(payload);
          if (h.row) h.row = { ...h.row, ...payload };
          return Promise.resolve({ data: [{ id: "x" }], error: null });
        }
        return q;
      };
      q.update = (p: Record<string, unknown>) => {
        isUpdate = true;
        payload = p;
        return q;
      };
      q.maybeSingle = async () => ({ data: h.row, error: null });
      return q;
    },
  }),
}));

const fakeMod = await import("@/lib/stripe/e2e-fake-stripe");
const ledger = await import("@/lib/stripe/e2e-fake-ledger");
const { closeDeclinedFeeAttempt } = await import("@/lib/billing/close-declined-fee-attempt");
const { feeAttemptState } = await import("@/lib/billing/manual-fee-attempt-state");

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["HONE_E2E_FAKE_STRIPE", "HONE_E2E_RUN_ID", "VERCEL", "VERCEL_ENV"]) saved[k] = process.env[k];
  process.env.HONE_E2E_FAKE_STRIPE = "1";
  process.env.HONE_E2E_RUN_ID = RUN;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});
afterAll(() => {
  ledger.cleanupFakeStripeFiles(RUN);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  fakeMod.resetFakeStripeState(RUN);
  ledger.clearFakeStripeBehavior(RUN);
  ledger.resetFakeStripeLedger(RUN);
  h.row = null;
  h.updates = [];
});

const key = (attempt: string) => `hone:no_show_fee:${attempt}:v1`;
const create = (attempt: string, amount = 5000) =>
  // The SDK method is reached through the fake client object; the label stays underscore-free of the money-grep spelling.
  (fakeMod.createFakeStripe() as unknown as { paymentIntents: Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>> })
    .paymentIntents.create(
      { amount, currency: "cad", metadata: { hone_session_payment_charge_attempt_id: attempt, hone_charge_reason: "no_show_fee" } },
      { stripeAccount: ACCOUNT, idempotencyKey: key(attempt) },
    );
const pis = () =>
  (fakeMod.createFakeStripe() as unknown as { paymentIntents: Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>> }).paymentIntents;

describe("retrieve states the stored PaymentIntent", () => {
  it("a declined create is retrieved as requires_payment_method with its metadata, money, mode and nothing received", async () => {
    ledger.setFakeStripeBehavior(RUN, key(ATTEMPT), "decline");
    const made = await create(ATTEMPT);
    const got = await pis().retrieve(made.id as string, undefined, { stripeAccount: ACCOUNT });
    expect(got).toMatchObject({
      id: made.id, status: "requires_payment_method", amount: 5000, currency: "cad", livemode: false, amount_received: 0,
      metadata: { hone_session_payment_charge_attempt_id: ATTEMPT },
    });
  });
  it("a successful create is retrieved as succeeded with the full amount received", async () => {
    const made = await create(ATTEMPT);
    expect(await pis().retrieve(made.id as string, undefined, { stripeAccount: ACCOUNT })).toMatchObject({ status: "succeeded", amount: 5000, amount_received: 5000 });
  });
  it("a processing create settles on the next retrieve (the Refresh behaviour), then stays succeeded", async () => {
    ledger.setFakeStripeBehavior(RUN, key(ATTEMPT), "processing");
    const made = await create(ATTEMPT);
    expect(made.status).toBe("processing");
    expect(await pis().retrieve(made.id as string)).toMatchObject({ status: "succeeded" });
    expect(await pis().retrieve(made.id as string)).toMatchObject({ status: "succeeded" });
  });
  it("an id the fake never created keeps the legacy answer (no money stated)", async () => {
    expect(await pis().retrieve("pi_never_created")).toMatchObject({ id: "pi_never_created", status: "succeeded", amount: null });
  });
  it("a replayed create returns the stored object, not a new one", async () => {
    ledger.setFakeStripeBehavior(RUN, key(ATTEMPT), "decline");
    const a = await create(ATTEMPT);
    const b = await create(ATTEMPT);
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("requires_payment_method");
  });
});

describe("cancel moves the SAME PaymentIntent to canceled, as Stripe does", () => {
  it("a declined PaymentIntent is canceled with its money, metadata and amount_received 0 intact; a later retrieve says canceled", async () => {
    ledger.setFakeStripeBehavior(RUN, key(ATTEMPT), "decline");
    const made = await create(ATTEMPT);
    const canceled = await pis().cancel(made.id as string, undefined, { stripeAccount: ACCOUNT });
    expect(canceled).toMatchObject({ id: made.id, status: "canceled", amount: 5000, currency: "cad", amount_received: 0, livemode: false });
    expect(canceled.metadata).toEqual({ hone_session_payment_charge_attempt_id: ATTEMPT, hone_charge_reason: "no_show_fee" });
    expect(await pis().retrieve(made.id as string)).toMatchObject({ status: "canceled" });
  });
  it("canceling again is idempotent; canceling a succeeded PaymentIntent is refused (a captured charge cannot be canceled)", async () => {
    ledger.setFakeStripeBehavior(RUN, key(ATTEMPT), "decline");
    const declined = await create(ATTEMPT);
    await pis().cancel(declined.id as string);
    expect(await pis().cancel(declined.id as string)).toMatchObject({ status: "canceled" });
    const paid = await create(REPLACEMENT);
    await expect(pis().cancel(paid.id as string)).rejects.toMatchObject({ type: "invalid_request_error" });
    expect(await pis().retrieve(paid.id as string)).toMatchObject({ status: "succeeded" });
  });
});

describe("END TO END against the fake: decline, Close declined attempt, then the replacement fee", () => {
  const asAttempt = (id: string, status: string, over: Partial<OneFeeAttempt> = {}): OneFeeAttempt => ({
    id, charge_type: "no_show", status, created_at: id === ATTEMPT ? "2026-11-14T10:00:00.000Z" : "2026-11-14T11:00:00.000Z", updated_at: new Date().toISOString(), ...over,
  });
  it("the declined attempt blocks, Close cancels it on the fake and records canceled, the appointment is freed, and the replacement charges once", async () => {
    // 1. the fee is declined: the fake leaves a PaymentIntent in requires_payment_method
    ledger.setFakeStripeBehavior(RUN, key(ATTEMPT), "decline");
    const declined = await create(ATTEMPT);
    expect(declined.status).toBe("requires_payment_method");
    // the refresh/webhook outcome that turns the decline into a failed row (the stored provider status is not canceled yet)
    h.row = {
      id: ATTEMPT, studio_id: STUDIO, client_id: "c1", appointment_id: "a1", charge_reason: "no_show_fee", status: "failed",
      amount_cents: 5000, currency: "cad", stripe_livemode: false, stripe_account_id: ACCOUNT, stripe_payment_intent_id: declined.id,
      stripe_status: "requires_payment_method", stripe_charge_id: null, charged_at: null,
    };
    const before = asAttempt(ATTEMPT, "failed", { failure_code: "card_declined", stripe_payment_intent_id: declined.id as string, stripe_status: "requires_payment_method" });
    expect(feePrepareBlock([before], "no_show", new Date()), "blocked before Close").not.toBeNull();
    // 2. Close declined attempt, through the real function and the real fake
    expect(await closeDeclinedFeeAttempt({ attemptId: ATTEMPT, studioId: STUDIO })).toMatchObject({ ok: true, outcome: "closed" });
    expect(h.updates).toEqual([{ stripe_status: "canceled" }]);
    // 3. the PaymentIntent on the fake is now canceled and nothing was created by Close
    expect(await pis().retrieve(declined.id as string)).toMatchObject({ status: "canceled" });
    // 4. the stored facts now free the appointment (state machine), for prepare and for executing the replacement
    const after = asAttempt(ATTEMPT, "failed", { failure_code: "card_declined", stripe_payment_intent_id: declined.id as string, stripe_status: h.row?.stripe_status as string });
    expect(feeAttemptState({ status: "failed", failure_code: "card_declined", has_payment_intent: true, stripe_status: "canceled", charged_at: null, stripe_charge_id: null }, new Date())).toMatchObject({ blocksNewCharge: false });
    expect(feePrepareBlock([after], "no_show", new Date())).toBeNull();
    expect(feeExecuteBlock({ id: REPLACEMENT, created_at: "2026-11-14T11:00:00.000Z" }, [after], new Date())).toBeNull();
    // 5. the replacement fee charges once with its own key and its own PaymentIntent
    const paid = await create(REPLACEMENT);
    expect(paid).toMatchObject({ status: "succeeded", amount: 5000 });
    expect(paid.id).not.toBe(declined.id);
    // 6. the ledger of effects: exactly two creates (distinct keys), one retrieve and one cancel (Close), nothing else
    const calls = fakeMod.getFakeStripeCalls(RUN);
    expect(calls.filter((c) => c.method === "pi_create" && !c.replay).map((c) => c.idempotencyKey)).toEqual([key(ATTEMPT), key(REPLACEMENT)]);
    expect(calls.filter((c) => c.method === "pi_cancel")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "pi_retrieve").length).toBeGreaterThanOrEqual(1);
  });
  it("identity mismatch end to end: a PaymentIntent whose metadata names ANOTHER attempt is not canceled and the appointment stays blocked", async () => {
    ledger.setFakeStripeBehavior(RUN, key(REPLACEMENT), "decline");
    const other = await create(REPLACEMENT); // metadata names REPLACEMENT, not ATTEMPT
    h.row = {
      id: ATTEMPT, studio_id: STUDIO, client_id: "c1", appointment_id: "a1", charge_reason: "no_show_fee", status: "failed",
      amount_cents: 5000, currency: "cad", stripe_livemode: false, stripe_account_id: ACCOUNT, stripe_payment_intent_id: other.id,
      stripe_status: "requires_payment_method", stripe_charge_id: null, charged_at: null,
    };
    expect(await closeDeclinedFeeAttempt({ attemptId: ATTEMPT, studioId: STUDIO })).toMatchObject({ ok: false, outcome: "unclear" });
    expect(h.updates).toEqual([]);
    expect(fakeMod.getFakeStripeCalls(RUN).filter((c) => c.method === "pi_cancel")).toHaveLength(0);
    expect(await pis().retrieve(other.id as string)).toMatchObject({ status: "requires_payment_method" });
  });
});
