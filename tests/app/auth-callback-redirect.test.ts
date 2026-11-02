import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ exchange: vi.fn(), reconcile: vi.fn(), identify: vi.fn(), capture: vi.fn(), harden: vi.fn(), reissue: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/auth/proof-hardening", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/proof-hardening")>()), applyProofHardening: h.harden }));
// An access token whose payload carries the session's amr (decoded, not verified, exactly as the route reads a token the
// auth server just issued).
const token = (amr: unknown[]) => `h.${Buffer.from(JSON.stringify({ amr })).toString("base64url")}.s`;
const OTP_TOKEN = token([{ method: "otp", timestamp: 1 }]);
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({
  auth: { exchangeCodeForSession: h.exchange, verifyOtp: h.verify }, rpc: h.reconcile,
}) }));
vi.mock("@/lib/analytics/server", () => ({ identifyServerUser: h.identify, captureServerEvent: h.capture }));
import { GET } from "@/app/(auth)/auth/callback/route";
const ORIGIN = "https://hone.example.test";
function request(next?: string) {
  const url = new URL("/auth/callback", ORIGIN);
  url.searchParams.set("code", "synthetic-code");
  if (next !== undefined) url.searchParams.set("next", next);
  return new Request(url);
}
beforeEach(() => {
  vi.clearAllMocks();
  h.exchange.mockResolvedValue({ data: { user: { id: "11111111-2222-4333-8444-555555555555", email: "member@harness.local" }, session: { access_token: OTP_TOKEN } }, error: null });
  h.harden.mockResolvedValue("skipped_off");
  delete process.env.HONE_PROOF_HARDENING;
  h.reconcile.mockResolvedValue({ data: null, error: null });
});
describe("successful auth callback redirect boundary", () => {
  it.each(["@outside.example.test", ".outside.example.test/path", ":444/path", "//outside.example.test/path", "/\\outside.example.test/path", "https://outside.example.test", "?next=outside"])("refuses host-changing or non-path suffix %s", async (next) => {
    const response = await GET(request(next));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    expect(h.exchange).toHaveBeenCalledExactlyOnceWith("synthetic-code");
    expect(h.reconcile).toHaveBeenCalledExactlyOnceWith("reconcile_my_pending_invitation");
  });
  it.each(["/dashboard", "/settings/team?tab=invites#pending", "/clients/synthetic?return=%2Fdashboard"])("preserves same-origin path/query/fragment %s", async (next) => {
    expect((await GET(request(next))).headers.get("location")).toBe(new URL(next, ORIGIN).href);
  });
  it("defaults a missing destination and preserves opaque analytics", async () => {
    expect((await GET(request())).headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    expect(h.identify).toHaveBeenCalledOnce(); expect(h.capture).toHaveBeenCalledOnce();
  });
  it.each([["acceptance_required", "/accept-invitation"], ["conflict", "/no-access?reason=invite-conflict"], ["ambiguous", "/no-access?reason=invite-ambiguous"]])("preserves invitation routing %s", async (status, path) => {
    h.reconcile.mockResolvedValue({ data: { status }, error: null });
    expect((await GET(request("@outside.example.test"))).headers.get("location")).toBe(`${ORIGIN}${path}`);
  });
  it("preserves multi-studio selection clearing", async () => {
    h.reconcile.mockResolvedValue({ data: { status: "linked", choose_studio: true }, error: null });
    const response = await GET(request("/settings/team"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    expect(response.headers.get("set-cookie")).toContain("hone_selected_studio=;");
  });
  it("reconciliation rejection still signs in to a safe destination", async () => {
    h.reconcile.mockRejectedValue(new Error("synthetic refusal"));
    expect((await GET(request("@outside.example.test"))).headers.get("location")).toBe(`${ORIGIN}/dashboard`);
  });
  it("failed exchange retains the login error destination", async () => {
    h.exchange.mockResolvedValue({ data: { user: null }, error: { code: "synthetic" } });
    expect((await GET(request("@outside.example.test"))).headers.get("location")).toBe(`${ORIGIN}/login?error=auth`);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  describe("mailbox proof (email-trust, 2 Nov)", () => {
    const user = { id: "11111111-2222-4333-8444-555555555555", email: "member@harness.local" };
    const sessionWith = (amr: unknown[], u: Record<string, unknown> = user) => ({ data: { user: u, session: { access_token: token(amr) } }, error: null });
    it("NEGATIVE: a session without mailbox proof does not link an invitation and is not hardened", async () => {
      h.exchange.mockResolvedValue(sessionWith([{ method: "password", timestamp: 1 }]));
      h.reconcile.mockResolvedValue({ data: { status: "linked" }, error: null });
      const response = await GET(request("/dashboard"));
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.harden).not.toHaveBeenCalled();
      expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`); // still signed in; the accept page asks for proof
    });
    it("NEGATIVE: a session with no access token / no amr is treated as unproven", async () => {
      h.exchange.mockResolvedValue({ data: { user }, error: null });
      await GET(request("/dashboard"));
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.harden).not.toHaveBeenCalled();
    });
    it.each([[undefined, "off"], ["", "off"], ["off", "off"], ["bogus", "off"], ["password_only", "password_only"], ["all", "all"]])("HONE_PROOF_HARDENING=%s runs the hardening in mode %s, and reconcile still happens", async (flag, mode) => {
      if (flag === undefined) delete process.env.HONE_PROOF_HARDENING; else process.env.HONE_PROOF_HARDENING = flag;
      await GET(request("/dashboard"));
      expect(h.harden).toHaveBeenCalledOnce();
      expect(h.harden.mock.calls[0][0]).toMatchObject({ mode, user: { id: user.id } });
      expect(h.reconcile).toHaveBeenCalledOnce();
    });
    it("a rotation whose session cannot be re-established sends the person to sign in again, linking nothing", async () => {
      h.harden.mockResolvedValue("hardened_reissue_failed");
      const response = await GET(request("/dashboard"));
      expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=auth`);
      expect(h.reconcile).not.toHaveBeenCalled();
    });
    it.each(["skipped_off", "skipped_no_password", "skipped_password_unknown", "already_hardened", "hardened_session_reissued", "failed"])("outcome %s never blocks sign-in", async (outcome) => {
      h.harden.mockResolvedValue(outcome);
      expect((await GET(request("/dashboard"))).headers.get("location")).toBe(`${ORIGIN}/dashboard`);
      expect(h.reconcile).toHaveBeenCalledOnce();
    });
    it("a throw inside the hardening never blocks sign-in", async () => {
      h.harden.mockRejectedValue(new Error("synthetic"));
      expect((await GET(request("/dashboard"))).headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    });
    it("NEGATIVE: an unproven session never reaches the hardening at all, whatever the flag", async () => {
      process.env.HONE_PROOF_HARDENING = "all";
      h.exchange.mockResolvedValue(sessionWith([{ method: "password", timestamp: 1 }]));
      await GET(request("/dashboard"));
      expect(h.harden).not.toHaveBeenCalled();
    });
    it("POSITIVE: Google asserting the same verified address proves the mailbox", async () => {
      const google = { ...user, identities: [{ provider: "google", identity_data: { email: user.email, email_verified: true } }] };
      h.exchange.mockResolvedValue(sessionWith([{ method: "oauth", provider: "google", timestamp: 1 }], google));
      await GET(request("/dashboard"));
      expect(h.reconcile).toHaveBeenCalledOnce();
    });
    it("NEGATIVE: Google for a DIFFERENT address does not prove this account's mailbox", async () => {
      const google = { ...user, identities: [{ provider: "google", identity_data: { email: "other@harness.local", email_verified: true } }] };
      h.exchange.mockResolvedValue(sessionWith([{ method: "oauth", provider: "google", timestamp: 1 }], google));
      await GET(request("/dashboard"));
      expect(h.reconcile).not.toHaveBeenCalled();
    });
    it("token_hash signup-confirmation links are verified with verifyOtp and carry the same proof rules", async () => {
      h.verify.mockResolvedValue(sessionWith([{ method: "email/signup", timestamp: 1 }]));
      const url = new URL("/auth/callback", ORIGIN);
      url.searchParams.set("token_hash", "synthetic-hash");
      url.searchParams.set("type", "signup");
      const response = await GET(new Request(url));
      expect(h.verify).toHaveBeenCalledExactlyOnceWith({ token_hash: "synthetic-hash", type: "signup" });
      expect(h.exchange).not.toHaveBeenCalled();
      expect(h.reconcile).toHaveBeenCalledOnce();
      expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    });
    it("an unknown token_hash type is refused without calling the auth server", async () => {
      const url = new URL("/auth/callback", ORIGIN);
      url.searchParams.set("token_hash", "x");
      url.searchParams.set("type", "not-a-type");
      expect((await GET(new Request(url))).headers.get("location")).toBe(`${ORIGIN}/login?error=auth`);
      expect(h.verify).not.toHaveBeenCalled();
    });
  });
});
