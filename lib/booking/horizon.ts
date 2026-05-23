import { addDays, localDateString } from "./tz";

// Public booking horizon. Applies to the public booking page and the
// public reschedule flow. Practitioner internal booking is not
// subject to this limit (owners can book farther out administratively).
export const BOOKING_HORIZON_DAYS = 90;

export type HorizonRange = {
  minDateStr: string;
  maxDateStr: string;
};

// Returns today and today + BOOKING_HORIZON_DAYS as YYYY-MM-DD
// strings in the studio's local calendar.
export function horizonRangeInStudioTz(tz: string): HorizonRange {
  const todayLocal = localDateString(new Date(), tz);
  return {
    minDateStr: todayLocal,
    maxDateStr: addDays(todayLocal, BOOKING_HORIZON_DAYS),
  };
}

// True if the given UTC instant falls on or after today AND on or
// before today + 90 days in the studio's local calendar. The check
// runs in the studio timezone so a late-evening Toronto booking is
// not rejected because UTC has rolled past midnight.
export function isWithinPublicBookingHorizon(
  instant: Date,
  tz: string,
): boolean {
  const dateStr = localDateString(instant, tz);
  const { minDateStr, maxDateStr } = horizonRangeInStudioTz(tz);
  return dateStr >= minDateStr && dateStr <= maxDateStr;
}
