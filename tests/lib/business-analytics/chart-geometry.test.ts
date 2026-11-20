import { describe, expect, it } from "vitest";

import { barLayout, isolatedPoints, lineLayout, linePathD, niceAxis, segmentShares, truncateLabel } from "@/lib/business-analytics/chart-geometry";

describe("axis", () => {
  it("is zero-based and covers the data in at most the requested steps", () => {
    for (const m of [1, 7, 99, 100, 101, 2499, 2500, 2501, 123456, 0.4]) {
      const a = niceAxis(m, 5);
      expect(a.ticks[0]).toBe(0);
      expect(a.max).toBeGreaterThanOrEqual(m);
      expect(a.ticks[a.ticks.length - 1]).toBe(a.max);
      expect(a.ticks.length).toBeLessThanOrEqual(7);
    }
    expect(niceAxis(100, 5)).toMatchObject({ max: 100, step: 20 });
    expect(niceAxis(101, 5).max).toBe(125);
  });
  it("empty, zero, negative and non-finite data give a harmless 0..1 axis", () => {
    for (const m of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(niceAxis(m)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
  });
});

describe("bars", () => {
  const axis = niceAxis(200, 4);
  const pts = [{ key: "a", value: 0 }, { key: "b", value: 100 }, { key: "c", value: 200 }];
  const bars = barLayout(pts, axis, 300, 100);
  it("sit on the baseline and scale to the axis; a zero value is a zero-height bar", () => {
    expect(bars.map((b) => b.height)).toEqual([0, 50, 100]);
    for (const b of bars) expect(b.y + b.height).toBe(100);
  });
  it("do not overlap and stay inside the plot", () => {
    for (let i = 1; i < bars.length; i++) expect(bars[i].x).toBeGreaterThanOrEqual(bars[i - 1].x + bars[i - 1].width);
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(300);
    }
  });
  it("a tiny positive value is still visible; negative and non-finite are drawn as zero", () => {
    const [tiny, neg, nan] = barLayout([{ key: "t", value: 0.0001 }, { key: "n", value: -3 }, { key: "x", value: Number.NaN }], niceAxis(1000), 90, 100);
    expect(tiny.height).toBeGreaterThanOrEqual(1);
    expect([neg.height, nan.height]).toEqual([0, 0]);
  });
  it("no points or an empty plot give no bars", () => {
    expect(barLayout([], axis, 300, 100)).toEqual([]);
    expect(barLayout(pts, axis, 0, 100)).toEqual([]);
  });
});

describe("labels and shares", () => {
  it("truncates with an ellipsis, never past the limit, and does not split an emoji", () => {
    expect(truncateLabel("Short", 10)).toBe("Short");
    expect(truncateLabel("A long practitioner name", 8)).toBe("A long …");
    expect(truncateLabel("A long practitioner name", 8).length).toBeLessThanOrEqual(8);
    expect(truncateLabel("😀😀😀😀", 3)).toBe("😀😀…");
    expect(truncateLabel("x", 0)).toBe("");
  });
  it("shares add to one, and a zero whole draws no segment", () => {
    const s = segmentShares([{ key: "returning", value: 3 }, { key: "first", value: 1 }]);
    expect(s.map((x) => x.fraction)).toEqual([0.75, 0.25]);
    expect(segmentShares([{ key: "a", value: 0 }, { key: "b", value: 0 }])).toEqual([]);
    expect(segmentShares([{ key: "a", value: -2 }, { key: "b", value: 2 }]).map((x) => x.fraction)).toEqual([0, 1]);
  });
});

describe("line layout", () => {
  const axis = niceAxis(100, 4);
  it("spreads the slots edge to edge, with value 0 on the baseline and the axis maximum at the top", () => {
    const pts = lineLayout([0, 50, axis.max], axis, 3, 300, 100);
    expect(pts.map((p) => p && p.x)).toEqual([0, 150, 300]);
    expect(pts[0]?.y).toBe(100);
    expect(pts[2]?.y).toBe(0);
  });
  it("a series shorter than the slots ends sooner: the missing places are absent, never drawn at 0", () => {
    const pts = lineLayout([10, 20], axis, 5, 400, 100);
    expect(pts).toHaveLength(2);
    expect(pts[1]?.x).toBe(100);
  });
  it("a null, negative or non-finite value breaks the line and is not drawn", () => {
    const pts = lineLayout([10, null, -5, Number.NaN, 20], axis, 5, 400, 100);
    expect(pts.map((p) => p === null)).toEqual([false, true, true, true, false]);
    const d = linePathD(pts);
    expect(d.match(/M/g)).toHaveLength(2); // two separate strokes, no line across the gap
    expect(d).not.toContain("L");
  });
  it("one slot sits in the middle; no slots or a zero size draws nothing", () => {
    expect(lineLayout([5], axis, 1, 200, 100)[0]?.x).toBe(100);
    expect(lineLayout([5], axis, 0, 200, 100)).toEqual([]);
    expect(lineLayout([5], axis, 1, 0, 100)).toEqual([]);
  });
  it("consecutive values join with a line", () => {
    expect(linePathD(lineLayout([10, 20, 30], axis, 3, 200, 100))).toMatch(/^M[\d. ]+L[\d. ]+L[\d. ]+$/);
    expect(linePathD([])).toBe("");
  });
});

describe("line layout: slots and isolated points (A4 review)", () => {
  const axis = niceAxis(100, 4);
  it("values beyond the slots are not drawn: only the first `slots` values are laid out", () => {
    const pts = lineLayout([10, 20, 30, 40, 50], axis, 3, 300, 100);
    expect(pts).toHaveLength(3);
    expect(pts[2]?.x).toBe(300);
  });
  it("a single point and a point between breaks are isolated, and a point inside a stroke is not", () => {
    expect(isolatedPoints(lineLayout([40], axis, 1, 200, 100))).toHaveLength(1);
    const layout = lineLayout([10, null, 20, null, 30, 40], axis, 6, 500, 100);
    expect(isolatedPoints(layout).map((p) => p.x)).toEqual([0, 200]); // the 10 and the 20; 30 and 40 are joined
    expect(isolatedPoints([])).toEqual([]);
    expect(isolatedPoints([null, null])).toEqual([]);
  });
});
