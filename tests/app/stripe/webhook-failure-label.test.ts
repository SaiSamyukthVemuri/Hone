import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WEBHOOK-FAILURE-LABEL. A failed handler's `stripe_webhook_handler_failed`
// line carries `failureLabel`: the same bounded label the catch stores on
// stripe_events.error, so the failing step is visible in the logs. Before this,
// the line carried only `errorClass` ("error"), and a label whose database code
// had uppercase letters ("...:PGRST202") was also lost from storage.
//
// Behavioural, through the real POST: claim -> dispatch (a handler throws) ->
// release-with-error. Status, release and alert must be exactly as before.

const CONSTRUCT_EVENT = vi.fn();
const RECORD_OPS_ALERT = vi.fn(async () => {});
const HANDLE_SUCCEEDED = vi.fn(async (): Promise<Record<string, unknown>> => ({ handled: "succeeded" }));

vi.mock("@/lib/stripe/server", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/stripe/server")>()),
  getStripe: () => ({ webhooks: { constructEvent: CONSTRUCT_EVENT }, paymentMethods: { retrieve: vi.fn() } }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: RECORD_OPS_ALERT, recordOpsAlertDurably: vi.fn(async () => true) }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/billing/payment-webhook-reconciliation", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/billing/payment-webhook-reconciliation")>()),
  handlePaymentIntentSucceeded: HANDLE_SUCCEEDED,
}));

type Result = { data: unknown; error: unknown };
const ADMIN = { current: null as ReturnType<typeof makeAdmin> | null };
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ADMIN.current!.admin }));

function makeAdmin() {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const reads = { studio_payment_settings: [{ data: { studio_id: "studio-1" }, error: null }] as Result[] };
  const admin = {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        in: () => q,
        maybeSingle: async (): Promise<Result> =>
          (reads as Record<string, Result[]>)[table]?.shift() ?? { data: null, error: null },
        update: () => q,
        insert: async () => ({ error: null }),
      };
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
      rpcCalls.push({ name, args });
      if (name === "claim_stripe_event") {
        return { data: [{ already_processed: false, currently_processing_elsewhere: false, claimed_by_this_request: true, claim_token: "claim-1" }], error: null };
      }
      return { data: null, error: null };
    },
  };
  return { admin, rpcCalls };
}

const EVENT = { id: "evt_1", type: "payment_intent.succeeded", account: "acct_1", livemode: false, created: 1_700_000_000, data: { object: { id: "obj_1", livemode: false } } };
async function callRoute() {
  const mod = await import("@/app/api/stripe/webhook/route");
  return mod.POST(new Request("https://hone.care/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "sig" }, body: "{}" }));
}
const release = () => ADMIN.current!.rpcCalls.find((c) => c.name === "release_stripe_event_claim_with_error");

let logged: string[] = [];
function handlerFailedLine(): { event: string; detail: Record<string, unknown> } {
  const lines = logged.filter((l) => l.includes('"stripe_webhook_handler_failed"'));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

beforeEach(() => {
  vi.resetModules();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  delete process.env.HONE_PAYMENT_WEBHOOK_MAINTENANCE;
  ADMIN.current = makeAdmin();
  CONSTRUCT_EVENT.mockReturnValue(EVENT);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("stripe_webhook_handler_failed carries the stored failureLabel", () => {
  it.each(["save_client_card_on_file_failed:PGRST202", "customer_lineage_lookup_failed:42P01", "card_setup_active_event_order_unverified"])(
    "a deliberate label (%s) is logged and stored verbatim; status, release and alert unchanged",
    async (label) => {
      HANDLE_SUCCEEDED.mockRejectedValueOnce(new Error(label));
      const res = await callRoute();
      expect(res.status).toBe(500);
      const line = handlerFailedLine();
      expect(line.detail).toMatchObject({ eventId: "evt_1", eventType: "payment_intent.succeeded", errorClass: "error", failureLabel: label });
      expect(release()?.args).toEqual({ p_event_id: "evt_1", p_claim_token: "claim-1", p_error: label });
      expect(RECORD_OPS_ALERT).toHaveBeenCalledTimes(1);
      expect(RECORD_OPS_ALERT.mock.calls[0]).toEqual([expect.objectContaining({ severity: "critical", event: "stripe_webhook_processing_failed", stripeEventId: "evt_1" })]);
    },
  );

  it("free text is never logged: failureLabel falls back to handler_failed:<class>, the same value stored", async () => {
    HANDLE_SUCCEEDED.mockRejectedValueOnce(new Error("duplicate key: Key (email)=(synthetic.person@example.test)"));
    const res = await callRoute();
    expect(res.status).toBe(500);
    const line = handlerFailedLine();
    expect(line.detail.failureLabel).toBe("handler_failed:error");
    expect(release()?.args.p_error).toBe("handler_failed:error");
    expect(JSON.stringify(line)).not.toMatch(/synthetic|example\.test|duplicate key/);
  });
});
