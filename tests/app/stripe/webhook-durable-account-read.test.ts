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
