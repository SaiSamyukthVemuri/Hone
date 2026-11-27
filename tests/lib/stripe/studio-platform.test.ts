import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const read = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({ getStudioPaymentJurisdiction: async () => read.value }));
const clients = vi.hoisted(() => ({ ca: { who: "CA" }, us: { who: "US" }, forCalls: [] as string[] }));
vi.mock("@/lib/stripe/server", () => ({
  getStripe: () => clients.ca,
  getStripeFor: (p: string) => { clients.forCalls.push(p); return p === "US" ? clients.us : clients.ca; },
}));

import { StripePlatformUnavailableError, requireStripeForStudio, resolveStudioPlatform } from "@/lib/stripe/studio-platform";

const body = (n: string) => n.padEnd(40, "A1b2C3d4E5");
const ENV_BOTH = { STRIPE_SECRET_KEY: `sk_test_${body("ca")}`, STRIPE_SECRET_KEY_US: `sk_test_${body("us")}` };

beforeEach(() => { clients.forCalls.length = 0; });

describe("the platform comes from the studio's verified jurisdiction row, read by studio id", () => {
  it("a CA/cad studio gets the existing CA client, via getStripe(), not getStripeFor", async () => {
    read.value = { ok: true, jurisdiction: { country: "CA", currency: "cad" } };
    expect(await resolveStudioPlatform("s1", ENV_BOTH)).toEqual({ ok: true, platform: "CA" });
    const saved = process.env.STRIPE_SECRET_KEY;
    expect(await requireStripeForStudio("s1")).toBe(clients.ca);
    expect(clients.forCalls).toEqual([]);
    expect(process.env.STRIPE_SECRET_KEY).toBe(saved);
  });

  it("a US/usd studio gets the US client when the US platform resolves", async () => {
    read.value = { ok: true, jurisdiction: { country: "US", currency: "usd" } };
    const prev = { ...process.env };
    Object.assign(process.env, ENV_BOTH);
    try {
      expect(await requireStripeForStudio("s2")).toBe(clients.us);
      expect(clients.forCalls).toEqual(["US"]);
    } finally {
      process.env = prev;
    }
  });

  it("a US studio with no US platform configured is refused, never given the CA client", async () => {
    read.value = { ok: true, jurisdiction: { country: "US", currency: "usd" } };
    const prev = { ...process.env };
    delete process.env.STRIPE_SECRET_KEY_US;
    try {
      await expect(requireStripeForStudio("s2")).rejects.toBeInstanceOf(StripePlatformUnavailableError);
      expect(clients.forCalls).toEqual([]);
    } finally {
      process.env = prev;
    }
  });

  it("a missing, unreadable or invalid jurisdiction row refuses for every studio, CA included (the charge path already does)", async () => {
    for (const reason of ["missing", "read_failed", "invalid"] as const) {
      read.value = { ok: false, reason };
      expect(await resolveStudioPlatform("s3", ENV_BOTH)).toEqual({ ok: false, reason });
      await expect(requireStripeForStudio("s3")).rejects.toMatchObject({ reason });
    }
  });
});
