import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PUBLIC_BOOKING_HORIZON_MONTHS_VALUES,
  DEFAULT_PUBLIC_BOOKING_HORIZON_MONTHS,
  horizonDaysForMonths,
  maxPublicBookingHorizonDays,
  horizonRangeInStudioTz,
  isWithinPublicBookingHorizon,
} from "@/lib/booking/horizon";

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
// Count of calendar days between two YYYY-MM-DD strings.
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
const TZ = "America/Toronto";

describe("horizon presets widened to 1..12", () => {
  it("exposes every whole month 1..12 (drives the UI + validation + type)", () => {
    expect([...PUBLIC_BOOKING_HORIZON_MONTHS_VALUES]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(DEFAULT_PUBLIC_BOOKING_HORIZON_MONTHS).toBe(3); // default unchanged
  });
  it("max horizon days = 12 * 31 = 372 (single source for the safety bounds)", () => {
    expect(maxPublicBookingHorizonDays()).toBe(372);
    expect(horizonDaysForMonths(12)).toBe(372);
    expect(horizonDaysForMonths(1)).toBe(31);
  });
});

describe("horizonRangeInStudioTz respects 1..12 and is timezone-correct", () => {
  it("a 12-month horizon spans 372 days; a 1-month horizon spans 31", () => {
    const r12 = horizonRangeInStudioTz(TZ, 12);
    expect(daysBetween(r12.minDateStr, r12.maxDateStr)).toBe(372);
    const r1 = horizonRangeInStudioTz(TZ, 1);
    expect(daysBetween(r1.minDateStr, r1.maxDateStr)).toBe(31);
    // range is anchored to "today" in the studio tz (min is a valid date string)
    expect(r12.minDateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("out-of-range values coerce to the default (3 months = 93 days), never crash", () => {
    for (const bad of [0, 13, -1, 3.5]) {
      const r = horizonRangeInStudioTz(TZ, bad);
      expect(daysBetween(r.minDateStr, r.maxDateStr)).toBe(93);
    }
  });
  it("isWithinPublicBookingHorizon holds across a 12-month window (final booking gate)", () => {
    const { minDateStr, maxDateStr } = horizonRangeInStudioTz(TZ, 12);
    // a day near the far edge of a 12-month horizon is still within it
    const near = new Date(`${maxDateStr}T12:00:00Z`);
    expect(isWithinPublicBookingHorizon(near, TZ, 12)).toBe(true);
    // but rejected under a 1-month horizon
    expect(isWithinPublicBookingHorizon(near, TZ, 1)).toBe(false);
    expect(minDateStr <= maxDateStr).toBe(true);
  });
});

describe("downstream bounds derive from the max horizon (no truncation)", () => {
  const BOOK = read("app/book/[slug]/actions.ts");
  const RESCHED = read("app/reschedule/[token]/actions.ts");
  const CRON = read("app/api/cron/materialize-recurring-breaks/route.ts");
  const RFORM = read("app/reschedule/[token]/RescheduleForm.tsx");
  const SETTINGS = read("app/(app)/settings/booking/page.tsx");

  it("next-available scan caps derive from maxPublicBookingHorizonDays() (cover 12 months)", () => {
    expect(BOOK).toMatch(/MAX_NEXT_AVAILABLE_SCAN_DAYS = maxPublicBookingHorizonDays\(\) \+ 14/);
    expect(RESCHED).toMatch(/MAX_NEXT_AVAILABLE_SCAN_DAYS = maxPublicBookingHorizonDays\(\) \+ 14/);
    expect(BOOK).not.toMatch(/MAX_NEXT_AVAILABLE_SCAN_DAYS = 200/);
  });
  it("recurring-break materialization window derives from the max horizon too", () => {
    expect(CRON).toMatch(/HORIZON_DAYS = maxPublicBookingHorizonDays\(\) \+ 14/);
    expect(CRON).not.toMatch(/HORIZON_DAYS = 186/);
  });
  it("the reschedule client picker accepts 1..12", () => {
    expect(RFORM).toMatch(/months >= 1 && months <= 12/);
  });
  it("final booking validation is preserved (isWithinPublicBookingHorizon still gates the book)", () => {
    expect(BOOK).toMatch(/isWithinPublicBookingHorizon\(/);
  });
  it("settings UI renders the presets from the single VALUES source (1..12) with clean copy", () => {
    expect(SETTINGS).toMatch(/PUBLIC_BOOKING_HORIZON_MONTHS_VALUES\.map/);
    expect(SETTINGS).toMatch(/\{m\} month\{m === 1 \? "" : "s"\}/);
  });
});
