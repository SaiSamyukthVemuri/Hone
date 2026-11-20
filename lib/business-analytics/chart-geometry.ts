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
