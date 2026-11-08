import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ exchange: vi.fn(), reconcile: vi.fn(), identify: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { exchangeCodeForSession: h.exchange }, rpc: h.reconcile }) }));
vi.mock("@/lib/analytics/server", () => ({ identifyServerUser: h.identify, captureServerEvent: h.capture }));
import { GET } from "@/app/(auth)/auth/callback/route";

// HON-7. The auth callback lands on a remembered internal page only for a known key, and every existing outcome is unchanged.

const ORIGIN = "https://hone.example.test";
function request(opts: { next?: string; cookie?: string } = {}) {
  const url = new URL("/auth/callback", ORIGIN);
  url.searchParams.set("code", "synthetic-code");
  if (opts.next !== undefined) url.searchParams.set("next", opts.next);
  return new Request(url, opts.cookie === undefined ? undefined : { headers: { cookie: opts.cookie } });
}
const loc = async (r: Request) => (await GET(r)).headers.get("location");

beforeEach(() => {
  vi.clearAllMocks();
  h.exchange.mockResolvedValue({ data: { user: { id: "11111111-2222-4333-8444-555555555555" } }, error: null });
  h.reconcile.mockResolvedValue({ data: null, error: null });
});

describe("return to the follow-up after sign-in", () => {
  it("the follow-up key lands on the page WITH the fragment (the round trip)", async () => {
    expect(await loc(request({ cookie: "hone_return_to=waitlist_followup" }))).toBe(`${ORIGIN}/settings/waitlist#follow-up`);
  });
  it("the plain key lands on the page", async () => {
    expect(await loc(request({ cookie: "x=1; hone_return_to=waitlist" }))).toBe(`${ORIGIN}/settings/waitlist`);
  });
  it("the key is single-use: the response clears the cookie", async () => {
    const res = await GET(request({ cookie: "hone_return_to=waitlist_followup" }));
    expect(res.headers.get("set-cookie") ?? "").toMatch(/hone_return_to=;/);
  });
  it.each([
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "/%2F%2Fevil",
    "javascript:alert(1)",
    "/settings/waitlist%0d%0aLocation:%20https://evil.com",
    "/" + "a".repeat(5000),
    "/settings/team",
    "waitlist_followup/../../x",
    "",
  ])("a tampered cookie value %j goes to /dashboard", async (value) => {
    expect(await loc(request({ cookie: `hone_return_to=${value}` }))).toBe(`${ORIGIN}/dashboard`);
  });
});

describe("existing sign-in flows are unchanged", () => {
  it("an explicit next still wins over the cookie and keeps its old behaviour", async () => {
    expect(await loc(request({ next: "/settings/team", cookie: "hone_return_to=waitlist_followup" }))).toBe(`${ORIGIN}/settings/team`);
    expect(await loc(request({ next: "//outside.example.test/path", cookie: "hone_return_to=waitlist_followup" }))).toBe(`${ORIGIN}/dashboard`);
  });
  it("no cookie and no next goes to /dashboard", async () => {
    expect(await loc(request())).toBe(`${ORIGIN}/dashboard`);
  });
  it.each([["acceptance_required", "/accept-invitation"], ["conflict", "/no-access?reason=invite-conflict"], ["ambiguous", "/no-access?reason=invite-ambiguous"]])(
    "a %s reconciliation still overrides the remembered page",
    async (status, path) => {
      h.reconcile.mockResolvedValue({ data: { status }, error: null });
      expect(await loc(request({ cookie: "hone_return_to=waitlist_followup" }))).toBe(`${ORIGIN}${path}`);
    },
  );
  it("a multi-studio chooser still wins", async () => {
    h.reconcile.mockResolvedValue({ data: { status: "linked", choose_studio: true }, error: null });
    expect(await loc(request({ cookie: "hone_return_to=waitlist_followup" }))).toBe(`${ORIGIN}/dashboard`);
  });
  it("a failed exchange keeps the login error and ignores the cookie", async () => {
    h.exchange.mockResolvedValue({ data: { user: null }, error: { code: "synthetic" } });
    expect(await loc(request({ cookie: "hone_return_to=waitlist_followup" }))).toBe(`${ORIGIN}/login?error=auth`);
  });
});

describe("authority is not carried by the return", () => {
  it("the destination page refuses a non-owner BEFORE it reads anything", () => {
    const src = readFileSync(join(process.cwd(), "app/(app)/settings/waitlist/page.tsx"), "utf8");
    const refusal = src.indexOf('practitioner.role !== "owner"');
    expect(refusal).toBeGreaterThan(-1);
    const afterRefusal = src.slice(refusal);
    expect(afterRefusal.includes("OwnerOnlyNotice")).toBe(true);
    expect(afterRefusal.indexOf("OwnerOnlyNotice")).toBeLessThan(afterRefusal.indexOf("createClient()") === -1 ? Infinity : afterRefusal.indexOf("createClient()"));
    // nothing before the refusal queries data except the practitioner lookup
    const before = src.slice(src.indexOf("export default async function WaitlistSettingsPage"), refusal);
    expect(/\.from\(|\.rpc\(/.test(before)).toBe(false);
  });
});
