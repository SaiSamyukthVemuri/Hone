import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginStudioCheckout } from "@/app/(auth)/no-access/checkout-action";
import {
  fakeBilling,
  price,
  SOLO_PRICE,
  STUDIO_PRICE,
  ENV_ON,
} from "./helpers/fake-billing-client";

const hooks = vi.hoisted(() => ({
  rpc: vi.fn(),
  user: vi.fn(),
  billing: vi.fn(),
  origin: vi.fn(() => "https://sandbox.example.test"),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error("redirect " + to);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: hooks.user } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: hooks.rpc }),
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: hooks.origin }));
vi.mock("@/lib/subscriptions/billing-client", () => ({
  createBillingStripeClient: hooks.billing,
}));

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  email_confirmed_at: "2026-01-01",
};
const checkoutUrl = "https://checkout.stripe.com/c/pay/test";
function attempt(plan = "solo") {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    plan,
    state: "open",
    created: Math.floor(Date.now() / 1000),
    email: user.email,
    session: null,
    url: null,
  };
}
function submit(plan = "solo") {
  const form = new FormData();
  form.set("plan", plan);
  form.set("studio", "Sandbox studio");
  form.set("owner", "Test owner");
  return beginStudioCheckout(form);
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(ENV_ON)) vi.stubEnv(key, value);
  hooks.user.mockResolvedValue({ data: { user } });
  hooks.origin.mockReturnValue("https://sandbox.example.test");
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["solo", SOLO_PRICE, 4900],
  ["studio", STUDIO_PRICE, 9900],
] as const)(
  "binds the verified owner and the %s price before redirecting to checkout",
  async (plan, id, amount) => {
    const a = attempt(plan);
    const stripe = fakeBilling({
      prices: { [id]: price({ id, unit_amount: amount }) },
      checkoutUrl,
    });
    hooks.billing.mockReturnValue(stripe);
    hooks.rpc
      .mockResolvedValueOnce({ data: a })
      .mockResolvedValueOnce({ data: 1 })
      .mockResolvedValueOnce({ data: true });
    await expect(submit(plan)).rejects.toThrow("redirect " + checkoutUrl);
    expect(hooks.rpc.mock.calls.map((c) => c[0])).toEqual([
      "claim_hone_signup",
      "claim_hone_checkout_generation",
      "bind_hone_checkout",
    ]);
    expect(stripe.calls.createCheckoutSession).toHaveLength(1);
    expect(stripe.calls.createCheckoutSession[0]).toMatchObject({
      priceId: id,
      customerEmail: user.email,
      clientReferenceId: user.id,
      attemptId: a.id,
      generation: 1,
      metadata: {
        hone_plan: plan,
        hone_attempt_id: a.id,
        hone_user_id: user.id,
      },
    });
  },
);

it("reuses a bound checkout and refuses to start a different plan alongside it", async () => {
  const stripe = fakeBilling();
  hooks.billing.mockReturnValue(stripe);
  hooks.rpc.mockResolvedValue({
    data: { ...attempt(), url: checkoutUrl, session: "cs_test" },
  });
  await expect(submit()).rejects.toThrow("redirect " + checkoutUrl);
  await expect(submit("studio")).rejects.toThrow("reason=checkout-open");
  expect(stripe.calls.createCheckoutSession).toHaveLength(0);
});

it.each(["complete", "expired"] as const)(
  "reconciles an interrupted checkout reported as %s",
  async (status) => {
    const a = { ...attempt(), created: Math.floor(Date.now() / 1000) - 3600 };
    const findAttemptSession = vi
      .fn()
      .mockResolvedValue({ id: "cs_old", status });
    hooks.billing.mockReturnValue({ findAttemptSession });
    hooks.rpc
      .mockResolvedValueOnce({ data: a })
      .mockResolvedValueOnce({ data: true });
    await expect(submit()).rejects.toThrow(
      status === "complete" ? "confirming-payment" : "checkout-expired",
    );
    expect(findAttemptSession).toHaveBeenCalledWith(a);
    expect(hooks.rpc.mock.calls.map((c) => c[0])).toEqual(
      status === "complete"
        ? ["claim_hone_signup"]
        : ["claim_hone_signup", "expire_hone_checkout"],
    );
  },
);

it("refuses an unverified account before reserving a purchase or opening Checkout", async () => {
  hooks.user.mockResolvedValue({
    data: { user: { ...user, email_confirmed_at: null } },
  });
  await expect(submit()).rejects.toThrow("redirect /login");
  expect(hooks.rpc).not.toHaveBeenCalled();
  expect(hooks.billing).not.toHaveBeenCalled();
});

it("measures the session's expiry from the retry, not from the claim (Stripe's 30 minute minimum)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const a = { ...attempt(), created: now - 120 }; // the retry arrives two minutes after the claim
  const stripe = fakeBilling({ prices: { [SOLO_PRICE]: price({ id: SOLO_PRICE, unit_amount: 4900 }) }, checkoutUrl });
  hooks.billing.mockReturnValue(stripe);
  hooks.rpc.mockResolvedValueOnce({ data: a }).mockResolvedValueOnce({ data: 2 }).mockResolvedValueOnce({ data: true });
  await expect(submit()).rejects.toThrow("redirect " + checkoutUrl);
  const { expiresAt } = stripe.calls.createCheckoutSession[0];
  expect(expiresAt).toBeGreaterThanOrEqual(now + 30 * 60 + 60);
  expect(expiresAt).toBeGreaterThan(a.created + 31 * 60);
});

it("reuses an unbound session Stripe still has open instead of opening a second one", async () => {
  const now = Math.floor(Date.now() / 1000);
  const stripe = fakeBilling({ prior: { id: "cs_prior", status: "open", url: checkoutUrl, expires_at: now + 20 * 60 } });
  hooks.billing.mockReturnValue(stripe);
  hooks.rpc.mockResolvedValueOnce({ data: { ...attempt(), created: now - 600 } }).mockResolvedValueOnce({ data: true });
  await expect(submit()).rejects.toThrow("redirect " + checkoutUrl);
  expect(stripe.calls.createCheckoutSession).toHaveLength(0);
  expect(hooks.rpc.mock.calls[1]).toEqual(["bind_hone_checkout", expect.objectContaining({ p_session: "cs_prior" })]);
});

it("two overlapping submissions open ONE Stripe session: the loser gets no generation and is sent to confirming", async () => {
  // The database hands the generation out atomically: the first claim gets 1, a claim while that one is live gets null.
  let handed = 0;
  const bound: string[] = [];
  hooks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "claim_hone_signup") return { data: attempt() };
    if (fn === "claim_hone_checkout_generation") return { data: ++handed === 1 ? 1 : null };
    if (fn === "bind_hone_checkout") { bound.push(String(args.p_session)); return { data: bound.length === 1 }; }
    return { data: null };
  });
  const stripe = fakeBilling({ prices: { [SOLO_PRICE]: price({ id: SOLO_PRICE, unit_amount: 4900 }) }, checkoutUrl });
  hooks.billing.mockReturnValue(stripe);
  const outcomes = await Promise.all([submit(), submit()].map((p) => p.then(() => "returned", (e: Error) => e.message)));
  expect(stripe.calls.createCheckoutSession).toHaveLength(1);
  expect(stripe.calls.createCheckoutSession[0]).toMatchObject({ generation: 1 });
  expect(outcomes.filter((o) => o === "redirect " + checkoutUrl)).toHaveLength(1);
  expect(outcomes.filter((o) => String(o).includes("confirming-payment"))).toHaveLength(1);
});

it("a Stripe request is keyed by the claimed generation, never by a clock value two requests can share", async () => {
  const src = (await import("node:fs")).readFileSync("lib/subscriptions/billing-client.ts", "utf8");
  expect(src).toMatch(/hone-signup-" \+ params\.attemptId \+ "-" \+ \(params\.generation \?\? params\.expiresAt\)/);
  const action = (await import("node:fs")).readFileSync("app/(auth)/no-access/checkout-action.ts", "utf8");
  // the generation is claimed before the session is created
  expect(action.indexOf("claim_hone_checkout_generation")).toBeGreaterThan(-1);
  expect(action.indexOf("claim_hone_checkout_generation")).toBeLessThan(action.indexOf("createSubscriptionCheckout({"));
});
