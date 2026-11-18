import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The route's decisions, with identity and the reader stubbed. The RLS refusals against a real database are in
// tests/db/calendar-change-fingerprint.db.test.ts.

const state = vi.hoisted(() => ({
  user: { id: "u" } as { id: string } | null,
  studio: { id: "s-1", timezone: "America/Toronto" } as { id: string; timezone: string } | null,
  read: vi.fn(async (..._a: unknown[]) => "0123456789abcdef0123456789abcdef"),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => {
    if (!state.studio) throw new Error("no practitioner");
    return { studio: state.studio };
  },
}));
vi.mock("@/lib/calendar/change-probe-read", () => ({ readCalendarFingerprint: (...a: unknown[]) => state.read(...a) }));

import { GET } from "@/app/api/calendar/change-fingerprint/route";

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/calendar/change-fingerprint?${qs}`));

beforeEach(() => {
  state.user = { id: "u" };
  state.studio = { id: "s-1", timezone: "America/Toronto" };
  state.read.mockClear();
});

describe("GET /api/calendar/change-fingerprint", () => {
  it("returns only the fingerprint, never cached", async () => {
    const res = await get("view=week&anchor=2026-11-15");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fingerprint: "0123456789abcdef0123456789abcdef" });
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("the studio and zone come from the session, never from the request", async () => {
    await get("view=day&anchor=2026-11-18&studio=other&studioId=other&timezone=UTC");
    expect(state.read).toHaveBeenCalledWith({ studioId: "s-1", timezone: "America/Toronto", view: "day", anchor: "2026-11-18" });
  });
  it("no session: 401 and nothing is read", async () => {
    state.user = null;
    const res = await get("view=day&anchor=2026-11-18");
    expect(res.status).toBe(401);
    expect(state.read).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
  it("signed in but no active practitioner: 403 and nothing is read", async () => {
    state.studio = null;
    const res = await get("view=day&anchor=2026-11-18");
    expect(res.status).toBe(403);
    expect(state.read).not.toHaveBeenCalled();
  });
  it("a bad view or anchor is a 400 before any identity or read work", async () => {
    for (const qs of ["", "view=year&anchor=2026-11-18", "view=day", "view=day&anchor=2026-02-30", "view=day&anchor=2026-11-18T00:00"]) {
      expect((await get(qs)).status, qs).toBe(400);
    }
    expect(state.read).not.toHaveBeenCalled();
  });
  it("a read failure is a plain 500 with no detail", async () => {
    state.read.mockRejectedValueOnce(new Error("relation secret_table does not exist"));
    const res = await get("view=day&anchor=2026-11-18");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret_table/);
  });
});

describe("what the route file must not do", () => {
  it("uses the caller's session client, never the admin client, and adds no middleware exemption", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/calendar/change-fingerprint/route.ts", "utf8");
    const read = readFileSync("lib/calendar/change-probe-read.ts", "utf8");
    for (const src of [route, read]) expect(src).not.toMatch(/createAdminClient|service_role|SERVICE_ROLE/);
    expect(read).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(readFileSync("lib/supabase/middleware.ts", "utf8")).not.toMatch(/api\/calendar/);
  });
});
