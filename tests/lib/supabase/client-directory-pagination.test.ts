import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string; studio_id: string; archived_at: string | null };
const state = vi.hoisted(() => ({
  rows: [] as Row[], cap: 1000, failAfter: Infinity,
  requests: [] as Array<{ from: number; studio: unknown; archived: boolean; orders: string[] }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      let studio: unknown;
      let archived = false;
      let from = 0;
      let to = Infinity;
      const orders: Array<{ key: keyof Row; ascending: boolean }> = [];
      const run = () => {
        state.requests.push({ from, studio, archived, orders: orders.map((o) => o.key) });
        if (from >= state.failAfter) return { data: null, error: { message: "synthetic private diagnostic" } };
        const rows = state.rows.filter((r) => r.studio_id === studio && (r.archived_at !== null) === archived);
        rows.sort((a, b) => {
          for (const { key, ascending } of orders) {
            const x = String(a[key]); const y = String(b[key]);
            if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        return { data: rows.slice(from, Math.min(to + 1, from + state.cap)), error: null };
      };
      const query = {
        select: () => query,
        eq: (_key: string, value: unknown) => { studio = value; return query; },
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

beforeEach(() => { state.rows = []; state.requests = []; state.cap = 1000; state.failAfter = Infinity; });

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
