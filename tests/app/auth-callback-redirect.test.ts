import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ exchange: vi.fn(), reconcile: vi.fn(), identify: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({
  auth: { exchangeCodeForSession: h.exchange }, rpc: h.reconcile,
}) }));
vi.mock("@/lib/analytics/server", () => ({ identifyServerUser: h.identify, captureServerEvent: h.capture }));
import { GET } from "@/app/(auth)/auth/callback/route";
const ORIGIN = "https://hone.example.test";
function request(next?: string) {
  const url = new URL("/auth/callback", ORIGIN);
  url.searchParams.set("code", "synthetic-code");
  if (next !== undefined) url.searchParams.set("next", next);
  return new NextRequest(url);
}
beforeEach(() => {
  vi.clearAllMocks();
  h.exchange.mockResolvedValue({ data: { user: { id: "11111111-2222-4333-8444-555555555555" } }, error: null });
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
    // Integrated LEAD-ALERT return-path contract keeps query, drops fragment.
    const expected = new URL(next, ORIGIN);
    expected.hash = "";
    expect((await GET(request(next))).headers.get("location")).toBe(expected.href);
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
});
