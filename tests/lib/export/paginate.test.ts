import { describe, expect, it } from "vitest";
import {
  fetchAllRows,
  assertDeterministicOrder,
  EXPORT_PAGE_SIZE,
  type PageResult,
} from "@/lib/export/paginate";

// Complete studio exports (security review finding #4).
//
// PostgREST caps responses at max_rows (supabase/config.toml: 1000). The export
// issued unbounded selects, so a studio past 1000 rows in any table got a ZIP
// that was truncated, plausible, and labelled "export everything".
//
// These are BEHAVIOURAL tests against a fake page source that reproduces the
// server's cap: it never returns more than `pageSize` rows and it honours the
// requested range. If the helper stops paginating, these fail — that is proved
// by the negative control recorded in the PR, not assumed.

type Row = { id: string; name: string };

function makeRows(n: number, name: (i: number) => string = (i) => `row-${i}`): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    // Zero-padded so lexical id order matches insertion order.
    id: `id-${String(i).padStart(6, "0")}`,
    name: name(i),
  }));
}

/** A page source with PostgREST's clamp: a range wider than pageSize is cut. */
function pageSource(rows: Row[], pageSize = EXPORT_PAGE_SIZE) {
  let calls = 0;
  const factory = (from: number, to: number): PromiseLike<PageResult<Row>> => {
    calls++;
    const end = Math.min(to, from + pageSize - 1);
    return Promise.resolve({ data: rows.slice(from, end + 1), error: null });
  };
  return { factory, callCount: () => calls };
}

describe("E1 — a source larger than one page exports every row", () => {
  it("1001 rows: all 1001 are returned, not the first 1000", async () => {
    const rows = makeRows(1001);
    const { factory } = pageSource(rows);
    const { data, error } = await fetchAllRows(factory);
    expect(error).toBeNull();
    expect(data).toHaveLength(1001);
    expect(data![1000].id).toBe(rows[1000].id);
  });

  it("2500 rows across three pages", async () => {
    const { factory, callCount } = pageSource(makeRows(2500));
    const { data } = await fetchAllRows(factory);
    expect(data).toHaveLength(2500);
    expect(callCount()).toBe(3);
  });

  it("an exact multiple asks once more and stops on the empty page", async () => {
    // 2000 rows: page 0 and page 1 are both full, so "full page" cannot mean
    // "end of table". Off-by-one here silently drops the tail in the 1000/2000
    // case, which is exactly the size a real studio hits first.
    const { factory, callCount } = pageSource(makeRows(2000));
    const { data } = await fetchAllRows(factory);
    expect(data).toHaveLength(2000);
    expect(callCount()).toBe(3);
  });

  it("an empty table returns an empty array, never an error", async () => {
    const { data, error } = await fetchAllRows(pageSource([]).factory);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("E2 — pages do not overlap", () => {
  it("no duplicate ids across a multi-page read", async () => {
    const { data } = await fetchAllRows(pageSource(makeRows(3001)).factory);
    const ids = data!.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("E3 — a non-unique sort still paginates deterministically", () => {
  it("every row survives when the primary sort value repeats across the boundary", async () => {
    // Every row shares one `name`, so `order("name")` alone has no defined
    // order within the tie and a row can land on two pages or none. The `id`
    // tiebreak is what makes the read stable.
    const rows = makeRows(1500, () => "same-name");
    const { data } = await fetchAllRows(pageSource(rows).factory);
    expect(data).toHaveLength(1500);
    expect(new Set(data!.map((r) => r.id)).size).toBe(1500);
    expect(data!.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("the ordering contract rejects a read whose last sort column is not the tiebreak", () => {
    expect(() => assertDeterministicOrder("clients", ["name"])).toThrow(
      /final ordering column must be "id"/,
    );
    expect(() =>
      assertDeterministicOrder("clients", ["name", "id"]),
    ).not.toThrow();
  });
});

describe("E4 — a parent page boundary must not delete child rows", () => {
  // THE AMPLIFICATION. electrolysis_entries / laser_entries carry no studio_id;
  // the export filters them against the set of session ids it fetched. Truncate
  // sessions at 1000 and every child of session 1001+ vanishes from the ZIP as
  // well — clinical rows lost because a DIFFERENT table hit a page cap.
  const sessions = makeRows(1001);
  const lateSessionId = sessions[1000].id;
  const entries = [
    { id: "e-early", session_id: sessions[0].id },
    { id: "e-late", session_id: lateSessionId },
  ];
  const keepEntries = (sessionRows: Row[]) => {
    const active = new Set(sessionRows.map((s) => s.id));
    return entries.filter((e) => active.has(e.session_id));
  };

  it("paginated sessions keep the child row whose session is on page 2", async () => {
    const { data } = await fetchAllRows(pageSource(sessions).factory);
    expect(keepEntries(data!).map((e) => e.id)).toEqual(["e-early", "e-late"]);
  });

  it("NEGATIVE CONTROL: a truncated parent read silently drops that child", () => {
    // Reproduces the pre-fix behaviour. If this ever stops dropping the row,
    // the fixture no longer models the bug and E4 above proves nothing.
    const truncated = sessions.slice(0, EXPORT_PAGE_SIZE);
    expect(keepEntries(truncated).map((e) => e.id)).toEqual(["e-early"]);
  });
});

describe("E5 — a failed page fails the whole read", () => {
  it("an error on page 2 returns an error, never the first page as the table", async () => {
    const rows = makeRows(2500);
    const factory = (from: number, to: number): PromiseLike<PageResult<Row>> => {
      if (from > 0) {
        return Promise.resolve({
          data: null,
          error: { message: "connection reset" },
        });
      }
      return Promise.resolve({
        data: rows.slice(from, Math.min(to, from + EXPORT_PAGE_SIZE - 1) + 1),
        error: null,
      });
    };
    const { data, error } = await fetchAllRows(factory);
    expect(data).toBeNull();
    expect(error?.message).toBe("connection reset");
  });

  it("a runaway read refuses rather than returning a capped set", async () => {
    // Always-full pages: a source that never terminates. Better to fail loudly
    // than to hand back a silently bounded slice — the whole point of #4.
    const always = (): PromiseLike<PageResult<Row>> =>
      Promise.resolve({ data: makeRows(10), error: null });
    const { data, error } = await fetchAllRows(always, {
      pageSize: 10,
      maxPages: 3,
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/refusing to return a partial table/);
  });
});

describe("page size matches the server cap", () => {
  it("EXPORT_PAGE_SIZE equals supabase/config.toml max_rows", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = readFileSync("supabase/config.toml", "utf8");
    const m = cfg.match(/^max_rows\s*=\s*(\d+)/m);
    expect(m, "max_rows must be declared in supabase/config.toml").not.toBeNull();
    // A page larger than the server's cap is silently clamped, which would
    // make "a short page means the end" false and drop the tail.
    expect(EXPORT_PAGE_SIZE).toBeLessThanOrEqual(Number(m![1]));
  });
});
