import { beforeEach, describe, expect, it, vi } from "vitest";

// PR: resolved-row stripe_livemode guard for payment_intent.payment_failed.
// Behavioral proof (mock-based — the db harness is raw pg and cannot invoke a
// handler that uses the supabase-js admin client). Mocks the three module
// deps (admin client, ops alerts, inferStripeLivemode) and drives the real
// handler so we can prove: a WRONG-mode resolved row is NOT mutated, and a
// MATCHING-mode row still flips to failed.

const h = vi.hoisted(() => {
  const state = {
    livemode: true,
    selectResult: { data: null as unknown, error: null as unknown },
    updateResult: { data: [] as unknown[], error: null as unknown },
    updateCalls: [] as Record<string, unknown>[],
    rpcCalls: [] as Record<string, unknown>[],
    alerts: [] as Record<string, unknown>[],
  };
  // Fluent builder: chainable for the resolver (.select().eq().maybeSingle())
  // and awaitable for the update terminal (.update().eq().in().select() then
  // awaited). `.update()` marks the chain so awaiting it yields updateResult.
  const makeBuilder = () => {
    let isUpdate = false;
    const b: Record<string, unknown> = {
      from: () => b,
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name !== "reconcile_bound_payment_event") throw new Error(`unexpected RPC ${name}`);
        state.rpcCalls.push({ name, ...args });
        const row = state.selectResult.data as Record<string, unknown>;
        const object = args.p_object as Record<string, unknown>;
        const match = row && row.id === args.p_attempt_id && row.studio_id === args.p_studio_id
          && row.stripe_account_id === args.p_stripe_account_id && row.stripe_livemode === args.p_livemode
          && row.stripe_customer_id === object.customer_id && row.stripe_payment_intent_id === object.payment_intent_id
          && row.amount_cents === object.amount_cents && row.currency === object.currency;
        if (!match) return { data: [{ result: "identity_mismatch" }], error: null };
        if (state.updateResult.data.length && ["ready", "pending_stripe"].includes(String(row.status))) {
          const payload = { status: "failed", failed_at: "2026-10-21T04:00:00Z",
            failure_code: object.failure_code, failure_message_safe: object.failure_message_safe };
          state.updateCalls.push(payload); Object.assign(row, payload);
          return { data: [{ result: "reconciled" }], error: null };
        }
        return { data: [{ result: "zero_rows" }], error: null };
      },
      select: () => b,
      eq: () => b,
      in: () => b,
      update: (payload: Record<string, unknown>) => {
        isUpdate = true;
        state.updateCalls.push(payload);
        return b;
      },
      maybeSingle: () => Promise.resolve(state.selectResult),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(isUpdate ? state.updateResult : state.selectResult).then(
          onF,
          onR,
        ),
    };
    return b;
  };
  return { state, makeBuilder };
});

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => h.makeBuilder(),
}));
vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.state.livemode,
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: Record<string, unknown>) => {
    h.state.alerts.push(a);
  },
}));

const { handlePaymentIntentPaymentFailed } = await import(
  "@/lib/billing/payment-webhook-reconciliation"
);

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: "att_1",
    studio_id: "stud_1",
    client_id: "cli_1",
    charge_reason: "session_payment",
    status: "ready",
    stripe_livemode: true,
    stripe_account_id: "acct_row",
    stripe_customer_id: "cus_row",
    stripe_payment_intent_id: "pi_row",
    stripe_charge_id: null,
    amount_cents: 2500,
    currency: "cad",
    charged_at: null,
    refund_status: null,
    refund_amount_cents: null,
    refunded_at: null,
    stripe_refund_id: null,
    ...over,
  };
}

// Event whose livemode MATCHES the deployment + metadata matching the row's
// studio/client/reason (so the event-mode + metadata guards both PASS and we
// reach the row-mode guard).
function failedEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "payment_intent.payment_failed",
    account: "acct_row",
    livemode: true,
    data: {
      object: {
        id: "pi_row",
        customer: "cus_row",
        status: "requires_payment_method",
        // A real PaymentIntent states its money (PAY-CCY-01).
        amount: 2500,
        currency: "cad",
        metadata: {
          hone_payment_charge_attempt_id: "att_1",
          hone_studio_id: "stud_1",
          hone_client_id: "cli_1",
          hone_charge_reason: "session_payment",
        },
        last_payment_error: { type: "card_error", code: "card_declined", message: "declined" },
      },
    },
    ...over,
  } as never;
}

const CTX = { studioId: "stud_1", stripeAccountId: "acct_row", livemode: true };

beforeEach(() => {
  h.state.livemode = true;
  h.state.selectResult = { data: null, error: null };
  h.state.updateResult = { data: [], error: null };
  h.state.updateCalls = [];
  h.state.rpcCalls = [];
  h.state.alerts = [];
});

describe("payment_intent.payment_failed — resolved-row livemode guard", () => {
  it("WRONG-mode row: does NOT mutate, fires the published mode-specific refusal before any command", async () => {
    // Deployment is LIVE; the resolved row is TEST-mode (same studio/client/reason).
    h.state.livemode = true;
    h.state.selectResult = {
      data: attemptRow({ stripe_livemode: false, status: "ready" }),
      error: null,
    };

    const result = await handlePaymentIntentPaymentFailed(failedEvent(), CTX);

    // No row mutation.
    expect(h.state.updateCalls).toHaveLength(0);
    // Critical mismatch alert with the exact event name + no-mutation message.
    const alert = h.state.alerts.find(
      (a) => a.event === "payment_intent_failed_livemode_row_mismatch",
    );
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("critical");
    expect(String(alert!.message)).toMatch(/Row was NOT mutated/);
    expect(alert).toMatchObject({ safeDetails: { attempt_id: "att_1" } });
    expect(h.state.rpcCalls).toHaveLength(0);
    // Structured return.
    expect(result).toMatchObject({ livemodeRowMismatch: true, attemptId: "att_1" });
    expect(result).not.toHaveProperty("identityMismatch");
  });

  it("MATCHING-mode row (regression): still flips ready → failed with sanitized error fields", async () => {
    h.state.livemode = true;
    h.state.selectResult = {
      data: attemptRow({ stripe_livemode: true, status: "ready" }),
      error: null,
    };
    h.state.updateResult = { data: [{ id: "att_1" }], error: null };

    const result = await handlePaymentIntentPaymentFailed(failedEvent(), CTX);

    // Exactly one bound-command ledger update, with original identity/mode/money.
    expect(h.state.rpcCalls[0]).toMatchObject({ p_stripe_account_id: "acct_row", p_livemode: true,
      p_object: { customer_id: "cus_row", payment_intent_id: "pi_row", amount_cents: 2500, currency: "cad" } });
    expect(h.state.updateCalls).toHaveLength(1);
    expect(h.state.updateCalls[0]).toMatchObject({
      status: "failed",
      failure_code: "card_declined",
    });
    expect(h.state.updateCalls[0].failed_at).toBeTruthy();
    // No mismatch alert on the happy path.
    expect(
      h.state.alerts.find(
        (a) => a.event === "payment_intent_failed_livemode_row_mismatch",
      ),
    ).toBeUndefined();
    expect(result).not.toHaveProperty("livemodeRowMismatch");
  });

  it("MATCHING-mode pending_stripe row also flips to failed (unchanged behavior)", async () => {
    h.state.selectResult = {
      data: attemptRow({ stripe_livemode: true, status: "pending_stripe" }),
      error: null,
    };
    h.state.updateResult = { data: [{ id: "att_1" }], error: null };
    await handlePaymentIntentPaymentFailed(failedEvent(), CTX);
    expect(h.state.updateCalls).toHaveLength(1);
    expect(h.state.updateCalls[0].status).toBe("failed");
  });
});
