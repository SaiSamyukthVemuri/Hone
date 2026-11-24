import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: () => false }));
import { middleware } from "@/middleware";
import { updateSession } from "@/lib/supabase/middleware";

// HON-7. Signed out: the redirect to /login remembers WHICH allowlisted page was asked for (a key in an HttpOnly cookie), and nothing else.

const ORIGIN = "https://hone.example.test";
const req = (pathAndQuery: string) => new NextRequest(new URL(pathAndQuery, ORIGIN));

beforeEach(() => vi.clearAllMocks());

describe("signed-out redirect", () => {
  it("permanently forwards an old link and applies sign-in on the new route", async () => {
    const first = await middleware(req("/settings/waitlist?followup=1"));
    expect(first.status).toBe(308);
    const destination = first.headers.get("location");
    expect(destination).toBe(ORIGIN + "/waitlist?followup=1");
    const second = await middleware(req(destination!));
    expect(new URL(second.headers.get("location")!).pathname).toBe("/login");
    expect(second.headers.get("set-cookie")).toContain("hone_return_to=waitlist_followup");
  });

  it("preserves a filtered search URL through the permanent move", async () => {
    const query = "?q=sample%20person&section=invited&page=2";
    const result = await middleware(req("/settings/waitlist/search" + query));
    expect(result.status).toBe(308);
    expect(result.headers.get("location")).toBe(ORIGIN + "/waitlist/search" + query);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
  it("still redirects to /login, and remembers the follow-up page as a key (HttpOnly, Lax, secure on https)", async () => {
    const res = await updateSession(req("/waitlist?followup=1"));
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
    expect((await updateSession(req("/waitlist"))).headers.get("set-cookie") ?? "").toContain("hone_return_to=waitlist;");
  });
  it.each([
    "/settings/team",
    "/dashboard",
    "/waitlist?followup=1&x=//evil.com",
    "/waitlist?next=https://evil.com",
    "/waitlist/replies",
    "/clients",
  ])("%s still redirects to /login and remembers NOTHING", async (target) => {
    const res = await updateSession(req(target));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
    expect((res.headers.get("set-cookie") ?? "").includes("hone_return_to")).toBe(false);
  });
});
