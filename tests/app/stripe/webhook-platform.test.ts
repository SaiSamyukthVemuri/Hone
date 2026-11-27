import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// HON-90. Which platform a delivery belongs to is the ROUTE it arrived on. Real Stripe signature verification, synthetic secrets.
const CA_SECRET = "whsec_" + "ca".repeat(16);
const US_SECRET = "whsec_" + "us".repeat(16);
const BODY = JSON.stringify({ id: "evt_1", object: "event", type: "customer.created", livemode: false, data: { object: {} } });

const built = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("@/lib/stripe/server", async () => {
  const { default: Stripe } = await import("stripe");
  const make = (key: string) => { built.keys.push(key); return new Stripe(key); };
  return { getStripe: () => make("sk_test_" + "ca".repeat(20)), getStripeFor: (p: string) => make(`sk_test_${p === "US" ? "us" : "ca"}`.padEnd(48, "x")) };
});
const claims = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    rpc: async (name: string) => {
      if (name === "claim_stripe_event") { claims.n += 1; return { data: [{ already_processed: false, claimed_by_this_request: true, claim_token: "tok" }], error: null }; }
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => undefined }));

async function sign(secret: string) {
  const { default: Stripe } = await import("stripe");
  return Stripe.webhooks.generateTestHeaderString({ payload: BODY, secret });
}
const req = (sig: string) => new Request("http://x.test/hook", { method: "POST", body: BODY, headers: { "stripe-signature": sig } });

const KEYS = ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET_US"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.STRIPE_WEBHOOK_SECRET = CA_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET_US = US_SECRET;
  claims.n = 0;
  built.keys.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

describe("the two webhook routes verify with their own platform's secret", () => {
  it("the CA route accepts a CA-signed event and refuses a US-signed one", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    expect((await POST(req(await sign(US_SECRET)))).status).toBe(400);
    expect(claims.n).toBe(0);
    expect((await POST(req(await sign(CA_SECRET)))).status).toBe(200);
    expect(claims.n).toBe(1);
  });

  it("the US route accepts a US-signed event and refuses a CA-signed one", async () => {
    const { POST } = await import("@/app/api/stripe/webhook-us/route");
    expect((await POST(req(await sign(CA_SECRET)))).status).toBe(400);
    expect(claims.n).toBe(0);
    expect((await POST(req(await sign(US_SECRET)))).status).toBe(200);
    expect(claims.n).toBe(1);
  });

  it("the US route with no US secret configured refuses everything, and never falls back to the CA secret", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET_US;
    const { POST } = await import("@/app/api/stripe/webhook-us/route");
    expect((await POST(req(await sign(CA_SECRET)))).status).toBe(400);
    expect(claims.n).toBe(0);
  });

  it("a replayed delivery is acknowledged without a second effect (the claim is the dedupe; the same id is presented each time)", async () => {
    const { POST } = await import("@/app/api/stripe/webhook-us/route");
    const sig = await sign(US_SECRET);
    expect((await POST(req(sig))).status).toBe(200);
    expect((await POST(req(sig))).status).toBe(200);
    expect(claims.n).toBe(2); // each delivery asks the database to claim the SAME (account, mode, event id); the database refuses the second
  });

  it("the platform is fixed by the route: a CA delivery after a US one is still CA (no context leaks)", async () => {
    const us = await import("@/app/api/stripe/webhook-us/route");
    const ca = await import("@/app/api/stripe/webhook/route");
    await us.POST(req(await sign(US_SECRET)));
    expect((await ca.POST(req(await sign(US_SECRET)))).status).toBe(400);
    expect((await ca.POST(req(await sign(CA_SECRET)))).status).toBe(200);
  });
});
