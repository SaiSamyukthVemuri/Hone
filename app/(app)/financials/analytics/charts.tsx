import { barLayout, niceAxis, truncateLabel } from "@/lib/business-analytics/chart-geometry";

// ===========================================================================
// Server-rendered SVG bar charts, each with the SAME numbers in a data table below. No script, no chart library, nothing client-side.
// ===========================================================================
// The chart and its table are built from one `points` array, so they cannot disagree. Keys are opaque per-render indexes and never a name or an id.
// A label is shortened for the axis only; the table always holds the full label. The title and description are the visible heading and table caption.

export type ChartPoint = { key: string; label: string; value: number };

const W = 640;
const H = 220;
const PAD = { left: 64, right: 8, top: 8, bottom: 34 };
/** Width of one 11px axis character, rounded up, and the gap before the plot. The left margin follows the longest tick label, so a long money label is never cut off. */
const TICK_CHAR_W = 6.6;
export const tickMargin = (labels: readonly string[]): number => Math.max(PAD.left, Math.ceil(Math.max(0, ...labels.map((l) => l.length)) * TICK_CHAR_W) + 14);

export function BarChart({
  idPrefix,
  title,
  caption,
  valueHeading,
  points,
  formatValue,
  formatTick,
  maxLabelChars = 10,
}: {
  idPrefix: string;
  title: string;
  caption: string;
  valueHeading: string;
  points: readonly ChartPoint[];
  formatValue: (v: number) => string;
  formatTick: (v: number) => string;
  maxLabelChars?: number;
}) {
  const plotH = H - PAD.top - PAD.bottom;
  const max = points.reduce((m, p) => (p.value > m ? p.value : m), 0);
  const axis = niceAxis(max, 4);
  const left = tickMargin(axis.ticks.map((t) => formatTick(t)));
  const plotW = W - left - PAD.right;
  const bars = barLayout(points.map((p) => ({ key: p.key, value: p.value })), axis, plotW, plotH);
  const every = Math.max(1, Math.ceil(points.length / 12)); // at most about twelve axis labels
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;
  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descId}`} className="h-auto w-full max-w-full">
        <title id={titleId}>{title}</title>
        <desc id={descId}>{caption}</desc>
        <g transform={`translate(${left} ${PAD.top})`}>
          {axis.ticks.map((t) => {
            const y = plotH - (t / axis.max) * plotH;
            return (
              <g key={t}>
                <line x1={0} x2={plotW} y1={y} y2={y} stroke="#d6dbd3" strokeWidth={1} />
                <text x={-8} y={y + 4} textAnchor="end" fontSize={11} fill="#5a6358">{formatTick(t)}</text>
              </g>
            );
          })}
          {bars.map((b, i) => (
            <g key={b.key}>
              <rect x={b.x} y={b.y} width={b.width} height={b.height} rx={2} fill="#6f8a64" />
              {i % every === 0 ? (
                <text x={b.x + b.width / 2} y={plotH + 18} textAnchor="middle" fontSize={11} fill="#5a6358">{truncateLabel(points[i].label, maxLabelChars)}</text>
              ) : null}
            </g>
          ))}
        </g>
      </svg>
      <table className="w-full text-left text-sm">
        <caption className="pb-1 text-left text-xs text-fg-muted">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-fg-muted">
            <th scope="col" className="py-1 pr-3 font-medium">Period</th>
            <th scope="col" className="py-1 text-right font-medium">{valueHeading}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key} className="border-b border-line/60">
              <th scope="row" className="py-1 pr-3 font-normal text-fg">{p.label}</th>
              <td className="py-1 text-right tabular-nums text-fg">{formatValue(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
