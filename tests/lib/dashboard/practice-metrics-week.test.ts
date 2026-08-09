import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePeriodRange } from "@/lib/dashboard/practice-metrics";
import { addDays, startOfWeek } from "@/lib/booking/tz";

// ===========================================================================
// Dashboard V2 Part 1 — the dashboard reporting week runs SUNDAY -> SATURDAY.
// ===========================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// `resolvePeriodRange(todayLocal, "week")` used to anchor on MONDAY:
//
//     const dow = new Date(`${todayLocal}T12:00:00Z`).getUTCDay();
//     const sinceMonday = (dow + 6) % 7;
//
// while the practitioner calendar has always run Sunday -> Saturday. The
// failure Chloe hit is specific and invisible in a screenshot: ON A SUNDAY the
// two disagreed by a FULL WEEK. Sunday was the LAST day of the metrics week and
// the FIRST day of the calendar week, so a Sunday appointment was counted in
// the week that was ending while the calendar showed it in the week beginning.
//
// The fix is delegation, not a second algorithm: `resolvePeriodRange` now calls
// the same `lib/booking/tz.startOfWeek` the calendar uses. The tests below
// therefore do two different jobs, and BOTH are needed:
//
//   1. Boundary cases asserted against INDEPENDENTLY computed weekday names,
//      so a broken helper cannot also define what "Sunday" means.
//   2. A source guard that the dashboard still DELEGATES. Without it, someone
//      could reintroduce a local copy that happens to agree today and drifts
//      later — which is exactly how these two got out of sync.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Name the weekday of a YYYY-MM-DD without using the code under test. */
function weekdayOf(dateStr: string): string {
  return DOW[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}

/** The inclusive last day of the range, for readability in assertions. */
function lastDayOf(r: { endLocalExclusive: string }): string {
  return addDays(r.endLocalExclusive, -1);
}

const week = (todayLocal: string) => resolvePeriodRange(todayLocal, "week");

// 2026-08-09 is a Sunday; 2026-08-15 is the Saturday that closes that week.
const SUN = "2026-08-09";
const MON = "2026-08-10";
const SAT = "2026-08-15";
const NEXT_SUN = "2026-08-16";

describe("dashboard week — the anchor is Sunday", () => {
  it("the fixture dates really are the weekdays this file claims", () => {
    // Guards the whole file: if these drift, every case below is meaningless.
    expect(weekdayOf(SUN)).toBe("Sun");
    expect(weekdayOf(MON)).toBe("Mon");
    expect(weekdayOf(SAT)).toBe("Sat");
    expect(weekdayOf(NEXT_SUN)).toBe("Sun");
  });

  it("SUNDAY starts a NEW week — it is the first day, not the last", () => {
    // The exact case that was broken. Under the old Monday anchor this
    // returned 2026-08-03 (the PREVIOUS Monday), putting Sunday at the END of
    // the previous week — a full week away from the calendar.
    const r = week(SUN);
    expect(r.startLocal).toBe(SUN);
    expect(weekdayOf(r.startLocal)).toBe("Sun");
    expect(lastDayOf(r)).toBe(SAT);
    expect(weekdayOf(lastDayOf(r))).toBe("Sat");
  });

  it("MONDAY still includes the IMMEDIATELY PRECEDING Sunday", () => {
    const r = week(MON);
    expect(r.startLocal).toBe(SUN);
    expect(addDays(r.startLocal, 1)).toBe(MON);
  });

  it("SATURDAY belongs to the same week as that Sunday", () => {
    expect(week(SAT).startLocal).toBe(SUN);
    expect(week(SAT).startLocal).toBe(week(SUN).startLocal);
    expect(week(SAT).startLocal).toBe(week(MON).startLocal);
  });

  it("every day Sunday..Saturday resolves to the SAME week", () => {
    const starts = Array.from({ length: 7 }, (_, i) => week(addDays(SUN, i)).startLocal);
    expect(new Set(starts)).toEqual(new Set([SUN]));
  });

  it("rollover happens at the Saturday -> Sunday boundary, not Sunday -> Monday", () => {
    expect(week(SAT).startLocal).toBe(SUN);
    expect(week(NEXT_SUN).startLocal).toBe(NEXT_SUN);
    expect(week(NEXT_SUN).startLocal).not.toBe(week(SAT).startLocal);
    // ...and Monday does NOT roll over.
    expect(week(MON).startLocal).toBe(week(SUN).startLocal);
  });

  it("the range is exactly 7 days, half-open [start, end)", () => {
    for (const d of [SUN, MON, SAT]) {
      const r = week(d);
      expect(r.endLocalExclusive).toBe(addDays(r.startLocal, 7));
      // The exclusive end is the NEXT Sunday and must not be counted.
      expect(weekdayOf(r.endLocalExclusive)).toBe("Sun");
    }
  });

  it("the label is unchanged", () => {
    expect(week(MON).label).toBe("this week");
  });
});

describe("dashboard week — boundaries that are not week boundaries", () => {
  it("crosses a MONTH boundary without truncating to the 1st", () => {
    // 2026-09-01 is a Tuesday; its week starts Sunday 2026-08-30 — in August.
    expect(weekdayOf("2026-09-01")).toBe("Tue");
    const r = week("2026-09-01");
    expect(r.startLocal).toBe("2026-08-30");
    expect(weekdayOf(r.startLocal)).toBe("Sun");
    expect(lastDayOf(r)).toBe("2026-09-05");
  });

  it("crosses a YEAR boundary without truncating to Jan 1", () => {
    // 2027-01-01 is a Friday; its week starts Sunday 2026-12-27 — in 2026.
    expect(weekdayOf("2027-01-01")).toBe("Fri");
    const r = week("2027-01-01");
    expect(r.startLocal).toBe("2026-12-27");
    expect(weekdayOf(r.startLocal)).toBe("Sun");
    expect(lastDayOf(r)).toBe("2027-01-02");
  });

  it("crosses a LEAP-DAY boundary", () => {
    // 2028-02-29 is a Tuesday; the week runs Sun 2028-02-27 .. Sat 2028-03-04.
    expect(weekdayOf("2028-02-29")).toBe("Tue");
    const r = week("2028-02-29");
    expect(r.startLocal).toBe("2028-02-27");
    expect(lastDayOf(r)).toBe("2028-03-04");
  });

  it("is unaffected by DST transitions, because it ranges over DATE STRINGS", () => {
    // America/Toronto springs forward 2026-03-08 and falls back 2026-11-01 —
    // both Sundays, i.e. both are week STARTS. A "start + 168 hours" range
    // would land 23h/25h off; a date-string range cannot.
    for (const [inside, expectedStart] of [
      ["2026-03-11", "2026-03-08"],
      ["2026-11-04", "2026-11-01"],
    ] as const) {
      const r = week(inside);
      expect(r.startLocal, inside).toBe(expectedStart);
      expect(weekdayOf(r.startLocal)).toBe("Sun");
      expect(r.endLocalExclusive).toBe(addDays(expectedStart, 7));
    }
  });
});

describe("dashboard week — it is the SAME boundary the calendar uses", () => {
  it("agrees with startOfWeek() on every day of a full year", () => {
    // The strongest form of "one algorithm": 365 days, no disagreement.
    let d = "2026-01-01";
    for (let i = 0; i < 365; i++) {
      expect(week(d).startLocal, d).toBe(startOfWeek(d));
      d = addDays(d, 1);
    }
  });

  it("agrees with the calendar ON A SUNDAY — the case that was broken", () => {
    expect(week(SUN).startLocal).toBe(startOfWeek(SUN));
  });

  it("the dashboard DELEGATES to the shared helper instead of re-deriving it", () => {
    // A source guard, deliberately. A local re-implementation that agrees
    // today is exactly how the dashboard and calendar drifted apart before.
    const src = readFileSync(
      join(process.cwd(), "lib/dashboard/practice-metrics.ts"),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code).toMatch(/startOfWeek\s*\(\s*todayLocal\s*\)/);
    expect(code, "the Monday anchor must not come back").not.toMatch(/sinceMonday/);
    expect(code, "no hand-rolled day-of-week arithmetic").not.toMatch(/\(\s*dow\s*\+\s*6\s*\)\s*%\s*7/);
    expect(code).toMatch(/from "@\/lib\/booking\/tz"/);
  });
});

describe("dashboard week — the other periods are untouched", () => {
  it("'today' is still a single day", () => {
    const r = resolvePeriodRange(MON, "today");
    expect(r.startLocal).toBe(MON);
    expect(r.endLocalExclusive).toBe(addDays(MON, 1));
    expect(r.label).toBe("today");
  });

  it("'month' is still calendar-month anchored, including December rollover", () => {
    expect(resolvePeriodRange("2026-08-15", "month")).toEqual({
      startLocal: "2026-08-01",
      endLocalExclusive: "2026-09-01",
      label: "this month",
    });
    expect(resolvePeriodRange("2026-12-15", "month")).toEqual({
      startLocal: "2026-12-01",
      endLocalExclusive: "2027-01-01",
      label: "this month",
    });
  });
});
