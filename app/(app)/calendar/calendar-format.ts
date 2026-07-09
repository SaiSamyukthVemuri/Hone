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

// Google-style visible week range label from two YYYY-MM-DD strings:
//   same month   -> "Jul 7 – 13, 2026"
//   same year    -> "Jun 29 – Jul 5, 2026"
//   cross year   -> "Dec 29, 2025 – Jan 4, 2026"
// Pure string math (no Date construction) so it never drifts across timezones.
export function weekRangeLabel(startStr: string, endStr: string): string {
  const sM = parseInt(startStr.slice(5, 7), 10);
  const sD = parseInt(startStr.slice(8, 10), 10);
  const sY = startStr.slice(0, 4);
  const eM = parseInt(endStr.slice(5, 7), 10);
  const eD = parseInt(endStr.slice(8, 10), 10);
  const eY = endStr.slice(0, 4);
  const sMonth = MONTHS_SHORT[sM - 1] ?? "";
  const eMonth = MONTHS_SHORT[eM - 1] ?? "";
  if (sY !== eY) {
    return `${sMonth} ${sD}, ${sY} – ${eMonth} ${eD}, ${eY}`;
  }
  if (sM !== eM) {
    return `${sMonth} ${sD} – ${eMonth} ${eD}, ${eY}`;
  }
  return `${sMonth} ${sD} – ${eD}, ${eY}`;
}

// Hour-of-day → "8 AM" / "12 PM" / "1 PM". Used by the left time rail.
export function formatHourLabel(hour24: number): string {
  const period = hour24 >= 12 ? "PM" : "AM";
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12} ${period}`;
}

// Block / break display labels. These live here (not DayColumn.tsx) so the
// server-rendered month view (MonthView + calendar/page.tsx renderMonthView)
// can resolve the same labels the week view shows without crossing the client
// boundary. The week view (DayColumn) imports the same source of truth.

// Timed-block category → display label (categories stored lowercase).
export const TIMED_BLOCK_LABEL: Record<string, string> = {
  lunch: "Lunch",
  break: "Break",
  meeting: "Meeting",
  emergency: "Emergency",
  personal: "Personal",
  training: "Training",
  admin: "Admin",
  other: "Unavailable",
};

// Migration 0037 (Breaks & blocks cleanup) widened the recurring-break label
// column to free text. KNOWN_RECURRING_BREAK_LABELS keeps the old enum values
// rendering with their pre-existing capitalized display ("lunch" → "Lunch").
// Custom labels typed by the practitioner ("Dinner", "School pickup") fall
// through and preserve their casing.
const KNOWN_RECURRING_BREAK_LABELS: Record<string, string> = {
  lunch: "Lunch",
  break: "Break",
  admin: "Admin",
  other: "Break",
};

export function displayRecurringBreakLabel(
  rawLabel: string | null | undefined,
): string {
  if (!rawLabel) return "Break";
  const t = rawLabel.trim();
  if (t.length === 0) return "Break";
  const known = KNOWN_RECURRING_BREAK_LABELS[t.toLowerCase()];
  if (known) return known;
  // Custom label: preserve practitioner-supplied casing, but capitalize the
  // first letter for tidy display if it was typed all-lowercase.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Full-day blockout display label: the practitioner-entered reason, or the
// generic "Blocked" fallback when no reason was given.
export function displayBlockoutLabel(reason: string | null | undefined): string {
  const t = reason?.trim();
  return t && t.length > 0 ? t : "Blocked";
}

// Compact appointment time range for a calendar card: two "HH:MM" (24-hour)
// local labels → "9:00–10:00" (leading zero on the hour stripped, en dash, no
// AM/PM to stay dense). Pure string formatting — no Date construction, so it
// can't drift across timezones (callers pass already-localized labels). Falls
// back to just the start when the end is missing/blank.
export function timeRangeLabel(
  start24: string,
  end24: string | null | undefined,
): string {
  const strip = (t: string) => t.replace(/^0(?=\d:)/, "");
  const start = strip(start24);
  const end = end24?.trim() ? strip(end24) : "";
  return end ? `${start}–${end}` : start;
}
