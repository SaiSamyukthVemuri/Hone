import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HON-45 (Sam): show the TOTAL unfinished count and a paginated View all; never silently hide unfinished visits beyond the first
// 100. The fake below really applies eq / lte / is / order / range / count over an in-memory table, so these tests check the
// behaviour (totals, page coverage, studio scope), not just the shape of the query. Synthetic values only.

type Appt = {
  id: string; studio_id: string; status: string; client_id: string; starts_at: string; ends_at: string;
  client: { id: string; name: string; archived_at: string | null };
  sessions: Array<{ id: string; studio_id: string; deleted_at: string | null }>;
};
const h = vi.hoisted(() => ({ table: [] as unknown[], failRead: false, recs: [] as string[] }));

function get(row: Record<string, unknown>, path: string): unknown {
  const [head, ...rest] = path.split(".");
  const v = row[head];
  if (!rest.length) return v;
  const inner = Array.isArray(v) ? v : [v];
  return inner.map((x) => get(x as Record<string, unknown>, rest.join(".")));
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (t: string) => {
      h.recs.push(t);
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let range: [number, number] | null = null;
      let head = false;
      const q: Record<string, unknown> = {};
      q.select = (_c: string, o?: { count?: string; head?: boolean }) => { head = !!o?.head; return q; };
      q.eq = (c: string, v: unknown) => { filters.push((r) => [get(r, c)].flat().some((x) => x === v)); return q; };
      q.lte = (c: string, v: string) => { filters.push((r) => String(get(r, c)) <= v); return q; };
      q.is = (c: string, v: null) => { filters.push((r) => [get(r, c)].flat().some((x) => x === v)); return q; };
      q.order = (col: string, o: { ascending: boolean }) => { orders.push({ col, asc: o.ascending }); return q; };
      q.range = (a: number, b: number) => { range = [a, b]; return q; };
      q.then = (resolve: (v: unknown) => unknown) => {
        if (h.failRead) return resolve({ data: null, error: { message: "boom" }, count: null });
        let rows = (h.table as Array<Record<string, unknown>>).filter((r) => filters.every((f) => f(r)));
        const count = rows.length;
        rows = [...rows].sort((x, y) => {
          for (const o of orders) {
            const a = String(x[o.col]), b = String(y[o.col]);
            if (a !== b) return (a < b ? -1 : 1) * (o.asc ? 1 : -1);
          }
          return 0;
        });
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return resolve({ data: head ? null : rows, error: null, count });
      };
      return q;
    },
  }),
}));

import { countUnfinishedVisits, loadUnfinishedPage, parseUnfinishedPage, UNFINISHED_PAGE_SIZE } from "@/lib/dashboard/unfinished-visits";
import { UnfinishedVisitsNote, unfinishedTotalLabel } from "@/app/(app)/dashboard/unfinished-visits-note";

const NOW = "2026-11-18T12:00:00.000Z";
const mk = (i: number, over: Partial<Appt> = {}): Appt => ({
  id: `a${String(i).padStart(4, "0")}`,
  studio_id: "S1",
  status: "confirmed",
  client_id: `c${i}`,
  starts_at: "2026-09-01T10:00:00.000Z",
  // Several rows share an end time so the id tie-break is exercised.
  ends_at: `2026-09-${String(1 + (i % 20)).padStart(2, "0")}T11:00:00.000Z`,
  client: { id: `c${i}`, name: `Client ${i}`, archived_at: null },
  sessions: [{ id: `s${i}`, studio_id: "S1", deleted_at: null }],
  ...over,
});

beforeEach(() => { h.table = []; h.failRead = false; h.recs.length = 0; });

describe("the exact total", () => {
  it("counts beyond 100 (never capped), and the head count equals the list total", async () => {
    h.table = Array.from({ length: 130 }, (_, i) => mk(i));
    expect(await countUnfinishedVisits("S1", NOW)).toBe(130);
    expect((await loadUnfinishedPage("S1", NOW, 1)).total).toBe(130);
  });

  it("counts only what the Finish nudge means: confirmed, ended, live chart, active client", async () => {
    h.table = [
      mk(1),
      mk(2, { status: "completed" }),
      mk(3, { status: "cancelled" }),
      mk(4, { ends_at: "2026-11-19T11:00:00.000Z" }), // not ended yet
      mk(5, { sessions: [{ id: "s5", studio_id: "S1", deleted_at: "2026-10-01T00:00:00Z" }] }), // chart deleted
      mk(6, { client: { id: "c6", name: "X", archived_at: "2026-01-01T00:00:00Z" } }),
    ];
    expect(await countUnfinishedVisits("S1", NOW)).toBe(1);
  });

  it("another studio's visits are never counted or listed", async () => {
    h.table = [
      ...Array.from({ length: 30 }, (_, i) => mk(i)),
      ...Array.from({ length: 40 }, (_, i) => mk(1000 + i, { studio_id: "S2", sessions: [{ id: `x${i}`, studio_id: "S2", deleted_at: null }] })),
    ];
    expect(await countUnfinishedVisits("S1", NOW)).toBe(30);
    const ids: string[] = [];
    const first = await loadUnfinishedPage("S1", NOW, 1);
    for (let p = 1; p <= first.pageCount; p++) ids.push(...(await loadUnfinishedPage("S1", NOW, p)).rows.map((r) => r.appointmentId));
    expect(ids).toHaveLength(30);
    expect(ids.some((id) => Number(id.slice(1)) >= 1000)).toBe(false);
  });
});

describe("pagination", () => {
  it("the pages cover every row exactly once (no gaps, no duplicates), newest ended first with id as the tie-break", async () => {
    h.table = Array.from({ length: 130 }, (_, i) => mk(i)).reverse(); // stored in an unhelpful order
    const first = await loadUnfinishedPage("S1", NOW, 1);
    expect(first.pageCount).toBe(Math.ceil(130 / UNFINISHED_PAGE_SIZE));
    const all: Array<{ id: string; endsAt: string }> = [];
    for (let p = 1; p <= first.pageCount; p++) {
      const pg = await loadUnfinishedPage("S1", NOW, p);
      expect(pg.rows.length).toBe(p < first.pageCount ? UNFINISHED_PAGE_SIZE : 130 - UNFINISHED_PAGE_SIZE * (first.pageCount - 1));
      all.push(...pg.rows.map((r) => ({ id: r.appointmentId, endsAt: r.endsAt })));
    }
    expect(new Set(all.map((r) => r.id)).size).toBe(130);
    expect([...all.map((r) => r.id)].sort()).toEqual(Array.from({ length: 130 }, (_, i) => mk(i).id).sort());
    const expected = [...all].sort((a, b) => (a.endsAt === b.endsAt ? (a.id < b.id ? 1 : -1) : a.endsAt < b.endsAt ? 1 : -1));
    expect(all).toEqual(expected);
  });

  it("a page past the end is empty but still reports the exact total", async () => {
    h.table = Array.from({ length: 3 }, (_, i) => mk(i));
    const pg = await loadUnfinishedPage("S1", NOW, 9);
    expect(pg.rows).toEqual([]);
    expect(pg.total).toBe(3);
  });

  it("parses the page parameter safely", () => {
    expect([parseUnfinishedPage(undefined), parseUnfinishedPage("0"), parseUnfinishedPage("-3"), parseUnfinishedPage("abc"), parseUnfinishedPage("4"), parseUnfinishedPage(["2", "5"])]).toEqual([1, 1, 1, 1, 4, 2]);
  });
});

describe("a failed read refuses instead of showing nothing", () => {
  it("the list and the count throw a fixed message", async () => {
    h.failRead = true;
    await expect(loadUnfinishedPage("S1", NOW, 1)).rejects.toThrow(/^Failed to load unfinished visits$/);
    await expect(countUnfinishedVisits("S1", NOW)).rejects.toThrow(/^Failed to load unfinished visits$/);
  });

  it("the dashboard line says it could not check, never a zero or an empty line", async () => {
    h.failRead = true;
    const html = renderToStaticMarkup(await UnfinishedVisitsNote({ studioId: "S1", nowIso: NOW }));
    expect(html).toContain('data-testid="unfinished-total-unavailable"');
    expect(html).not.toContain("not finished");
  });
});

describe("the dashboard line", () => {
  it("shows the total and a View all link, and says the list below is only the most recent", async () => {
    h.table = Array.from({ length: 130 }, (_, i) => mk(i));
    const html = renderToStaticMarkup(await UnfinishedVisitsNote({ studioId: "S1", nowIso: NOW }));
    expect(html).toContain("130 visits not finished");
    expect(html).toContain('href="/dashboard/unfinished"');
    expect(html).toContain("View all");
    expect(html).toContain("most recent only");
  });

  it("says nothing when there is nothing to finish, and uses the singular for one", async () => {
    expect(await UnfinishedVisitsNote({ studioId: "S1", nowIso: NOW })).toBeNull();
    expect(unfinishedTotalLabel(1)).toBe("1 visit not finished");
    expect(unfinishedTotalLabel(12)).toBe("12 visits not finished");
  });
});
