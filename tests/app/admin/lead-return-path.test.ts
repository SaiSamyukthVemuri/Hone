import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// LEAD-ALERT-01 (Codex P2 4248920454): the operator who opens the alert's
// /admin/leads/... link while signed out signs in and lands back on that lead.
// The target travels ONLY as a validated same-origin /admin path, in a
// short-lived httpOnly cookie that the sign-in callback consumes.

const auth = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  // An allowlisted operator: the remembered target is honoured only for one
  // (lib/auth/admin-return.ts; lead-return-through-invitation.test.ts).
  exchange: { data: { user: { id: "u1", email: "ops@hone.example" } }, error: null } as unknown,
  reconcile: { data: { status: "none" } } as unknown,
}));

const { query } = vi.hoisted(() => ({
  query: (data: unknown) => Object.assign(Promise.resolve({ data, error: null }), { limit: async () => ({ data, error: null }) }),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }) },
    // Awaitable AND .limit()-able, so the mock holds whichever membership
    // reads the middleware makes.
    from: () => ({ select: () => ({ eq: () => ({ eq: () => query([]) }) }) }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: async () => auth.exchange },
    rpc: async () => auth.reconcile,
  }),
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: vi.fn(), identifyServerUser: vi.fn() }));

import { updateSession } from "@/lib/supabase/middleware";
import { GET as callback } from "@/app/(auth)/auth/callback/route";
import { ADMIN_RETURN_COOKIE } from "@/lib/auth/return-path";

const ORIGIN = "https://hone.example";
const LEAD = "/admin/leads/demo-request/8f0c2b7e-5d1a-4a2b-9c3d-4e5f6a7b8c9d";

beforeEach(() => {
  auth.user = null;
  auth.reconcile = { data: { status: "none" } };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.ADMIN_EMAILS = "ops@hone.example";
});

const returnCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${ADMIN_RETURN_COOKIE}=`)) ?? null;

describe("the middleware remembers ONLY a validated /admin target", () => {
  it("a signed-out request for the lead page goes to /login with the lead path in an httpOnly cookie", async () => {
    const res = await updateSession(new NextRequest(`${ORIGIN}${LEAD}`));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    const cookie = returnCookie(res)!;
    expect(decodeURIComponent(cookie)).toContain(`${ADMIN_RETURN_COOKIE}=${LEAD}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=900/);
  });

  it("a signed-out request for any other private page sets no return cookie", async () => {
    const res = await updateSession(new NextRequest(`${ORIGIN}/dashboard`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(returnCookie(res)).toBeNull();
  });
});

describe("the sign-in callback", () => {
  const signIn = (cookie?: string, next?: string) => {
    const url = new URL(`${ORIGIN}/auth/callback`);
    url.searchParams.set("code", "c");
    if (next !== undefined) url.searchParams.set("next", next);
    const req = new NextRequest(url, cookie ? { headers: { cookie: `${ADMIN_RETURN_COOKIE}=${encodeURIComponent(cookie)}` } } : undefined);
    return callback(req);
  };

  it("lands on the remembered lead page, and consumes the cookie", async () => {
    const res = await signIn(LEAD);
    expect(res.headers.get("location")).toBe(`${ORIGIN}${LEAD}`);
    expect(returnCookie(res)).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  it.each([
    ["an outside URL", "https://evil.example/admin"],
    ["protocol-relative", "//evil.example/admin"],
    ["a non-admin internal path", "/settings"],
  ])("ignores a cookie holding %s", async (_label, value) => {
    expect((await signIn(value)).headers.get("location")).toBe(`${ORIGIN}/dashboard`);
  });

  it.each([
    ["userinfo", "@evil.example"],
    ["host suffix", ".evil.example"],
    ["protocol-relative", "//evil.example"],
    ["backslash", "/\\evil.example"],
  ])("never leaves the origin through `next` (%s); it falls back to the dashboard", async (_label, next) => {
    const res = await signIn(undefined, next);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
  });

  it("a valid internal `next` still works as before", async () => {
    expect((await signIn(undefined, "/clients")).headers.get("location")).toBe(`${ORIGIN}/clients`);
  });

  it("an invitation that needs acceptance still comes first, and the target is CARRIED, not consumed (Codex P2 4263663458)", async () => {
    auth.reconcile = { data: { status: "acceptance_required" } };
    const res = await signIn(LEAD);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/accept-invitation`);
    expect(returnCookie(res)).toBeNull();
  });
});
