import { describe, expect, it } from "vitest";
import {
  CHARTING_VIEW_KEY,
  chartingViewFromMetadata,
  parseChartingViewGate,
  readChartingView,
  resolveChartingView,
  strictChartingView,
  withChartingView,
} from "@/lib/charting/view-preference";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("the default is Current for anything unexpected", () => {
  it.each([undefined, null, "", "New", "NEW", " new", "new ", "current ", "old", 1, true, {}, ["new"], "new\n"])(
    "reads %j as current",
    (v) => {
      expect(strictChartingView(v)).toBeNull();
      expect(readChartingView(v)).toBe("current");
    },
  );
  it("reads exactly the two stored values", () => {
    expect(readChartingView("new")).toBe("new");
    expect(readChartingView("current")).toBe("current");
  });
  it("reads missing, empty and malformed metadata as current", () => {
    for (const m of [undefined, null, "x", 5, [], {}, { other: "new" }, { [CHARTING_VIEW_KEY]: "bogus" }]) {
      expect(chartingViewFromMetadata(m)).toBe("current");
    }
    expect(chartingViewFromMetadata({ [CHARTING_VIEW_KEY]: "new" })).toBe("new");
  });
});

describe("the write merges: every other profile key survives", () => {
  it("keeps all other keys, including nested values, and sets only the one key", () => {
    const existing = { full_name: "Avery Example", nested: { a: [1, 2], b: null }, flag: false };
    const out = withChartingView(existing, "new");
    expect(out).toEqual({ ...existing, [CHARTING_VIEW_KEY]: "new" });
    expect(existing).not.toHaveProperty(CHARTING_VIEW_KEY); // the input is not mutated
  });
  it("replaces only its own previous value", () => {
    expect(withChartingView({ x: 1, [CHARTING_VIEW_KEY]: "new" }, "current")).toEqual({
      x: 1,
      [CHARTING_VIEW_KEY]: "current",
    });
  });
  it("stores only the key when the existing metadata is absent or not an object", () => {
    for (const e of [undefined, null, "s", 3, ["a"]]) {
      expect(withChartingView(e, "new")).toEqual({ [CHARTING_VIEW_KEY]: "new" });
    }
  });
  it("does not carry a __proto__ key", () => {
    const e = JSON.parse('{"__proto__":{"polluted":true},"keep":1}');
    const out = withChartingView(e, "new");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.keep).toBe(1);
  });
});

describe("who sees the toggle: the rollout and the kill switch", () => {
  it("empty, missing or garbage is OFF", () => {
    for (const raw of [undefined, null, "", "  ", "none", "ALLOW", "not-a-uuid", "*"]) {
      expect(parseChartingViewGate(raw)).toEqual({ kind: "off" });
    }
  });
  it('"all" (any case, padded) is every studio', () => {
    for (const raw of ["all", " ALL ", "All"]) expect(parseChartingViewGate(raw)).toEqual({ kind: "all" });
  });
  it("a list names studios; a malformed token only shrinks it", () => {
    const g = parseChartingViewGate(` ${A.toUpperCase()}, nope ,${B}, ${A.slice(0, 8)}`);
    expect(g.kind).toBe("list");
    expect(g.kind === "list" && [...g.ids].sort()).toEqual([A, B]);
  });
  it("resolves the view: a hidden toggle always means Current, even when the profile says new", () => {
    const meta = { [CHARTING_VIEW_KEY]: "new" };
    expect(resolveChartingView(meta, A, "")).toEqual({ toggleVisible: false, view: "current" });
    expect(resolveChartingView(meta, A, B)).toEqual({ toggleVisible: false, view: "current" });
    expect(resolveChartingView(meta, A, A)).toEqual({ toggleVisible: true, view: "new" });
    expect(resolveChartingView(meta, null, "all")).toEqual({ toggleVisible: true, view: "new" });
    expect(resolveChartingView(undefined, A, "all")).toEqual({ toggleVisible: true, view: "current" });
  });
});
