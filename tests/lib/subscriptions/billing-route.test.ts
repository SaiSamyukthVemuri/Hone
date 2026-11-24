import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/billing/webhook/route";

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/billing/webhook (sandbox access)", () => {
  it("is a 404 while the flag is off", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "");
    expect(
      (
        await POST(
          new Request("http://localhost/api/billing/webhook", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("rejects an invalid webhook signature before looking up an invoice", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
    vi.stubEnv("HONE_BILLING_WEBHOOK_SECRET", "whsec_fixture");
    vi.stubEnv("HONE_BILLING_STRIPE_SECRET_KEY", "sk_test_fixture");
    const request = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "invalid" },
      body: '{"id":"evt_test"}',
    });
    expect((await POST(request)).status).toBe(400);
  });

  it("fails closed with 503 when the signing secret is missing", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
    vi.stubEnv("HONE_BILLING_WEBHOOK_SECRET", "");
    expect(
      (
        await POST(
          new Request("http://localhost/api/billing/webhook", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(503);
  });
});
