import { describe, expect, it } from "vitest";

import { lastMonthMidInstant, studioLocalYearMonth, studioMonths } from "../../e2e/helpers/studio-months";

// The browser specs derive "this month" and "last month" from the STUDIO's local date, as the page does. At 23:30 UTC on the last day of a month a studio in
// UTC+10..+12 is already in the NEXT month, and UTC itself is not: deriving from UTC made a correct build fail for about three hours a month.
describe("studioMonths", () => {
  const lastUtcDay = new Date("2026-11-30T23:30:00Z");
  it("a studio ahead of UTC is already in the next month at 23:30 UTC on the last day", () => {
    for (const tz of ["Pacific/Auckland", "Pacific/Fiji", "Australia/Sydney", "Pacific/Kiritimati"]) {
      expect(studioMonths(lastUtcDay, tz), tz).toMatchObject({ thisYm: "2026-12", lastYm: "2026-11" });
    }
  });
  it("UTC and a studio behind UTC are still in the old month", () => {
    expect(studioMonths(lastUtcDay, "UTC")).toMatchObject({ thisYm: "2026-11", lastYm: "2026-10" });
    expect(studioMonths(lastUtcDay, "America/Toronto")).toMatchObject({ thisYm: "2026-11", lastYm: "2026-10" });
  });
  it("crosses a year boundary both ways", () => {
    expect(studioMonths(new Date("2026-12-31T23:30:00Z"), "Pacific/Auckland")).toEqual({ thisYm: "2027-01", lastYm: "2026-12", lastYear: 2026, lastMonthNumber: 12 });
    expect(studioMonths(new Date("2026-01-01T02:00:00Z"), "America/Toronto")).toEqual({ thisYm: "2025-12", lastYm: "2025-11", lastYear: 2025, lastMonthNumber: 11 });
    expect(studioMonths(new Date("2026-01-15T12:00:00Z"), "UTC")).toMatchObject({ thisYm: "2026-01", lastYm: "2025-12", lastYear: 2025 });
  });
  it("the middle of last month is inside last month's calendar for every zone", () => {
    const m = studioMonths(lastUtcDay, "Pacific/Auckland");
    for (const tz of ["Pacific/Auckland", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      const { year, month } = studioLocalYearMonth(lastMonthMidInstant(m), tz);
      expect(`${year}-${String(month).padStart(2, "0")}`, tz).toBe(m.lastYm);
    }
  });
});
