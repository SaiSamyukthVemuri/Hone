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
    expect(getPlanChoices({ HONE_SELF_SERVE_CHECKOUT_ENABLED: "TRUE" })).toEqual([]);
    const page = strip(read("app/pricing/page.tsx")).replace(/\s+/g, " ");
    expect(page).toContain(
      "Prices are in US dollars (USD). Setup and payment activation happen during guided onboarding; there is no self-service checkout.",
    );
    expect(page).toMatch(/planChoices\.length === 0 \?/);
  });

  it("flag on: two CTAs carry only the plan KEY, and the footnote separates account from studio access", () => {
    const c = getPlanChoices({ HONE_SELF_SERVE_CHECKOUT_ENABLED: "true" });
    expect(c.map((x) => x.href)).toEqual(["/signup?plan=solo", "/signup?plan=studio"]);
    expect(SELF_SERVE_PRICING_FOOTNOTE).toMatch(/free and gives no studio access/);
    expect(SELF_SERVE_PRICING_FOOTNOTE).not.toMatch(/price_|sk_|checkout\.stripe/);
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
    expect(src).toMatch(/if \(!isSelfServeCheckoutEnabled\(process\.env\)\) notFound\(\)/);
    expect(src).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  it("middleware lists /signup by EXACT match only", () => {
    const mw = read("lib/supabase/middleware.ts");
    expect(mw).toMatch(/pathname === "\/signup" \|\|/);
    expect(mw).not.toMatch(/startsWith\("\/signup/);
  });

  it("the form keeps account creation apart from paid studio access and invents no legal terms", () => {
    const f = strip(read("app/signup/SignupForm.tsx")).replace(/\s+/g, " ");
    expect(f).toMatch(/Creating an account is free and gives no studio access/);
    expect(f).toMatch(/Starting your studio is a separate, paid step/);
    expect(f).toMatch(/href="\/terms"/);
    expect(f).toMatch(/href="\/privacy"/);
    expect(f).not.toMatch(/I agree|I accept|consent/i);
  });

  it("the account step touches no Stripe, billing or checkout code", () => {
    for (const f of ["app/signup/actions.ts", "app/signup/SignupForm.tsx", "app/signup/page.tsx"]) {
      expect(strip(read(f)), f).not.toMatch(
        /stripe|checkout-session|billing-client|createSubscriptionCheckout/i,
      );
    }
  });
});

describe("requestSignupLinkAction", () => {
  beforeEach(() => createClientMock.mockReset());
  afterEach(() => vi.unstubAllEnvs());

  async function run(email: string, flag: string) {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", flag);
    const { requestSignupLinkAction } = await import("@/app/signup/actions");
    return requestSignupLinkAction(email);
  }

  it("flag off: refuses and never creates a client or sends anything", async () => {
    expect(await run("a@example.test", "")).toEqual({ ok: false, error: "Not available." });
    expect(await run("a@example.test", "TRUE")).toEqual({ ok: false, error: "Not available." });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("rejects malformed addresses before any auth call", async () => {
    for (const bad of ["", "nope", "a@b", `${"x".repeat(300)}@example.test`]) {
      expect((await run(bad, "true")).ok).toBe(false);
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("flag on: one verification link, user creation allowed, redirect to the ordinary callback", async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    createClientMock.mockResolvedValue({ auth: { signInWithOtp } });
    expect(await run("  New@Example.test ", "true")).toEqual({ ok: true });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "new@example.test",
      options: {
        emailRedirectTo: "https://app.example.test/auth/callback",
        shouldCreateUser: true,
      },
    });
  });

  it("a provider error returns a fixed message that never quotes the address or the error", async () => {
    createClientMock.mockResolvedValue({
      auth: {
        signInWithOtp: vi
          .fn()
          .mockResolvedValue({ error: { message: "rate limit for new@example.test req_SECRET" } }),
      },
    });
    const r = await run("new@example.test", "true");
    expect(r).toEqual({ ok: false, error: "Could not send the link. Try again in a moment." });
    expect(JSON.stringify(r)).not.toContain("example.test");
    expect(JSON.stringify(r)).not.toContain("req_SECRET");
  });
});
