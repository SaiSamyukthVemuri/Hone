import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SELF_SERVE_PRICING_FOOTNOTE,
  getPlanChoices,
} from "@/lib/subscriptions/plan-selection";

// HON-70 account step (PROPOSED, flag-gated). Pins: flag OFF means nothing
// exists (404, no links, original pricing sentence untouched); flag ON creates
// an ACCOUNT only, with copy that keeps account creation apart from paid studio
// access, no Stripe, no checkout, and no raw auth error leaking.

const REPO = process.cwd();
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const createClientMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: (...a: unknown[]) => createClientMock(...a),
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://app.example.test",
}));

describe("pricing page: flag OFF is untouched, flag ON adds account CTAs", () => {
  it("flag off: no plan choices and the original sentence is still in the page source verbatim", () => {
    expect(getPlanChoices({})).toEqual([]);
    expect(
      getPlanChoices({ HONE_SELF_SERVE_CHECKOUT_ENABLED: "TRUE" }),
    ).toEqual([]);
    const page = strip(read("app/pricing/page.tsx")).replace(/\s+/g, " ");
    expect(page).toContain(
      "Prices are in US dollars (USD). Setup and payment activation happen during guided onboarding; there is no self-service checkout.",
    );
    expect(page).toMatch(/planChoices\.length === 0 \?/);
  });

  it("flag on: two CTAs carry only the plan KEY, and the footnote separates account from studio access", () => {
    const c = getPlanChoices({ HONE_SELF_SERVE_CHECKOUT_ENABLED: "true" });
    expect(c.map((x) => x.href)).toEqual([
      "/signup?plan=solo",
      "/signup?plan=studio",
    ]);
    expect(SELF_SERVE_PRICING_FOOTNOTE).toMatch(
      /free and gives no studio access/,
    );
    expect(SELF_SERVE_PRICING_FOOTNOTE).not.toMatch(
      /price_|sk_|checkout\.stripe/,
    );
  });

  it("nothing else links to /signup with a static href", () => {
    for (const f of [
      "app/pricing/page.tsx",
      "app/_components/marketing/SiteHeader.tsx",
      "app/_components/marketing/SiteFooter.tsx",
      "app/page.tsx",
    ]) {
      expect(strip(read(f)), f).not.toMatch(/["'`]\/signup/);
    }
  });
});

describe("/signup page and middleware", () => {
  it("the page 404s unless the flag is exactly true", () => {
    const src = strip(read("app/signup/page.tsx"));
    expect(src).toMatch(
      /if \(!isSelfServeCheckoutEnabled\(process\.env\)\) notFound\(\)/,
    );
    expect(src).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  it("middleware lists /signup by EXACT match only", () => {
    const mw = read("lib/supabase/middleware.ts");
    expect(mw).toMatch(/pathname === "\/signup" \|\|/);
    expect(mw).not.toMatch(/startsWith\("\/signup/);
  });

  it("offers Google and email code with the chosen plan", () => {
    const f = read("app/signup/SignupForm.tsx");
    expect(f).toContain("Continue with Google");
    expect(f).toContain("Send me a code");
    expect(f).toContain('autoComplete="one-time-code"');
    expect(read("supabase/templates/sign-in.html")).toContain("{{ .Token }}");
  });
});

describe("owner signup", () => {
  beforeEach(() => {
    createClientMock.mockReset();
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("refuses invalid plans, disabled signup, and invalid codes", async () => {
    const { startOwnerSignIn, confirmOwnerCode } = await import(
      "@/app/signup/actions"
    );
    expect((await startOwnerSignIn("other")).ok).toBe(false);
    expect(
      (await confirmOwnerCode("studio", "test@example.test", "invalid")).ok,
    ).toBe(false);
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "false");
    expect((await startOwnerSignIn("solo")).ok).toBe(false);
    expect(createClientMock).not.toHaveBeenCalled();
  });
  it("lets a subscriber return without picking a tier or opening another purchase", async () => {
    const auth = {
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      verifyOtp: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "returning" } } }),
    };
    createClientMock.mockResolvedValue({
      auth,
      rpc: vi.fn().mockResolvedValue({ data: null }),
    });
    const { startOwnerSignIn, confirmOwnerCode } = await import(
      "@/app/signup/actions"
    );
    expect((await startOwnerSignIn("signin", "owner@example.test")).ok).toBe(
      true,
    );
    expect(auth.signInWithOtp.mock.calls[0][0].options.shouldCreateUser).toBe(
      false,
    );
    expect(
      await confirmOwnerCode("signin", "owner@example.test", "123456"),
    ).toEqual({ ok: true, destination: "/dashboard" });
  });

  it.each(["solo", "studio"])(
    "carries %s through Google and through an email code",
    async (plan) => {
      const auth = {
        signInWithOAuth: vi
          .fn()
          .mockResolvedValue({ data: { url: "https://example.test/oauth" } }),
        signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
        verifyOtp: vi
          .fn()
          .mockResolvedValue({ data: { user: { id: "account" } } }),
      };
      const rpc = vi.fn().mockResolvedValue({ data: null });
      createClientMock.mockResolvedValue({ auth, rpc });
      const { startOwnerSignIn, confirmOwnerCode } = await import(
        "@/app/signup/actions"
      );
      expect((await startOwnerSignIn(plan)).ok).toBe(true);
      const callback = new URL(
        auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
      );
      expect(callback.searchParams.get("next")).toBe("/no-access?plan=" + plan);
      expect((await startOwnerSignIn(plan, " Owner@Example.test ")).ok).toBe(
        true,
      );
      expect(auth.signInWithOtp.mock.calls[0][0].email).toBe(
        "owner@example.test",
      );
      expect(
        await confirmOwnerCode(plan, "owner@example.test", "123456"),
      ).toEqual({ ok: true, destination: "/no-access?plan=" + plan });
      expect(auth.verifyOtp).toHaveBeenCalledWith({
        email: "owner@example.test",
        type: "email",
        token: "123456",
      });
      rpc.mockResolvedValueOnce({ data: { status: "acceptance_required" } });
      expect(
        await confirmOwnerCode(plan, "owner@example.test", "123456"),
      ).toEqual({ ok: true, destination: "/accept-invitation" });
    },
  );
});
