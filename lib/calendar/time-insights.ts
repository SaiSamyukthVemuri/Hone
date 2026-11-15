import { isSelected, type PractitionerSelection } from "@/lib/calendar/practitioner-selection";

// HON-48 sidebar "Time insights": BOOKED APPOINTMENT HOURS and APPOINTMENT COUNT for the displayed
// period and the selected practitioners. ONE pure module: every rule lives here and nowhere else.
//
// RULES (Sam's spec):
//  * Counted: appointments that are not cancelled or voided. Scheduled (confirmed), completed and
//    no-show all count, because they were booked.
//  * Never counted: timed blocks, breaks, blockouts and closures. They are not appointments and this
//    module has no input for them.
//  * The period is a half-open instant range [start, end) in the STUDIO timezone (the caller builds it
//    from studio-local midnights, so a 23 or 25 hour DST day is exactly that long). Day = that local
//    day; Week = the displayed 7 days; Month = the calendar month ONLY (the spill-over days of the
//    neighbouring months drawn in the grid are not in the period).
//  * An appointment that crosses a period boundary contributes only the minutes inside the period and
//    is counted once if any part of it is inside.
//  * Only the selected practitioners (lib/calendar/practitioner-selection.ts): the same rows the view
//    draws, from data the view already holds. Nothing here reads or widens access.
//  * Zero is shown as zero. No averages, estimates or comparisons.
//
// Minutes are the booked interval (starts_at to ends_at): buffers (blocked_ends_at) are not booked
// time. Two overlapping appointments both count (each is booked time); the total is a sum.

export const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(["cancelled", "voided"]);

export type InsightAppointment = {
  id?: string;
  status: string;
  starts_at: string;
  ends_at: string;
  practitioner_id: string | null;
};

/** Half-open [startMs, endMs) in epoch milliseconds. */
export type InsightPeriod = { startMs: number; endMs: number };

export function insightPeriod(start: Date, end: Date): InsightPeriod {
  return { startMs: start.getTime(), endMs: end.getTime() };
}

export type TimeInsightsTotals = { minutes: number; count: number };

export function computeTimeInsights(args: {
  appointments: ReadonlyArray<InsightAppointment>;
  period: InsightPeriod;
  selection: PractitionerSelection;
}): TimeInsightsTotals {
  const { period, selection } = args;
  if (!(period.endMs > period.startMs)) return { minutes: 0, count: 0 };
  let ms = 0;
  let count = 0;
  const seen = new Set<string>();
  for (const a of args.appointments) {
    if (EXCLUDED_STATUSES.has(a.status)) continue;
    if (!isSelected(selection, a.practitioner_id)) continue;
    if (a.id !== undefined) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
    }
    const start = Date.parse(a.starts_at);
    const end = Date.parse(a.ends_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const inside = Math.min(end, period.endMs) - Math.max(start, period.startMs);
    if (inside > 0) {
      ms += inside;
      count += 1;
    } else if (end === start && start >= period.startMs && start < period.endMs) {
      // A zero-length appointment inside the period: counted, adds no time.
      count += 1;
    }
  }
  return { minutes: Math.round(ms / 60_000), count };
}

/** "0 h", "45 min", "3 h", "2 h 15 min". */
export function formatInsightHours(minutes: number): string {
  const total = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0 && m === 0) return "0 h";
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** "0 h · 0 appointments", "1 h · 1 appointment". */
export function formatInsightSummary(t: TimeInsightsTotals): string {
  return `${formatInsightHours(t.minutes)} · ${t.count} ${t.count === 1 ? "appointment" : "appointments"}`;
}

/** The rule, for the tooltip and the screen-reader description. */
export const INSIGHTS_RULE =
  "Booked appointment time. Cancelled and voided appointments are not counted; scheduled, completed and no-show are. Blocks, breaks and closures are never counted. An appointment crossing the period's edge counts only its minutes inside the period.";

/** "all selected", "Sam selected", "3 practitioners selected", "no practitioner selected". */
export function selectionPhrase(args: {
  mode: PractitionerSelection["mode"];
  selectedNames: ReadonlyArray<string>;
  listedCount: number;
}): string {
  const { mode, selectedNames, listedCount } = args;
  if (mode === "none" || selectedNames.length === 0) return "no practitioner selected";
  if (mode === "all" && listedCount > 1) return "all selected";
  if (selectedNames.length === 1) return `${selectedNames[0]} selected`;
  return `${selectedNames.length} practitioners selected`;
}

export type TimeInsightsModel = TimeInsightsTotals & {
  label: string;
  hoursText: string;
  summary: string;
};

/** Everything the sidebar section shows, labelled with the displayed period and the selection. */
export function buildTimeInsights(args: {
  appointments: ReadonlyArray<InsightAppointment>;
  period: InsightPeriod;
  selection: PractitionerSelection;
  periodLabel: string;
  practitioners: ReadonlyArray<{ id: string; name: string }>;
}): TimeInsightsModel {
  const totals = computeTimeInsights(args);
  const selectedNames = args.practitioners.filter((p) => isSelected(args.selection, p.id)).map((p) => p.name);
  const phrase = selectionPhrase({ mode: args.selection.mode, selectedNames, listedCount: args.practitioners.length });
  return {
    ...totals,
    label: `${args.periodLabel} · ${phrase}`,
    hoursText: formatInsightHours(totals.minutes),
    summary: formatInsightSummary(totals),
  };
}
