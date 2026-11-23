import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isDeskEnabled, isDeskPath } from "@/lib/desk/flag";

// The desk carve-out: with the flag off nothing about routing changes; with it on, only /desk is exempt from the
// practitioner gate, and only for an authenticated user.

let practitioners: unknown[] = [];
let user: { id: string; email: string } | null = { id: "u", email: "r@example.test" };

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.then = (resolve: (v: unknown) => void) => resolve({ data: practitioners, error: null });
      return q;
    },
  }),
}));

import { updateSession } from "@/lib/supabase/middleware";

beforeEach(() => {
  practitioners = [];
  user = { id: "u", email: "r@example.test" };
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
});
afterEach(() => vi.unstubAllEnvs());

const go = async (path: string) => {
  const res = await updateSession(new NextRequest(`http://localhost${path}`));
  return { status: res.status, location: res.headers.get("location") };
};

describe("the desk flag", () => {
  it("is on only for exactly \"true\"", () => {
    for (const v of ["", "false", "TRUE", "1", "yes", " true", "true "]) {
      vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", v);
      expect(isDeskEnabled(), JSON.stringify(v)).toBe(false);
    }
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    expect(isDeskEnabled()).toBe(true);
  });
  it("matches /desk and below, and nothing that merely starts with it", () => {
    for (const p of ["/desk", "/desk/", "/desk/clients"]) expect(isDeskPath(p), p).toBe(true);
    for (const p of ["/deskx", "/desks/clients", "/dashboard", "/", "/api/desk", "/desk.json"]) expect(isDeskPath(p), p).toBe(false);
  });
  it("is case sensitive: /DESK and /Desk/clients are not desk paths", () => {
    for (const p of ["/DESK", "/Desk", "/DESK/clients", "/desK/x"]) expect(isDeskPath(p), p).toBe(false);
  });
  it("is false for a path with an encoded slash or backslash (any case) or a dot-dot segment", () => {
    for (const p of ["/desk/..%2Fdashboard", "/desk/..%2fdashboard", "/desk%2Fclients", "/desk/%5Cdashboard", "/desk/%5cx", "/desk/../dashboard", "/desk/a/../b", "/desk/.."]) expect(isDeskPath(p), p).toBe(false);
  });
  it("still accepts ordinary nested desk paths, including dots that are not a dot-dot segment", () => {
    for (const p of ["/desk/a.b", "/desk/..a", "/desk/a..", "/desk/a/b"]) expect(isDeskPath(p), p).toBe(true);
  });
});

describe("middleware: /desk exemption from the practitioner gate", () => {
  it("flag off (default): /desk follows the ordinary gate for a user with no practitioner row", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    for (const path of ["/desk", "/desk/clients"]) expect((await go(path)).location, path).toContain("/no-access");
  });

  it("flag on: /desk and below are not redirected to /no-access, and anonymous still goes to /login", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    for (const path of ["/desk", "/desk/clients"]) expect((await go(path)).location, path).toBeNull();
    user = null;
    for (const path of ["/desk", "/desk/clients"]) expect((await go(path)).location, path).toContain("/login");
  });

  it("flag on: the exemption is narrow, every other authenticated path still hits the gate", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    for (const path of ["/dashboard", "/clients", "/calendar", "/settings", "/deskx", "/desks/clients", "/api/desk"]) {
      expect((await go(path)).location, path).toContain("/no-access");
    }
  });

  it("flag on: /DESK and traversal or encoded-slash forms are still gated", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    for (const path of ["/DESK", "/Desk/clients", "/desk/..%2Fdashboard", "/desk/..%2fdashboard", "/desk/%5Cdashboard", "/desk%2Fclients"]) {
      expect((await go(path)).location, path).toContain("/no-access");
    }
  });

  it("flag on: /desk/../dashboard is parsed to /dashboard and hits the gate", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    const req = new NextRequest("http://localhost/desk/../dashboard");
    expect(req.nextUrl.pathname).toBe("/dashboard");
    expect(new URL((await updateSession(req)).headers.get("location") ?? "http://x/").pathname).toBe("/no-access");
  });

  it("flag on: a user with a practitioner row is unchanged on ordinary paths", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    practitioners = [{ studio_id: "s1" }];
    expect((await go("/dashboard")).location).toBeNull();
  });
});
