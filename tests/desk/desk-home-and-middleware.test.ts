import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// R3: nothing about sign-in or routing changes while the flag is off; with it on, only a
// receptionist-only user is sent to /desk and only /desk is exempt from the practitioner gate.

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

import { deskHomeFor, type HomeSupabase } from "@/lib/desk/home";
import { updateSession } from "@/lib/supabase/middleware";

beforeEach(() => {
  practitioners = [];
  user = { id: "u", email: "r@example.test" };
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
});
afterEach(() => vi.unstubAllEnvs());

function homeDb(rows: { practitioners?: unknown[] | "error"; receptionists?: unknown[] | "error" }) {
  const reads: string[] = [];
  const db = {
    from: (t: string) => ({
      select: () => {
        const q = {
          eq: () => q,
          limit: async () => {
            reads.push(t);
            const v = t === "practitioners" ? rows.practitioners : rows.receptionists;
            return v === "error" ? { data: null, error: { message: "x" } } : { data: v ?? [], error: null };
          },
        };
        return q;
      },
    }),
  } as unknown as HomeSupabase;
  return { db, reads };
}

describe("sign-in landing", () => {
  it("flag off: null with no read at all", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    const { db, reads } = homeDb({ receptionists: [{ id: "r" }] });
    expect(await deskHomeFor(db, "u")).toBeNull();
    expect(reads).toEqual([]);
  });

  it("flag on: receptionist-only -> /desk; a practitioner anywhere keeps the dashboard; failures keep the ordinary landing", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    expect(await deskHomeFor(homeDb({ receptionists: [{ id: "r" }] }).db, "u")).toBe("/desk");
    expect(await deskHomeFor(homeDb({ practitioners: [{ studio_id: "s" }], receptionists: [{ id: "r" }] }).db, "u")).toBeNull();
    expect(await deskHomeFor(homeDb({}).db, "u")).toBeNull();
    expect(await deskHomeFor(homeDb({ practitioners: "error", receptionists: [{ id: "r" }] }).db, "u")).toBeNull();
    expect(await deskHomeFor(homeDb({ receptionists: "error" }).db, "u")).toBeNull();
  });
});

const go = async (path: string) => {
  const res = await updateSession(new NextRequest(`http://localhost${path}`));
  return { status: res.status, location: res.headers.get("location") };
};

describe("middleware: /desk exemption from the practitioner gate", () => {
  it("flag off (default): /desk follows the ordinary gate for a user with no practitioner row", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    const r = await go("/desk");
    expect(r.location).toContain("/no-access");
  });

  it("flag on: /desk and /desk/clients are not redirected to /no-access, and anonymous still goes to /login", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    for (const path of ["/desk", "/desk/clients"]) expect((await go(path)).location).toBeNull();
    user = null;
    expect((await go("/desk")).location).toContain("/login");
  });

  it("flag on: the exemption is narrow: every other authenticated path still hits the gate", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    for (const path of ["/dashboard", "/clients", "/calendar", "/settings", "/deskx", "/desks/clients"]) {
      expect((await go(path)).location, path).toContain("/no-access");
    }
  });
});
