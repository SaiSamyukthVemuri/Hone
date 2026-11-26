// The studio's CALENDAR, not UTC's. The page decides "this month" from the studio's LOCAL date, and a seeded studio's zone can be a day ahead of UTC
// (the seed keeps the studio clock near 09:00, so from 21:00 UTC the zone is UTC+10 to +12 and its date is already tomorrow). A spec that derives its
// months from UTC fails on a correct build for those hours on the last UTC day of a month. PURE: no I/O, no Playwright.

export type StudioMonths = {
  /** "YYYY-MM" of the studio's current month. */
  thisYm: string;
  /** "YYYY-MM" of the month before it. */
  lastYm: string;
  lastYear: number;
  /** 1-12 */
  lastMonthNumber: number;
};

/** The studio-local year and month of an instant, from Intl with the studio's own zone. */
export function studioLocalYearMonth(at: Date, timezone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(at);
  return { year: Number(parts.find((p) => p.type === "year")!.value), month: Number(parts.find((p) => p.type === "month")!.value) };
}

export function studioMonths(now: Date, timezone: string): StudioMonths {
  const { year, month } = studioLocalYearMonth(now, timezone);
  const lastYear = month === 1 ? year - 1 : year;
  const lastMonthNumber = month === 1 ? 12 : month - 1;
  const ym = (y: number, m: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
  return { thisYm: ym(year, month), lastYm: ym(lastYear, lastMonthNumber), lastYear, lastMonthNumber };
}

/** Noon-ish on the 15th of last month, in UTC: a safe instant inside last month in every zone. */
export function lastMonthMidInstant(m: StudioMonths): Date {
  return new Date(Date.UTC(m.lastYear, m.lastMonthNumber - 1, 15, 15, 0, 0));
}
