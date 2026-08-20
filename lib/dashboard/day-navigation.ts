import { addDays } from "@/lib/booking/tz";

// ===========================================================================
// DASHBOARD DAY NAVIGATION — pure, server-driven, studio-local
// ===========================================================================
//
// Chloe: "I want an option to go to the next day." The Dashboard briefing stays
// a one-day briefing; only WHICH day it describes becomes navigable, via a
// `?day=YYYY-MM-DD` search param so the URL is shareable and browser Back works
// without any client-side date state.
//
// WHY THE VALIDATION HERE IS CALENDAR-AWARE AND NOT A SHAPE REGEX.
//
// `day` is browser-controlled and flows into `utcInstantFromLocal` and
// `addDays`. Both are total only for real dates, and they fail in two DIFFERENT
// and equally unacceptable ways:
//
//   * `2026-02-31` matches every shape regex in this repository and SILENTLY
//     rolls over to 2026-03-03. The header would name one day while the roster
//     queried another, and stepping onward would compound the drift.
//   * `2026-8-2`, `2026-13-01` and a bare timestamp THROW RangeError. This page
//     is an async Server Component with no local boundary, so that is a 500 for
//     the whole Dashboard from a hand-typed URL.
//
// Shape alone cannot separate those, so this re-formats the parsed date and
// requires byte equality with the input. That is the only check that rejects a
// rollover. Nothing invalid ever reaches a date helper: it falls back to the
// studio's actual today.
//
// The round-trip is the AUTHORITY; `CANONICAL_DAY` is a cheap pre-filter that
// documents the accepted shape and short-circuits obvious junk. A mutation run
// confirmed this honestly: deleting the regex killed no test, because any
// string that is not its own canonical rendering already fails the round-trip.
// It is kept for readability, not for safety, and nothing should be added here
// that relies on it doing the rejecting.
//
// Every function here is pure and takes the studio-local "today" as an
// argument. There is no clock read in this module, so a caller cannot
// accidentally introduce a second one.

/** The search param this module owns. */
export const DASHBOARD_DAY_PARAM = "day";

/**
 * How far from actual today the briefing may be pointed. A bounded horizon
 * keeps `9999-12-31` from issuing real queries, and matches the fact that this
 * is day-to-day navigation rather than arbitrary calendar browsing.
 */
export const DASHBOARD_DAY_MAX_OFFSET_DAYS = 365;

const CANONICAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict: canonical shape, a REAL calendar date, and byte-identical when
 * re-formatted. Returns null for everything else — never throws.
 *
 * Handles `string[]` because Next hands `?day=a&day=b` through as an array;
 * the first usable value wins, mirroring the calendar's existing posture.
 */
export function parseDashboardDay(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!CANONICAL_DAY.test(trimmed)) return null;

  const [y, m, d] = trimmed.split("-").map(Number);
  // Construct in UTC so no server/local timezone can shift the components.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(probe.getTime())) return null;

  // THE ROLLOVER CHECK. `Date.UTC(2026, 1, 31)` happily yields March 3, so the
  // only way to reject an impossible date is to ask what the date actually is
  // and require it to be what was asked for.
  const canonical = probe.toISOString().slice(0, 10);
  return canonical === trimmed ? canonical : null;
}

/**
 * The day the briefing describes. Falls back to the studio's actual today for
 * anything absent, malformed, impossible, or beyond the horizon.
 */
export function resolveSelectedDay(
  raw: string | string[] | undefined,
  todayLocal: string,
): string {
  const parsed = parseDashboardDay(raw);
  if (parsed === null) return todayLocal;
  const min = addDays(todayLocal, -DASHBOARD_DAY_MAX_OFFSET_DAYS);
  const max = addDays(todayLocal, DASHBOARD_DAY_MAX_OFFSET_DAYS);
  // Lexicographic comparison is exact for canonical YYYY-MM-DD.
  if (parsed < min || parsed > max) return todayLocal;
  return parsed;
}

/** True when the briefing is describing the real present day. */
export function isViewingToday(selectedDay: string, todayLocal: string): boolean {
  return selectedDay === todayLocal;
}

/**
 * A Dashboard URL for one day, preserving any other supported param.
 *
 * `day` is OMITTED when it is actual today, so the canonical Dashboard URL
 * stays `/dashboard` and a bookmark never pins a date that goes stale
 * overnight. `period` is carried through in both directions: dropping it would
 * silently reset a practitioner's practice-snapshot selection back to the
 * default, with no error and no visual cue beyond the numbers changing.
 */
export function dashboardDayHref(args: {
  day: string;
  todayLocal: string;
  period?: string | null;
}): string {
  const params = new URLSearchParams();
  if (args.period) params.set("period", args.period);
  if (args.day !== args.todayLocal) params.set(DASHBOARD_DAY_PARAM, args.day);
  const qs = params.toString();
  return qs ? `/dashboard?${qs}` : "/dashboard";
}

/** Previous / next day as canonical local date strings. */
export function previousDay(day: string): string {
  return addDays(day, -1);
}
export function nextDay(day: string): string {
  return addDays(day, 1);
}

/**
 * Studio-local long label, e.g. "Thursday, August 27".
 *
 * Formatted in UTC from the bare date components on purpose: a plain date
 * string carries no instant, so rendering it in any other zone can shift it by
 * a day. The year is omitted because this is day-to-day navigation within a
 * bounded horizon; the weekday is what a practitioner actually scans for.
 */
export function formatSelectedDayLabel(day: string): string {
  const m = CANONICAL_DAY.exec(day);
  if (!m) return day;
  const [y, mo, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, mo - 1, d)));
}

/**
 * The heading for the briefing. "Today" and "Tomorrow" are what a practitioner
 * thinks in; anything further out gets the actual date, because "in 3 days" is
 * a puzzle rather than a label.
 */
export function dayHeading(selectedDay: string, todayLocal: string): string {
  if (selectedDay === todayLocal) return "Today";
  if (selectedDay === addDays(todayLocal, 1)) return "Tomorrow";
  return formatSelectedDayLabel(selectedDay);
}

/**
 * Empty-state sentence for the selected day.
 *
 * The today branch returns the EXACT pre-existing literal, unchanged: it is
 * pinned by source-grep tests and by the browser suite, and more importantly it
 * is already the right words. The other branches exist because "No appointments
 * today." is simply false when the briefing is showing tomorrow.
 */
export function emptyDayMessage(selectedDay: string, todayLocal: string): string {
  if (selectedDay === todayLocal) return "No appointments today.";
  if (selectedDay === addDays(todayLocal, 1)) return "No appointments tomorrow.";
  return `No appointments on ${formatSelectedDayLabel(selectedDay)}.`;
}
