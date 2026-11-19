// HON-64 Slice A period: ONE calendar month in the STUDIO's timezone (the default until Sam decides otherwise).
// PURE. No clock, no timezone lookup: the caller supplies today's studio-local date. The half-open window is
// [startLocal, endLocalExclusive); converting each to an instant is `utcInstantFromLocal(date, "00:00", tz)` at the call site, TWICE,
// never "start + 30 days", because a DST day is 23 or 25 hours.

export type YearMonth = string; // "YYYY-MM"

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isYearMonth(v: string | undefined): v is YearMonth {
  return typeof v === "string" && YM.test(v);
}

/** The statement's calendar: from this month to the studio's current month. Wider values are never read. */
export const STATEMENT_MIN_MONTH: YearMonth = "2000-01";
/** A sanity ceiling for the loader only (the page's ceiling is the studio's current month). Keeps every date arithmetic call in range. */
export const STATEMENT_MAX_SANE_MONTH: YearMonth = "2999-12";

/** True for a well-formed month from January 2000 to `currentMonth` (the studio's current month, supplied by the caller). */
export function isStatementMonth(v: string | undefined, currentMonth: YearMonth): v is YearMonth {
  return isYearMonth(v) && v >= STATEMENT_MIN_MONTH && v <= currentMonth;
}

/**
 * The month the page shows for a requested one: the request when it is a valid month in range, otherwise the current month, with `fellBack`
 * true when something WAS requested but could not be honoured (so the page says so). An absent request is not a fallback.
 */
export function resolveStatementMonth(requested: string | string[] | undefined, currentMonth: YearMonth): { month: YearMonth; fellBack: boolean } {
  const value = Array.isArray(requested) ? requested[0] : requested;
  if (isStatementMonth(value, currentMonth)) return { month: value, fellBack: false };
  return { month: currentMonth, fellBack: value !== undefined };
}

export function yearMonthOf(localDate: string): YearMonth {
  return localDate.slice(0, 7);
}

export function shiftYearMonth(ym: YearMonth, delta: number): YearMonth {
  const m = YM.exec(ym);
  if (!m) throw new Error("not a YYYY-MM");
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`;
}

export function monthRange(ym: YearMonth): { startLocal: string; endLocalExclusive: string; label: string } {
  if (!isYearMonth(ym)) throw new Error("not a YYYY-MM");
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return {
    startLocal: `${ym}-01`,
    endLocalExclusive: `${shiftYearMonth(ym, 1)}-01`,
    label: `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`,
  };
}
