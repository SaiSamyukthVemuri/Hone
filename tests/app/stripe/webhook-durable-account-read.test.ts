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

vi.mock("@/lib/stripe/server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/stripe/server")>();
  return {
    ...actual,
    getStripe: () => ({
      webhooks: { constructEvent: CONSTRUCT_EVENT },
      accounts: { retrieve: ACCOUNTS_RETRIEVE },
    }),
  };
});
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: RECORD_OPS_ALERT }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: CAPTURE_EVENT }));

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
  const updateCalls: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      let update: Record<string, unknown> | null = null;
      const q = {
        select: () => update ? Promise.resolve({ data: [{ id: "attempt-1" }], error: null }) : q,
        update: (payload: Record<string, unknown>) => {
          update = payload; updateCalls.push({ table, payload }); return q;
        },
        in: () => q,
        or: () => q,
        is: () => q,
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
  return { admin, rpcCalls, eqCalls, updateCalls };
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

function post() {
  return new Request("https://hone.care/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: JSON.stringify({ any: "body" }),
  });
}

async function callRoute() {
  const mod = await import("@/app/api/stripe/webhook/route");
  return mod.POST(post());
}

beforeEach(() => {
  vi.resetModules();
  CONSTRUCT_EVENT.mockReset();
  RECORD_OPS_ALERT.mockClear();
  CAPTURE_EVENT.mockClear();
  ACCOUNTS_RETRIEVE.mockReset();
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
  function prepare(overrides: Record<string, unknown> = {}) {
    CONSTRUCT_EVENT.mockReturnValue({
      id: "evt_payment_1", type: "payment_intent.succeeded", account: "acct_test_1", livemode: false,
      data: { object: { id: "pi_1", customer: "cus_1", amount: 5000, currency: "cad", latest_charge: "ch_1",
        metadata: { hone_payment_charge_attempt_id: "attempt-1" } } },
    });
    ADMIN.current = makeAdmin({
      studio_payment_settings: [{ data: { studio_id: "studio-1" }, error: null }],
      payment_charge_attempts: [{ data: { ...attempt, ...overrides }, error: null }],
    }, { claim_stripe_event: CLAIM_OK, reconcile_card_payment_succeeded: { data: [{ result: "zero_rows" }], error: null } });
  }
  it.each([
    ["account", { stripe_account_id: "acct_other" }],
    ["studio", { studio_id: "studio-other" }],
    ["customer", { stripe_customer_id: "cus_other" }],
    ["payment intent", { stripe_payment_intent_id: "pi_other" }],
    ["charge", { stripe_charge_id: "ch_other" }],
    ["missing original intent on a terminal row", { stripe_payment_intent_id: null, status: "failed" }],
    ["missing original customer", { stripe_customer_id: null }],
  ] as const)("refuses a signed event resolving to a different %s", async (_label, overrides) => {
    prepare(overrides);
    const response = await callRoute();
    expect(response.status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).not.toContain("reconcile_card_payment_succeeded");
    expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
    expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
  });
  it("allows a genuinely matching event to reach the existing locked command", async () => {
    prepare();
    const response = await callRoute();
    expect(response.status).toBe(200);
    expect(names(ADMIN.current!.rpcCalls)).toContain("reconcile_card_payment_succeeded");
    expect(ADMIN.current!.eqCalls).toEqual(expect.arrayContaining([
      { table: "payment_charge_attempts", column: "studio_id", value: "studio-1" },
      { table: "payment_charge_attempts", column: "stripe_account_id", value: "acct_test_1" },
      { table: "payment_charge_attempts", column: "stripe_livemode", value: false },
    ]));
  });
});

// Exercise all three existing payment writers through the real route. Scripted
// reads deliberately may return a row despite its filters, so the independent
// identity guard is tested too; positive cases prove the write detector works.
describe.each(["payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded"] as const)(
  "PAY-001 app-first %s binding",
  (type) => {
    function prepareBound(options: {
      row?: Record<string, unknown>;
      object?: Record<string, unknown>;
      metadata?: Record<string, string>;
      account?: string;
      studio?: string;
      resolution?: "canonical" | "legacy" | "fallback";
    } = {}) {
      const account = options.account ?? "acct_test_1";
      const studio = options.studio ?? "studio-1";
      const row = {
        id: "attempt-1", studio_id: studio, client_id: "client-1", charge_reason: "session_payment",
        status: type === "charge.refunded" ? "succeeded" : "pending_stripe", stripe_livemode: false,
        stripe_account_id: account, stripe_customer_id: "cus_1", stripe_payment_intent_id: "pi_1",
        stripe_charge_id: "ch_1", amount_cents: 5000, currency: "cad", charged_at: null,
        refund_status: type === "charge.refunded" ? "pending_stripe" : null,
        refund_amount_cents: null, refunded_at: null, stripe_refund_id: null, ...options.row,
      };
      const metadata = options.metadata ?? (options.resolution === "fallback" ? {}
        : options.resolution === "legacy" ? { hone_session_payment_charge_attempt_id: "attempt-1" }
        : { hone_payment_charge_attempt_id: "attempt-1" });
      const object = type === "charge.refunded"
        ? { id: "ch_1", payment_intent: "pi_1", customer: "cus_1", amount: 5000, currency: "cad",
          refunded: true, amount_refunded: 5000, refunds: { data: [{ id: "re_1" }] }, metadata, ...options.object }
        : { id: "pi_1", customer: "cus_1", amount: 5000, currency: "cad", latest_charge: "ch_1",
          metadata, ...options.object };
      CONSTRUCT_EVENT.mockReturnValue({ id: "evt_payment_bound", type, account, livemode: false, data: { object } });
      ADMIN.current = makeAdmin({
        studio_payment_settings: [{ data: { studio_id: studio }, error: null }],
        payment_charge_attempts: [{ data: row, error: null }],
      }, { claim_stripe_event: CLAIM_OK,
        reconcile_card_payment_succeeded: { data: [{ result: "reconciled", status_before: "pending_stripe" }], error: null } });
    }
    const writes = () => ADMIN.current!.rpcCalls.filter(({ name }) => name === "reconcile_card_payment_succeeded");
    it.each([
      ["another connected account", { stripe_account_id: "acct_test_2" }],
      ["another studio", { studio_id: "studio-2" }],
      ["another customer", { stripe_customer_id: "cus_other" }],
      ["another mode", { stripe_livemode: true }],
      ["another original intent", { stripe_payment_intent_id: "pi_other" }],
      ["another original charge", { stripe_charge_id: "ch_other" }],
      ["missing original intent on a terminal row", { stripe_payment_intent_id: null, status: "failed" }],
      ["missing original customer", { stripe_customer_id: null }],
      ["missing bound account", { stripe_account_id: null }],
    ] as const)("refuses %s despite a scripted row result", async (_name, row) => {
      prepareBound({ row });
      expect((await callRoute()).status).toBe(200);
      expect(writes()).toEqual([]);
      expect(ADMIN.current!.updateCalls).toEqual([]);
      expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
      expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({
        severity: "critical", event: "stripe_webhook_payment_identity_mismatch",
      }));
    });
    it.each(["canonical", "legacy", "fallback"] as const)("matching %s resolution reaches the existing writer with all scope filters", async (resolution) => {
      prepareBound({ resolution });
      expect((await callRoute()).status).toBe(200);
      if (type === "payment_intent.succeeded") expect(writes()).toHaveLength(1);
      else {
        expect(ADMIN.current!.updateCalls).toHaveLength(1);
        expect(ADMIN.current!.updateCalls[0]).toMatchObject({ table: "payment_charge_attempts",
          payload: type === "charge.refunded" ? { refund_status: "succeeded", stripe_refund_id: "re_1" } : { status: "failed" } });
      }
      expect(ADMIN.current!.eqCalls).toEqual(expect.arrayContaining([
        { table: "payment_charge_attempts", column: "studio_id", value: "studio-1" },
        { table: "payment_charge_attempts", column: "stripe_account_id", value: "acct_test_1" },
        { table: "payment_charge_attempts", column: "stripe_livemode", value: false },
        { table: "payment_charge_attempts", column: resolution === "fallback"
          ? type === "charge.refunded" ? "stripe_charge_id" : "stripe_payment_intent_id" : "id",
          value: resolution === "fallback" ? type === "charge.refunded" ? "ch_1" : "pi_1" : "attempt-1" },
      ]));
    });
    it("early event waits for original PI persistence, then the SAME event reconciles on redelivery", async () => {
      // The existing create(confirm:true) request has claimed the attempt but
      // has not yet persisted the returned provider identity. Do not spend the
      // event while that original identity is still unavailable.
      prepareBound({ row: { status: "pending_stripe", stripe_payment_intent_id: null } });
      const first = ADMIN.current!;
      const response = await callRoute();
      const originalEnvelope = CONSTRUCT_EVENT.mock.results.at(-1)!.value;
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false });
      expect(first.updateCalls).toEqual([]);
      expect(writes()).toEqual([]);
      expect(names(first.rpcCalls)).not.toContain("mark_stripe_event_processed");
      expect(first.rpcCalls.filter(({ name }) => name === "release_stripe_event_claim_with_error")).toEqual([
        { name: "release_stripe_event_claim_with_error", args: {
          p_event_id: "evt_payment_bound", p_claim_token: "claim-token-1",
          p_error: "stripe_webhook_payment_original_binding_pending",
        } },
      ]);
      expect(ACCOUNTS_RETRIEVE).not.toHaveBeenCalled();

      // A separate request writes the original binding; this retry only reads
      // it and processes the very same signed event. It creates no PI/refund.
      prepareBound();
      expect((await callRoute()).status).toBe(200);
      expect(CONSTRUCT_EVENT.mock.results.at(-1)!.value).toEqual(originalEnvelope);
      expect(writes().length + ADMIN.current!.updateCalls.length).toBe(1);
      expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
      expect(names(ADMIN.current!.rpcCalls)).not.toContain("release_stripe_event_claim_with_error");
      expect(ACCOUNTS_RETRIEVE).not.toHaveBeenCalled();
    });
    it("repeated early delivery remains retryable without a binding or money write", async () => {
      for (let delivery = 0; delivery < 2; delivery++) {
        prepareBound({ row: { status: "pending_stripe", stripe_payment_intent_id: null } });
        expect((await callRoute()).status).toBe(500);
        expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
        expect(names(ADMIN.current!.rpcCalls)).not.toContain("mark_stripe_event_processed");
        expect(names(ADMIN.current!.rpcCalls)).toContain("release_stripe_event_claim_with_error");
      }
      expect(ACCOUNTS_RETRIEVE).not.toHaveBeenCalled();
    });
    it.each([
      { stripe_account_id: "acct_other" }, { stripe_customer_id: "cus_other" },
      { stripe_livemode: true }, { stripe_charge_id: "ch_other" },
    ])("a known contradiction does not become retryable just because the PI is missing: %j", async (contradiction) => {
      prepareBound({ row: { status: "pending_stripe", stripe_payment_intent_id: null, ...contradiction } });
      expect((await callRoute()).status).toBe(200);
      expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
      expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
      expect(names(ADMIN.current!.rpcCalls)).not.toContain("release_stripe_event_claim_with_error");
      expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
    });
    it.each(["ready", "failed", "cancelled", "blocked", "succeeded"])("missing original on %s is not an in-flight binding claim", async (status) => {
      prepareBound({ row: { status, stripe_payment_intent_id: null } });
      expect((await callRoute()).status).toBe(200);
      expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
      expect(names(ADMIN.current!.rpcCalls)).not.toContain("release_stripe_event_claim_with_error");
      expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
    });
    it("contradictory metadata cannot turn a missing PI into an in-flight binding claim", async () => {
      prepareBound({ row: { status: "pending_stripe", stripe_payment_intent_id: null },
        metadata: { hone_payment_charge_attempt_id: "attempt-1", hone_session_payment_charge_attempt_id: "attempt-other" } });
      expect((await callRoute()).status).toBe(200);
      expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
      expect(names(ADMIN.current!.rpcCalls)).not.toContain("release_stripe_event_claim_with_error");
      expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
    });
    if (type === "charge.refunded") {
      it("pending required charge waits for its original binding without adopting the event ID", async () => {
        prepareBound({ row: { status: "pending_stripe", stripe_charge_id: null } });
        expect((await callRoute()).status).toBe(500);
        expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
        expect(names(ADMIN.current!.rpcCalls)).not.toContain("mark_stripe_event_processed");
        expect(names(ADMIN.current!.rpcCalls)).toContain("release_stripe_event_claim_with_error");
        prepareBound();
        expect((await callRoute()).status).toBe(200);
        expect(ADMIN.current!.updateCalls).toHaveLength(1);
        expect(names(ADMIN.current!.rpcCalls)).toContain("mark_stripe_event_processed");
      });
    }
    it("allows a separately bound second studio/account without borrowing the first", async () => {
      prepareBound({ account: "acct_test_2", studio: "studio-2" });
      expect((await callRoute()).status).toBe(200);
      expect(writes().length + ADMIN.current!.updateCalls.length).toBe(1);
      expect(ADMIN.current!.eqCalls).toEqual(expect.arrayContaining([
        { table: "payment_charge_attempts", column: "studio_id", value: "studio-2" },
        { table: "payment_charge_attempts", column: "stripe_account_id", value: "acct_test_2" },
      ]));
      expect(RECORD_OPS_ALERT).not.toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
    });
    it("does not trust contradictory canonical and legacy metadata IDs", async () => {
      prepareBound({ metadata: { hone_payment_charge_attempt_id: "attempt-1", hone_session_payment_charge_attempt_id: "attempt-other" } });
      expect((await callRoute()).status).toBe(200);
      expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
      expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
    });
    it("does not bind a different provider object because metadata names this attempt", async () => {
      prepareBound({ object: { id: type === "charge.refunded" ? "ch_other" : "pi_other" } });
      expect((await callRoute()).status).toBe(200);
      expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
      expect(RECORD_OPS_ALERT).toHaveBeenCalledWith(expect.objectContaining({ event: "stripe_webhook_payment_identity_mismatch" }));
    });
    it("does not borrow a payment row when its account has no studio binding", async () => {
      prepareBound();
      ADMIN.current = makeAdmin({ studio_payment_settings: [{ data: null, error: null }] }, { claim_stripe_event: CLAIM_OK });
      expect((await callRoute()).status).toBe(200);
      expect(writes()).toEqual([]); expect(ADMIN.current!.updateCalls).toEqual([]);
      expect(ADMIN.current!.eqCalls.filter(({ table }) => table === "payment_charge_attempts")).toEqual([]);
    });
  },
);
