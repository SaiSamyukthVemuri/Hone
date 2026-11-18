import { describe, expect, it, vi } from "vitest";
import {
  LAST_VISIT_FILTER_LABEL,
  lastVisitIsAtLeastMonthsAgo,
  lastVisitMatcher,
  notSeenCutoffDate,
  parseLastVisitFilter,
  studioLocalDate,
} from "@/lib/clients/last-visit-filter";
import { WHOLE_MAX_BLOCKS, readAllLastVisits, type LastVisitSupabase } from "@/lib/clients/last-visit";
import {
  directoryHref,
  parseDirectoryParams,
  queryDirectory,
  type DirectoryAggregates,
} from "@/lib/clients/directory-query";
import { projectStaffRow } from "@/lib/clients/directory-rules";

// The last-visit SORT and the "not seen in N months" FILTER on the clients directory. Synthetic data only.
// The rule under test: a visit is a live non-void session or a COMPLETED appointment, neither in the future;
// everything else is not evidence, and missing evidence is "No recorded visit", never "overdue".

const NOW = "2026-11-18T12:00:00Z";
const TZ = "America/New_York";

// ---------------------------------------------------------------------------------------------------------
// 1. Calendar months in the studio's timezone.
describe("not seen in N months: calendar months in the studio's timezone", () => {
  it("cutoff is today's studio date minus N calendar months", () => {
    expect(notSeenCutoffDate(NOW, 3, TZ)).toBe("2026-08-18");
    expect(notSeenCutoffDate(NOW, 6, TZ)).toBe("2026-05-18");
    expect(notSeenCutoffDate(NOW, 12, TZ)).toBe("2025-11-18");
  });
  it("clamps the day to the shorter month, including a leap year", () => {
    expect(notSeenCutoffDate("2026-08-31T12:00:00Z", 6, "UTC")).toBe("2026-02-28");
    expect(notSeenCutoffDate("2028-08-31T12:00:00Z", 6, "UTC")).toBe("2028-02-29");
    expect(notSeenCutoffDate("2026-03-31T12:00:00Z", 1, "UTC")).toBe("2026-02-28");
  });
  it("crosses a year boundary", () => {
    expect(notSeenCutoffDate("2026-02-10T12:00:00Z", 3, "UTC")).toBe("2025-11-10");
  });
  it("the boundary day counts as N months ago; the next day does not", () => {
    expect(lastVisitIsAtLeastMonthsAgo("2026-05-18T15:00:00Z", 6, NOW, TZ)).toBe(true);
    expect(lastVisitIsAtLeastMonthsAgo("2026-05-19T15:00:00Z", 6, NOW, TZ)).toBe(false);
    expect(lastVisitIsAtLeastMonthsAgo("2026-05-17T15:00:00Z", 6, NOW, TZ)).toBe(true);
  });
  it("the studio's calendar decides, not UTC: 23:30 on the 18th in New York is the 19th in UTC", () => {
    // 2026-05-19T03:30Z is 2026-05-18 23:30 in New York (UTC-4): on the cutoff day there.
    expect(lastVisitIsAtLeastMonthsAgo("2026-05-19T03:30:00Z", 6, NOW, "America/New_York")).toBe(true);
    expect(lastVisitIsAtLeastMonthsAgo("2026-05-19T03:30:00Z", 6, NOW, "UTC")).toBe(false);
    expect(studioLocalDate("2026-05-19T03:30:00Z", "America/New_York")).toBe("2026-05-18");
  });
  it("an unusable instant or timezone never throws and never reads as 'unseen'", () => {
    expect(lastVisitIsAtLeastMonthsAgo("not a date", 6, NOW, TZ)).toBe(false);
    expect(studioLocalDate("2026-05-18T12:00:00Z", "Not/AZone")).toBe("2026-05-18");
  });
  it("parses only the known choices; anything else applies nothing", () => {
    expect(["3", "6", "12", "none"].map((v) => parseLastVisitFilter(v))).toEqual(["3", "6", "12", "none"]);
    expect(parseLastVisitFilter("9")).toBe("any");
    expect(parseLastVisitFilter(undefined)).toBe("any");
    expect(parseLastVisitFilter(["6", "3"])).toBe("6");
  });
  it("the bucket for missing evidence is labelled apart from the date buckets", () => {
    expect(LAST_VISIT_FILTER_LABEL.none).toBe("No recorded visit");
    expect(Object.values(LAST_VISIT_FILTER_LABEL).filter((l) => /not seen/i.test(l))).toHaveLength(3);
    expect(LAST_VISIT_FILTER_LABEL.none).not.toMatch(/overdue|not seen|never/i);
  });
});

describe("one matcher per request gives the same answer as the per-client function, and builds one formatter", () => {
  const nows = ["2026-11-18T12:00:00Z", "2026-08-31T12:00:00Z", "2028-08-31T12:00:00Z", "2026-03-31T12:00:00Z", "2026-02-10T04:30:00Z", "2026-01-01T00:30:00Z"];
  const zones = ["America/New_York", "UTC", "Pacific/Auckland", "Not/AZone"];
  const offsets = [-400, -190, -181, -180, -179, -1, 0, 1, 30, 200];
  it("equals lastVisitIsAtLeastMonthsAgo across month ends, a leap year, year boundaries and timezones", () => {
    let checked = 0;
    for (const now of nows) for (const tz of zones) for (const months of [3, 6, 12]) {
      const match = lastVisitMatcher(months, now, tz);
      for (const days of offsets) {
        const visit = new Date(Date.parse(now) + days * 86_400_000 + 5 * 3_600_000).toISOString();
        expect(match(visit)).toBe(lastVisitIsAtLeastMonthsAgo(visit, months, now, tz));
        checked += 1;
      }
      expect(match("not a date")).toBe(false);
    }
    expect(checked).toBe(nows.length * zones.length * 3 * offsets.length);
  });
  it("keeps the boundary: the cutoff day counts, the next day does not", () => {
    const match = lastVisitMatcher(6, NOW, TZ);
    expect(match("2026-05-18T15:00:00Z")).toBe(true);
    expect(match("2026-05-19T15:00:00Z")).toBe(false);
  });
  it("filtering many clients builds ONE date formatter, not one per client", () => {
    const many = Array.from({ length: 2000 }, (_, i) => src(`k${i}`, `Client ${String(i).padStart(4, "0")}`));
    const map = new Map(many.map((r, i) => [r.id, new Date(Date.parse(NOW) - (i + 1) * 86_400_000).toISOString()]));
    const Real = Intl.DateTimeFormat;
    let built = 0;
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built += 1;
      return new Real(...args);
    } as never);
    try {
      const p = queryDirectory(many, agg(map), P({ lastVisit: "3" }), clock);
      expect(p.total).toBeGreaterThan(0);
      expect(built).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. The directory query: filter, bucket, sort, unavailable.
const src = (id: string, name: string) =>
  projectStaffRow({ id, name, preferred_name: null, pronouns: null, email: null, phone: null, archived_at: null });
const rows = [src("a", "Ada"), src("b", "Bea"), src("c", "Cy"), src("d", "Di"), src("e", "Eli")];
const visits = new Map([
  ["a", "2026-11-01T10:00:00Z"], // 17 days ago
  ["b", "2026-07-01T10:00:00Z"], // ~4.5 months ago
  ["c", "2026-01-15T10:00:00Z"], // ~10 months ago
  ["d", "2025-06-01T10:00:00Z"], // ~17 months ago
  // "e": no recorded visit
]);
const agg = (lastVisits: ReadonlyMap<string, string> | null | undefined): DirectoryAggregates => ({
  nextAppointments: new Map(),
  intake: new Map(),
  lastVisits,
});
const P = (over: Partial<ReturnType<typeof parseDirectoryParams>> = {}) => ({ ...parseDirectoryParams({}), ...over });
const clock = { nowIso: NOW, timeZone: TZ };
const ids = (p: { rows: { id: string }[] }) => p.rows.map((r) => r.id);

describe("the last-visit filter and sort over the directory", () => {
  it("N months lists only clients WITH a recorded visit that long ago; the no-evidence client is never in it", () => {
    expect(ids(queryDirectory(rows, agg(visits), P({ lastVisit: "3" }), clock)).sort()).toEqual(["b", "c", "d"]);
    expect(ids(queryDirectory(rows, agg(visits), P({ lastVisit: "6" }), clock)).sort()).toEqual(["c", "d"]);
    expect(ids(queryDirectory(rows, agg(visits), P({ lastVisit: "12" }), clock)).sort()).toEqual(["d"]);
  });
  it("'No recorded visit' lists exactly the clients with no evidence, on its own", () => {
    const p = queryDirectory(rows, agg(visits), P({ lastVisit: "none" }), clock);
    expect(ids(p)).toEqual(["e"]);
    expect(p.total).toBe(1);
  });
  it("the date buckets and the no-evidence bucket never overlap, and together with 'recent' they cover everyone", () => {
    const seen = new Set<string>();
    for (const f of ["3", "none"] as const) for (const id of ids(queryDirectory(rows, agg(visits), P({ lastVisit: f }), clock))) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect([...seen].sort()).toEqual(["b", "c", "d", "e"]); // "a" was seen 17 days ago
  });
  it("composes with search and the other filters (the count describes the set shown)", () => {
    const p = queryDirectory(rows, agg(visits), P({ lastVisit: "3", q: "c" }), clock);
    expect(ids(p)).toEqual(["c"]);
    expect(p.total).toBe(1);
  });
  it("sort: longest ago first; a client with no recorded visit follows everyone who has one, not 'oldest'", () => {
    const p = queryDirectory(rows, agg(visits), P({ sort: "lastvisit" }), clock);
    expect(ids(p)).toEqual(["d", "c", "b", "a", "e"]);
  });
  it("a tie on the same instant breaks by name, then id", () => {
    const tied = new Map([["a", "2026-01-01T00:00:00Z"], ["b", "2026-01-01T00:00:00Z"]]);
    expect(ids(queryDirectory(rows.slice(0, 2), agg(tied), P({ sort: "lastvisit" }), clock))).toEqual(["a", "b"]);
  });
  it("UNAVAILABLE data blocks the filter (no rows, flagged) instead of answering from nothing", () => {
    for (const lastVisits of [null, undefined]) {
      for (const f of ["3", "none"] as const) {
        const p = queryDirectory(rows, agg(lastVisits), P({ lastVisit: f }), clock);
        expect(p.lastVisitBlocked).toBe(true);
        expect(p.rows).toEqual([]);
      }
    }
  });
  it("UNAVAILABLE data degrades the sort to name and says so, and never blocks the list", () => {
    const p = queryDirectory(rows, agg(null), P({ sort: "lastvisit" }), clock);
    expect(p.lastVisitUnavailable).toBe(true);
    expect(p.lastVisitBlocked).toBe(false);
    expect(ids(p)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("a plain list needs and reports nothing about visits", () => {
    const p = queryDirectory(rows, agg(undefined), P(), clock);
    expect(p.lastVisitUnavailable).toBe(false);
    expect(p.lastVisitBlocked).toBe(false);
    expect(p.total).toBe(5);
  });
  it("the archived view ignores the filter and the sort", () => {
    const sp = { lastvisit: "6", sort: "lastvisit" };
    const q = parseDirectoryParams(sp, "archived");
    expect(q.lastVisit).toBe("any");
    expect(q.sort).toBe("archived");
    const a = parseDirectoryParams(sp, "active");
    expect(a.lastVisit).toBe("6");
    expect(a.sort).toBe("lastvisit");
  });
  it("the URL carries the state and round-trips", () => {
    const href = directoryHref({ view: "active", sort: "lastvisit", lastVisit: "6", q: "x" });
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseDirectoryParams(sp)).toMatchObject({ sort: "lastvisit", lastVisit: "6", q: "x" });
    expect(directoryHref({ view: "active", lastVisit: "any" })).toBe("/clients");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. The evidence definition, through the real whole-studio read, over synthetic rows.
type Row = Record<string, string | null>;
function store(tables: Record<string, Row[]>, opts: { failTable?: string } = {}): LastVisitSupabase {
  return {
    from: (t: string) => ({
      select: () => {
        let rowsNow = [...(tables[t] ?? [])];
        const b = {
          eq: (c: string, v: string) => ((rowsNow = rowsNow.filter((r) => r[c] === v)), b),
          neq: (c: string, v: string) => ((rowsNow = rowsNow.filter((r) => r[c] !== null && r[c] !== v)), b),
          lte: (c: string, v: string) => ((rowsNow = rowsNow.filter((r) => (r[c] as string) <= v)), b),
          gte: (c: string, v: string) => ((rowsNow = rowsNow.filter((r) => (r[c] as string) >= v)), b),
          lt: (c: string, v: string) => ((rowsNow = rowsNow.filter((r) => (r[c] as string) < v)), b),
          is: (c: string) => ((rowsNow = rowsNow.filter((r) => r[c] === null || r[c] === undefined)), b),
          in: (c: string, v: string[]) => ((rowsNow = rowsNow.filter((r) => v.includes(r[c] as string))), b),
          order: () => b,
          range: (from: number, to: number) =>
            Promise.resolve(
              opts.failTable === t
                ? { data: null, error: { message: "boom" } }
                : { data: rowsNow.slice(from, to + 1) as Record<string, string>[], error: null },
            ),
        };
        return b as never;
      },
    }),
  };
}

describe("what counts as a visit (readAllLastVisits, synthetic rows)", () => {
  const S = "studio-1";
  const sess = (client_id: string, started_at: string, record_status = "complete", deleted_at: string | null = null): Row =>
    ({ studio_id: S, client_id, started_at, record_status, deleted_at });
  const appt = (client_id: string, starts_at: string, status: string): Row => ({ studio_id: S, client_id, starts_at, status });

  it("a COMPLETED past appointment counts; a past appointment left 'confirmed' does not", async () => {
    const r = await readAllLastVisits(
      store({ sessions: [], appointments: [appt("done", "2026-06-01T10:00:00Z", "completed"), appt("left-confirmed", "2026-06-01T10:00:00Z", "confirmed")] }),
      S,
      NOW,
    );
    expect(r).toEqual({ ok: true, value: new Map([["done", "2026-06-01T10:00:00Z"]]) });
  });
  it("a cancelled or no-show appointment does not count", async () => {
    const r = await readAllLastVisits(
      store({ sessions: [], appointments: [appt("c", "2026-06-01T10:00:00Z", "cancelled"), appt("n", "2026-06-01T10:00:00Z", "no-show")] }),
      S,
      NOW,
    );
    expect(r).toEqual({ ok: true, value: new Map() });
  });
  it("a VOID session does not count; a deleted session does not count; a charted session does", async () => {
    const r = await readAllLastVisits(
      store({
        sessions: [sess("void", "2026-06-01T10:00:00Z", "void"), sess("gone", "2026-06-01T10:00:00Z", "complete", "2026-07-01T00:00:00Z"), sess("charted", "2026-06-02T10:00:00Z")],
        appointments: [],
      }),
      S,
      NOW,
    );
    expect(r).toEqual({ ok: true, value: new Map([["charted", "2026-06-02T10:00:00Z"]]) });
  });
  it("a FUTURE appointment or session is not a visit", async () => {
    const r = await readAllLastVisits(
      store({ sessions: [sess("fs", "2027-01-01T10:00:00Z")], appointments: [appt("fa", "2027-01-01T10:00:00Z", "completed")] }),
      S,
      NOW,
    );
    expect(r).toEqual({ ok: true, value: new Map() });
  });
  it("a client with no evidence at all is simply absent (shown as 'No recorded visit')", async () => {
    const r = await readAllLastVisits(store({ sessions: [], appointments: [] }), S, NOW);
    expect(r).toEqual({ ok: true, value: new Map() });
  });
  it("the later of the two sources wins", async () => {
    const r = await readAllLastVisits(
      store({ sessions: [sess("x", "2026-03-01T10:00:00Z")], appointments: [appt("x", "2026-05-01T10:00:00Z", "completed")] }),
      S,
      NOW,
    );
    expect((r as { value: Map<string, string> }).value.get("x")).toBe("2026-05-01T10:00:00Z");
  });
  it("another studio's rows are never read", async () => {
    const r = await readAllLastVisits(store({ sessions: [{ ...sess("x", "2026-03-01T10:00:00Z"), studio_id: "studio-2" }], appointments: [] }), S, NOW);
    expect(r).toEqual({ ok: true, value: new Map() });
  });
  it("end to end: synthetic evidence through the filter puts each client in the right bucket", async () => {
    const r = await readAllLastVisits(
      store({
        sessions: [sess("void-only", "2026-01-10T10:00:00Z", "void")],
        appointments: [
          appt("confirmed-only", "2026-01-10T10:00:00Z", "confirmed"),
          appt("future-only", "2027-02-01T10:00:00Z", "confirmed"),
          appt("old-done", "2026-01-10T10:00:00Z", "completed"),
          appt("recent-done", "2026-11-10T10:00:00Z", "completed"),
        ],
      }),
      S,
      NOW,
    );
    const map = (r as { value: Map<string, string> }).value;
    const clients = ["void-only", "confirmed-only", "future-only", "old-done", "recent-done", "nothing"].map((id) => src(id, id));
    const run = (f: "3" | "none") => ids(queryDirectory(clients, agg(map), P({ lastVisit: f }), clock)).sort();
    // Not seen in 3+ months: only the one with a COMPLETED visit that long ago.
    expect(run("3")).toEqual(["old-done"]);
    // No recorded visit: void, merely-confirmed, future-only and nothing at all. None of them is "overdue".
    expect(run("none")).toEqual(["confirmed-only", "future-only", "nothing", "void-only"]);
  });
  it("a failed read of either source is unavailable, never 'no visit'", async () => {
    for (const failTable of ["sessions", "appointments"]) {
      expect(await readAllLastVisits(store({ sessions: [], appointments: [] }, { failTable }), S, NOW)).toEqual({ ok: false });
    }
  });
  it("more rows than the whole-studio bound is unavailable, never a partial answer", async () => {
    const many = Array.from({ length: WHOLE_MAX_BLOCKS * 1000 }, (_, i) => appt(`c${i}`, "2026-06-01T10:00:00Z", "completed"));
    expect(await readAllLastVisits(store({ sessions: [], appointments: many }), S, NOW)).toEqual({ ok: false });
  });
  it("reads no client-id list (a studio-sized in(...) is unsafe) and no clinical content", async () => {
    const seen: string[] = [];
    const base = store({ sessions: [], appointments: [] });
    const spy: LastVisitSupabase = {
      from: (t) => ({
        select: (cols) => {
          seen.push(`${t}:${cols}`);
          return base.from(t).select(cols);
        },
      }),
    };
    await readAllLastVisits(spy, S, NOW);
    expect(seen.sort()).toEqual(["appointments:client_id, starts_at", "sessions:client_id, started_at"]);
  });
});
