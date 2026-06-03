// Plain, server-safe helpers for the calendar month view.
//
// All values are 'YYYY-MM-DD' strings (the same string shape every
// other calendar surface uses) so a downstream consumer can hand
// them to startOfWeek / addDays / utcInstantFromLocal from
// lib/booking/tz.ts without converting through Date. There is no
// timezone math in this module: a "YYYY-MM-DD" string is a calendar
// date label independent of timezone, and the caller is responsible
// for asking todayInTz(studio.timezone) when it needs "today" in the
// studio timezone.
//
// The grid this module describes is the classic 6-row, Sunday-start
// month grid: every month produces exactly 42 cells, so the layout
// is constant across short (28-day) and long (31-day) months and the
// previous/next month spillover days are visible for orientation.
//
// What this file does NOT do:
//   * No DB access. No createClient. Safe to import from any client
//     or server component.
//   * No booking math, no slot generation, no availability logic.
//     This is layout-only; the booking engine and public booking
//     remain entirely untouched.

import { addDays, startOfWeek } from "./tz";

// Parse a YYYY-MM-DD string into its (year, month, day) parts. Throws
// on malformed input rather than silently returning a sentinel; the
// month view always passes a server-validated string into this
// module, so any failure here is a caller bug we want loud.
export function parseDateString(dateStr: string): {
  year: number;
  month: number; // 1-12
  day: number;
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) {
    throw new Error(`Invalid YYYY-MM-DD date string: ${dateStr}`);
  }
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
  };
}

// Format (year, month, day) back into a YYYY-MM-DD string. Pads with
// leading zeros so January 5th becomes "2026-01-05", not "2026-1-5".
function formatYmd(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// First day of the month containing the given date, as YYYY-MM-DD.
export function firstOfMonthString(dateStr: string): string {
  const { year, month } = parseDateString(dateStr);
  return formatYmd(year, month, 1);
}

// First day of the next month following the given date. Used to derive
// the UTC end-of-range for appointment queries (caller hands this to
// utcInstantFromLocal with the studio timezone and "00:00").
export function firstOfNextMonthString(dateStr: string): string {
  const { year, month } = parseDateString(dateStr);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return formatYmd(nextYear, nextMonth, 1);
}

// First day of the previous month relative to the given date. Used
// for the "previous month" navigation link.
export function firstOfPreviousMonthString(dateStr: string): string {
  const { year, month } = parseDateString(dateStr);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return formatYmd(prevYear, prevMonth, 1);
}

// Build the 6-week (42-cell) Sunday-start grid for the month
// containing `dateStr`. Returns the ordered date strings; the
// caller divides into 6 rows of 7 columns for rendering. The first
// cell is the Sunday on or before the 1st of the month; the last
// cell is the Saturday on or after the 1st of the next month minus
// one day.
//
// Returning 42 every time keeps the grid layout stable: months that
// fit in 5 weeks still get a sixth row of next-month dates so the
// grid height does not jump as the user navigates. This matches
// Google/Apple/Fresha calendars.
export function monthGridDates(dateStr: string): string[] {
  const first = firstOfMonthString(dateStr);
  const gridStart = startOfWeek(first);
  const out: string[] = [];
  let cursor = gridStart;
  for (let i = 0; i < 42; i += 1) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

// Pretty label for the month-and-year header, "June 2026".
// Intl.DateTimeFormat with timeZone="UTC" so the labelling never
// drifts by a day at month boundaries; the date string parts are
// the source of truth.
export function monthYearLabel(dateStr: string): string {
  const { year, month } = parseDateString(dateStr);
  // Day 15 sits safely inside every month; we just want the month
  // name + year, and using the 15th avoids the day rolling backward
  // through DST changes in a stray timezone.
  const utc = new Date(Date.UTC(year, month - 1, 15));
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utc);
}

// Day-of-month integer for a YYYY-MM-DD string. Used to render the
// day number inside each cell.
export function dayOfMonth(dateStr: string): number {
  return parseDateString(dateStr).day;
}

// True when the date string is inside the month-of-interest (i.e.
// not a spillover day from the previous or next month). The caller
// uses this to dim/soften the spillover cells.
export function isInMonth(cellDate: string, monthAnchor: string): boolean {
  const cell = parseDateString(cellDate);
  const anchor = parseDateString(monthAnchor);
  return cell.year === anchor.year && cell.month === anchor.month;
}
