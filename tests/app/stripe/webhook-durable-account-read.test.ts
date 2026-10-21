import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PAY-WEBHOOK-01. DURABLE EVENT LOSS ON A FAILED STUDIO-BINDING READ.
//
// THE BUG THIS EXISTS TO PREVENT
// The route resolves which studio owns a connected account by reading
// studio_payment_settings. That read discarded its PostgREST error, so a
// database failure and a genuine "this account belongs to no studio" both
// produced studioId = null. With a null studio the account.updated /
// capability.updated arm returns `unboundAccount` WITHOUT syncing, the route
// marks the event processed, and answers 200. Stripe treats 200 as terminal and
// never redelivers, so the local Connect status keeps whatever it last held --
// including charges_enabled = true after Stripe had disabled charges.
//
// These are BEHAVIOURAL, not source pins. The previous coverage for this route
// was entirely readFileSync + regex, which is exactly why the defect survived:
// a source pin cannot observe that mark_stripe_event_processed was called.

const CONSTRUCT_EVENT = vi.fn();
const RECORD_OPS_ALERT = vi.fn(async () => {});
const CAPTURE_EVENT = vi.fn();
const ACCOUNTS_RETRIEVE = vi.fn();
const PAYMENT_METHOD_RETRIEVE = vi.fn();
const ENSURE_CARD_NOTIFICATION = vi.fn(async () => ({ eventType: "card_added", deduped: false }));

vi.mock("@/lib/stripe/server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/stripe/server")>();
  return {
    ...actual,
    getStripe: () => ({
      webhooks: { constructEvent: CONSTRUCT_EVENT },
      accounts: { retrieve: ACCOUNTS_RETRIEVE },
      paymentMethods: { retrieve: PAYMENT_METHOD_RETRIEVE },
    }),
  };
});
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: RECORD_OPS_ALERT }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: CAPTURE_EVENT }));
vi.mock("@/lib/billing/card-change-notification", () => ({ ensureCardChangeNotification: ENSURE_CARD_NOTIFICATION }));

const ADMIN = { current: null as ReturnType<typeof makeAdmin> | null };
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ADMIN.current!.admin,
}));

type ReadResult = { data: unknown; error: unknown };

/**
 * Fake admin client that records every rpc() by name. Reads are queued PER
 * TABLE because studio_payment_settings is read twice on the account arm (the
 * studio binding, then preserve-first-completion) and the two must be able to
 * fail independently.
 */
function makeAdmin(reads: Record<string, ReadResult[]>, rpcs: Record<string, ReadResult> = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const admin = {
    from(table: string) {
      const q = {
        select: () => q,
        eq: (column: string, value: unknown) => {
          eqCalls.push({ table, column, value });
          return q;
        },
        maybeSingle: async (): Promise<ReadResult> =>
          reads[table]?.shift() ?? { data: null, error: null },
      };
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<ReadResult> {
      rpcCalls.push({ name, args });
      return rpcs[name] ?? { data: null, error: null };
    },
  };
  return { admin, rpcCalls, eqCalls };
}

const CLAIM_OK = {
  data: [
    {
      already_processed: false,
      currently_processing_elsewhere: false,
      claimed_by_this_request: true,
      claim_token: "claim-token-1",
    },
  ],
  error: null,
};

const ACCOUNT_OBJECT = {
  id: "acct_test_1",
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: true,
  requirements: { currently_due: ["x"], eventually_due: [], disabled_reason: "requirements.past_due" },
  capabilities: { card_payments: "inactive", transfers: "inactive" },
};

function accountEvent(type = "account.updated") {
  return {
    id: "evt_1",
    type,
    account: "acct_test_1",
    livemode: false,
    data: { object: ACCOUNT_OBJECT },
  };
}

function post(body = JSON.stringify({ any: "body" }), signature = "sig") {
  return new Request("https://hone.care/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}

async function callRoute(request = post()) {
  const mod = await import("@/app/api/stripe/webhook/route");
  return mod.POST(request);
}

beforeEach(() => {
  vi.resetModules();
  CONSTRUCT_EVENT.mockReset();
  RECORD_OPS_ALERT.mockClear();
  CAPTURE_EVENT.mockClear();
  ACCOUNTS_RETRIEVE.mockReset();
  PAYMENT_METHOD_RETRIEVE.mockReset();
  ENSURE_CARD_NOTIFICATION.mockReset();
  ENSURE_CARD_NOTIFICATION.mockResolvedValue({ eventType: "card_added", deduped: false });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
});
afterEach(() => vi.clearAllMocks());

const names = (calls: Array<{ name: string }>) => calls.map((c) => c.name);

describe("PAY-WEBHOOK-01: a failed studio-binding read must not be an unbound account", () => {
  it("1. a successful binding still syncs the account and marks the event processed", async () => {
    CONSTRUCT_EVENT.mockReturnValue(accountEvent());
    ADMIN.current = makeAdmin(
      {
        studio_payment_settings: [
          { data: { studio_id: "studio-1" }, error: null },
          { data: { stripe_onboarding_completed_at: "2026-01-01T00:00:00Z" }, error: null },
        ],
      },
      { claim_stripe_event: CLAIM_OK },
    );
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(names(ADMIN.current.rpcCalls)).toContain("sync_studio_account_status");
    expect(names(ADMIN.current.rpcCalls)).toContain("mark_stripe_event_processed");
  });

  it("2. a genuinely unbound account is still recorded and acknowledged, without syncing", async () => {
    CONSTRUCT_EVENT.mockReturnValue(accountEvent());
    // Query SUCCEEDED with zero rows. This must keep its existing behaviour.
    ADMIN.current = makeAdmin(
      { studio_payment_settings: [{ data: null, error: null }] },
      { claim_stripe_event: CLAIM_OK },
    );
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(names(ADMIN.current.rpcCalls)).not.toContain("sync_studio_account_status");
    // Still terminal: an unbound account is a real answer, not a failure.
    expect(names(ADMIN.current.rpcCalls)).toContain("mark_stripe_event_processed");
  });

  it("3. a DATABASE ERROR on the binding read cannot masquerade as unbound", async () => {
    CONSTRUCT_EVENT.mockReturnValue(accountEvent());
    ADMIN.current = makeAdmin(
      {
        studio_payment_settings: [
          { data: null, error: { code: "57014", message: "statement timeout" } },
        ],
      },
      { claim_stripe_event: CLAIM_OK },
    );
    const res = await callRoute();
    // Retryable failure, not a 2xx acknowledgement.
    expect(res.status).toBe(500);
  });

  it("4. THE DURABLE-LOSS INVARIANT: the event is never marked processed after that failure", async () => {
    CONSTRUCT_EVENT.mockReturnValue(accountEvent());
    ADMIN.current = makeAdmin(
      {
        studio_payment_settings: [
          { data: null, error: { code: "57014", message: "statement timeout" } },
        ],
      },
      { claim_stripe_event: CLAIM_OK },
    );
    await callRoute();
    const called = names(ADMIN.current.rpcCalls);
    expect(called).not.toContain("mark_stripe_event_processed");
    // Nothing is recorded at all: the failure is raised BEFORE the claim, so the
    // next delivery starts from a clean slate.
    expect(called).not.toContain("claim_stripe_event");
    // And the stale local status was never touched.
    expect(called).not.toContain("sync_studio_account_status");
  });

  it("5. a failed preserve-first-completion read releases the claim and stays retryable", async () => {
    CONSTRUCT_EVENT.mockReturnValue(accountEvent());
    ADMIN.current = makeAdmin(
      {
        studio_payment_settings: [
          { data: { studio_id: "studio-1" }, error: null },
          { data: null, error: { code: "57014", message: "statement timeout" } },
        ],
      },
      { claim_stripe_event: CLAIM_OK },
    );
    const res = await callRoute();
    expect(res.status).toBe(500);
    const called = names(ADMIN.current.rpcCalls);
    // The retry/release path is reachable...
    expect(called).toContain("release_stripe_event_claim_with_error");
    // ...and the event is NOT terminal, and the status was NOT overwritten with
    // a fabricated first-completion timestamp.
    expect(called).not.toContain("mark_stripe_event_processed");
    expect(called).not.toContain("sync_studio_account_status");
  });

  it("6. no Stripe API call is made on the failure path", async () => {
    CONSTRUCT_EVENT.mockReturnValue(accountEvent());
    ADMIN.current = makeAdmin(
      {
        studio_payment_settings: [
          { data: null, error: { code: "57014", message: "statement timeout" } },
        ],
      },
      { claim_stripe_event: CLAIM_OK },
    );
    await callRoute();
    expect(ACCOUNTS_RETRIEVE).not.toHaveBeenCalled();
  });

  it("7. the binding read stays scoped to THIS event's Stripe mode", async () => {
    CONSTRUCT_EVENT.mockReturnValue({ ...accountEvent(), livemode: true });
    ADMIN.current = makeAdmin(
      { studio_payment_settings: [{ data: { studio_id: "studio-1" }, error: null }] },
      { claim_stripe_event: CLAIM_OK },
    );
    await callRoute();
    const modeFilter = ADMIN.current.eqCalls.find(
      (c) => c.table === "studio_payment_settings" && c.column === "stripe_livemode",
    );
    expect(modeFilter?.value).toBe(true);
  });

  it("8. other event families are unaffected by a HEALTHY binding read", async () => {
    CONSTRUCT_EVENT.mockReturnValue({
      id: "evt_2",
      type: "payment_intent.succeeded",
      account: "acct_test_1",
      livemode: false,
      data: { object: { id: "pi_1", metadata: {}, latest_charge: null } },
    });
    ADMIN.current = makeAdmin(
      {
        studio_payment_settings: [{ data: { studio_id: "studio-1" }, error: null }],
        payment_charge_attempts: [{ data: null, error: null }],
      },
      { claim_stripe_event: CLAIM_OK },
    );
    const res = await callRoute();
    // No match for the PI is a legitimate terminal answer for that family.
    expect(res.status).toBe(200);
    expect(names(ADMIN.current.rpcCalls)).toContain("mark_stripe_event_processed");
  });
});

// PAY-001: signature verification authenticates Stripe, not this attempt's owner.
describe("PAY-001 durable payment event identity", () => {
  const attempt = {
    id: "attempt-1", studio_id: "studio-1", client_id: "client-1",
    charge_reason: "session_payment", status: "pending_stripe",
    stripe_account_id: "acct_test_1", stripe_customer_id: "cus_1",
    stripe_livemode: false, stripe_payment_intent_id: "pi_1", stripe_charge_id: "ch_1",
    amount_cents: 5000, currency: "cad", charged_at: null,
    refund_status: null, refund_amount_cents: null, refunded_at: null, stripe_refund_id: null,
  };
  function prepare(overrides: Record<string, unknown> = {}, commandResult = "zero_rows") {
    CONSTRUCT_EVENT.mockReturnValue({
      id: "evt_payment_1", type: "payment_intent.succeeded", account: "acct_test_1", livemode: false,
      data: { object: { id: "pi_1", customer: "cus_1", amount: 5000, currency: "cad", latest_charge: "ch_1",
        metadata: { hone_payment_charge_attempt_id: "attempt-1" } } },
    });
    ADMIN.current = makeAdmin({
      studio_payment_settings: [{ data: { studio_id: "studio-1" }, error: null }],
      payment_charge_attempts: [{ data: { ...attempt, ...overrides }, error: null }],
    }, { claim_stripe_event: CLAIM_OK, reconcile_bound_payment_event: { data: [{ result: commandResult }], error: null } });
  }
  it.each([
    ["account", { stripe_account_id: "acct_other" }],
    ["studio", { studio_id: "studio-other" }],
    ["customer", { stripe_customer_id: "cus_other" }],
    ["payment intent", { stripe_payment_intent_id: "pi_other" }],
    ["charge", { stripe_charge_id: "ch_other" }],
    ["missing original intent", { stripe_payment_intent_id: null }],
    ["missing original customer", { stripe_customer_id: null }],
  ] as const)("refuses a signed event resolving to a different %s", async (_label, overrides) => {
    prepare(overrides);
    const response = await callRoute();
    expect(response.status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("reconcile_bound_payment_event");
    expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
    expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
  });
  it("a locked-command identity refusal after the application read remains processed without a receipt", async () => {
    prepare({}, "identity_mismatch");
    const response = await callRoute();
    expect(response.status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
    expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_bound_command_refused" }));
  });
  it("allows a genuinely matching event to reach the existing locked command", async () => {
    prepare();
    const response = await callRoute();
    expect(response.status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).toContain("reconcile_bound_payment_event");
    expect(ADMIN.current!.eqCalls).toEqual(expect.arrayContaining([
      { table: "payment_charge_attempts", column: "studio_id", value: "studio-1" },
      { table: "payment_charge_attempts", column: "stripe_account_id", value: "acct_test_1" },
      { table: "payment_charge_attempts", column: "stripe_livemode", value: false },
    ]));
  });
});

describe("PAY-002 signed refund status wiring", () => {
  function prepareRefund(status: string, attemptOverride: Record<string, unknown> = {}, refundOverride: Record<string, unknown> = {}) {
    CONSTRUCT_EVENT.mockReturnValue({ id: "evt_refund_1", created: 1770000000,
      type: "refund.updated", account: "acct_test_1", livemode: false,
      data: { object: { id: "re_1", charge: "ch_1", payment_intent: "pi_1", amount: 5000,
        currency: "cad", status, metadata: { hone_payment_charge_attempt_id: "attempt-1" }, ...refundOverride } },
    });
    ADMIN.current = makeAdmin({
      studio_payment_settings: [{ data: { studio_id: "studio-1" }, error: null }],
      payment_charge_attempts: [{ data: { id: "attempt-1", studio_id: "studio-1", client_id: "client-1",
        charge_reason: "session_payment", status: "succeeded", stripe_livemode: false,
        stripe_account_id: "acct_test_1", stripe_customer_id: "cus_original",
        stripe_payment_intent_id: "pi_1", stripe_charge_id: "ch_1", amount_cents: 5000,
        currency: "cad", refund_status: "pending_stripe", stripe_refund_id: "re_1", ...attemptOverride }, error: null }],
    }, { claim_stripe_event: CLAIM_OK, reconcile_bound_payment_event: { data: [{ result: "refund_pending" }], error: null } });
  }
  it.each(["pending", "requires_action", "succeeded", "failed", "canceled"])("passes actual %s and immutable original identity to the ordered command", async (status) => {
    prepareRefund(status);
    const response = await callRoute();
    expect(response.status).toBe(200);
    const command = ADMIN.current!.rpcCalls.find((call) => call.name === "reconcile_bound_payment_event");
    expect(command?.args).toMatchObject({ p_event_id: "evt_refund_1", p_event_type: "refund.updated",
      p_studio_id: "studio-1", p_stripe_account_id: "acct_test_1", p_livemode: false,
      p_object: { refund_id: "re_1", refund_status: status, refund_amount_cents: 5000,
        refund_currency: "cad", refund_charge_id: "ch_1", payment_intent_id: "pi_1",
        customer_id: "cus_original", evidence_kind: "signed_event", event_created: 1770000000 } });
    expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
  });
  it("refuses a provider-supplied customer that conflicts with the original payment", async () => {
    prepareRefund("succeeded", {}, { customer: "cus_other" });
    expect((await callRoute()).status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("reconcile_bound_payment_event");
  });
  it.each([{ stripe_account_id: "acct_other" }, { stripe_payment_intent_id: "pi_other" }, { stripe_charge_id: "ch_other" }, { stripe_customer_id: null }])(
    "refuses a signed status event with conflicting/missing original identity: %j", async (overrides) => {
      prepareRefund("succeeded", overrides);
      expect((await callRoute()).status).toBe(200);
      expect(names(ADMIN.current!.rpcCalls)).not.toContain("reconcile_bound_payment_event");
      expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
    },
  );
});

// PAY-006 app half only: the allocated SQL command must order under its lock.
describe("PAY-006 signed setup success ordering orchestration", () => {
  function prepareSetup(outcome = "inserted", eventOverride: Record<string, unknown> = {}, cardId: string | null = ["inserted", "idempotent"].includes(outcome) ? "card-1" : null, existingCard: Record<string, unknown> | null = null) {
    const setupEvent = { id: "evt_setup_success", created: 1770000200,
      type: "setup_intent.succeeded", account: "acct_test_1", livemode: false,
      data: { object: { id: "seti_old_created_late_completed", status: "succeeded", livemode: false, created: 1600000000,
        customer: "cus_1", payment_method: "pm_1",
        metadata: { hone_studio_id: "studio-1", hone_client_id: "client-1",
          hone_card_authorization_signature_id: "signature-1", success_event_created: "9999999999" } } },
      ...eventOverride,
    };
    CONSTRUCT_EVENT.mockReturnValue(setupEvent);
    PAYMENT_METHOD_RETRIEVE.mockResolvedValue({ id: "pm_1", livemode: false, type: "card", customer: "cus_1",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } });
    ADMIN.current = makeAdmin({
      studio_payment_settings: [{ data: { studio_id: "studio-1" }, error: null }],
      client_stripe_customers: [{ data: { client_id: "client-1", studio_id: "studio-1", stripe_account_id: "acct_test_1", stripe_livemode: false }, error: null }],
      client_consent_signatures: [{ data: { id: "signature-1" }, error: null }],
      client_payment_methods: [{ data: existingCard, error: null }],
    }, { claim_stripe_event: CLAIM_OK,
      save_client_card_on_file: { data: [{ outcome: "inserted", card_id: "would-overwrite-newer-card", previous_card_id: "newer-card" }], error: null },
      save_client_card_on_file_ordered: { data: [{ outcome, card_id: cardId, previous_card_id: null }], error: null },
    });
    return setupEvent;
  }
  it("passes signed success completion identity/time, not SetupIntent issuance or metadata time", async () => {
    prepareSetup();
    expect((await callRoute()).status).toBe(200);
    const command = ADMIN.current!.rpcCalls.find((call) => call.name === "save_client_card_on_file_ordered");
    expect(command?.args).toMatchObject({ p_success_event_id: "evt_setup_success", p_success_event_created: 1770000200,
      p_stripe_setup_intent_id: "seti_old_created_late_completed", p_studio_id: "studio-1", p_client_id: "client-1",
      p_stripe_account_id: "acct_test_1", p_stripe_livemode: false, p_stripe_customer_id: "cus_1" });
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("save_client_card_on_file");
    expect(ENSURE_CARD_NOTIFICATION).toHaveBeenCalledTimes(1);
  });
  it.each(["stale_event", "ambiguous_event_order"])("%s preserves selection and never advertises a saved card", async (outcome) => {
    prepareSetup(outcome);
    expect((await callRoute()).status).toBe(200);
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
    expect(CAPTURE_EVENT).not.toHaveBeenCalled();
    const processed = ADMIN.current!.rpcCalls.find((call) => call.name === "mark_stripe_event_processed");
    expect(processed?.args).toMatchObject({ p_payload_summary: { terminalRejection: true, rejected: outcome } });
  });
  it("legacy unknown active chronology stays retryable without guessing or notifying", async () => {
    prepareSetup("unknown_event_order");
    expect((await callRoute()).status).toBe(500);
    expect(names(ADMIN.current!.rpcCalls)).toContain("release_stripe_event_claim_with_error");
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("mark_stripe_event_processed");
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
    expect(CAPTURE_EVENT).not.toHaveBeenCalled();
  });
  it.each([undefined, null, -1, 1770000200.5, Number.MAX_SAFE_INTEGER + 1])("invalid signed success time %s cannot fall back to issuance/arrival", async (created) => {
    prepareSetup("inserted", { created });
    expect((await callRoute()).status).toBe(500);
    expect(PAYMENT_METHOD_RETRIEVE).not.toHaveBeenCalled();
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("save_client_card_on_file_ordered");
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("save_client_card_on_file");
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
  });
  it("a processed claim is only a transport acknowledgement, never a saved-card claim or evidence adoption", async () => {
    prepareSetup();
    const rpc = ADMIN.current!.admin.rpc;
    ADMIN.current!.admin.rpc = async (name, args) => name === "claim_stripe_event"
      ? { data: [{ already_processed: true }], error: null } : rpc(name, args);
    const response = await callRoute();
    expect(await response.json()).toEqual({ ok: true, alreadyProcessed: true });
    expect(PAYMENT_METHOD_RETRIEVE).not.toHaveBeenCalled();
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
    expect(CAPTURE_EVENT).not.toHaveBeenCalled();
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("save_client_card_on_file_ordered");
  });
  it("new app with old DB refuses and releases claim without unordered fallback", async () => {
    prepareSetup();
    const rpc = ADMIN.current!.admin.rpc;
    ADMIN.current!.admin.rpc = async (name, args) => name === "save_client_card_on_file_ordered"
      ? { data: null, error: { code: "PGRST202", message: "missing ordered command" } } : rpc(name, args);
    expect((await callRoute()).status).toBe(500);
    expect(names(ADMIN.current!.rpcCalls)).toContain("release_stripe_event_claim_with_error");
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("save_client_card_on_file");
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
    expect(CAPTURE_EVENT).not.toHaveBeenCalled();
  });
  it("explicit signed epoch zero is valid, never a missing-time default", async () => {
    prepareSetup("inserted", { created: 0 });
    expect((await callRoute()).status).toBe(200);
    expect(ADMIN.current!.rpcCalls.find((c) => c.name === "save_client_card_on_file_ordered")?.args.p_success_event_created).toBe(0);
  });
  it.each([
    { customer: "cus_other" }, { livemode: true }, { id: "pm_other" },
  ])("refuses retrieved PM lineage mismatch %j before persistence or notification", async (over) => {
    prepareSetup();
    PAYMENT_METHOD_RETRIEVE.mockResolvedValue({ id: "pm_1", livemode: false, customer: "cus_1", ...over,
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } });
    expect((await callRoute()).status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("save_client_card_on_file_ordered");
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
    expect(CAPTURE_EVENT).not.toHaveBeenCalled();
  });
  it("an existing removed card cannot bypass ordered stale adjudication to notify", async () => {
    prepareSetup("stale_event", {}, null, { id: "removed-a", status: "removed" });
    // The legacy read would see this row and notify; the new route never reads it.
    expect((await callRoute()).status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).toContain("save_client_card_on_file_ordered");
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
  });
  it("missing signed event identity cannot admit a new selection", async () => {
    prepareSetup("inserted", { id: "" });
    expect((await callRoute()).status).toBe(500);
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("save_client_card_on_file_ordered");
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
  });
  it("an unrecognized ordered result cannot advertise saved even when it carries a card id", async () => {
    prepareSetup("unrecognized_outcome", {}, "card-1");
    expect((await callRoute()).status).toBe(500);
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
    expect(CAPTURE_EVENT).not.toHaveBeenCalled();
  });
  it("passes the identity/time verified by actual SDK signature authentication", async () => {
    const event = prepareSetup();
    const payload = JSON.stringify(event);
    const webhooks = new Stripe("sk_test_synthetic_no_network").webhooks;
    const signature = webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
    CONSTRUCT_EVENT.mockImplementation((body, header, secret) => webhooks.constructEvent(body, header, secret));
    expect((await callRoute(post(payload, signature))).status).toBe(200);
    expect(ADMIN.current!.rpcCalls.find((call) => call.name === "save_client_card_on_file_ordered")?.args)
      .toMatchObject({ p_success_event_id: "evt_setup_success", p_success_event_created: 1770000200 });
  });
  it("tampering with success time after signing cannot reach any privileged operation", async () => {
    const event = prepareSetup();
    const payload = JSON.stringify(event);
    const webhooks = new Stripe("sk_test_synthetic_no_network").webhooks;
    const signature = webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
    CONSTRUCT_EVENT.mockImplementation((body, header, secret) => webhooks.constructEvent(body, header, secret));
    const tampered = payload.replace('"created":1770000200', '"created":1770000300');
    expect(tampered).not.toBe(payload);
    expect((await callRoute(post(tampered, signature))).status).toBe(400);
    expect(ADMIN.current!.rpcCalls).toEqual([]);
    expect(PAYMENT_METHOD_RETRIEVE).not.toHaveBeenCalled();
    expect(ENSURE_CARD_NOTIFICATION).not.toHaveBeenCalled();
  });
  it("the ordered command's genuine idempotent result still ensures the durable notification", async () => {
    prepareSetup("idempotent");
    expect((await callRoute()).status).toBe(200);
    expect(ENSURE_CARD_NOTIFICATION).toHaveBeenCalledTimes(1);
  });
});

describe("PAY-005 capability retrieval stays retryable", () => {
  function prepareCapability() {
    CONSTRUCT_EVENT.mockReturnValue({ id: "evt_capability_1", type: "capability.updated", account: "acct_test_1", livemode: false,
      data: { object: { id: "card_payments", object: "capability", account: "acct_test_1", status: "inactive" } } });
    ADMIN.current = makeAdmin({ studio_payment_settings: [
      { data: { studio_id: "studio-1" }, error: null },
      { data: { stripe_onboarding_completed_at: null }, error: null },
    ] }, { claim_stripe_event: CLAIM_OK });
  }
  it("does not acknowledge provider retrieval failure as processed", async () => {
    prepareCapability();
    ACCOUNTS_RETRIEVE.mockRejectedValue(new Error("synthetic provider unavailable"));
    const response = await callRoute();
    expect(response.status).toBe(500);
    expect(ACCOUNTS_RETRIEVE).toHaveBeenCalledWith("acct_test_1");
    expect(names(ADMIN.current!.rpcCalls)).toContain("release_stripe_event_claim_with_error");
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("mark_stripe_event_processed");
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("sync_studio_account_status");
  });
  it.each([false, true])("raw provider PII cannot reach console/ops/claim/response sinks (plain rejection=%s)", async (plain) => {
    prepareCapability();
    const pii = "synthetic.person@example.invalid +15555550199 123 Synthetic Street sk_test_SENSITIVE";
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ACCOUNTS_RETRIEVE.mockRejectedValue(plain ? { toString: () => pii } : new Error(pii));
      const response = await callRoute();
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(ACCOUNTS_RETRIEVE).toHaveBeenCalledTimes(1);
      expect(ACCOUNTS_RETRIEVE).toHaveBeenCalledWith("acct_test_1");
      expect(names(ADMIN.current!.rpcCalls)).toContain("release_stripe_event_claim_with_error");
      expect(names(ADMIN.current!.rpcCalls)).not.toContain("mark_stripe_event_processed");
      expect(names(ADMIN.current!.rpcCalls)).not.toContain("sync_studio_account_status");
      const serializedSinks = JSON.stringify({ console: sink.mock.calls, ops: RECORD_OPS_ALERT.mock.calls,
        rpc: ADMIN.current!.rpcCalls, body });
      for (const token of [pii, "synthetic.person@example.invalid", "+15555550199", "123 Synthetic Street", "sk_test_SENSITIVE"]) {
        expect(serializedSinks).not.toContain(token);
      }
      expect(serializedSinks).toContain("capability_updated_account_retrieve_failed");
    } finally {
      sink.mockRestore();
    }
  });
  it("a healthy retrieval still synchronizes and completes the event", async () => {
    prepareCapability();
    ACCOUNTS_RETRIEVE.mockResolvedValue(ACCOUNT_OBJECT);
    expect((await callRoute()).status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).toContain("sync_studio_account_status");
    expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
  });
});
