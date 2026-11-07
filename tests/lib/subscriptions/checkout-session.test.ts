import { describe, expect, it } from "vitest";
import {
  CHECKOUT_SESSION_TTL_SECONDS,
  createSubscriptionCheckout,
} from "@/lib/subscriptions/checkout-session";
import {
  ENV_ON,
  SOLO_PRICE,
  STUDIO_PRICE,
  fakeBilling,
  price,
} from "./helpers/fake-billing-client";

const USER = { id: "user-1", email: "owner@example.test" };
const ORIGIN = "https://app.example.test";
const NOW = 1_800_000_000;

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
    nowSeconds: NOW,
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
      reused: false,
    });
    expect(client.calls.createCheckoutSession).toEqual([
      {
        priceId: SOLO_PRICE,
        clientReferenceId: "user-1",
        customerEmail: "owner@example.test",
        metadata: { hone_user_id: "user-1", hone_plan: "solo" },
        successUrl: `${ORIGIN}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${ORIGIN}/pricing`,
        expiresAt: NOW + CHECKOUT_SESSION_TTL_SECONDS,
      },
    ]);
    // Stripe's floor is 30 minutes.
    expect(CHECKOUT_SESSION_TTL_SECONDS).toBeGreaterThanOrEqual(30 * 60);
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

  it("a throwing createCheckoutSession returns a fixed code and never leaks the error text, email or request id (Privacy S-1)", async () => {
    const leak = new Error(`Invalid email address: ${USER.email} (request req_SECRET123)`);
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((m) => {
      const orig = console[m];
      console[m] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
      return () => { console[m] = orig; };
    });
    let result;
    try {
      ({ result } = await run({}, fakeBilling({ prices: prices(), createError: leak })));
    } finally {
      spies.forEach((restore) => restore());
    }
    expect(result).toEqual({ ok: false, reason: "checkout_unavailable" });
    const seen = JSON.stringify(result) + logs.join("\n");
    expect(seen).not.toContain(USER.email);
    expect(seen).not.toContain("req_SECRET123");
    expect(seen).not.toContain("Invalid email");
  });

  it("refuses a session that has no hosted url", async () => {
    const { result } = await run({}, fakeBilling({ prices: prices(), checkoutUrl: null }));
    expect(result).toEqual({ ok: false, reason: "price_unavailable" });
  });

  describe("one live purchase path per user (Codex P2 4499972609)", () => {
    const open = (over: Partial<NonNullable<NonNullable<Parameters<typeof createSubscriptionCheckout>[0]["existing"]>["openSession"]>> = {}) => ({
      id: "cs_test_open",
      url: "https://checkout.stripe.test/c/cs_test_open",
      plan: "solo" as const,
      expiresAt: NOW + 600,
      ...over,
    });

    it("refuses a user who already has an open subscription, without calling Stripe", async () => {
      const { result, client } = await run({ existing: { hasOpenSubscription: true, openSession: null } });
      expect(result).toEqual({ ok: false, reason: "already_subscribed" });
      expect(client.calls.retrievePrice).toEqual([]);
      expect(client.calls.createCheckoutSession).toEqual([]);
    });

    it("reuses an unexpired session for the SAME plan instead of creating a second", async () => {
      const { result, client } = await run({ existing: { hasOpenSubscription: false, openSession: open() } });
      expect(result).toEqual({
        ok: true,
        sessionId: "cs_test_open",
        url: "https://checkout.stripe.test/c/cs_test_open",
        reused: true,
      });
      expect(client.calls.createCheckoutSession).toEqual([]);
    });

    it("refuses a DIFFERENT plan while an unexpired session is open", async () => {
      const { result, client } = await run({
        plan: "studio",
        existing: { hasOpenSubscription: false, openSession: open({ plan: "solo" }) },
      });
      expect(result).toEqual({ ok: false, reason: "checkout_in_progress" });
      expect(client.calls.createCheckoutSession).toEqual([]);
    });

    it("an EXPIRED session no longer blocks: a new one is created (any plan)", async () => {
      for (const expiresAt of [NOW, NOW - 1, NOW - 86_400]) {
        const { result, client } = await run({
          plan: "studio",
          existing: { hasOpenSubscription: false, openSession: open({ expiresAt }) },
        });
        expect(result).toMatchObject({ ok: true, reused: false });
        expect(client.calls.createCheckoutSession).toHaveLength(1);
      }
    });

    it("still refuses when disabled or unauthenticated, before looking at existing state", async () => {
      const off = await run({ env: {}, existing: { hasOpenSubscription: false, openSession: open() } });
      expect(off.result).toEqual({ ok: false, reason: "checkout_disabled" });
      const anon = await run({ user: null, existing: { hasOpenSubscription: false, openSession: open() } });
      expect(anon.result).toEqual({ ok: false, reason: "unauthenticated" });
    });
  });
});
