import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string; studio_id: string; archived_at: string | null };
const state = vi.hoisted(() => ({
  rows: [] as Row[], cap: 1000, failAfter: Infinity,
  onRead: null as null | ((page: number) => void),
  ignoreCursor: false,
  requests: [] as Array<{ from: number; studio: unknown; archived: boolean; orders: string[]; cursor: string | null }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      let studio: unknown;
      let archived = false;
      let cursor: { key: keyof Row; value: string } | null = null;
      let from = 0;
      let to = Infinity;
      const orders: Array<{ key: keyof Row; ascending: boolean }> = [];
      const run = () => {
        const page = state.requests.length;
        state.onRead?.(page);
        state.requests.push({ from, studio, archived, orders: orders.map((o) => o.key), cursor: cursor?.value ?? null });
        if (page >= state.failAfter) return { data: null, error: { message: "synthetic private diagnostic" } };
        const rows = state.rows.filter((r) => r.studio_id === studio && (r.archived_at !== null) === archived
          && (state.ignoreCursor || cursor === null || String(r[cursor.key]) > cursor.value));
        rows.sort((a, b) => {
          for (const { key, ascending } of orders) {
            const x = String(a[key]); const y = String(b[key]);
            if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        return { data: rows.slice(from, Math.min(to + 1, from + state.cap)).map((row) => ({ ...row })), error: null };
      };
      const query = {
        select: () => query,
        eq: (_key: string, value: unknown) => { studio = value; return query; },
        gt: (key: keyof Row, value: string) => { cursor = { key, value }; return query; },
        is: () => { archived = false; return query; },
        not: () => { archived = true; return query; },
        order: (key: keyof Row, options: { ascending: boolean }) => { orders.push({ key, ...options }); return query; },
        range: (start: number, end: number) => { from = start; to = end; return query; },
        then: (resolve: (value: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return query;
    },
  }),
}));

import { getArchivedClientsForStudio, getClientsForStudio } from "@/lib/supabase/queries";

function seed(count: number, archived = false) {
  state.rows = Array.from({ length: count }, (_, i) => ({
    id: String(i).padStart(5, "0"), name: "Same name", studio_id: "A",
    archived_at: archived ? "2026-10-20T10:00:00Z" : null,
  })).reverse();
  state.rows.push({ id: "foreign", name: "Other", studio_id: "B", archived_at: archived ? "2026-10-20T10:00:00Z" : null });
  state.rows.push({ id: "opposite", name: "Other", studio_id: "A", archived_at: archived ? null : "2026-10-20T10:00:00Z" });
}

beforeEach(() => { state.rows = []; state.requests = []; state.cap = 1000; state.failAfter = Infinity; state.onRead = null; state.ignoreCursor = false; });

describe("DAT-001 complete studio-scoped client directories", () => {
  it.each([false, true])("loads beyond the API ceiling with deterministic ties (archived=%s)", async (archived) => {
    seed(1305, archived);
    const rows = await (archived ? getArchivedClientsForStudio("A") : getClientsForStudio("A"));
    expect(rows).toHaveLength(1305);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 1305 }, (_, i) => String(i).padStart(5, "0")));
    expect(state.requests.every((r) => r.studio === "A" && r.archived === archived && r.orders.includes("id"))).toBe(true);
  });

  it("does not mistake a smaller server cap for the end of the directory", async () => {
    seed(23); state.cap = 7;
    expect(await getClientsForStudio("A")).toHaveLength(23);
  });

  it("refuses a partial directory if a later page fails, without exposing row diagnostics", async () => {
    seed(1305); state.failAfter = 1;
    await expect(getClientsForStudio("A")).rejects.toThrow("Failed to load clients");
    await expect(getClientsForStudio("A")).rejects.not.toThrow("synthetic private diagnostic");
  });

  it("returns an actual empty directory without querying another studio", async () => {
    expect(await getClientsForStudio("A")).toEqual([]);
    expect(state.requests).toHaveLength(1);
  });
});


describe("#9814332907456 mutable directory membership and display order", () => {
  it.each(["archive", "delete", "rename"])("does not skip unread active clients when a prior-page client changes (%s)", async (change) => {
    seed(9); state.cap = 3;
    state.rows.filter((row) => row.studio_id === "A" && row.archived_at === null).forEach((row) => { row.name = `Name ${row.id}`; });
    state.onRead = (page) => {
      if (page !== 1) return;
      const prior = state.rows.find((row) => row.id === "00000")!;
      if (change === "archive") prior.archived_at = "2026-10-21T10:00:00Z";
      else if (change === "delete") state.rows = state.rows.filter((row) => row !== prior);
      else prior.name = "Z moved after the unread clients";
    };
    const rows = await getClientsForStudio("A");
    // Earlier response rows are snapshots, not a cross-request transaction;
    // the regression is losing an untouched unread client after that change.
    expect(rows.map((row) => row.id).sort()).toEqual(Array.from({ length: 9 }, (_, i) => String(i).padStart(5, "0")));
    expect(state.requests.every((q) => q.studio === "A" && !q.archived)).toBe(true);
  });

  it.each(["unarchive", "delete", "retime"])("does not skip unread archived clients when a prior-page client changes (%s)", async (change) => {
    seed(9, true); state.cap = 3;
    state.onRead = (page) => {
      if (page !== 1) return;
      const prior = state.rows.find((row) => row.id === "00000")!;
      if (change === "unarchive") prior.archived_at = null;
      else if (change === "delete") state.rows = state.rows.filter((row) => row !== prior);
      else prior.archived_at = "2020-01-01T00:00:00Z";
    };
    const rows = await getArchivedClientsForStudio("A");
    expect(rows.map((row) => row.id).sort()).toEqual(Array.from({ length: 9 }, (_, i) => String(i).padStart(5, "0")));
    expect(state.requests.every((q) => q.studio === "A" && q.archived)).toBe(true);
  });

  it("finds an unread client renamed before the old name-page position, then sorts names for display", async () => {
    seed(9); state.cap = 3;
    state.rows.filter((row) => row.studio_id === "A" && row.archived_at === null).forEach((row) => { row.name = `Name ${row.id}`; });
    state.onRead = (page) => { if (page === 1) state.rows.find((row) => row.id === "00007")!.name = "Ada renamed"; };
    const rows = await getClientsForStudio("A");
    expect(rows[0]).toMatchObject({ id: "00007", name: "Ada renamed" });
    expect(rows.map((row) => row.id)).toEqual(["00007", "00000", "00001", "00002", "00003", "00004", "00005", "00006", "00008"]);
  });

  it("keeps archive recency display order separate from immutable traversal order", async () => {
    seed(3, true); state.cap = 1;
    state.rows.find((row) => row.id === "00000")!.archived_at = "2025-01-01T00:00:00Z";
    state.rows.find((row) => row.id === "00001")!.archived_at = "2026-01-01T00:00:00Z";
    state.rows.find((row) => row.id === "00002")!.archived_at = "2026-01-01T00:00:00Z";
    expect((await getArchivedClientsForStudio("A")).map((row) => row.id)).toEqual(["00001", "00002", "00000"]);
  });

  it("refuses repeated pages rather than returning a partial directory when the server ignores progression", async () => {
    seed(9); state.cap = 3; state.ignoreCursor = true;
    await expect(getClientsForStudio("A")).rejects.toThrow("Failed to load clients");
  });
});
