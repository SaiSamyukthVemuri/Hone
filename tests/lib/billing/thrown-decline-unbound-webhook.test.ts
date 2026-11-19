import { beforeEach, describe, expect, it, vi } from "vitest";

// WHAT A THROWN DECLINE LEAVES BEHIND, AND WHAT THE DECLINE EVENT THEN DOES.
// When the charge call THROWS a card error that carries a PaymentIntent which is not canceled, runSessionPaymentCharge
// records a critical alert and returns needs_manual_review WITHOUT storing the intent id on the attempt (only a RETURNED
// non-canceled intent goes through retainNonterminalPaymentIntent). The attempt therefore stays pending_stripe with
// stripe_payment_intent_id NULL. This drives the real payment_failed handler against exactly that row, mock-based like
// payment-failed-livemode-row-guard.test.ts, to show what the event does to it.

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
// The decline cleanup has its own suites (cancel-declined-session-intent.test.ts, the cleanup lane spec); this file is about binding.
vi.mock("@/lib/billing/cancel-declined-session-intent", () => ({
  cancelDeclinedSessionIntent: async () => ({ outcome: "not_applicable" }),
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



const event = (over: Record<string, unknown> = {}, objOver: Record<string, unknown> = {}) =>
  ({
    id: "evt_1", type: "payment_intent.payment_failed", account: "acct_row", livemode: true,
    data: { object: {
      id: "pi_thrown", customer: "cus_row", status: "requires_payment_method", amount: 2500, currency: "cad",
      metadata: { hone_payment_charge_attempt_id: "att_1", hone_studio_id: "stud_1", hone_client_id: "cli_1", hone_charge_reason: "session_payment" },
      last_payment_error: { type: "card_error", code: "card_declined", message: "declined" }, ...objOver,
    } },
    ...over,
  }) as never;
const row = (over: Record<string, unknown> = {}) => ({
  id: "att_1", studio_id: "stud_1", client_id: "cli_1", charge_reason: "session_payment", status: "pending_stripe",
  stripe_livemode: true, stripe_account_id: "acct_row", stripe_customer_id: "cus_row", stripe_payment_intent_id: null,
  stripe_charge_id: null, amount_cents: 2500, currency: "cad", charged_at: null, refund_status: null,
  refund_amount_cents: null, refunded_at: null, stripe_refund_id: null, ...over,
});
const { PaymentOriginalBindingPendingError } = await import("@/lib/billing/payment-webhook-reconciliation");

beforeEach(() => {
  h.state.livemode = true;
  h.state.selectResult = { data: null, error: null };
  h.state.updateResult = { data: [{ id: "att_1" }], error: null };
  h.state.updateCalls = [];
  h.state.rpcCalls = [];
  h.state.alerts = [];
});

describe("the payment_failed event against the row a thrown decline leaves", () => {
  it("CONTROL: a pending_stripe attempt whose intent id IS stored becomes failed", async () => {
    h.state.selectResult = { data: row({ stripe_payment_intent_id: "pi_thrown" }), error: null };
    await handlePaymentIntentPaymentFailed(event(), CTX);
    expect(h.state.updateCalls).toHaveLength(1);
    expect(h.state.updateCalls[0]).toMatchObject({ status: "failed", failure_code: "card_declined" });
  });
  it("FINDING: a pending_stripe attempt whose intent id was NEVER stored (the thrown-decline state) does not become failed; the handler throws the binding-pending error, so the route answers 500 and Stripe redelivers", async () => {
    h.state.selectResult = { data: row({ stripe_payment_intent_id: null }), error: null };
    await expect(handlePaymentIntentPaymentFailed(event(), CTX)).rejects.toBeInstanceOf(PaymentOriginalBindingPendingError);
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.rpcCalls).toHaveLength(0);
  });
  it("the same unbound row is never bound from the event: even on a redelivery nothing is written, so it cannot leave pending on its own", async () => {
    h.state.selectResult = { data: row({ stripe_payment_intent_id: null }), error: null };
    for (let i = 0; i < 3; i += 1) {
      await expect(handlePaymentIntentPaymentFailed(event(), CTX)).rejects.toBeInstanceOf(PaymentOriginalBindingPendingError);
    }
    expect(h.state.updateCalls).toHaveLength(0);
    expect((h.state.selectResult.data as { stripe_payment_intent_id: unknown }).stripe_payment_intent_id).toBeNull();
  });
  it("an event WITHOUT the customer adds a second mismatch, so it is refused as an identity mismatch instead of waiting for the binding (why the fake's event must carry customer)", async () => {
    h.state.selectResult = { data: row({ stripe_payment_intent_id: null }), error: null };
    const out = await handlePaymentIntentPaymentFailed(event({}, { customer: null }), CTX);
    expect(out).toMatchObject({ identityMismatch: true });
    expect(h.state.alerts.some((a) => a.event === "stripe_webhook_payment_identity_mismatch")).toBe(true);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});
