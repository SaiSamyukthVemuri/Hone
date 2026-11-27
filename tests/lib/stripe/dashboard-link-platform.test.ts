import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-90 Option A. A US studio has a FULL Stripe Dashboard: Stripe refuses an Express login link for it, so Hone points the studio at Stripe's
// own sign-in and makes no createLoginLink call. Canada keeps the Express login link exactly as before.

const h = vi.hoisted(() => ({ platform: "CA" as "CA" | "US", loginCalls: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false, getStripe: () => ({}), getStripeFor: () => ({}) }));
vi.mock("@/lib/stripe/studio-platform", () => ({
  resolveStudioPlatform: async () => ({ ok: true, platform: h.platform }),
  requireStripeForStudio: async () => ({
    accounts: { createLoginLink: async (id: string) => { h.loginCalls.push(id); return { url: "https://connect.stripe.com/express/login-link" }; } },
  }),
}));

const { createExpressDashboardLoginLink, FULL_DASHBOARD_SIGN_IN_URL } = await import("@/lib/stripe/account");

beforeEach(() => { h.loginCalls = []; });

describe("the Open Stripe dashboard action", () => {
  it("US (full Dashboard): Stripe's own sign-in, and NO Express login link is requested", async () => {
    h.platform = "US";
    expect(await createExpressDashboardLoginLink("s", "acct_us")).toBe(FULL_DASHBOARD_SIGN_IN_URL);
    expect(FULL_DASHBOARD_SIGN_IN_URL).toBe("https://dashboard.stripe.com/login");
    expect(h.loginCalls).toEqual([]);
  });
  it("CA: the Express login link, unchanged", async () => {
    h.platform = "CA";
    expect(await createExpressDashboardLoginLink("s", "acct_ca")).toBe("https://connect.stripe.com/express/login-link");
    expect(h.loginCalls).toEqual(["acct_ca"]);
  });
});
