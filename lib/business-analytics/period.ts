import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";

// ===========================================================================
// Business → Analytics: PERIODS. PURE. No I/O, no clock, no timezone lookup.
// ===========================================================================
//
// The caller supplies today's STUDIO-LOCAL date (`todayInTz(studio.timezone)`). Every window is a half-open range of studio-local dates,
// [startLocal, endLocalExclusive). Turning a window into instants is `windowInstants`, which converts the TWO local midnights separately
// (a DST day is 23 or 25 hours; never "start + N days"), the same rule as lib/finance/statement-period.ts.
//
// Comparison is by EQUIVALENT ELAPSED time: month to date against the same number of days of the previous month, year to date against the
// same dates of the previous year. When the equivalent day does not exist (31 March against February, 29 February against a common year)
// the comparison is CLAMPED to the last day that exists, and `clamped` says so, so a screen can print it. A partial period is labelled.

export type LocalDate = string; // "YYYY-MM-DD", a real calendar date

export type PeriodKind = "month_to_date" | "previous_month" | "year_to_date" | "custom";
export const PERIOD_KINDS: readonly PeriodKind[] = ["month_to_date", "previous_month", "year_to_date", "custom"];

/** How a CUSTOM period is compared. Both options are offered; the default is the preceding period. */
export type CustomComparison = "preceding" | "last_year";
export const CUSTOM_COMPARISONS: readonly CustomComparison[] = ["preceding", "last_year"];

/** A custom range longer than this is refused, never silently shortened. */
export const MAX_CUSTOM_DAYS = 366;
/** Up to this many days a chart uses one bucket per day; beyond it, one per calendar month. */
export const MAX_DAILY_BUCKET_DAYS = 62;

export type PeriodWindow = {
  /** First included local date. */
  startLocal: LocalDate;
  /** First local date NOT included. */
  endLocalExclusive: LocalDate;
  /** Last included local date (endLocalExclusive minus one day). */
  lastLocal: LocalDate;
  /** Number of local dates in the window. */
  days: number;
};

export type PeriodError = "invalid_kind" | "invalid_date" | "custom_dates_missing" | "from_after_to" | "future_date" | "range_too_long" | "invalid_comparison";

export type ResolvedPeriod = {
  kind: PeriodKind;
  current: PeriodWindow;
  comparison: PeriodWindow;
  /** True when the current window ends before its calendar month or year does (month to date, year to date, and a custom range). */
  partial: boolean;
  /** True when the comparison window had to be shortened because an equivalent day does not exist. */
  clamped: boolean;
  currentLabel: string;
  comparisonLabel: string;
  /** Sentences a screen shows above the figures, in this order. */
  notes: string[];
};

export type PeriodResult = { ok: true; period: ResolvedPeriod } | { ok: false; error: PeriodError };

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-12; day 0 of the next month is the last day of this one
}

/** True only for a real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
export function isRealLocalDate(v: unknown): v is LocalDate {
  if (typeof v !== "string") return false;
  const m = LOCAL_DATE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function parts(d: LocalDate): { y: number; m: number; d: number } {
  const m = LOCAL_DATE.exec(d)!;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function make(y: number, m: number, d: number): LocalDate {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Whole calendar days from `a` to `b` (b minus a). Both must be real local dates. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** The same month and day in another year, clamped to the last day that exists (29 February in a common year becomes 28 February). */
export function sameDateInYear(d: LocalDate, year: number): { date: LocalDate; clamped: boolean } {
  const p = parts(d);
  const last = daysInMonth(year, p.m);
  return p.d <= last ? { date: make(year, p.m, p.d), clamped: false } : { date: make(year, p.m, last), clamped: true };
}

function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

function windowOf(startLocal: LocalDate, lastLocal: LocalDate): PeriodWindow {
  return { startLocal, endLocalExclusive: addDays(lastLocal, 1), lastLocal, days: daysBetween(startLocal, lastLocal) + 1 };
}

// ---------------------------------------------------------------------------
// Labels (English, fixed words: no Intl, so a screen, a CSV and a print say the same thing)
// ---------------------------------------------------------------------------

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export function monthName(m: number): string {
  return MONTH_FULL[m - 1];
}

/** "1–19 Nov 2026", "1 Jan–19 Nov 2026", "29 Dec 2025–19 Jan 2026", "19 Nov 2026" (one day). */
export function rangeLabel(w: Pick<PeriodWindow, "startLocal" | "lastLocal">): string {
  const a = parts(w.startLocal);
  const b = parts(w.lastLocal);
  if (w.startLocal === w.lastLocal) return `${b.d} ${MONTH_ABBR[b.m - 1]} ${b.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTH_ABBR[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTH_ABBR[a.m - 1]}–${b.d} ${MONTH_ABBR[b.m - 1]} ${b.y}`;
  return `${a.d} ${MONTH_ABBR[a.m - 1]} ${a.y}–${b.d} ${MONTH_ABBR[b.m - 1]} ${b.y}`;
}

function dayCount(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export type ResolveInput = {
  kind: string;
  /** Today in the STUDIO's time zone. */
  today: LocalDate;
  /** Required for `custom`. */
  from?: string;
  to?: string;
  /** For `custom` only; defaults to "preceding". */
  customComparison?: string;
};

export function resolvePeriod(input: ResolveInput): PeriodResult {
  if (!isRealLocalDate(input.today)) return { ok: false, error: "invalid_date" };
  if (!(PERIOD_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "invalid_kind" };
  const kind = input.kind as PeriodKind;
  const t = parts(input.today);

  if (kind === "month_to_date") {
    const current = windowOf(make(t.y, t.m, 1), input.today);
    const pm = shiftMonth(t.y, t.m, -1);
    const prevLen = daysInMonth(pm.y, pm.m);
    const clamped = t.d > prevLen;
    const comparison = windowOf(make(pm.y, pm.m, 1), make(pm.y, pm.m, Math.min(t.d, prevLen)));
    const currentLabel = `Month to date: ${rangeLabel(current)} (${dayCount(current.days)})`;
    const comparisonLabel = `${rangeLabel(comparison)} (${dayCount(comparison.days)})`;
    const notes = [`${currentLabel} compared with ${comparisonLabel}.`, "Today's visits count once they are marked complete."];
    if (clamped) notes.push(`${monthName(pm.m)} has only ${prevLen} days, so the comparison stops at its last day.`);
    return { ok: true, period: { kind, current, comparison, partial: true, clamped, currentLabel, comparisonLabel, notes } };
  }

  if (kind === "previous_month") {
    const pm = shiftMonth(t.y, t.m, -1);
    const pp = shiftMonth(t.y, t.m, -2);
    const current = windowOf(make(pm.y, pm.m, 1), make(pm.y, pm.m, daysInMonth(pm.y, pm.m)));
    const comparison = windowOf(make(pp.y, pp.m, 1), make(pp.y, pp.m, daysInMonth(pp.y, pp.m)));
    const currentLabel = `${monthName(pm.m)} ${pm.y} (complete month, ${dayCount(current.days)})`;
    const comparisonLabel = `${monthName(pp.m)} ${pp.y} (complete month, ${dayCount(comparison.days)})`;
    const notes = [`${currentLabel} compared with ${comparisonLabel}.`];
    if (current.days !== comparison.days) notes.push("The two months have different numbers of days.");
    return { ok: true, period: { kind, current, comparison, partial: false, clamped: false, currentLabel, comparisonLabel, notes } };
  }

  if (kind === "year_to_date") {
    const current = windowOf(make(t.y, 1, 1), input.today);
    const sd = sameDateInYear(input.today, t.y - 1);
    const comparison = windowOf(make(t.y - 1, 1, 1), sd.date);
    const currentLabel = `Year to date: ${rangeLabel(current)} (${dayCount(current.days)})`;
    const comparisonLabel = `${rangeLabel(comparison)} (${dayCount(comparison.days)})`;
    const notes = [`${currentLabel} compared with ${comparisonLabel}.`, "Today's visits count once they are marked complete."];
    if (sd.clamped) notes.push("29 February does not exist in the previous year, so the comparison stops at 28 February.");
    return { ok: true, period: { kind, current, comparison, partial: true, clamped: sd.clamped, currentLabel, comparisonLabel, notes } };
  }

  // custom
  if (input.from === undefined || input.to === undefined || input.from === "" || input.to === "") return { ok: false, error: "custom_dates_missing" };
  if (!isRealLocalDate(input.from) || !isRealLocalDate(input.to)) return { ok: false, error: "invalid_date" };
  if (input.from > input.to) return { ok: false, error: "from_after_to" };
  if (input.to > input.today) return { ok: false, error: "future_date" };
  const mode = input.customComparison ?? "preceding";
  if (!(CUSTOM_COMPARISONS as readonly string[]).includes(mode)) return { ok: false, error: "invalid_comparison" };
  const current = windowOf(input.from, input.to);
  if (current.days > MAX_CUSTOM_DAYS) return { ok: false, error: "range_too_long" };

  let comparison: PeriodWindow;
  let clamped = false;
  if (mode === "preceding") {
    comparison = windowOf(addDays(input.from, -current.days), addDays(input.from, -1));
  } else {
    const a = sameDateInYear(input.from, parts(input.from).y - 1);
    const b = sameDateInYear(input.to, parts(input.to).y - 1);
    clamped = a.clamped || b.clamped;
    comparison = windowOf(a.date, b.date);
  }
  const currentLabel = `Custom range: ${rangeLabel(current)} (${dayCount(current.days)})`;
  const comparisonLabel = `${rangeLabel(comparison)} (${dayCount(comparison.days)})`;
  const notes = [`${currentLabel} compared with ${comparisonLabel}.`];
  if (mode === "last_year") notes.push("The comparison is the same dates one year earlier.");
  if (mode === "last_year" && comparison.days !== current.days) notes.push("The two ranges have different numbers of days.");
  if (clamped) notes.push("29 February does not exist in the previous year, so that end of the comparison is 28 February.");
  if (input.to === input.today) notes.push("Today's visits count once they are marked complete.");
  return { ok: true, period: { kind, current, comparison, partial: true, clamped, currentLabel, comparisonLabel, notes } };
}

/** The two UTC instants of a window in the studio's time zone: each local midnight converted on its own. */
export function windowInstants(w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">, timezone: string): { startUtc: string; endUtc: string } {
  return {
    startUtc: utcInstantFromLocal(w.startLocal, "00:00", timezone).toISOString(),
    endUtc: utcInstantFromLocal(w.endLocalExclusive, "00:00", timezone).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Chart buckets
// ---------------------------------------------------------------------------

export type Bucket = { key: string; startLocal: LocalDate; endLocalExclusive: LocalDate };
export type BucketUnit = "day" | "month";

export function bucketUnit(w: Pick<PeriodWindow, "days">): BucketUnit {
  return w.days <= MAX_DAILY_BUCKET_DAYS ? "day" : "month";
}

/** Buckets covering the window exactly, in order, with no gap and no overlap. A month bucket is clipped to the window at either end. */
export function bucketsOf(w: PeriodWindow): { unit: BucketUnit; buckets: Bucket[] } {
  const unit = bucketUnit(w);
  const out: Bucket[] = [];
  if (unit === "day") {
    for (let d = w.startLocal; d < w.endLocalExclusive; d = addDays(d, 1)) out.push({ key: d, startLocal: d, endLocalExclusive: addDays(d, 1) });
    return { unit, buckets: out };
  }
  let cursor = w.startLocal;
  while (cursor < w.endLocalExclusive) {
    const p = parts(cursor);
    const next = shiftMonth(p.y, p.m, 1);
    const monthEnd = make(next.y, next.m, 1);
    const end = monthEnd < w.endLocalExclusive ? monthEnd : w.endLocalExclusive;
    out.push({ key: `${pad(p.y, 4)}-${pad(p.m)}`, startLocal: cursor, endLocalExclusive: end });
    cursor = end;
  }
  return { unit, buckets: out };
}

/** Which bucket a local date falls in, or null when it is outside the window. */
export function bucketKeyFor(d: LocalDate, w: PeriodWindow): string | null {
  if (d < w.startLocal || d >= w.endLocalExclusive) return null;
  return bucketUnit(w) === "day" ? d : d.slice(0, 7);
}

/** True when `d` is inside the window. */
export function inWindow(d: LocalDate, w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">): boolean {
  return d >= w.startLocal && d < w.endLocalExclusive;
}

/** The calendar months a window touches, with the part of each month the window covers. Used to reconcile against Statements, which is one month per page. */
export function monthsCovered(w: PeriodWindow): Array<{ month: string; startLocal: LocalDate; endLocalExclusive: LocalDate; wholeMonth: boolean }> {
  const out: Array<{ month: string; startLocal: LocalDate; endLocalExclusive: LocalDate; wholeMonth: boolean }> = [];
  let cursor = w.startLocal;
  while (cursor < w.endLocalExclusive) {
    const p = parts(cursor);
    const next = shiftMonth(p.y, p.m, 1);
    const monthEnd = make(next.y, next.m, 1);
    const end = monthEnd < w.endLocalExclusive ? monthEnd : w.endLocalExclusive;
    out.push({ month: `${pad(p.y, 4)}-${pad(p.m)}`, startLocal: cursor, endLocalExclusive: end, wholeMonth: cursor === make(p.y, p.m, 1) && end === monthEnd });
    cursor = end;
  }
  return out;
}

/**
 * What may be CLAIMED about Statements for a window. A Statements page is one WHOLE calendar month, so only a window that is exactly one
 * whole month may say "matches Statements for <month>". A window of several whole months may say "the sum of these Statements months". Month to date,
 * year to date and any other window may NOT claim to match a Statements page: they are checked against the Statements rules applied independently
 * to the same dates, and the screen says that instead.
 */
export type StatementsClaim =
  | { kind: "one_whole_month"; month: string }
  | { kind: "several_whole_months"; months: string[] }
  | { kind: "same_rules_same_dates"; months: string[] };

export function statementsClaim(w: PeriodWindow): StatementsClaim {
  const covered = monthsCovered(w);
  const months = covered.map((m) => m.month);
  if (covered.length > 0 && covered.every((m) => m.wholeMonth)) return covered.length === 1 ? { kind: "one_whole_month", month: months[0] } : { kind: "several_whole_months", months };
  return { kind: "same_rules_same_dates", months };
}
