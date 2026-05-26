import { addDays, localDateString } from "./tz";

// Public booking horizon. Applies to the public booking page and the
// public reschedule flow. Practitioner internal booking (the calendar-
// first drawer in /calendar) is NOT subject to this limit — owners can
// book farther out administratively.
//
// Migration 0036 (Booking Horizon v1) made this per-studio: each studio
// chooses 3, 4, or 6 months. Default 3 when a caller can't supply a
// studio for some reason. The minimum and maximum are deliberately
// narrow so the recurring-break materialization horizon (cron +
// per-rule on create) can be bumped to the maximum (6 months ≈ 180
// days) without growing unbounded.

export const PUBLIC_BOOKING_HORIZON_MONTHS_VALUES = [3, 4, 6] as const;
export type PublicBookingHorizonMonths =
  (typeof PUBLIC_BOOKING_HORIZON_MONTHS_VALUES)[number];

export const DEFAULT_PUBLIC_BOOKING_HORIZON_MONTHS: PublicBookingHorizonMonths = 3;

// Conservative "month" length in days. We use 31 so a "3 months" choice
// always covers at least 3 calendar months even when the last span
// contains a 31-day month. This matches the spirit of the previous
// hardcoded 90 — slightly more generous, never less.
const DAYS_PER_HORIZON_MONTH = 31;

export function horizonDaysForMonths(
  months: PublicBookingHorizonMonths,
): number {
  return months * DAYS_PER_HORIZON_MONTH;
}

// Fail-safe coerce: an unknown value (caller forgot to pass, DB has
// drifted, etc.) gets the default 3. Keeps the booking page rendering
// rather than crashing.
function normalizeMonths(
  months: number | null | undefined,
): PublicBookingHorizonMonths {
  if (months === 3 || months === 4 || months === 6) return months;
  return DEFAULT_PUBLIC_BOOKING_HORIZON_MONTHS;
}

export type HorizonRange = {
  minDateStr: string;
  maxDateStr: string;
};

// Returns today and today + (months * 31 days) as YYYY-MM-DD strings
// in the studio's local calendar.
export function horizonRangeInStudioTz(
  tz: string,
  months: number | null | undefined,
): HorizonRange {
  const m = normalizeMonths(months);
  const todayLocal = localDateString(new Date(), tz);
  return {
    minDateStr: todayLocal,
    maxDateStr: addDays(todayLocal, horizonDaysForMonths(m)),
  };
}

// True if the given UTC instant falls on or after today AND on or
// before today + horizon in the studio's local calendar. The check
// runs in the studio timezone so a late-evening Toronto booking is
// not rejected because UTC has rolled past midnight.
export function isWithinPublicBookingHorizon(
  instant: Date,
  tz: string,
  months: number | null | undefined,
): boolean {
  const dateStr = localDateString(instant, tz);
  const { minDateStr, maxDateStr } = horizonRangeInStudioTz(tz, months);
  return dateStr >= minDateStr && dateStr <= maxDateStr;
}
