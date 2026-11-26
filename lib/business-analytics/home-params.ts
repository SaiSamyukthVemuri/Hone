import { addDays } from "@/lib/booking/tz";
import { isStatementMonth, shiftYearMonth, type YearMonth } from "@/lib/finance/statement-period";

import type { RawParams } from "./overview-params";

// ===========================================================================
// Business → Overview: THE REPORTING PERIOD IN THE ADDRESS. PURE.
// ===========================================================================
//
// The period lives in the URL, so Overview → Statements → Back lands on the same period and the same figures. Every value is untrusted input, parsed to a
// closed vocabulary: an unknown or repeated value falls back to Month to date and the page SAYS so. A chosen month must be a real month from January 2000
// to the studio's current month. The three named periods use the Analytics vocabulary, so the same figures can be read in either screen.
//
// The figures are not computed here. This module only decides WHICH existing Analytics window to read (`analyticsRawFor`), so there is no second money path.

export type HomePeriod = "month_to_date" | "previous_month" | "year_to_date" | "month";
export const HOME_PERIODS: readonly HomePeriod[] = ["month_to_date", "previous_month", "year_to_date", "month"];
export const DEFAULT_HOME_PERIOD: HomePeriod = "month_to_date";

/** The control's words, as the preview draws them. */
export const HOME_PERIOD_LABELS: Record<Exclude<HomePeriod, "month">, string> = {
  month_to_date: "Month to date",
  previous_month: "Last month",
  year_to_date: "Year to date",
};
export const CHOOSE_MONTH_LABEL = "Choose month";

export type HomeSelection = { period: HomePeriod; /** Set only when `period` is "month". */ month: YearMonth | null };

export const HOME_PERIOD_NOTICE = "The reporting period in the address was not recognised, so Month to date is shown.";

const first = (v: string | readonly string[] | undefined): { present: boolean; value: string | undefined; repeated: boolean } => {
  if (v === undefined) return { present: false, value: undefined, repeated: false };
  if (typeof v === "string") return { present: true, value: v, repeated: false };
  return { present: true, value: v[0], repeated: v.length !== 1 };
};

/**
 * The selection for a request. `currentMonth` is the studio's current month (YYYY-MM). A chosen month equal to the current or the previous month is the
 * same window as the named period, so it is reported as that period: one window never has two addresses.
 */
export function parseHomeParams(raw: RawParams, currentMonth: YearMonth): { selection: HomeSelection; notices: string[] } {
  const dflt: HomeSelection = { period: DEFAULT_HOME_PERIOD, month: null };
  const p = first(raw.period);
  const m = first(raw.month);
  if (!p.present) return { selection: dflt, notices: m.present ? [HOME_PERIOD_NOTICE] : [] };
  if (p.repeated || p.value === undefined || !(HOME_PERIODS as readonly string[]).includes(p.value)) return { selection: dflt, notices: [HOME_PERIOD_NOTICE] };
  const period = p.value as HomePeriod;
  if (period !== "month") return { selection: { period, month: null }, notices: [] };
  if (m.repeated || !isStatementMonth(m.value, currentMonth)) return { selection: dflt, notices: [HOME_PERIOD_NOTICE] };
  const month = m.value as YearMonth;
  if (month === currentMonth) return { selection: dflt, notices: [] };
  if (month === shiftYearMonth(currentMonth, -1)) return { selection: { period: "previous_month", month: null }, notices: [] };
  return { selection: { period: "month", month }, notices: [] };
}

/** The query string for a selection. The default is left out so a link stays short. */
export function homeQuery(sel: HomeSelection): string {
  if (sel.period === DEFAULT_HOME_PERIOD) return "";
  if (sel.period === "month" && sel.month) return `?period=month&month=${sel.month}`;
  return `?period=${sel.period}`;
}

/** Which existing Analytics window answers this selection. A chosen month is the custom range from its first to its last day. */
export function analyticsRawFor(sel: HomeSelection): RawParams {
  if (sel.period === "month" && sel.month) {
    // Compared with the calendar month before it, the same as Last month and Month to date (the preview's labels are calendar-based).
    return { period: "custom", from: `${sel.month}-01`, to: addDays(`${shiftYearMonth(sel.month, 1)}-01`, -1), compare: "previous_month" };
  }
  return { period: sel.period === "month" ? DEFAULT_HOME_PERIOD : sel.period };
}

/** The Statements month that matches this selection, or null when none does (Year to date spans many months). */
export function statementMonthFor(sel: HomeSelection, currentMonth: YearMonth): YearMonth | null {
  if (sel.period === "month_to_date") return currentMonth;
  if (sel.period === "previous_month") return shiftYearMonth(currentMonth, -1);
  if (sel.period === "month") return sel.month;
  return null;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * The collections headline, named for the period (operator decision, 26 Nov 2026): money is grouped by VISIT date, so the words say "for visits in <month>".
 * The year is added only when the month is not in the current year. Month to date and Year to date use the equivalent wording.
 */
export function heroTitle(sel: HomeSelection, currentMonth: YearMonth): string {
  const named = (ym: YearMonth) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]}${ym.slice(0, 4) === currentMonth.slice(0, 4) ? "" : ` ${ym.slice(0, 4)}`}`;
  if (sel.period === "year_to_date") return "Collected for visits this year";
  if (sel.period === "previous_month") return `Collected for visits in ${named(shiftYearMonth(currentMonth, -1))}`;
  if (sel.period === "month" && sel.month) return `Collected for visits in ${named(sel.month)}`;
  return "Collected for visits this month";
}
