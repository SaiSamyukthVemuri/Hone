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
// requires byte equality with the input. That round-trip is the AUTHORITY —
// any string that is not its own canonical rendering fails it, including every
// non-canonical spelling of a real date. `CANONICAL_DAY` below is a cheap
// pre-filter that documents the accepted shape; nothing here should be written
// to rely on it doing the rejecting.
//
// Every function is pure and takes the studio-local "today" as an argument.
// There is no clock read in this module, so a caller cannot accidentally
// introduce a second one.

/** The search param this module owns. */
export const DASHBOARD_DAY_PARAM = "day";

/**
 * How far from actual today the briefing may be pointed. A bounded horizon
 * keeps `9999-12-31` from issuing real queries, and matches the fact that this
 * is day-to-day navigation rather than arbitrary calendar browsing.
 *
 * ONE authority: the resolver clamps to it and the navigation controls are
 * derived from it, so a control can never offer a day the resolver rejects.
 */
export const DASHBOARD_DAY_MAX_OFFSET_DAYS = 365;

const CANONICAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in canonical form, or null. Never throws. */
export function parseDashboardDay(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!CANONICAL_DAY.test(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(probe.getTime())) return null;
  const canonical = probe.toISOString().slice(0, 10);
  // THE ROLLOVER CHECK. `2026-02-31` parses happily and comes back as
  // `2026-03-03`; only comparing the rendering to the input catches it.
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
  const { min, max } = dashboardDayBounds(todayLocal);
  // Lexicographic comparison is exact for canonical YYYY-MM-DD.
  if (parsed < min || parsed > max) return todayLocal;
  return parsed;
}

/** The inclusive navigable range, derived from the ONE horizon constant. */
export function dashboardDayBounds(todayLocal: string): {
  min: string;
  max: string;
} {
  return {
    min: addDays(todayLocal, -DASHBOARD_DAY_MAX_OFFSET_DAYS),
    max: addDays(todayLocal, DASHBOARD_DAY_MAX_OFFSET_DAYS),
  };
}

/**
 * Whether stepping one day back stays inside the navigable range.
 *
 * The controls must agree with the resolver BY CONSTRUCTION. A link that
 * targets a day the resolver rejects does not error — it falls back to today,
 * so pressing "Next" at the far edge would throw the practitioner a year
 * backwards with no explanation. That is a fine answer for a hand-typed
 * address and a terrible one for a button the product itself rendered.
 */
export function canNavigatePrevious(
  selectedDay: string,
  todayLocal: string,
): boolean {
  return previousDay(selectedDay) >= dashboardDayBounds(todayLocal).min;
}

/** Whether stepping one day forward stays inside the navigable range. */
export function canNavigateNext(
  selectedDay: string,
  todayLocal: string,
): boolean {
  return nextDay(selectedDay) <= dashboardDayBounds(todayLocal).max;
}

/** True when the briefing is describing the real present day. */
export function isViewingToday(
  selectedDay: string,
  todayLocal: string,
): boolean {
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
  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

export function previousDay(day: string): string {
  return addDays(day, -1);
}

export function nextDay(day: string): string {
  return addDays(day, 1);
}

/**
 * "Thursday, August 27".
 *
 * Formatted from the bare date in UTC, so the label cannot shift a day: the
 * string already IS the studio-local date, and re-interpreting it in any other
 * zone is what would introduce an offset.
 */
export function formatSelectedDayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** The section heading: "Today", "Tomorrow", or the dated label. */
export function dayHeading(selectedDay: string, todayLocal: string): string {
  if (selectedDay === todayLocal) return "Today";
  if (selectedDay === nextDay(todayLocal)) return "Tomorrow";
  return formatSelectedDayLabel(selectedDay);
}

/**
 * The empty-roster sentence for the day on screen.
 *
 * The today branch returns the EXACT pre-existing literal, unchanged. The other
 * branches exist because "No appointments today." is simply false when the
 * briefing is showing another day.
 */
export function emptyDayMessage(
  selectedDay: string,
  todayLocal: string,
): string {
  if (selectedDay === todayLocal) return "No appointments today.";
  if (selectedDay === nextDay(todayLocal)) return "No appointments tomorrow.";
  return `No appointments on ${formatSelectedDayLabel(selectedDay)}.`;
}
