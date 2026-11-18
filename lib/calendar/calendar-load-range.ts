// PURE. The UTC range each calendar view loads its rows for, in ONE place.
//
// The page loads appointments, timed blocks and break occurrences for exactly this range, and the change probe
// (lib/calendar/change-probe-read.ts) reads the same range to decide whether what a screen shows is stale. If the two
// ever disagreed, the probe would report a change that the screen could never absorb. So both call this function: the
// page for what it draws, the probe route for what it fingerprints, and a client only ever sends the VIEW and its
// ANCHOR DATE, never instants.
//
//   day   anchor = the day            [anchor 00:00, anchor+1 00:00)
//   week  anchor = the week's first   [anchor 00:00, anchor+7 00:00)
//   month anchor = the month's first  [anchor 00:00, first of next month 00:00)
//
// all in the studio's timezone.

import { firstOfNextMonthString } from "@/lib/booking/month-grid";
import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";

export type CalendarView = "day" | "week" | "month";

export const CALENDAR_VIEWS: ReadonlyArray<CalendarView> = ["day", "week", "month"];

export function isCalendarView(raw: unknown): raw is CalendarView {
  return typeof raw === "string" && (CALENDAR_VIEWS as ReadonlyArray<string>).includes(raw);
}

/** A real calendar date in YYYY-MM-DD form: 2026-02-30 and 2026-13-01 are refused, not rolled over. */
export function isCalendarAnchor(raw: unknown): raw is string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function calendarLoadRange(
  view: CalendarView,
  anchor: string,
  timezone: string,
): { startUtc: Date; endUtc: Date } {
  const endLocal =
    view === "day" ? addDays(anchor, 1) : view === "week" ? addDays(anchor, 7) : firstOfNextMonthString(anchor);
  return {
    startUtc: utcInstantFromLocal(anchor, "00:00", timezone),
    endUtc: utcInstantFromLocal(endLocal, "00:00", timezone),
  };
}
