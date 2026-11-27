import { beforeEach, describe, expect, it, vi } from "vitest";

// The desk guard refuses everyone who is not an ACTIVE receptionist of the studio. With the flag on, any signed-in user
// passes the middleware on /desk, so this is the real refusal. Removed and inactive receptionists, practitioners who are
// not receptionists, and strangers all reach it as "no active receptionist row".

class Redirected extends Error {}
const state: { user: { id: string } | null; rows: unknown[]; error: unknown; selected: string | null; queries: Array<[string, unknown]>; allowed: string[] | "all"; accessError: unknown } = { user: { id: "u1" }, rows: [], error: null, selected: null, queries: [], allowed: "all", accessError: null };

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Redirected("404"); },
  redirect: (to: string) => { throw new Redirected(to); },
}));
vi.mock("@/lib/supabase/selected-studio", () => ({ readSelectedStudioId: async () => state.selected }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    // front_desk_access() (0390): the studios whose Front Desk is on and where the caller holds a seat.
    rpc: async (fn: string) => {
      state.queries.push([`rpc:${fn}`, null]);
      if (state.accessError) return { data: null, error: state.accessError };
      return { data: state.allowed === "all" ? (state.rows as { studio_id: string }[]).map((r) => r.studio_id) : state.allowed, error: null };
    },
    from: (t: string) => {
      state.queries.push([`from:${t}`, null]);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { state.queries.push([c, v]); return q; };
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: state.rows, error: state.error }).then(res);
      return q;
    },
  }),
}));

import { requireReceptionistWithStudio } from "@/lib/desk/guard";

const where = async () => (await requireReceptionistWithStudio().then(() => "ok", (e: Error) => e.message));
beforeEach(() => {
  state.user = { id: "u1" };
  state.rows = [];
  state.error = null;
  state.selected = null;
  state.queries = [];
  state.allowed = "all";
  state.accessError = null;
  vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
});

describe("requireReceptionistWithStudio", () => {
  it("flag off: the desk does not exist (404), and nothing is read", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    expect(await where()).toBe("404");
    expect(state.queries).toEqual([]);
  });

  it("anonymous goes to login", async () => {
    state.user = null;
    expect(await where()).toBe("/login");
  });

  it("asks only for the signed-in user's own ACTIVE receptionist rows", async () => {
    state.rows = [{ id: "r1", studio_id: "s1", display_name: "Desk" }];
    await requireReceptionistWithStudio();
    expect(state.queries).toEqual([["from:studio_receptionists", null], ["user_id", "u1"], ["active", true], ["rpc:front_desk_access", null]]);
  });

  it("refuses a user with no active receptionist row (removed, inactive, practitioner only, stranger) to /no-access", async () => {
    state.rows = [];
    expect(await where()).toBe("/no-access");
  });

  it("one active row resolves to that studio", async () => {
    state.rows = [{ id: "r1", studio_id: "s1", display_name: "Desk" }];
    await expect(requireReceptionistWithStudio()).resolves.toEqual({ studioId: "s1", receptionistId: "r1", displayName: "Desk" });
  });

  it("two studios and no valid selection goes to the chooser, never auto-picked", async () => {
    state.rows = [{ id: "r1", studio_id: "s1", display_name: "A" }, { id: "r2", studio_id: "s2", display_name: "B" }];
    expect(await where()).toBe("/desk/choose");
    state.selected = "s3-held-only-as-practitioner";
    expect(await where()).toBe("/desk/choose");
  });

  it("two studios and a selection naming one of them resolves to it", async () => {
    state.rows = [{ id: "r1", studio_id: "s1", display_name: "A" }, { id: "r2", studio_id: "s2", display_name: "B" }];
    state.selected = "s2";
    await expect(requireReceptionistWithStudio()).resolves.toMatchObject({ studioId: "s2", receptionistId: "r2" });
  });

  it("a failed membership read is loud, never read as no membership", async () => {
    state.error = { message: "boom" };
    expect(await where()).toBe("Failed to load receptionist membership");
  });
});

describe("the per-studio Front Desk gate (0390)", () => {
  it("a studio whose Front Desk is off, or where the receptionist holds no seat, is as good as absent: /no-access", async () => {
    state.rows = [{ id: "r1", studio_id: "s1", display_name: "Desk" }];
    state.allowed = [];
    expect(await where()).toBe("/no-access");
  });

  it("a revoked or expired seat in one of two studios leaves the other: the guard resolves it with no chooser", async () => {
    state.rows = [
      { id: "r1", studio_id: "s1", display_name: "A" },
      { id: "r2", studio_id: "s2", display_name: "B" },
    ];
    state.allowed = ["s2"];
    const identity = await requireReceptionistWithStudio();
    expect(identity.studioId).toBe("s2");
  });

  it("a selected-studio cookie naming a studio the receptionist no longer has a seat in is never trusted", async () => {
    state.rows = [
      { id: "r1", studio_id: "s1", display_name: "A" },
      { id: "r2", studio_id: "s2", display_name: "B" },
    ];
    state.allowed = ["s1"];
    state.selected = "s2";
    const identity = await requireReceptionistWithStudio();
    expect(identity.studioId).toBe("s1");
  });

  it("a failed access read is loud: it never becomes an empty desk and never an open one", async () => {
    state.rows = [{ id: "r1", studio_id: "s1", display_name: "Desk" }];
    state.accessError = { message: "x" };
    expect(await where()).toBe("Failed to load front desk access");
  });

  it("flag off: nothing is read at all, including the access function", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    expect(await where()).toBe("404");
    expect(state.queries).toEqual([]);
  });
});
