import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_ENV, deploymentMode, routeStripePlatform, secretKeyFor } from "@/lib/stripe/platform-routing";

vi.mock("server-only", () => ({}));
// Record how each client is built: the key it was given and the options (API version).
const built = vi.hoisted(() => ({ calls: [] as Array<{ key: string; opts: { apiVersion?: string } }> }));
vi.mock("stripe", () => ({
  default: class FakeStripe {
    constructor(key: string, opts: { apiVersion?: string }) {
      built.calls.push({ key, opts });
    }
  },
}));

// HON-90. Which platform account a studio's money goes through. Keys below are synthetic, long enough not to read as placeholders.
const body = (n: string) => `${n}`.padEnd(40, "A1b2C3d4E5");
const CA_TEST = `sk_test_${body("ca")}`;
const US_TEST = `sk_test_${body("us")}`;
const CA_LIVE = `sk_live_${body("ca")}`;
const US_LIVE = `sk_live_${body("us")}`;
const CA = { country: "CA", currency: "cad" } as const;
const US = { country: "US", currency: "usd" } as const;

describe("routing a studio's verified pair to its platform", () => {
  it("a Canadian studio routes to CA, with exactly the production variable names", () => {
    expect(PLATFORM_ENV.CA).toEqual({
      secretKey: "STRIPE_SECRET_KEY",
      webhookSecret: "STRIPE_WEBHOOK_SECRET",
      publishableKey: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    });
    expect(routeStripePlatform(CA, { STRIPE_SECRET_KEY: CA_LIVE })).toEqual({ ok: true, platform: "CA" });
  });

  it("a CA route accepts exactly what it did: it reads no US variable, so any US configuration (absent, broken, same key) changes nothing", () => {
    for (const us of [undefined, "garbage", CA_LIVE, US_TEST]) {
      expect(routeStripePlatform(CA, { STRIPE_SECRET_KEY: CA_LIVE, STRIPE_SECRET_KEY_US: us })).toEqual({ ok: true, platform: "CA" });
    }
    expect(routeStripePlatform(CA, {})).toEqual({ ok: true, platform: "CA" }); // an unset CA key is getStripe()'s own refusal, unchanged
  });

  it("a US studio routes to US when its own key is present, distinct, and in the deployment's mode", () => {
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY: CA_TEST, STRIPE_SECRET_KEY_US: US_TEST })).toEqual({ ok: true, platform: "US" });
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY: CA_LIVE, STRIPE_SECRET_KEY_US: US_LIVE })).toEqual({ ok: true, platform: "US" });
    // a local stack with only the US key: the deployment is test mode
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY_US: US_TEST })).toEqual({ ok: true, platform: "US" });
  });

  it("a US route never reads a CA variable for its key: a CA key alone is 'not configured'", () => {
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY: CA_TEST })).toEqual({ ok: false, reason: "platform_not_configured" });
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY: CA_LIVE })).toEqual({ ok: false, reason: "platform_not_configured" });
  });

  it("the same key string for both platforms is refused", () => {
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY: CA_TEST, STRIPE_SECRET_KEY_US: CA_TEST })).toEqual({ ok: false, reason: "platform_keys_identical" });
  });

  it("production today: CA is live, so a US SANDBOX key is refused and the US path stays dormant", () => {
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY: CA_LIVE, STRIPE_SECRET_KEY_US: US_TEST })).toEqual({ ok: false, reason: "mode_mismatch" });
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY: CA_TEST, STRIPE_SECRET_KEY_US: US_LIVE })).toEqual({ ok: false, reason: "mode_mismatch" });
    expect(routeStripePlatform(US, { STRIPE_SECRET_KEY_US: US_LIVE })).toEqual({ ok: false, reason: "mode_mismatch" });
  });

  it("a US key that is not a Stripe secret key is refused", () => {
    for (const k of ["pk_test_abc", "rk_test_abc", "whsec_abc", "garbage"]) {
      expect(routeStripePlatform(US, { STRIPE_SECRET_KEY_US: k })).toEqual({ ok: false, reason: "invalid_key" });
    }
  });

  it("unknown or mismatched country/currency never routes, whatever the keys", () => {
    const env = { STRIPE_SECRET_KEY: CA_TEST, STRIPE_SECRET_KEY_US: US_TEST };
    const refused = [
      { country: "CA", currency: "usd" },
      { country: "US", currency: "cad" },
      { country: "GB", currency: "gbp" },
      { country: "ca", currency: "cad" },
      { country: null, currency: null },
      { country: undefined, currency: "usd" },
      { country: "US", currency: undefined },
      { country: "", currency: "" },
    ];
    for (const pair of refused) expect(routeStripePlatform(pair, env), JSON.stringify(pair)).toEqual({ ok: false, reason: "jurisdiction_unverified" });
  });
});

describe("the platform's own variables", () => {
  it("secretKeyFor reads only the platform's own variable", () => {
    const env = { STRIPE_SECRET_KEY: CA_TEST, STRIPE_SECRET_KEY_US: US_TEST };
    expect(secretKeyFor("CA", env)).toBe(CA_TEST);
    expect(secretKeyFor("US", env)).toBe(US_TEST);
    expect(secretKeyFor("US", { STRIPE_SECRET_KEY: CA_TEST })).toBeUndefined();
    expect(secretKeyFor("CA", { STRIPE_SECRET_KEY_US: US_TEST })).toBeUndefined();
  });

  it("the deployment's mode is the CA key's: live only on an sk_live_ CA key", () => {
    expect(deploymentMode({ STRIPE_SECRET_KEY: CA_LIVE })).toBe("live");
    expect(deploymentMode({ STRIPE_SECRET_KEY: CA_TEST })).toBe("test");
    expect(deploymentMode({})).toBe("test");
  });
});

describe("getStripe / getStripeFor", () => {
  const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY_US", "STRIPE_ALLOW_LIVE_MODE", "VERCEL_ENV", "HONE_E2E_FAKE_STRIPE"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    built.calls.length = 0;
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it("CA: same variable, same pinned API version, and getStripe() is the very same client as getStripeFor('CA')", async () => {
    process.env.STRIPE_SECRET_KEY = CA_TEST;
    const m = await import("@/lib/stripe/server");
    const a = m.getStripe();
    expect(a).toBe(m.getStripeFor("CA"));
    expect(a).toBe(m.getStripe());
    expect(m.STRIPE_API_VERSION).toBe("2026-04-22.dahlia");
    expect(built.calls).toEqual([{ key: CA_TEST, opts: expect.objectContaining({ apiVersion: "2026-04-22.dahlia" }) }]);
  });

  it("US: its own client under its own key, a different object; building it never reads or disturbs the CA client", async () => {
    process.env.STRIPE_SECRET_KEY = CA_TEST;
    process.env.STRIPE_SECRET_KEY_US = US_TEST;
    const m = await import("@/lib/stripe/server");
    const ca = m.getStripe();
    const us = m.getStripeFor("US");
    expect(us).not.toBe(ca);
    expect(built.calls.map((c) => c.key)).toEqual([CA_TEST, US_TEST]);
    expect(built.calls[1].opts.apiVersion).toBe(built.calls[0].opts.apiVersion);
    expect(m.getStripeFor("US")).toBe(us);
  });

  it("a US client with only a CA key set throws, naming the US variable: it never falls back to CA", async () => {
    process.env.STRIPE_SECRET_KEY = CA_TEST;
    const m = await import("@/lib/stripe/server");
    expect(() => m.getStripeFor("US")).toThrow(/STRIPE_SECRET_KEY_US is not set/);
  });

  it("the live-mode gate applies to the US key too: sk_live_ without the explicit opt-in is refused", async () => {
    process.env.STRIPE_SECRET_KEY_US = US_LIVE;
    const m = await import("@/lib/stripe/server");
    expect(() => m.getStripeFor("US")).toThrow(/live mode is disabled/i);
  });
});

describe("source guard: only the resolver and the client builder read a platform's secret key", () => {
  const SCAN_DIRS = ["app", "lib", "components"];
  const ALLOWED = new Set(["lib/stripe/platform-routing.ts", "lib/stripe/server.ts"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
    }
    return out;
  }
  it("no other runtime file names STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_US", () => {
    const offenders = SCAN_DIRS.flatMap((d) => walk(d)).filter((f) => !ALLOWED.has(f)).filter((f) => {
      const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      return /process\.env\.STRIPE_SECRET_KEY|\bSTRIPE_SECRET_KEY_US\b/.test(code);
    });
    // lib/stripe/server.ts's inferStripeLivemode and e2e-fake files are the pre-existing readers; list any NEW one here, with a reason.
    expect(offenders.sort()).toEqual(["lib/stripe/e2e-fake-stripe.ts"].filter((f) => offenders.includes(f)).sort());
  });
});
