// Pure, server-safe calendar formatting helpers.
//
// IMPORTANT: these live here and NOT in DayColumn.tsx. DayColumn.tsx is a
// "use client" module, and its exports cross the client boundary. A
// Server Component (calendar/page.tsx) can read plain VALUES exported
// from a client module, but CALLING a function imported across that
// boundary throws at runtime ("Attempted to call X() from the server but
// X is on the client"). page.tsx renders the week header + hour rail on
// the server, so the formatters it calls must be in a plain module.

export const DAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// Two-line day header (Google/Fresha style): "Tue" on line 1, "May 26"
// on line 2. Split into two formatters so the header can stack them.
// Pure string formatting — no Date construction, so it can't drift across
// timezones.
export function weekdayLabel(dowIndex: number): string {
  return DAY_LABELS[dowIndex] ?? "";
}

export function monthDayLabel(date: string): string {
  const month = parseInt(date.slice(5, 7), 10);
  const day = parseInt(date.slice(8, 10), 10);
  const monthLabel = MONTHS_SHORT[month - 1] ?? "";
  return `${monthLabel} ${day}`;
}

// Hour-of-day → "8 AM" / "12 PM" / "1 PM". Used by the left time rail.
export function formatHourLabel(hour24: number): string {
  const period = hour24 >= 12 ? "PM" : "AM";
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12} ${period}`;
}
