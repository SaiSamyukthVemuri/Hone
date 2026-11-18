// CLIENTS DIRECTORY: the "not seen in N months" filter, as pure functions (no I/O, no clock of its own).
//
// WHAT IT ASKS. "Last visit" is ONE definition (lib/clients/last-visit.ts): the later of the newest live,
// non-void session and the newest completed appointment, neither in the future. Anything else is NOT
// evidence of a visit: a past appointment left "confirmed", a cancelled or no-show appointment, a void
// session, a future appointment.
//
// MISSING EVIDENCE IS NOT ABSENCE. A client with no such evidence has NO RECORDED VISIT. That is not "a
// long time ago" and not "overdue": the person may have been seen, with nothing recorded here (an
// imported history, a walk-in never charted, an appointment never marked complete). So the two questions
// are separate buckets and never mixed:
//   "3" | "6" | "12"  clients WITH a recorded visit whose last one was N calendar months ago or longer;
//   "none"            clients with NO recorded visit, listed on their own and labelled as such.
// The default ("any") applies nothing.
//
// CALENDAR MONTHS IN THE STUDIO'S TIMEZONE. The cutoff is today's studio-local date minus N calendar months
// (the day is clamped to the shorter month: 31 Aug minus 6 months is 28 Feb, 29 Feb in a leap year), and a
// visit is "N months or longer ago" when its studio-local date is on or before the cutoff. No browser clock
// or viewer timezone decides it.

export type LastVisitFilter = "any" | "3" | "6" | "12" | "none";

export const LAST_VISIT_FILTER_CHOICES: ReadonlyArray<Exclude<LastVisitFilter, "any">> = ["3", "6", "12", "none"];

export const LAST_VISIT_FILTER_LABEL: Record<Exclude<LastVisitFilter, "any">, string> = {
  "3": "Not seen in 3+ months",
  "6": "Not seen in 6+ months",
  "12": "Not seen in 12+ months",
  none: "No recorded visit",
};

export function parseLastVisitFilter(raw: string | string[] | undefined): LastVisitFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "3" || v === "6" || v === "12" || v === "none" ? v : "any";
}

/** One formatter for a timezone, built ONCE: returns the studio-local calendar date (YYYY-MM-DD) of an instant, or null. */
function localDateFormatter(timeZone: string): (iso: string) => string | null {
  const build = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = build(timeZone);
  } catch {
    fmt = build("UTC");
  }
  return (iso) => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    const parts = fmt.formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
}

/** The studio-local calendar date (YYYY-MM-DD) of an instant, or null when the instant is not a date. */
export function studioLocalDate(iso: string, timeZone: string): string | null {
  return localDateFormatter(timeZone)(iso);
}

function cutoffFromToday(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, daysInMonth);
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** Today's studio-local date minus `months` calendar months, day clamped to the shorter month. */
export function notSeenCutoffDate(nowIso: string, months: number, timeZone: string): string | null {
  const today = studioLocalDate(nowIso, timeZone);
  return today ? cutoffFromToday(today, months) : null;
}

/**
 * The matcher for ONE request: the cutoff is computed once and one date formatter is shared across every
 * client, so filtering a studio of thousands costs one formatter, not one per client. Identical in meaning
 * to `lastVisitIsAtLeastMonthsAgo` (a visit on the cutoff day counts); that function is this one, built per call.
 */
export function lastVisitMatcher(months: number, nowIso: string, timeZone: string): (lastVisitIso: string) => boolean {
  const localDate = localDateFormatter(timeZone);
  const today = localDate(nowIso);
  const cutoff = today ? cutoffFromToday(today, months) : null;
  return (lastVisitIso) => {
    if (cutoff === null) return false;
    const visit = localDate(lastVisitIso);
    return visit !== null && visit <= cutoff;
  };
}

/** True when a recorded last visit is N calendar months ago or longer (studio-local dates). */
export function lastVisitIsAtLeastMonthsAgo(
  lastVisitIso: string,
  months: number,
  nowIso: string,
  timeZone: string,
): boolean {
  return lastVisitMatcher(months, nowIso, timeZone)(lastVisitIso);
}
