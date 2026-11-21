import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  chooserReducer,
  filterCandidates,
  initialChooserState,
  pageOf,
  selectedAmong,
  selectedIds,
  type Candidate,
  type ChooserState,
} from "@/lib/waitlist/recipient-chooser";

const many = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ entryId: `e${i}`, name: `Person ${i}`, email: `p${i}@example.test` }));
const run = (s: ChooserState, ...a: Parameters<typeof chooserReducer>[1][]) => a.reduce(chooserReducer, s);

describe("pagination bounds what renders", () => {
  it("5,000 candidates give a page of at most the page size, with a correct range", () => {
    const v = pageOf(many(5000), 0);
    expect(v.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(v).toMatchObject({ total: 5000, pageCount: 100, from: 1, to: 50 });
  });
  it("the last page is partial, and an out-of-range or non-finite page is clamped", () => {
    const all = many(120);
    expect(pageOf(all, 2).items).toHaveLength(20);
    expect(pageOf(all, 99)).toMatchObject({ page: 2, from: 101, to: 120 });
    expect(pageOf(all, -5).page).toBe(0);
    expect(pageOf(all, Number.NaN).page).toBe(0);
    expect(pageOf(all, 0, Number.NaN).items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(pageOf(all, 0, 0).items).toHaveLength(DEFAULT_PAGE_SIZE);
  });
  it("no candidates is one empty page, not a negative range", () => {
    expect(pageOf([], 0)).toMatchObject({ items: [], pageCount: 1, total: 0, from: 0, to: 0 });
  });
});

describe("search narrows the list, never the selection", () => {
  it("matches every word against the name or the email, case-insensitively", () => {
    const all: Candidate[] = [
      { entryId: "a", name: "Ada Lovelace", email: "ada@example.test" },
      { entryId: "b", name: "Grace Hopper", email: "grace@example.test" },
    ];
    expect(filterCandidates(all, "  LOVE ").map((c) => c.entryId)).toEqual(["a"]);
    expect(filterCandidates(all, "grace hop").map((c) => c.entryId)).toEqual(["b"]);
    expect(filterCandidates(all, "example").map((c) => c.entryId)).toEqual(["a", "b"]);
    expect(filterCandidates(all, "zzz")).toEqual([]);
    expect(filterCandidates(all, "")).toHaveLength(2);
  });
  it("a new search returns to the first page and keeps every selected id", () => {
    const s = run(initialChooserState(["e7", "e900"]), { type: "page", page: 4 }, { type: "query", query: "person 1" });
    expect(s.page).toBe(0);
    expect([...s.selected]).toEqual(["e7", "e900"]);
  });
});

describe("selection survives paging and searching and has no ceiling", () => {
  it("nobody is selected by default", () => {
    expect(initialChooserState().selected.size).toBe(0);
  });
  it("selecting on page 1, moving to page 3 and selecting there keeps both", () => {
    const all = many(300);
    let s = initialChooserState();
    s = run(s, { type: "selectIds", entryIds: pageOf(all, 0).items.map((c) => c.entryId) });
    s = run(s, { type: "page", page: 2 }, { type: "toggle", entryId: "e101" });
    expect(s.selected.size).toBe(51);
    expect(s.selected.has("e0") && s.selected.has("e49") && s.selected.has("e101")).toBe(true);
  });
  it("select-all-matching selects every filtered person across all pages, with no cap (5,000)", () => {
    const all = many(5000);
    const s = run(initialChooserState(), { type: "selectIds", entryIds: filterCandidates(all, "").map((c) => c.entryId) });
    expect(s.selected.size).toBe(5000);
    expect(selectedIds(s.selected)).toHaveLength(5000);
    expect(new Set(selectedIds(s.selected)).size).toBe(5000);
  });
  it("clearing a page, or everything, removes only what it names", () => {
    let s = initialChooserState(["a", "b", "c"]);
    s = run(s, { type: "deselectIds", entryIds: ["a", "zzz"] });
    expect([...s.selected].sort()).toEqual(["b", "c"]);
    expect(run(s, { type: "clear" }).selected.size).toBe(0);
  });
  it("toggling twice leaves the selection as it was, and the reducer never mutates the previous state", () => {
    const s0 = initialChooserState(["a"]);
    const s1 = chooserReducer(s0, { type: "toggle", entryId: "b" });
    expect(s0.selected.size).toBe(1);
    expect(chooserReducer(s1, { type: "toggle", entryId: "b" }).selected.size).toBe(1);
  });
  it("counts how many of the matching people are selected, independent of the page", () => {
    const all = many(200);
    const s = initialChooserState(["e1", "e150", "elsewhere"]);
    expect(selectedAmong(filterCandidates(all, "person 1"), s.selected)).toBe(2);
    expect(selectedAmong(all, s.selected)).toBe(2);
  });
  it("a non-finite page request lands on page zero", () => {
    expect(chooserReducer(initialChooserState(), { type: "page", page: Number.NaN }).page).toBe(0);
  });
});
