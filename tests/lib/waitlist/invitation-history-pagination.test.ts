import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ pages: [] as Array<{ data: unknown; error: unknown }>, ranges: [] as Array<[number, number]>, orders: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q, in: () => q,
        order: (c: string) => { h.orders.push(c); return q; },
        range: (a: number, b: number) => { h.ranges.push([a, b]); return Promise.resolve(h.pages.shift() ?? { data: [], error: null }); },
      };
      return q;
    },
  }),
}));

const { loadInvitationHistory, HISTORY_PAGE, HISTORY_MAX_PAGES } = await import("@/lib/waitlist/invitation-history-server");

const E = "00000000-0000-4000-8000-0000000000e1";
const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `i${from + i}`, entry_id: E, issued_at: "2026-11-01T00:00:00Z", expires_at: "2026-11-03T00:00:00Z" }));

beforeEach(() => { h.pages = []; h.ranges = []; h.orders = []; });

describe("invitation history is read in full or not at all", () => {
  it("reads every page until a short one arrives, so more than 1,000 invitations are all counted", async () => {
    h.pages = [{ data: rows(HISTORY_PAGE), error: null }, { data: rows(HISTORY_PAGE, HISTORY_PAGE), error: null }, { data: rows(5, 2 * HISTORY_PAGE), error: null }];
    const r = await loadInvitationHistory("s1", [E]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.byEntry.get(E)).toHaveLength(2 * HISTORY_PAGE + 5);
    expect(h.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(h.orders).toEqual(["id", "id", "id"]);
  });
  it("one short page is one request", async () => {
    h.pages = [{ data: rows(3), error: null }];
    expect((await loadInvitationHistory("s1", [E])).kind).toBe("ok");
    expect(h.ranges).toHaveLength(1);
  });
  it("fails CLOSED at the page bound instead of presenting a truncated history as complete", async () => {
    h.pages = Array.from({ length: HISTORY_MAX_PAGES + 2 }, (_, p) => ({ data: rows(HISTORY_PAGE, p * HISTORY_PAGE), error: null }));
    expect((await loadInvitationHistory("s1", [E])).kind).toBe("unknown");
    expect(h.ranges).toHaveLength(HISTORY_MAX_PAGES);
  });
  it("a failed page anywhere makes the whole read unknown, never partial", async () => {
    h.pages = [{ data: rows(HISTORY_PAGE), error: null }, { data: null, error: { message: "x" } }];
    expect((await loadInvitationHistory("s1", [E])).kind).toBe("unknown");
  });
  it("no entries means no request", async () => {
    expect((await loadInvitationHistory("s1", [])).kind).toBe("ok");
    expect(h.ranges).toHaveLength(0);
  });
});
