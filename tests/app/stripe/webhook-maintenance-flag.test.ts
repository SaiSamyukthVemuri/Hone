import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PAYMENT-WEBHOOK-MAINTENANCE-FLAG (the #1035 S1->S3 cutover, Privacy
// PEER-COMPAT-0239-0245 option b).
//
// Between the 0239/0240 apply and the B-1035 deploy, B-OLD's
// payment_intent.payment_failed and charge.refunded arms are DIRECT service-role
// UPDATEs that the migrations do not revoke, so B-OLD would keep writing them
// without 0240's bound identity or refund provenance. With
// HONE_PAYMENT_WEBHOOK_MAINTENANCE=1 those two events answer 500 and release
// their claim BEFORE any handler runs, so Stripe redelivers them to B-1035.
//
// OFF (unset, or any value other than the exact "1") must be today's behaviour,
// byte for byte: the same handler, the same arguments, the same processed
// summary. payment_intent.succeeded and setup_intent.succeeded are never
// touched (0239/0245 already make them 500 under B-OLD).
//
// Behavioural, through the real POST: claim -> dispatch -> mark processed, or
// release-with-error. The reconciliation handlers are spied so the test sees
// whether one ran; the alert writer is spied so the test sees what was raised.

const CONSTRUCT_EVENT = vi.fn();
const RECORD_OPS_ALERT = vi.fn(async () => {});
const HANDLERS = {
  handlePaymentIntentSucceeded: vi.fn(async () => ({ handled: "succeeded" })),
  handlePaymentIntentPaymentFailed: vi.fn(async () => ({ handled: "payment_failed" })),
  handleChargeRefunded: vi.fn(async () => ({ handled: "charge_refunded" })),
  handleChargeDisputeCreated: vi.fn(async () => ({ handled: "dispute" })),
};

vi.mock("@/lib/stripe/server", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/stripe/server")>()),
  getStripe: () => ({ webhooks: { constructEvent: CONSTRUCT_EVENT }, paymentMethods: { retrieve: vi.fn() } }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: RECORD_OPS_ALERT, recordOpsAlertDurably: vi.fn(async () => true) }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/billing/payment-webhook-reconciliation", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/billing/payment-webhook-reconciliation")>()),
  ...HANDLERS,
}));

type Result = { data: unknown; error: unknown };
const ADMIN = { current: null as ReturnType<typeof makeAdmin> | null };
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ADMIN.current!.admin }));

function makeAdmin() {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const writes: Array<{ table: string; op: string }> = [];
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
        update: () => { writes.push({ table, op: "update" }); return q; },
        insert: async () => { writes.push({ table, op: "insert" }); return { error: null }; },
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
  return { admin, rpcCalls, writes };
}

function event(type: string) {
  return { id: "evt_1", type, account: "acct_1", livemode: false, created: 1_700_000_000, data: { object: { id: "obj_1", livemode: false } } };
}
async function callRoute() {
  const mod = await import("@/app/api/stripe/webhook/route");
  return mod.POST(new Request("https://hone.care/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "sig" }, body: "{}" }));
}
const names = () => ADMIN.current!.rpcCalls.map((c) => c.name);
const call = (name: string) => ADMIN.current!.rpcCalls.find((c) => c.name === name);
const ENV = "HONE_PAYMENT_WEBHOOK_MAINTENANCE";

let logged: string[] = [];
beforeEach(() => {
  vi.resetModules();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  delete process.env[ENV];
  ADMIN.current = makeAdmin();
});
afterEach(() => {
  delete process.env[ENV];
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const GATED = [
  ["payment_intent.payment_failed", "handlePaymentIntentPaymentFailed"],
  ["charge.refunded", "handleChargeRefunded"],
] as const;
const UNGATED = [
  ["payment_intent.succeeded", "handlePaymentIntentSucceeded"],
  ["charge.dispute.created", "handleChargeDisputeCreated"],
] as const;

describe("flag ON (HONE_PAYMENT_WEBHOOK_MAINTENANCE=1)", () => {
  it.each(GATED)("%s: 500, claim released, NO handler, NO write, never marked processed", async (type, handler) => {
    process.env[ENV] = "1";
    CONSTRUCT_EVENT.mockReturnValue(event(type));
    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(HANDLERS[handler]).not.toHaveBeenCalled();
    expect(ADMIN.current!.writes).toEqual([]);
    expect(names()).toContain("claim_stripe_event");
    expect(names()).not.toContain("mark_stripe_event_processed");
    const release = call("release_stripe_event_claim_with_error");
    expect(release?.args).toEqual({ p_event_id: "evt_1", p_claim_token: "claim-1", p_error: `payment_webhook_maintenance_deferred:${type}` });
  });

  it.each(GATED)("%s: an expected deferral pages nobody; it leaves one structural log line", async (type) => {
    process.env[ENV] = "1";
    CONSTRUCT_EVENT.mockReturnValue(event(type));
    await callRoute();
    expect(RECORD_OPS_ALERT).not.toHaveBeenCalled();
    const lines = logged.filter((l) => l.includes("stripe_webhook_maintenance_deferred"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(type);
    expect(lines[0]).not.toMatch(/studio-1|acct_1|obj_1/);
  });

  it.each(UNGATED)("%s: untouched by the flag (its handler runs, processed, 200)", async (type, handler) => {
    process.env[ENV] = "1";
    CONSTRUCT_EVENT.mockReturnValue(event(type));
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(HANDLERS[handler]).toHaveBeenCalledTimes(1);
    expect(names()).toContain("mark_stripe_event_processed");
    expect(names()).not.toContain("release_stripe_event_claim_with_error");
  });

  it("setup_intent.succeeded is untouched: it never reaches the maintenance deferral", async () => {
    process.env[ENV] = "1";
    CONSTRUCT_EVENT.mockReturnValue({ ...event("setup_intent.succeeded"), data: { object: { id: "seti_1", metadata: {} } } });
    await callRoute();
    // Missing metadata is B-OLD's own terminal rejection, marked processed.
    expect(call("release_stripe_event_claim_with_error")?.args.p_error ?? "").not.toMatch(/maintenance/);
    expect(logged.some((l) => l.includes("stripe_webhook_maintenance_deferred"))).toBe(false);
  });

  it("the flag is read per request, not at module load", async () => {
    CONSTRUCT_EVENT.mockReturnValue(event("charge.refunded"));
    const mod = await import("@/app/api/stripe/webhook/route");
    const post = () => mod.POST(new Request("https://hone.care/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "sig" }, body: "{}" }));
    expect((await post()).status).toBe(200);
    ADMIN.current = makeAdmin();
    process.env[ENV] = "1";
    expect((await post()).status).toBe(500);
    ADMIN.current = makeAdmin();
    delete process.env[ENV];
    expect((await post()).status).toBe(200);
  });
});

describe("flag OFF: today's behaviour", () => {
  it.each([undefined, "", "0", "true", "on", "yes", " 1", "1 ", "01", "TRUE"])("value %j is OFF", async (value) => {
    if (value !== undefined) process.env[ENV] = value;
    for (const [type, handler] of GATED) {
      ADMIN.current = makeAdmin();
      HANDLERS[handler].mockClear();
      CONSTRUCT_EVENT.mockReturnValue(event(type));
      const res = await callRoute();
      expect(res.status).toBe(200);
      expect(HANDLERS[handler]).toHaveBeenCalledTimes(1);
      // The same arguments the handler receives today: the event and the ctx.
      expect(HANDLERS[handler].mock.calls[0]).toEqual([
        expect.objectContaining({ id: "evt_1", type }),
        { studioId: "studio-1", stripeAccountId: "acct_1", livemode: false },
      ]);
      const mark = call("mark_stripe_event_processed");
      expect(mark?.args.p_payload_summary).toEqual({ handled: handler === "handleChargeRefunded" ? "charge_refunded" : "payment_failed" });
      expect(names()).not.toContain("release_stripe_event_claim_with_error");
    }
    expect(logged.some((l) => l.includes("stripe_webhook_maintenance_deferred"))).toBe(false);
  });
});
