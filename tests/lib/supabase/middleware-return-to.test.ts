import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: () => false }));
import { updateSession } from "@/lib/supabase/middleware";

// HON-7. Signed out: the redirect to /login remembers WHICH allowlisted page was asked for (a key in an HttpOnly cookie), and nothing else.

const ORIGIN = "https://hone.example.test";
const req = (pathAndQuery: string) => new NextRequest(new URL(pathAndQuery, ORIGIN));

beforeEach(() => vi.clearAllMocks());

describe("signed-out redirect", () => {
  it("still redirects to /login, and remembers the follow-up page as a key (HttpOnly, Lax, secure on https)", async () => {
    const res = await updateSession(req("/settings/waitlist?followup=1"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hone_return_to=waitlist_followup");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Max-Age=3600/i);
    expect(cookie).toMatch(/Path=\//i);
  });
  it("the plain page remembers the plain key", async () => {
    expect((await updateSession(req("/settings/waitlist"))).headers.get("set-cookie") ?? "").toContain("hone_return_to=waitlist;");
  });
  it.each([
    "/settings/team",
    "/dashboard",
    "/settings/waitlist?followup=1&x=//evil.com",
    "/settings/waitlist?next=https://evil.com",
    "/settings/waitlist/replies",
    "/clients",
  ])("%s still redirects to /login and remembers NOTHING", async (target) => {
    const res = await updateSession(req(target));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
    expect((res.headers.get("set-cookie") ?? "").includes("hone_return_to")).toBe(false);
  });
});
