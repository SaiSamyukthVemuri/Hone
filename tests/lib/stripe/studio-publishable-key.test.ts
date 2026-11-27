import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const route = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/stripe/studio-platform", () => ({ resolveStudioPlatform: async () => route.value }));

import { resolveStripePublishableKey } from "@/lib/stripe/publishable-key";
import { resolveStudioPublishableKey, studioPublishableKeyOk } from "@/lib/stripe/studio-publishable-key";

const CA_PK = "pk_test_" + "ca".repeat(20);
const US_PK = "pk_test_" + "us".repeat(20);
const KEYS = ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_US", "STRIPE_ALLOW_LIVE_MODE", "VERCEL_ENV"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = CA_PK;
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_US = US_PK;
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("a studio's publishable key is its platform's", () => {
  it("CA reads the existing variable and never the US one; US the reverse", () => {
    expect(resolveStripePublishableKey("CA")).toEqual({ ok: true, key: CA_PK });
    expect(resolveStripePublishableKey("US")).toEqual({ ok: true, key: US_PK });
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_US;
    expect(resolveStripePublishableKey("US")).toEqual({ ok: false, reason: "missing" });
    expect(resolveStripePublishableKey("CA")).toEqual({ ok: true, key: CA_PK });
  });

  it("the live-key gate applies to both platforms", () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_US = "pk_live_" + "us".repeat(20);
    expect(resolveStripePublishableKey("US")).toEqual({ ok: false, reason: "live_mode_blocked" });
  });

  it("for a studio: its resolved platform picks the key; an unresolved platform has no key (never the Canadian one)", async () => {
    route.value = { ok: true, platform: "US" };
    expect(await resolveStudioPublishableKey("s")).toEqual({ ok: true, key: US_PK });
    route.value = { ok: true, platform: "CA" };
    expect(await resolveStudioPublishableKey("s")).toEqual({ ok: true, key: CA_PK });
    route.value = { ok: false, reason: "jurisdiction_unverified" };
    expect(await resolveStudioPublishableKey("s")).toEqual({ ok: false, reason: "missing" });
    expect(await studioPublishableKeyOk("s")).toBe(false);
  });
});
