import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/subscription-emails/route";
import { ENV_ON, SOLO_PRICE } from "./helpers/fake-billing-client";

const { rpc, readInvoice, send } = vi.hoisted(() => ({
  rpc: vi.fn(),
  readInvoice: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc }),
}));
vi.mock("@/lib/subscriptions/billing-client", () => ({
  createBillingStripeClient: () => ({ readNoticeInvoice: readInvoice }),
}));
vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <billing@example.test>",
  getResendTransport: () => ({ emails: { send } }),
}));

const owner = "owner@example.test";
const request = () =>
  new Request("http://localhost/api/cron/subscription-emails", {
    headers: { authorization: "Bearer sandbox-cron" },
  });
function setup() {
  vi.stubEnv("CRON_SECRET", "sandbox-cron");
  vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
  vi.stubEnv("HONE_BILLING_TEST_RECIPIENT", owner);
  vi.stubEnv("HONE_STRIPE_PRICE_SOLO", ENV_ON.HONE_STRIPE_PRICE_SOLO);
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://hone.example.test");
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe("subscription mail worker", () => {
  it("requires scheduler authorization, an enabled sandbox and a configured test owner", async () => {
    setup();
    expect((await GET(new Request("http://localhost/"))).status).toBe(401);
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "false");
    expect(await (await GET(request())).json()).toEqual({ enabled: false });
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
    vi.stubEnv("HONE_BILLING_TEST_RECIPIENT", "");
    expect(await (await GET(request())).json()).toEqual({ enabled: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("sends the verified owner's receipt, then acknowledges the provider acceptance", async () => {
    setup();
    rpc
      .mockResolvedValueOnce({
        data: {
          id: "notice-1",
          kind: "receipt",
          lease: "worker-1",
          recipient: owner,
          invoice_id: "in_test",
          customer_id: "cus_test",
          subscription_id: "sub_test",
          timezone: "UTC",
          deadline: null,
        },
      })
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: null });
    readInvoice.mockResolvedValue({
      id: "in_test",
      live: false,
      customer: "cus_test",
      subscription: "sub_test",
      status: "paid",
      amountPaid: 4900,
      paidAt: 1795611600,
      number: "TEST-0042",
      price: SOLO_PRICE,
      period: { start: 1795611600, end: 1798203600 },
      hostedUrl: null,
      currency: "usd",
      total: 4900,
      subtotal: 4900,
      tax: 0,
    });
    send.mockResolvedValue({ data: { id: "mail-1" }, error: null });
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ accepted: 1, failures: 0 });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      "claim_hone_subscription_notice",
      "authorize_hone_subscription_notice",
      "finish_hone_subscription_notice",
      "claim_hone_subscription_notice",
    ]);
    expect(rpc.mock.calls[0][1]).toEqual({ p_recipient: owner });
    expect(rpc.mock.calls[1][1]).toEqual({
      p_id: "notice-1",
      p_lease: "worker-1",
      p_recipient: owner,
      p_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_deadline: null,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: owner,
        subject: "[Test] Your Hone subscription receipt",
        text: expect.stringContaining("TEST-0042"),
      }),
      { idempotencyKey: "hone-subscription/notice-1" },
    );
  });
});
