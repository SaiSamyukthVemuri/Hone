import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const read = vi.hoisted(() => ({ value: null as unknown, accounts: [] as Array<{ stripe_account_id: string }>, accountsError: false }));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({ getStudioPaymentJurisdiction: async () => read.value }));
// The studio's connected-account rows (one row per account MODE): the shape of studio_payment_settings.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ not: () => ({ limit: async () => (read.accountsError ? { data: null, error: { code: "x" } } : { data: read.accounts.slice(0, 1), error: null }) }) }) }),
    }),
  }),
}));
const clients = vi.hoisted(() => ({ ca: { who: "CA" }, us: { who: "US" }, forCalls: [] as string[] }));
vi.mock("@/lib/stripe/server", () => ({
  getStripe: () => clients.ca,
  getStripeFor: (p: string) => { clients.forCalls.push(p); return p === "US" ? clients.us : clients.ca; },
}));

import { StripePlatformUnavailableError, requireStripeForStudio, resolveStudioPlatform } from "@/lib/stripe/studio-platform";

const body = (n: string) => n.padEnd(40, "A1b2C3d4E5");
const ENV_BOTH = { STRIPE_SECRET_KEY: `sk_test_${body("ca")}`, STRIPE_SECRET_KEY_US: `sk_test_${body("us")}` };
const NO_ROW = { ok: false, reason: "missing" };

beforeEach(() => { clients.forCalls.length = 0; read.accounts = []; read.accountsError = false; });

describe("the platform comes from the studio's verified jurisdiction row, read by studio id", () => {
  it("a CA/cad studio gets the existing CA client, via getStripe(), not getStripeFor, under both purposes", async () => {
    read.value = { ok: true, jurisdiction: { country: "CA", currency: "cad" } };
    for (const purpose of ["new_money", "existing_account"] as const) {
      expect(await resolveStudioPlatform("s1", purpose, ENV_BOTH)).toEqual({ ok: true, platform: "CA" });
      expect(await requireStripeForStudio("s1", purpose)).toBe(clients.ca);
    }
    expect(clients.forCalls).toEqual([]);
  });

  it("a US/usd studio gets the US client only when the US platform resolves, under both purposes", async () => {
    read.value = { ok: true, jurisdiction: { country: "US", currency: "usd" } };
    const prev = { ...process.env };
    Object.assign(process.env, ENV_BOTH);
    try {
      for (const purpose of ["new_money", "existing_account"] as const) expect(await requireStripeForStudio("s2", purpose)).toBe(clients.us);
      delete process.env.STRIPE_SECRET_KEY_US;
      for (const purpose of ["new_money", "existing_account"] as const) await expect(requireStripeForStudio("s2", purpose)).rejects.toBeInstanceOf(StripePlatformUnavailableError);
    } finally {
      process.env = prev;
    }
  });

  it("an unreadable or invalid jurisdiction row refuses under both purposes (only an ABSENT row can fall back, and only for an existing account)", async () => {
    for (const reason of ["read_failed", "invalid"] as const) {
      read.value = { ok: false, reason };
      read.accounts = [{ stripe_account_id: "acct_x" }];
      for (const purpose of ["new_money", "existing_account"] as const) {
        expect(await resolveStudioPlatform("s3", purpose, ENV_BOTH)).toEqual({ ok: false, reason });
        await expect(requireStripeForStudio("s3", purpose)).rejects.toMatchObject({ reason });
      }
    }
  });
});

describe("a studio whose connected account PREDATES jurisdiction rows (no row, an existing account)", () => {
  // The two shapes found in production: an account in test AND live mode (two rows of one studio), and a live account only.
  const SHAPES: Record<string, Array<{ stripe_account_id: string }>> = {
    "test and live accounts": [{ stripe_account_id: "acct_test_1" }, { stripe_account_id: "acct_live_1" }],
    "a live account only": [{ stripe_account_id: "acct_live_2" }],
  };

  for (const [shape, rows] of Object.entries(SHAPES)) {
    describe(shape, () => {
      beforeEach(() => { read.value = NO_ROW; read.accounts = rows; });

      it("reads and servicing resolve to the CA platform, as today: status refresh, dashboard link, onboarding resume, card-on-file, refund/reconcile/cancel", async () => {
        expect(await resolveStudioPlatform("legacy", "existing_account", ENV_BOTH)).toEqual({ ok: true, platform: "CA" });
        expect(await requireStripeForStudio("legacy", "existing_account")).toBe(clients.ca);
      });

      it("NEW money is refused, as today: a charge needs a verified country and currency", async () => {
        expect(await resolveStudioPlatform("legacy", "new_money", ENV_BOTH)).toEqual({ ok: false, reason: "missing" });
        await expect(requireStripeForStudio("legacy", "new_money")).rejects.toMatchObject({ reason: "missing" });
      });

      it("never resolves to the US platform, however the US key is configured: a US platform needs an explicit US row", async () => {
        const prev = { ...process.env };
        Object.assign(process.env, ENV_BOTH);
        try {
          await requireStripeForStudio("legacy", "existing_account");
          expect(clients.forCalls).toEqual([]);
          expect(await resolveStudioPlatform("legacy", "existing_account", ENV_BOTH)).not.toEqual({ ok: true, platform: "US" });
        } finally {
          process.env = prev;
        }
      });
    });
  }

  it("no row AND no connected account: refused under both purposes (nothing to service, nothing verified)", async () => {
    read.value = NO_ROW;
    read.accounts = [];
    for (const purpose of ["new_money", "existing_account"] as const) {
      expect(await resolveStudioPlatform("fresh", purpose, ENV_BOTH)).toEqual({ ok: false, reason: "missing" });
    }
  });

  it("no row and the account lookup fails: refused (never guessed to be CA)", async () => {
    read.value = NO_ROW;
    read.accountsError = true;
    expect(await resolveStudioPlatform("legacy", "existing_account", ENV_BOTH)).toEqual({ ok: false, reason: "read_failed" });
  });
});
