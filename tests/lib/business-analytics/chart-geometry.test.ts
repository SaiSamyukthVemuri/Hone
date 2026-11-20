import { describe, expect, it } from "vitest";

import { barLayout, niceAxis, segmentShares, truncateLabel } from "@/lib/business-analytics/chart-geometry";

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
