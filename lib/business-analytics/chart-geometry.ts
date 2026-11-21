// ===========================================================================
// Business → Analytics: CHART GEOMETRY. PURE. The server-rendered SVG prints exactly what this returns; the data table beside it holds the same numbers.
// ===========================================================================

export type AxisScale = { max: number; step: number; ticks: number[] };

/** A "nice" zero-based axis for non-negative data: the smallest 1, 2, 2.5, 5 or 10 times a power of ten step that covers `maxValue` in at most `maxTicks` steps. */
export function niceAxis(maxValue: number, maxTicks = 5): AxisScale {
  const top = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 0;
  if (top === 0) return { max: 1, step: 1, ticks: [0, 1] };
  const steps = Math.max(1, Math.floor(maxTicks));
  const raw = top / steps;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw - 1e-12) ?? 10 * pow);
  const max = Math.ceil(top / step - 1e-12) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step / 2; t += step) ticks.push(Math.round(t * 1e9) / 1e9);
  return { max, step, ticks };
}

export type Bar = { key: string; value: number; x: number; y: number; width: number; height: number };

/**
 * Vertical bars in a `width` x `height` plot, baseline at the bottom (value 0 is always the baseline; a negative or non-finite value is drawn as 0
 * and is a caller error to be caught by the data table, never a hidden bar). A bar with a value above 0 is at least 1 unit tall so it stays visible.
 */
export function barLayout(points: ReadonlyArray<{ key: string; value: number }>, axis: AxisScale, width: number, height: number, gapRatio = 0.25): Bar[] {
  const n = points.length;
  if (n === 0 || !(width > 0) || !(height > 0)) return [];
  const slot = width / n;
  const barW = slot * (1 - Math.min(Math.max(gapRatio, 0), 0.9));
  return points.map((p, i) => {
    const v = Number.isFinite(p.value) && p.value > 0 ? p.value : 0;
    const h = v === 0 ? 0 : Math.max(1, (v / axis.max) * height);
    return { key: p.key, value: v, x: i * slot + (slot - barW) / 2, y: height - h, width: barW, height: h };
  });
}

/** Shorten a label to at most `max` characters with an ellipsis, never splitting a surrogate pair. */
export function truncateLabel(label: string, max: number): string {
  const chars = [...label];
  if (max < 1 || chars.length <= max) return max < 1 ? "" : label;
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/** Share of a whole as a rounded whole percent, and a segment layout for two or more parts. A zero whole gives no segments (not a 0% drawn as a slice). */
export function segmentShares(parts: ReadonlyArray<{ key: string; value: number }>): Array<{ key: string; value: number; fraction: number }> {
  const clean = parts.map((p) => ({ key: p.key, value: Number.isFinite(p.value) && p.value > 0 ? p.value : 0 }));
  const total = clean.reduce((n, p) => n + p.value, 0);
  if (total === 0) return [];
  return clean.map((p) => ({ ...p, fraction: p.value / total }));
}

export type LinePoint = { x: number; y: number };

/**
 * Positions for a line over `slots` evenly spaced places (index 0 at the left edge, the last slot at the right edge; one slot sits in the middle). A value
 * for slot i is drawn at slot i, so two series of different lengths line up by position and the shorter one simply ends sooner. A missing, negative or
 * non-finite value is `null`: the line breaks there and nothing is drawn, never a 0.
 */
/** The values a line over `slots` places actually draws: the first `slots` of them. The axis is scaled from exactly these, so a value the line never draws cannot stretch it. */
export function drawnValues(values: ReadonlyArray<number | null>, slots: number): Array<number | null> {
  return values.slice(0, Math.max(0, slots));
}

export function lineLayout(values: ReadonlyArray<number | null>, axis: AxisScale, slots: number, width: number, height: number): Array<LinePoint | null> {
  if (!(width > 0) || !(height > 0) || !(slots > 0)) return [];
  return drawnValues(values, slots).map((v, i) => {
    if (v === null || !Number.isFinite(v) || v < 0) return null;
    const x = slots === 1 ? width / 2 : (i * width) / (slots - 1);
    return { x, y: height - (Math.min(v, axis.max) / axis.max) * height };
  });
}

/** The points a stroke cannot show: a point with no drawn neighbour on either side (a single point, or one between breaks) has no segment, so it is marked on its own. */
export function isolatedPoints(points: ReadonlyArray<LinePoint | null>): LinePoint[] {
  const out: LinePoint[] = [];
  points.forEach((p, i) => {
    if (p !== null && (i === 0 || points[i - 1] === null) && (i === points.length - 1 || points[i + 1] === null)) out.push(p);
  });
  return out;
}

/** An SVG path for a line that breaks at every null. Coordinates are rounded to two places so the markup is stable. */
export function linePathD(points: ReadonlyArray<LinePoint | null>): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (p === null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`;
    pen = true;
  }
  return d;
}

/** A closed shape under each unbroken run of the line down to the baseline (`baseY`), so the area stops where the line breaks and never spans a gap. */
export function areaPathD(points: ReadonlyArray<LinePoint | null>, baseY: number): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  let d = "";
  let run: LinePoint[] = [];
  const close = () => {
    if (run.length >= 2) d += `M${r(run[0].x)} ${r(baseY)}${run.map((p) => `L${r(p.x)} ${r(p.y)}`).join("")}L${r(run[run.length - 1].x)} ${r(baseY)}Z`;
    run = [];
  };
  for (const p of points) {
    if (p === null) close();
    else run.push(p);
  }
  close();
  return d;
}
