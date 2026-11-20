import { areaPathD, isolatedPoints, lineLayout, linePathD, niceAxis, segmentShares, truncateLabel } from "@/lib/business-analytics/chart-geometry";

// ===========================================================================
// Server-rendered SVG and CSS charts, each with the SAME numbers as text. No script, no chart library, nothing client-side.
// ===========================================================================
// A chart and its numbers are built from one array, so they cannot disagree. Keys are opaque per-render indexes and never a name or an id. A label is
// shortened for an axis only; the table or row always holds the full label. Colours are white, charcoal and neutral greys: no decorative hue. Which
// line is which is never told by colour alone (the previous period is dashed and is named in the legend and the table).

export type ChartPoint = { key: string; label: string; value: number };

const INK = "#1f2328";
const INK_SOFT = "#9aa0a6";
const GRID = "#e3e5e8";
const AXIS_TEXT = "#5f6368";

const W = 640;
const H = 220;
const PAD = { left: 64, right: 12, top: 8, bottom: 34 };
/** Width of one 11px axis character, rounded up, and the gap before the plot. The left margin follows the longest tick label, so a long money label is never cut off. */
const TICK_CHAR_W = 6.6;
export const tickMargin = (labels: readonly string[]): number => Math.max(PAD.left, Math.ceil(Math.max(0, ...labels.map((l) => l.length)) * TICK_CHAR_W) + 14);

/**
 * The selected period against the previous one. `previous` is aligned by position (the first point of each is the first day or month of its period); a
 * previous period with fewer points ends sooner and its missing places are shown as "—" in the table, never 0. `previous` null means that line is not drawn.
 */
export function LineChart({
  idPrefix,
  title,
  caption,
  valueHeading,
  currentName,
  previousName,
  points,
  previous,
  formatValue,
  formatTick,
  maxLabelChars = 7,
  openData = false,
}: {
  idPrefix: string;
  title: string;
  caption: string;
  valueHeading: string;
  currentName: string;
  previousName: string;
  points: readonly ChartPoint[];
  previous: readonly number[] | null;
  formatValue: (v: number) => string;
  formatTick: (v: number) => string;
  maxLabelChars?: number;
  /** The chart data is open (print); on screen it is a closed disclosure. */
  openData?: boolean;
}) {
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(0, ...points.map((p) => p.value), ...(previous ?? []));
  const axis = niceAxis(max, 4);
  const left = tickMargin(axis.ticks.map((t) => formatTick(t)));
  const plotW = W - left - PAD.right;
  const slots = points.length;
  const cur = lineLayout(points.map((p) => p.value), axis, slots, plotW, plotH);
  const prev = previous ? lineLayout(previous, axis, slots, plotW, plotH) : [];
  const every = Math.max(1, Math.ceil(slots / 8)); // at most about eight axis labels
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-4 text-xs text-fg-muted" aria-label="Chart key">
        <li className="flex items-center gap-2">
          <svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" stroke={INK} strokeWidth="2.5" /></svg>
          {currentName}
        </li>
        {previous ? (
          <li className="flex items-center gap-2">
            <svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" stroke={INK_SOFT} strokeWidth="2.5" strokeDasharray="5 3" /></svg>
            {previousName}
          </li>
        ) : null}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descId}`} className="h-auto w-full max-w-full">
        <title id={titleId}>{title}</title>
        <desc id={descId}>{caption}</desc>
        <g transform={`translate(${left} ${PAD.top})`}>
          {axis.ticks.map((t) => {
            const y = plotH - (t / axis.max) * plotH;
            return (
              <g key={t}>
                <line x1={0} x2={plotW} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
                <text x={-8} y={y + 4} textAnchor="end" fontSize={11} fill={AXIS_TEXT}>{formatTick(t)}</text>
              </g>
            );
          })}
          {/* A faint neutral fill under the current line only; the line and the table carry the numbers. */}
          <path d={areaPathD(cur, plotH)} data-area="current" fill={INK} fillOpacity={0.06} stroke="none" />
          {previous ? <path d={linePathD(prev)} fill="none" stroke={INK_SOFT} strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" strokeLinecap="round" /> : null}
          <path d={linePathD(cur)} fill="none" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {/* A point with no neighbour has no segment to draw, so it gets a marker (the numbers stay in the table). */}
          {previous ? isolatedPoints(prev).map((p, i) => <circle key={`pp${i}`} data-isolated="previous" cx={p.x} cy={p.y} r={3.5} fill={INK_SOFT} />) : null}
          {isolatedPoints(cur).map((p, i) => <circle key={`cp${i}`} data-isolated="current" cx={p.x} cy={p.y} r={3.5} fill={INK} />)}
          {points.map((p, i) =>
            // The last label is always drawn, but not when the one before it would sit on top of it (a label is about every `every` slots apart).
            (i % every === 0 && (i === slots - 1 || slots - 1 - i >= Math.ceil(every / 2) + 1 || every === 1)) || i === slots - 1 ? (
              <text key={p.key} x={slots === 1 ? plotW / 2 : (i * plotW) / (slots - 1)} y={plotH + 18} textAnchor={slots === 1 ? "middle" : i === 0 ? "start" : i === slots - 1 ? "end" : "middle"} fontSize={11} fill={AXIS_TEXT}>
                {truncateLabel(p.label, maxLabelChars)}
              </text>
            ) : null,
          )}
        </g>
      </svg>
      <details open={openData} className="text-sm" data-chart-data="">
        <summary className="cursor-pointer text-xs text-fg-muted underline">View chart data</summary>
        <table className="mt-2 w-full text-left text-sm">
          <caption className="pb-1 text-left text-xs text-fg-muted">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-fg-muted">
              <th scope="col" className="py-1 pr-3 font-medium">Period</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">{valueHeading}, {currentName}</th>
              {previous ? <th scope="col" className="py-1 text-right font-medium">{valueHeading}, {previousName}</th> : null}
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={p.key} className="border-b border-line/60">
                <th scope="row" className="whitespace-nowrap py-1 pr-3 font-normal text-fg">{p.label}</th>
                <td className="py-1 pr-3 text-right tabular-nums text-fg">{formatValue(p.value)}</td>
                {previous ? (
                  <td className="py-1 text-right tabular-nums text-fg">
                    {i < previous.length ? formatValue(previous[i]) : <span aria-label="not in the comparison period">—</span>}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Two parts of a whole as a ring with a label in the middle; the parts are named and counted in the legend beside it. No part is drawn at 0. */
export function Donut({ idPrefix, title, centre, parts }: { idPrefix: string; title: string; centre: string; parts: ReadonlyArray<{ key: string; label: string; value: number; tone: "ink" | "soft" }> }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const shares = segmentShares(parts.map((p) => ({ key: p.key, value: p.value })));
  let offset = 0;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 140 140" width="132" height="132" role="img" aria-labelledby={`${idPrefix}-title`} className="shrink-0">
        <title id={`${idPrefix}-title`}>{title}</title>
        <circle cx="70" cy="70" r={R} fill="none" stroke={GRID} strokeWidth="14" />
        {shares.map((s) => {
          const tone = parts.find((p) => p.key === s.key)?.tone === "ink" ? INK : INK_SOFT;
          const dash = s.fraction * C;
          const el = <circle key={s.key} cx="70" cy="70" r={R} fill="none" stroke={tone} strokeWidth="14" strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)" />;
          offset += dash;
          return el;
        })}
        <text x="70" y="77" textAnchor="middle" fontSize="22" fontWeight="600" fill={INK}>{centre}</text>
      </svg>
      <ul className="space-y-1 text-sm text-fg">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.tone === "ink" ? INK : INK_SOFT }} />
            {p.value} {p.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bars, one row per item: the label and the value are text on the row, and the bar is only the length. A value of 0 has an empty track, never a sliver. */
export function HBars({ rows, formatValue }: { rows: ReadonlyArray<{ key: string; label: string; value: number }>; formatValue: (v: number) => string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-fg" title={r.label}>{r.label}</span>
          <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-[#e3e5e8]">
            <span className="block h-full rounded-full bg-[#1f2328]" style={{ width: max > 0 && r.value > 0 ? `${Math.max(2, (r.value / max) * 100)}%` : "0%" }} />
          </span>
          <span className="tabular-nums text-fg">{formatValue(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
