import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A local or test run whose STRIPE_SECRET_KEY is the harness placeholder (sk_test_dummy) and whose fake processor is OFF would
// build a real Stripe client and send real, always-refused requests to api.stripe.com (a run that forgot to export the fake
// flag did exactly that, twelve times). getStripe() now refuses to build that client. With the fake ON, or with a real-shaped
// test key, nothing changes.

vi.mock("server-only", () => ({}));

const KEYS = ["STRIPE_SECRET_KEY", "HONE_E2E_FAKE_STRIPE", "HONE_E2E_RUN_ID", "VERCEL", "VERCEL_ENV", "STRIPE_ALLOW_LIVE_MODE"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  vi.resetModules();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const REAL_SHAPED = "sk_test_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6";

describe("isPlaceholderStripeKey", () => {
  it("recognises the harness and documentation placeholders and short bodies", async () => {
    const { isPlaceholderStripeKey } = await import("@/lib/stripe/server");
    for (const k of ["sk_test_dummy", "sk_test_x", "sk_test_anything", "sk_test_", "sk_test_abcdefghij", "sk_test_your_test_key_here", "sk_test_synthetic_no_network"]) {
      expect(isPlaceholderStripeKey(k), k).toBe(true);
    }
  });
  it("does not flag a real-shaped test key", async () => {
    const { isPlaceholderStripeKey } = await import("@/lib/stripe/server");
    expect(isPlaceholderStripeKey(REAL_SHAPED)).toBe(false);
  });
});

describe("getStripe with a placeholder key", () => {
  it("fake OFF: refuses, so no client that can reach api.stripe.com is built", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    const { getStripe } = await import("@/lib/stripe/server");
    expect(() => getStripe()).toThrow(/placeholder/i);
    expect(() => getStripe()).toThrow(/HONE_E2E_FAKE_STRIPE/);
  });
  it("fake requested but missing its run id (the unexported-variable mistake): still refuses", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.HONE_E2E_FAKE_STRIPE = "1";
    const { getStripe } = await import("@/lib/stripe/server");
    expect(() => getStripe()).toThrow(/placeholder/i);
  });
  it("fake ON (flag and a valid run id): unchanged, the harness key is accepted", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.HONE_E2E_FAKE_STRIPE = "1";
    process.env.HONE_E2E_RUN_ID = "run-guard0001";
    const { getStripe } = await import("@/lib/stripe/server");
    expect(() => getStripe()).not.toThrow();
  });
  it("a real-shaped test key with the fake off: unchanged (a deliberate test-mode run still works)", async () => {
    process.env.STRIPE_SECRET_KEY = REAL_SHAPED;
    const { getStripe } = await import("@/lib/stripe/server");
    expect(() => getStripe()).not.toThrow();
  });
  it("an invalid or missing key still fails the existing way", async () => {
    const { getStripe } = await import("@/lib/stripe/server");
    expect(() => getStripe()).toThrow(/not set/);
    process.env.STRIPE_SECRET_KEY = "pk_test_nope";
    expect(() => getStripe()).toThrow(/Invalid Stripe secret key format/);
  });
});
