import { addDays, localDateString } from "./tz";

// Public booking horizon. Applies to the public booking page and the
// public reschedule flow. Practitioner internal booking (the calendar-
// first drawer in /calendar) is NOT subject to this limit — owners can
// book farther out administratively.
//
// Migration 0036 (Booking Horizon v1) made this per-studio; migration 0112
// (Booking Horizon v2) widened the presets to any whole month from 1 to 12.
// Default 3 when a caller can't supply a studio for some reason. The maximum
// (12 months) is a deliberate, safe upper bound: the recurring-break
// materialization horizon (cron) and the public next-available scan cap are
// both DERIVED from maxPublicBookingHorizonDays() below, so they always cover
// the largest configurable horizon and can never drift below it.

export const PUBLIC_BOOKING_HORIZON_MONTHS_VALUES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
] as const;
export type PublicBookingHorizonMonths =
  (typeof PUBLIC_BOOKING_HORIZON_MONTHS_VALUES)[number];

export const DEFAULT_PUBLIC_BOOKING_HORIZON_MONTHS: PublicBookingHorizonMonths = 3;

// Conservative "month" length in days. We use 31 so an "N months" choice
// always covers at least N calendar months even when a span contains a 31-day
// month. This matches the spirit of the previous hardcoded 90 — slightly more
// generous, never less.
const DAYS_PER_HORIZON_MONTH = 31;

export function horizonDaysForMonths(
  months: PublicBookingHorizonMonths,
): number {
  return months * DAYS_PER_HORIZON_MONTH;
}

// The longest horizon any studio can configure, in days (largest preset * 31 =
// 12 * 31 = 372). Single source of truth for the downstream safety bounds — the
// next-available scan cap and the recurring-break materialization window both
// derive from this, so widening the preset list automatically extends them and
// they can never fall below the maximum bookable horizon.
export function maxPublicBookingHorizonDays(): number {
  return (
    Math.max(...PUBLIC_BOOKING_HORIZON_MONTHS_VALUES) * DAYS_PER_HORIZON_MONTH
  );
}

// Fail-safe coerce: an unknown/out-of-range value (caller forgot to pass, DB
// has drifted, etc.) gets the default. Keeps the booking page rendering rather
// than crashing. Accepts any whole month 1..12.
function normalizeMonths(
  months: number | null | undefined,
): PublicBookingHorizonMonths {
  if (
    typeof months === "number" &&
    Number.isInteger(months) &&
    months >= 1 &&
    months <= 12
  ) {
    return months as PublicBookingHorizonMonths;
  }
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
