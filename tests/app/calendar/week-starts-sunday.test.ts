import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, startOfWeek, utcInstantFromLocal } from "@/lib/booking/tz";
import { DAY_LABELS, weekdayLabel } from "@/app/(app)/calendar/calendar-format";
import { monthGridDates } from "@/lib/booking/month-grid";

// The practitioner calendar week runs SUNDAY → SATURDAY, and the SAME Sunday
// boundary drives display, the data range, and navigation.
//
// WHY THIS FILE EXISTS
// --------------------
// This behaviour was already correct, `startOfWeek` has returned "the Sunday
// on or before" since its first commit, but it was almost entirely UNTESTED.
// A cosmetic header reorder, or a fetch range that quietly went back to
// Monday, would have shipped green. The failure mode that matters is not
// "headers look wrong"; it is a SUNDAY APPOINTMENT SILENTLY DISAPPEARING
// because the grid starts Sunday while the query still starts Monday. That is
// invisible in a screenshot and invisible in a header test.
//
// So this file locks the boundary in all three places at once, plus the DST
// semantics: a week is [Sunday local midnight, next Sunday local midnight),
// NEVER "start + 168 hours".
//
// Nothing here is a settings/locale preference. The practitioner calendar has
// a FIXED Sunday-start week.
//
// SCOPE, this note used to say Hone was NOT Sunday-first everywhere, because
// `lib/dashboard/practice-metrics.ts` anchored its "this week" REPORTING period
// on MONDAY (`const sinceMonday = (dow + 6) % 7`). It called reconciling them
// "a product call, not a refactor", and it was right.
//
// THAT PRODUCT CALL HAS NOW BEEN MADE (Dashboard V2 Part 1). The consequence
// this note warned about, on a Sunday, the dashboard's "this week" and the
// calendar's week differed by a FULL WEEK, because Sunday was day 7 of one and
// day 1 of the other, is closed: `resolvePeriodRange` now delegates to the
// SAME `startOfWeek` helper asserted throughout this file, so there is exactly
// one Sunday boundary in the product. The dashboard's own boundary cases live
// in tests/lib/dashboard/practice-metrics-week.test.ts.

const TZ = "America/Toronto"; // the repo's established DST fixture timezone
const CAL_PAGE = readFileSync(
  join(process.cwd(), "app/(app)/calendar/page.tsx"),
  "utf8",
);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Name the weekday of a YYYY-MM-DD independently of the code under test, so a
// broken startOfWeek cannot also define what "Sunday" means.
function weekdayOf(dateStr: string): string {
  return DOW[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}
function weekDays(anchor: string): string[] {
  const ws = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
}

// ---------------------------------------------------------------------------
// 1-3. Selected-date semantics: any day in the week resolves to ITS Sunday.
// ---------------------------------------------------------------------------
describe("selected date → week start", () => {
  it("1. Sunday selected: that same Sunday is the week start", () => {
    expect(startOfWeek("2026-08-09")).toBe("2026-08-09");
    expect(weekdayOf("2026-08-09")).toBe("Sun");
  });

  it("2. Monday selected: the PREVIOUS day's Sunday", () => {
    expect(startOfWeek("2026-08-10")).toBe("2026-08-09");
    expect(weekdayOf("2026-08-10")).toBe("Mon");
  });

  it("3. Saturday selected: the previous Sunday, six days back", () => {
    expect(startOfWeek("2026-08-15")).toBe("2026-08-09");
    expect(weekdayOf("2026-08-15")).toBe("Sat");
  });

  it("the brief's worked example: Wed 2026-08-12 → Sun 2026-08-09", () => {
    expect(startOfWeek("2026-08-12")).toBe("2026-08-09");
  });

  it("every day of one week resolves to the SAME Sunday, and it is a Sunday", () => {
    const week = weekDays("2026-08-12");
    for (const d of week) {
      expect(startOfWeek(d)).toBe("2026-08-09");
    }
    expect(weekdayOf(startOfWeek("2026-08-12"))).toBe("Sun");
  });

  it("startOfWeek is idempotent (the page normalizes a ?day= twice)", () => {
    for (const d of ["2026-08-09", "2026-08-12", "2026-08-15"]) {
      expect(startOfWeek(startOfWeek(d))).toBe(startOfWeek(d));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Display order.
// ---------------------------------------------------------------------------
describe("display order", () => {
  it("4. the seven visible days run Sunday → Saturday", () => {
    expect(weekDays("2026-08-12").map(weekdayOf)).toEqual([
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ]);
  });

  it("4. the header labels are Sunday-first and index-aligned to the days", () => {
    expect([...DAY_LABELS]).toEqual([
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ]);
    // page.tsx renders `weekdayLabel(i)` against `days[i]`. The label is
    // therefore only truthful while days[0] is a Sunday, assert the two
    // agree, which is exactly what a Monday-start regression would break.
    weekDays("2026-08-12").forEach((date, i) => {
      expect(weekdayLabel(i)).toBe(weekdayOf(date));
    });
  });

  it("4. the month grid's first column is also Sunday", () => {
    const cells = monthGridDates("2026-08-01");
    expect(weekdayOf(cells[0])).toBe("Sun");
    expect(cells.length % 7).toBe(0);
    // ...and every 7th cell thereafter starts a new Sunday row.
    for (let i = 0; i < cells.length; i += 7) {
      expect(weekdayOf(cells[i])).toBe("Sun");
    }
  });
});

// ---------------------------------------------------------------------------
// 5-7. The DATA RANGE uses the same boundary. This is the anti-cosmetic core.
// ---------------------------------------------------------------------------
describe("data range", () => {
  // Mirrors app/(app)/calendar/page.tsx exactly.
  function range(anchor: string, tz: string) {
    const weekStart = startOfWeek(anchor);
    return {
      weekStart,
      startUtc: utcInstantFromLocal(weekStart, "00:00", tz),
      endUtc: utcInstantFromLocal(addDays(weekStart, 7), "00:00", tz),
    };
  }

  it("5. range is [Sunday 00:00 local, next Sunday 00:00 local)", () => {
    const { weekStart, startUtc, endUtc } = range("2026-08-12", TZ);
    expect(weekStart).toBe("2026-08-09");
    expect(startUtc.toISOString()).toBe("2026-08-09T04:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2026-08-16T04:00:00.000Z");
    // The end is the NEXT Sunday, not the Saturday.
    expect(weekdayOf(addDays(weekStart, 7))).toBe("Sun");
  });

  it("6. a Sunday appointment falls INSIDE the week that displays Sunday", () => {
    const { startUtc, endUtc } = range("2026-08-12", TZ);
    // 09:00 local on the Sunday that is the grid's first column.
    const sundayAppt = utcInstantFromLocal("2026-08-09", "09:00", TZ);
    expect(sundayAppt.getTime()).toBeGreaterThanOrEqual(startUtc.getTime());
    expect(sundayAppt.getTime()).toBeLessThan(endUtc.getTime());
    // ...and local midnight on that Sunday is the inclusive lower bound.
    expect(utcInstantFromLocal("2026-08-09", "00:00", TZ).getTime()).toBe(
      startUtc.getTime(),
    );
  });

  it("7. the FOLLOWING Sunday is excluded from the prior week (half-open)", () => {
    const { endUtc } = range("2026-08-12", TZ);
    const nextSundayMidnight = utcInstantFromLocal("2026-08-16", "00:00", TZ);
    // Exactly the upper bound, and the bound is EXCLUSIVE.
    expect(nextSundayMidnight.getTime()).toBe(endUtc.getTime());
    expect(nextSundayMidnight.getTime() < endUtc.getTime()).toBe(false);
    // ...and it belongs to the NEXT week's range instead, so it is never lost.
    const next = range("2026-08-16", TZ);
    expect(next.weekStart).toBe("2026-08-16");
    expect(nextSundayMidnight.getTime()).toBeGreaterThanOrEqual(
      next.startUtc.getTime(),
    );
  });

  it("consecutive weeks abut exactly: no gap, no overlap", () => {
    const a = range("2026-08-12", TZ);
    const b = range("2026-08-16", TZ);
    expect(a.endUtc.getTime()).toBe(b.startUtc.getTime());
  });
});

// ---------------------------------------------------------------------------
// 8-10. Navigation anchors to Sundays and never drifts.
// ---------------------------------------------------------------------------
describe("navigation", () => {
  it("8. previous week anchors to the prior Sunday", () => {
    const weekStart = startOfWeek("2026-08-12");
    const prev = addDays(weekStart, -7);
    expect(prev).toBe("2026-08-02");
    expect(weekdayOf(prev)).toBe("Sun");
  });

  it("9. next week anchors to the following Sunday", () => {
    const weekStart = startOfWeek("2026-08-12");
    const next = addDays(weekStart, 7);
    expect(next).toBe("2026-08-16");
    expect(weekdayOf(next)).toBe("Sun");
  });

  it("no drift: 52 forward then 52 back returns to the same Sunday", () => {
    const origin = startOfWeek("2026-08-12");
    let cur = origin;
    // Crosses both DST transitions in each direction.
    for (let i = 0; i < 52; i++) {
      cur = addDays(cur, 7);
      expect(weekdayOf(cur)).toBe("Sun");
    }
    for (let i = 0; i < 52; i++) {
      cur = addDays(cur, -7);
      expect(weekdayOf(cur)).toBe("Sun");
    }
    expect(cur).toBe(origin);
  });

  it("10. Today resolves to the Sunday-start week CONTAINING today", () => {
    for (const today of [
      "2026-08-09", // Sun
      "2026-08-10", // Mon
      "2026-08-12", // Wed
      "2026-08-15", // Sat
    ]) {
      const ws = startOfWeek(today);
      expect(ws).toBe("2026-08-09");
      const week = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
      expect(week).toContain(today);
    }
  });
});

// ---------------------------------------------------------------------------
// 11-12. Month and year boundaries, the seven days need not share a month.
// ---------------------------------------------------------------------------
describe("month and year boundaries", () => {
  it("11. a week spanning a month boundary stays Sunday → Saturday", () => {
    // Sun Jan 31 2027 → Sat Feb 6 2027.
    const week = weekDays("2027-02-03");
    expect(week[0]).toBe("2027-01-31");
    expect(week[6]).toBe("2027-02-06");
    expect(week.map(weekdayOf)).toEqual([...DOW]);
    // Two different months in one week.
    expect(new Set(week.map((d) => d.slice(0, 7))).size).toBe(2);
  });

  it("12. a week spanning a YEAR boundary stays Sunday → Saturday", () => {
    // Sun Dec 27 2026 → Sat Jan 2 2027.
    const week = weekDays("2026-12-30");
    expect(week[0]).toBe("2026-12-27");
    expect(week[6]).toBe("2027-01-02");
    expect(week.map(weekdayOf)).toEqual([...DOW]);
    expect(new Set(week.map((d) => d.slice(0, 4))).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 13-14. DST. The week is a LOCAL-MIDNIGHT range, not 168 elapsed hours.
// ---------------------------------------------------------------------------
describe("DST: local midnight boundaries, never 168 fixed hours", () => {
  const HOUR = 3_600_000;
  function elapsedHours(weekStart: string, tz: string): number {
    const s = utcInstantFromLocal(weekStart, "00:00", tz);
    const e = utcInstantFromLocal(addDays(weekStart, 7), "00:00", tz);
    return (e.getTime() - s.getTime()) / HOUR;
  }

  it("13. spring-forward week is 167 hours, and still starts Sunday local midnight", () => {
    // America/Toronto springs forward Sun 2026-03-08 02:00 local.
    expect(weekdayOf("2026-03-08")).toBe("Sun");
    expect(startOfWeek("2026-03-11")).toBe("2026-03-08");
    expect(elapsedHours("2026-03-08", TZ)).toBe(167);
    // A fixed +168h would land an hour PAST the next Sunday's local midnight.
    const s = utcInstantFromLocal("2026-03-08", "00:00", TZ);
    const e = utcInstantFromLocal("2026-03-15", "00:00", TZ);
    expect(new Date(s.getTime() + 168 * HOUR).getTime()).not.toBe(e.getTime());
  });

  it("14. fall-back week is 169 hours, and still starts Sunday local midnight", () => {
    // America/Toronto falls back Sun 2026-11-01 02:00 local.
    expect(weekdayOf("2026-11-01")).toBe("Sun");
    expect(startOfWeek("2026-11-04")).toBe("2026-11-01");
    expect(elapsedHours("2026-11-01", TZ)).toBe(169);
    const s = utcInstantFromLocal("2026-11-01", "00:00", TZ);
    const e = utcInstantFromLocal("2026-11-08", "00:00", TZ);
    expect(new Date(s.getTime() + 168 * HOUR).getTime()).not.toBe(e.getTime());
  });

  it("an ordinary week is 168 hours (so 167/169 are the real exceptions)", () => {
    expect(elapsedHours("2026-08-09", TZ)).toBe(168);
  });

  it("a DST week still renders exactly seven Sunday→Saturday days", () => {
    for (const anchor of ["2026-03-11", "2026-11-04"]) {
      expect(weekDays(anchor).map(weekdayOf)).toEqual([...DOW]);
    }
  });

  // The cases above prove the SEMANTICS are DST-correct, but they compute the
  // range through this file's own `range()` mirror, so none of them can notice
  // page.tsx swapping its end boundary for elapsed time. That swap is the one
  // DST regression that reads as harmless in review, `startUtc + 168h` is
  // right 50 weeks a year and silently off by an hour in the other two. Pin it
  // HERE, next to the semantics it would break, not only in the wiring block.
  it("the PAGE's end boundary is a local midnight, never start + a fixed span", () => {
    expect(CAL_PAGE).toMatch(
      /const endUtc = utcInstantFromLocal\(addDays\(weekStart, 7\), "00:00", studio\.timezone\)/,
    );
    // Any elapsed-time spelling of "a week": 168h, 7*24, 604800s, or the
    // millisecond forms those become once multiplied out.
    expect(CAL_PAGE).not.toMatch(/168|7 \* 24|604800|604_800/);
    expect(CAL_PAGE).not.toMatch(/startUtc\.getTime\(\) \+/);
  });

  it("the boundary holds in a southern-hemisphere zone too (opposite DST)", () => {
    const AKL = "Pacific/Auckland";
    // NZ moves on Sundays as well; both transition weeks must still be
    // exactly Sunday→Sunday local midnight, whatever the elapsed hours.
    for (const ws of ["2026-04-05", "2026-09-27"]) {
      expect(weekdayOf(ws)).toBe("Sun");
      const hours = elapsedHours(ws, AKL);
      expect([167, 169]).toContain(hours);
    }
  });
});

// ---------------------------------------------------------------------------
// The page wiring: display, range and navigation must all read the SAME
// weekStart. Source-pinned, because that coupling is the whole point.
// ---------------------------------------------------------------------------
describe("calendar page wiring (source pins)", () => {
  it("the week anchor is startOfWeek, and days derive from it", () => {
    expect(CAL_PAGE).toMatch(/const weekStart = startOfWeek\(weekStartParam\)/);
    expect(CAL_PAGE).toMatch(
      /const days = Array\.from\(\{ length: 7 \}, \(_, i\) => addDays\(weekStart, i\)\)/,
    );
  });

  it("the fetch range is local midnight on weekStart → weekStart + 7", () => {
    expect(CAL_PAGE).toMatch(
      /utcInstantFromLocal\(weekStart, "00:00", studio\.timezone\)/,
    );
    expect(CAL_PAGE).toMatch(
      /utcInstantFromLocal\(addDays\(weekStart, 7\), "00:00", studio\.timezone\)/,
    );
    // Never a fixed elapsed-hours week.
    expect(CAL_PAGE).not.toMatch(/168|7 \* 24|604800/);
  });

  it("navigation derives from weekStart, not from arbitrary elapsed time", () => {
    expect(CAL_PAGE).toMatch(/const prevWeek = addDays\(weekStart, -7\)/);
    expect(CAL_PAGE).toMatch(/const nextWeek = addDays\(weekStart, 7\)/);
  });

  it("both the appointment and blocked-time ranges use the same bounds", () => {
    for (const fn of [
      "getAppointmentsForRange",
      "getTimedBlocksForRange",
      "getRecurringBreakOccurrencesForRange",
    ]) {
      expect(CAL_PAGE).toMatch(
        new RegExp(`${fn}\\([\\s\\S]{0,120}?startUtc\\.toISOString\\(\\)`),
      );
    }
    expect(CAL_PAGE).toMatch(
      /getOverridesForRange\(studio\.id, weekStart, weekEnd\)/,
    );
  });

  it("15. this behaviour is calendar presentation only, booking math is untouched", () => {
    // The calendar page must not import public-booking slot generation or the
    // smart-scheduling packer; Sunday-start is a VIEW boundary, not
    // availability business logic.
    expect(CAL_PAGE).not.toMatch(/from "@\/lib\/booking\/slots"/);
    expect(CAL_PAGE).not.toMatch(/generateSlots|smartSchedul|edgePack/i);
  });
});
