import { describe, expect, it } from "vitest";
import { createSubscriptionCheckout } from "@/lib/subscriptions/checkout-session";
import {
  ENV_ON,
  SOLO_PRICE,
  STUDIO_PRICE,
  fakeBilling,
  price,
} from "./helpers/fake-billing-client";

const USER = { id: "user-1", email: "owner@example.test" };
const ORIGIN = "https://app.example.test";

function prices() {
  return {
    [SOLO_PRICE]: price(),
    [STUDIO_PRICE]: price({ id: STUDIO_PRICE, unit_amount: 9900 }),
  };
}

function run(over: Partial<Parameters<typeof createSubscriptionCheckout>[0]> = {}, client = fakeBilling({ prices: prices() })) {
  return createSubscriptionCheckout({
    client,
    env: ENV_ON,
    plan: "solo",
    user: USER,
    origin: ORIGIN,
    ...over,
  }).then((result) => ({ result, client }));
}

describe("createSubscriptionCheckout", () => {
  it("creates a subscription session for Solo bound to the authenticated user", async () => {
    const { result, client } = await run();
    expect(result).toEqual({
      ok: true,
      sessionId: "cs_test_1",
      url: "https://checkout.stripe.test/c/cs_test_1",
    });
    expect(client.calls.createCheckoutSession).toEqual([
      {
        priceId: SOLO_PRICE,
        clientReferenceId: "user-1",
        customerEmail: "owner@example.test",
        metadata: { hone_user_id: "user-1", hone_plan: "solo" },
        successUrl: `${ORIGIN}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${ORIGIN}/pricing`,
      },
    ]);
  });

  it("uses the Studio price for the studio plan", async () => {
    const { client } = await run({ plan: "studio" });
    expect(client.calls.createCheckoutSession[0].priceId).toBe(STUDIO_PRICE);
    expect(client.calls.createCheckoutSession[0].metadata.hone_plan).toBe("studio");
  });

  it("refuses everything while the flag is off, without calling Stripe", async () => {
    const { result, client } = await run({ env: {} });
    expect(result).toEqual({ ok: false, reason: "checkout_disabled" });
    expect(client.calls.retrievePrice).toEqual([]);
    expect(client.calls.createCheckoutSession).toEqual([]);
  });

  it("requires an authenticated user", async () => {
    for (const user of [null, { id: "" }]) {
      const { result, client } = await run({ user });
      expect(result).toEqual({ ok: false, reason: "unauthenticated" });
      expect(client.calls.createCheckoutSession).toEqual([]);
    }
  });

  it("refuses a client-supplied price id or unknown plan", async () => {
    for (const plan of [SOLO_PRICE, "price_evil", "enterprise", undefined]) {
      const { result, client } = await run({ plan });
      expect(result).toEqual({ ok: false, reason: "unknown_plan" });
      expect(client.calls.createCheckoutSession).toEqual([]);
    }
  });

  it("refuses when the plan has no configured price", async () => {
    const { result } = await run({ env: { HONE_SELF_SERVE_CHECKOUT_ENABLED: "true" } });
    expect(result).toEqual({ ok: false, reason: "price_not_configured" });
  });

  it("refuses an invalid origin", async () => {
    for (const origin of ["", "not a url", "javascript:alert(1)"]) {
      const { result } = await run({ origin });
      expect(result).toEqual({ ok: false, reason: "invalid_origin" });
    }
  });

  const bad: Array<[string, Parameters<typeof price>[0], string]> = [
    ["wrong currency", { currency: "cad" }, "price_currency"],
    ["wrong interval", { recurring: { interval: "year", interval_count: 1 } }, "price_interval"],
    ["multi-month interval", { recurring: { interval: "month", interval_count: 3 } }, "price_interval"],
    ["wrong amount", { unit_amount: 4800 }, "price_amount"],
    ["inactive price", { active: false }, "price_inactive"],
    ["one-time price", { type: "one_time", recurring: null }, "price_not_recurring"],
    ["live-mode price", { livemode: true }, "price_livemode"],
    ["different price id returned", { id: "price_other" }, "price_mismatch"],
  ];
  it.each(bad)("refuses %s", async (_name, over, reason) => {
    const client = fakeBilling({ prices: { [SOLO_PRICE]: price(over) } });
    const { result } = await run({}, client);
    expect(result).toEqual({ ok: false, reason });
    expect(client.calls.createCheckoutSession).toEqual([]);
  });

  it("refuses when Stripe cannot retrieve the price", async () => {
    const { result } = await run({}, fakeBilling({ prices: {} }));
    expect(result).toEqual({ ok: false, reason: "price_unavailable" });
  });

  it("refuses a session that has no hosted url", async () => {
    const { result } = await run({}, fakeBilling({ prices: prices(), checkoutUrl: null }));
    expect(result).toEqual({ ok: false, reason: "price_unavailable" });
  });
});
