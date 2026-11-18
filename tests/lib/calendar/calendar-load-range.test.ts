import { describe, expect, it } from "vitest";
import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";
import { firstOfNextMonthString } from "@/lib/booking/month-grid";
import { calendarLoadRange, isCalendarAnchor, isCalendarView } from "@/lib/calendar/calendar-load-range";

// The one definition of "the range this view loads", shared by the page and the change probe.

const TZ = "America/Los_Angeles";

describe("calendarLoadRange", () => {
  it("day: local midnight to the next local midnight", () => {
    const { startUtc, endUtc } = calendarLoadRange("day", "2026-11-18", TZ);
    expect(startUtc.getTime()).toBe(utcInstantFromLocal("2026-11-18", "00:00", TZ).getTime());
    expect(endUtc.getTime()).toBe(utcInstantFromLocal("2026-11-19", "00:00", TZ).getTime());
  });
  it("week: seven local days, never 168 fixed hours (DST start and end weeks)", () => {
    for (const ws of ["2026-03-08", "2026-11-01"]) {
      const { startUtc, endUtc } = calendarLoadRange("week", ws, TZ);
      expect(endUtc.getTime()).toBe(utcInstantFromLocal(addDays(ws, 7), "00:00", TZ).getTime());
      expect(endUtc.getTime() - startUtc.getTime()).not.toBe(168 * 3_600_000);
    }
  });
  it("month: the first of the month to the first of the next, in the studio's zone", () => {
    for (const a of ["2026-11-01", "2026-12-01", "2026-02-01"]) {
      const { startUtc, endUtc } = calendarLoadRange("month", a, TZ);
      expect(startUtc.getTime()).toBe(utcInstantFromLocal(a, "00:00", TZ).getTime());
      expect(endUtc.getTime()).toBe(utcInstantFromLocal(firstOfNextMonthString(a), "00:00", TZ).getTime());
    }
  });
  it("a day boundary differs by zone, so the zone is part of the range", () => {
    expect(calendarLoadRange("day", "2026-11-18", "America/Toronto").startUtc.getTime()).not.toBe(
      calendarLoadRange("day", "2026-11-18", "America/Los_Angeles").startUtc.getTime(),
    );
  });
});

describe("what a caller may send", () => {
  it("only the three views", () => {
    for (const v of ["day", "week", "month"]) expect(isCalendarView(v)).toBe(true);
    for (const v of ["year", "", "DAY", null, undefined, 3]) expect(isCalendarView(v)).toBe(false);
  });
  it("only a real calendar date, never one that rolls over", () => {
    for (const a of ["2026-11-18", "2028-02-29"]) expect(isCalendarAnchor(a)).toBe(true);
    for (const a of ["2026-02-30", "2026-13-01", "2026-11-31", "2026-1-5", "18-11-2026", "2026-11-18T00:00", "", null, undefined, 20261118])
      expect(isCalendarAnchor(a)).toBe(false);
  });
});
