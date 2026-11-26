import { FIGURE_UNAVAILABLE_COPY } from "./figure";
import { formatExact, formatWhole } from "./money-format";
import type { OverviewView } from "./overview-model";

// ===========================================================================
// Business → Overview: THE FIGURES IN WORDS. PURE.
// ===========================================================================
//
// Maps the Analytics Overview's view to what the Overview page prints. It computes no money: every number comes from `OverviewView`, which already has the
// reconciliation and the fail-closed reads behind it. Its one job is to keep two states apart that must never look alike:
//   a genuine ZERO (a studio with no activity really collected $0, saw 0 visits)       -> state "value", printed as a number
//   a figure that CANNOT BE COMPUTED (a failed read, no visits to average)               -> state "unavailable", printed as "Not available"

export const NOT_AVAILABLE = "Not available";

export type HomeFigure<T> = { state: "value"; value: T } | { state: "unavailable"; reason: string };

export type HomeComparison =
  | { kind: "percent"; text: string; direction: "up" | "down" | "flat" }
  | { kind: "none_recorded"; text: string }
  | { kind: "unavailable"; text: string };

export type HomeHero = { display: string; cents: number; comparison: HomeComparison; comparisonLabel: string };

export type HomeFigures = {
  periodLabel: string;
  currency: string | null;
  collected: HomeFigure<HomeHero>;
  completedVisits: HomeFigure<number>;
  activeClients: HomeFigure<number>;
  averagePaid: HomeFigure<string>;
  /** Cumulative collections for the current and the comparison period (cents), for the line. Unavailable when the series could not be read. */
  trend: HomeFigure<{ current: number[]; previous: number[] | null; unit: "day" | "month"; firstKey: string; lastKey: string }>;
};

/** Whole dollars when there are no cents (the preview's "$6,075"), every cent otherwise ("$6,075.50"). */
export function heroMoney(cents: number): string {
  return Math.abs(cents) % 100 === 0 ? formatWhole(cents) : formatExact(cents);
}

export function describeComparison(c: Extract<OverviewView["collected"], { available: true }>["value"]["change"], comparisonLabel: string): HomeComparison {
  if (c.kind === "percent") {
    const rounded = Math.round(Math.abs(c.percent) * 10) / 10;
    if (rounded === 0) return { kind: "percent", text: "0.0%", direction: "flat" };
    return c.percent > 0
      ? { kind: "percent", text: `+${rounded.toFixed(1)}%`, direction: "up" }
      : { kind: "percent", text: `−${rounded.toFixed(1)}%`, direction: "down" };
  }
  if (c.kind === "none_recorded") return { kind: "none_recorded", text: `Nothing was collected in ${comparisonLabel}` };
  return { kind: "unavailable", text: "Comparison not available" };
}

const unavailable = (reason: keyof typeof FIGURE_UNAVAILABLE_COPY): { state: "unavailable"; reason: string } => ({ state: "unavailable", reason: FIGURE_UNAVAILABLE_COPY[reason] });

function cumulative(points: ReadonlyArray<{ collectedCents: number }>): number[] {
  let sum = 0;
  return points.map((p) => (sum += p.collectedCents));
}

export function buildHomeFigures(view: OverviewView): HomeFigures {
  const collected: HomeFigures["collected"] = view.collected.available
    ? {
        state: "value",
        value: {
          cents: view.collected.value.headlineCents,
          display: heroMoney(view.collected.value.headlineCents),
          comparison: describeComparison(view.collected.value.change, view.comparisonLabel),
          comparisonLabel: view.comparisonLabel,
        },
      }
    : unavailable(view.collected.reason);

  const averagePaid: HomeFigures["averagePaid"] = !view.averagePaid.available
    ? unavailable(view.averagePaid.reason)
    : view.averagePaid.value.averageCents.known
      ? { state: "value", value: heroMoney(view.averagePaid.value.averageCents.value) }
      : { state: "unavailable", reason: view.averagePaid.value.averageCents.reason };

  const trend: HomeFigures["trend"] = view.series.available
    ? {
        state: "value",
        value: {
          current: cumulative(view.series.value.points),
          previous: view.previousSeries.available ? cumulative(view.previousSeries.value.points) : null,
          unit: view.series.value.unit,
          firstKey: view.series.value.points[0]?.key ?? view.currentRange.startLocal,
          lastKey: view.series.value.points.at(-1)?.key ?? view.currentRange.lastLocal,
        },
      }
    : unavailable(view.series.reason);

  return {
    periodLabel: view.currentLabel,
    currency: view.currency,
    collected,
    completedVisits: view.completedVisits.available ? { state: "value", value: view.completedVisits.value.count } : unavailable(view.completedVisits.reason),
    activeClients: view.activeClients.available ? { state: "value", value: view.activeClients.value.count } : unavailable(view.activeClients.reason),
    averagePaid,
    trend,
  };
}

/** The SVG path data for a cumulative line in a `width` by `height` box. Flat at the bottom when nothing was collected; a missing point is never drawn as a rise. */
export function cumulativePath(values: readonly number[], max: number, slots: number, width: number, height: number): string {
  if (values.length === 0) return "";
  const top = 10;
  const bottom = height - 10;
  return values
    .map((v, i) => {
      const x = slots <= 1 ? width / 2 : 3 + (i / (slots - 1)) * (width - 6);
      const y = max <= 0 ? bottom : bottom - (v / max) * (bottom - top);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
