import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isFrontDeskPath, resolveReceptionistMembership } from "@/lib/receptionist/membership";

// STUDIO-READY-02d (#824): who may reach /front-desk, run against the REAL
// middleware (lib/supabase/middleware.ts) with only the Supabase client mocked.
// The mock answers each table with the rows a scenario sets, and records which
// tables were read, so a practitioner is also proved to pay no extra query.

type Rows = Record<string, Array<Record<string, unknown>>>;
const state: { user: { id: string; email: string } | null; rows: Rows; reads: string[] } = {
  user: null,
  rows: {},
  reads: [],
};

function builder(table: string) {
  const result = () => Promise.resolve({ data: state.rows[table] ?? [], error: null });
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit", "order"]) b[m] = () => b;
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => result().then(ok, bad);
  return b;
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => {
      state.reads.push(table);
      return builder(table);
    },
  }),
}));

const { updateSession } = await import("@/lib/supabase/middleware");

const go = (path: string) => updateSession(new NextRequest(new URL(`https://app.test${path}`)));
const location = (r: Response) => {
  const l = r.headers.get("location");
  return l ? new URL(l).pathname : null;
};

beforeEach(() => {
  state.user = { id: "user-1", email: "person@example.test" };
  state.rows = {};
  state.reads = [];
});

describe("a receptionist-only user", () => {
  beforeEach(() => {
    state.rows = { practitioners: [], studio_receptionists: [{ studio_id: "studio-1" }] };
  });

  it("is admitted to /front-desk and its subpages", async () => {
    for (const p of ["/front-desk", "/front-desk/contacts"]) {
      expect(location(await go(p)), p).toBeNull();
    }
  });

  it("is sent to /front-desk from every practitioner route, never into the app", async () => {
    for (const p of [
      "/dashboard",
      "/clients",
      "/clients/abc",
      "/clients/abc/images",
      "/calendar",
      "/records",
      "/financials",
      "/settings/team",
      "/settings/data",
    ]) {
      expect(location(await go(p)), p).toBe("/front-desk");
    }
  });

  it("does not match a lookalike path", async () => {
    expect(location(await go("/front-desk-admin"))).toBe("/front-desk");
    expect(location(await go("/front-deskx/clients"))).toBe("/front-desk");
  });
});

describe("everyone else is unchanged", () => {
  it("a practitioner routes as before, and the receptionist table is never read", async () => {
    state.rows = { practitioners: [{ studio_id: "studio-1" }] };
    expect(location(await go("/dashboard"))).toBeNull();
    expect(state.reads).toEqual(["practitioners"]);
  });

  it("a user with no membership of either kind still goes to /no-access", async () => {
    state.rows = { practitioners: [], studio_receptionists: [] };
    expect(location(await go("/dashboard"))).toBe("/no-access");
    expect(location(await go("/front-desk"))).toBe("/no-access");
  });

  it("an anonymous visitor to /front-desk goes to /login", async () => {
    state.user = null;
    expect(location(await go("/front-desk"))).toBe("/login");
  });
});

describe("the receptionist membership resolver", () => {
  const a = { id: "r-a", studio_id: "s-a", display_name: "A" };
  const b = { id: "r-b", studio_id: "s-b", display_name: "B" };

  it("none, one, or a choice, honouring the cookie only for an own membership", () => {
    expect(resolveReceptionistMembership([], "s-a")).toEqual({ kind: "none" });
    expect(resolveReceptionistMembership([a], null)).toEqual({ kind: "one", value: a });
    expect(resolveReceptionistMembership([a, b], "s-b")).toEqual({ kind: "one", value: b });
    expect(resolveReceptionistMembership([a, b], null)).toEqual({ kind: "choose", studioIds: ["s-a", "s-b"] });
    // A forged or stale cookie never selects a studio.
    expect(resolveReceptionistMembership([a, b], "s-forged")).toEqual({ kind: "choose", studioIds: ["s-a", "s-b"] });
  });

  it("isFrontDeskPath matches the route and its children only", () => {
    expect(isFrontDeskPath("/front-desk")).toBe(true);
    expect(isFrontDeskPath("/front-desk/contacts")).toBe(true);
    expect(isFrontDeskPath("/front-desk-admin")).toBe(false);
    expect(isFrontDeskPath("/dashboard")).toBe(false);
  });
});
