import { beforeEach, describe, expect, it, vi } from "vitest";

// The desk guard refuses everyone who is not an ACTIVE receptionist of the studio. With the flag on, any signed-in user
// passes the middleware on /desk, so this is the real refusal. Removed and inactive receptionists, practitioners who are
// not receptionists, and strangers all reach it as "no active receptionist row".

const canceledRead = vi.hoisted(() => vi.fn());
class Redirected extends Error {}
const state: { user: { id: string } | null; rows: unknown[]; error: unknown; selected: string | null; queries: Array<[string, unknown]> } = { user: { id: "u1" }, rows: [], error: null, selected: null, queries: [] };

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Redirected("404"); },
  redirect: (to: string) => { throw new Redirected(to); },
}));
vi.mock("@/lib/supabase/selected-studio", () => ({ readSelectedStudioId: async () => state.selected }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: canceledRead,
    auth: { getUser: async () => ({ data: { user: state.user } }) },
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
  vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "false");
  canceledRead.mockReset();
  state.user = { id: "u1" };
  state.rows = [];
  state.error = null;
  state.selected = null;
  state.queries = [];
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
    expect(state.queries).toEqual([["from:studio_receptionists", null], ["user_id", "u1"], ["active", true]]);
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

  it("does not turn a cancelled studio's receptionist away from the desk: the database refuses only new work", async () => {
    vi.stubEnv("HONE_SELF_SERVE_CHECKOUT_ENABLED", "true");
    state.rows = [{ id: "r1", studio_id: "s1", display_name: "Desk" }];
    canceledRead.mockResolvedValue({ data: true });
    await expect(requireReceptionistWithStudio()).resolves.toMatchObject({ studioId: "s1" });
    expect(canceledRead).not.toHaveBeenCalledWith("my_hone_studio_canceled", expect.anything());
  });

  it("a failed membership read is loud, never read as no membership", async () => {
    state.error = { message: "boom" };
    expect(await where()).toBe("Failed to load receptionist membership");
  });
});
