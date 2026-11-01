import { describe, expect, it } from "vitest";
import {
  DIRECTORY_PAGE_SIZE,
  directoryHref,
  parseDirectoryParams,
  queryDirectory,
  type DirectoryAggregates,
} from "@/lib/clients/directory-query";
import { projectStaffRow, type DirectorySourceClient } from "@/lib/clients/directory-rules";

// Privacy S4 (sort by shown name, ties by id), S5 (count == searched set).
const src = (id: string, name: string, preferred: string | null = null, over: Partial<DirectorySourceClient> = {}) =>
  projectStaffRow({ id, name, preferred_name: preferred, pronouns: null, email: null, phone: null, archived_at: null, ...over });
const agg = (next: Record<string, string> | null, intake: Record<string, "in_progress" | "submitted" | "reviewed"> | null): DirectoryAggregates => ({
  nextAppointments: next === null ? null : new Map(Object.entries(next)),
  intake: intake === null ? null : new Map(Object.entries(intake)),
});
const P = (over: Partial<ReturnType<typeof parseDirectoryParams>> = {}) => ({ ...parseDirectoryParams({}), ...over });

describe("directory sort (S4)", () => {
  it("sorts by the DISPLAYED name, not the stored name (control: opposite orders)", () => {
    // Stored order: Alpha < Zulu.  Displayed order: "Bea" < "Yan".
    const rows = [src("1", "Alpha Stored", "Yan"), src("2", "Zulu Stored", "Bea")];
    const stored = [...rows].sort((a, b) => ("Alpha Stored" === (a.id === "1" ? "Alpha Stored" : "Zulu Stored") ? -1 : 1));
    expect(stored.map((r) => r.id)).toEqual(["1", "2"]); // the control: the stored order is the opposite
    const page = queryDirectory(rows, agg({}, {}), P());
    expect(page.rows.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("breaks name ties by id and folds case and accents", () => {
    const rows = [src("b", "Émile"), src("a", "emile"), src("c", "Zed")];
    expect(queryDirectory(rows, agg({}, {}), P()).rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("next-appointment sort: earliest first, none last, ties by displayed name then id", () => {
    const rows = [src("1", "Cy"), src("2", "Ann"), src("3", "Bo"), src("4", "Di")];
    const page = queryDirectory(rows, agg({ "1": "2030-01-02T10:00:00Z", "2": "2030-01-02T10:00:00Z", "3": "2030-01-01T10:00:00Z" }, {}), P({ sort: "next" }));
    expect(page.rows.map((r) => r.id)).toEqual(["3", "2", "1", "4"]);
  });

  it("archived default is most recently archived first", () => {
    const rows = [src("1", "A", null, { archived_at: "2030-01-01T00:00:00Z" }), src("2", "B", null, { archived_at: "2030-02-01T00:00:00Z" })];
    const p = parseDirectoryParams({}, "archived");
    expect(p.sort).toBe("archived");
    expect(queryDirectory(rows, agg({}, {}), p).rows.map((r) => r.id)).toEqual(["2", "1"]);
  });
});

describe("count, filters and paging cover exactly the searched set (S5)", () => {
  const many = Array.from({ length: 60 }, (_, i) => src(String(1000 + i), `Client ${String(i).padStart(2, "0")}`));

  it("total is the whole set; a page is a slice of it; pages do not overlap or lose rows", () => {
    const seen: string[] = [];
    const first = queryDirectory(many, agg({}, {}), P());
    expect(first.total).toBe(60);
    expect(first.pageCount).toBe(Math.ceil(60 / DIRECTORY_PAGE_SIZE));
    expect(first.firstIndex).toBe(1);
    for (let n = 1; n <= first.pageCount; n += 1) seen.push(...queryDirectory(many, agg({}, {}), P({ page: n })).rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(60);
    expect(seen).toHaveLength(60);
  });

  it("a page past the end clamps to the last page", () => {
    const p = queryDirectory(many, agg({}, {}), P({ page: 999 }));
    expect(p.page).toBe(p.pageCount);
    expect(p.rows.length).toBeGreaterThan(0);
  });

  it("search narrows the count itself, over rows beyond the first page", () => {
    const p = queryDirectory(many, agg({}, {}), P({ q: "client 59" }));
    expect(p.total).toBe(1);
    expect(p.rows[0].id).toBe("1059");
  });

  it("a query that matches nothing says no matches, not an empty directory; an empty directory says that", () => {
    const none = queryDirectory(many, agg({}, {}), P({ q: "zzzzzz" }));
    expect(none).toMatchObject({ total: 0, directoryEmpty: false });
    expect(queryDirectory([], agg({}, {}), P())).toMatchObject({ total: 0, directoryEmpty: true });
  });

  it("filters: awaiting review, and no upcoming appointment; search and filters combine", () => {
    const rows = [src("1", "Ann"), src("2", "Bea"), src("3", "Cat")];
    const a = agg({ "1": "2030-01-01T00:00:00Z" }, { "2": "submitted", "3": "reviewed", "1": "submitted" });
    expect(queryDirectory(rows, a, P({ filters: ["intake_review"] })).rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(queryDirectory(rows, a, P({ filters: ["no_upcoming"] })).rows.map((r) => r.id)).toEqual(["2", "3"]);
    expect(queryDirectory(rows, a, P({ filters: ["intake_review", "no_upcoming"], q: "bea" })).rows.map((r) => r.id)).toEqual(["2"]);
  });
});

describe("missing data is never a claim", () => {
  const rows = [src("1", "Ann")];
  it("an unavailable aggregate yields the unavailable state, never Reviewed or No upcoming", () => {
    const p = queryDirectory(rows, agg(null, null), P());
    expect(p.rows[0].next).toEqual({ state: "unavailable" });
    expect(p.rows[0].intake).toBe("unavailable");
    expect(p).toMatchObject({ nextUnavailable: true, intakeUnavailable: true });
  });
  it("a filter on unavailable data is blocked with no rows, not silently ignored", () => {
    const p = queryDirectory(rows, agg(null, {}), P({ filters: ["no_upcoming"] }));
    expect(p.blockedFilters).toEqual(["no_upcoming"]);
    expect(p.rows).toEqual([]);
    expect(queryDirectory(rows, agg({}, null), P({ filters: ["intake_review"] })).blockedFilters).toEqual(["intake_review"]);
  });
  it("the next sort over unavailable data is reported degraded, and falls back to name order", () => {
    const p = queryDirectory([src("2", "Zed"), src("1", "Ann")], agg(null, {}), P({ sort: "next" }));
    expect(p.sortDegraded).toBe(true);
    expect(p.rows.map((r) => r.id)).toEqual(["1", "2"]);
  });
  it("no intake form is 'not submitted'; in progress is not awaiting review", () => {
    const p = queryDirectory(rows, agg({}, { "1": "in_progress" }), P());
    expect(p.rows[0].intake).toBe("not_submitted");
    expect(p.rows[0].next).toEqual({ state: "none" });
  });
});

describe("params and href", () => {
  it("parses and bounds the URL state; junk falls back to defaults", () => {
    expect(parseDirectoryParams({ q: "  ann ", filter: ["intake_review", "bogus"], sort: "next", page: "3" })).toEqual({
      q: "ann", filters: ["intake_review"], sort: "next", page: 3,
    });
    expect(parseDirectoryParams({ page: "-4", sort: "x" })).toMatchObject({ page: 1, sort: "name" });
    expect(parseDirectoryParams({ page: "abc" }).page).toBe(1);
  });
  it("round-trips the state, preserving the view and selection (closing the overview restores URL state)", () => {
    expect(directoryHref({ view: "active" })).toBe("/clients");
    const href = directoryHref({ view: "archived", q: "ann", filters: ["no_upcoming"], sort: "name", page: 2, client: "c1" });
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(sp).toMatchObject({ view: "archived", q: "ann", filter: "no_upcoming", sort: "name", page: "2", client: "c1" });
  });
});
