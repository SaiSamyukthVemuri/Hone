import { describe, expect, it } from "vitest";

import {
  MAX_CUSTOM_DAYS,
  bucketKeyFor,
  bucketsOf,
  daysBetween,
  isRealLocalDate,
  isWholeCalendarMonth,
  monthsCovered,
  rangeLabel,
  resolvePeriod,
  sameDateInYear,
  statementsClaim,
  windowInstants,
} from "@/lib/business-analytics/period";

// Business → Analytics. Synthetic dates only. Pure: no clock, no database.
const ok = (r: ReturnType<typeof resolvePeriod>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.period;
};

describe("real local dates", () => {
  it("accepts real dates only", () => {
    expect(isRealLocalDate("2026-11-19")).toBe(true);
    expect(isRealLocalDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "26-11-19", "2026-11-19T00:00", "", null, 20261119]) expect(isRealLocalDate(bad)).toBe(false);
  });
  it("counts days between dates across a month end and a leap day", () => {
    expect(daysBetween("2026-11-01", "2026-11-19")).toBe(18);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2027-02-28", "2027-03-01")).toBe(1);
  });
});

describe("month to date", () => {
  it("compares the same number of elapsed days of the previous month", () => {
    const p = ok(resolvePeriod({ kind: "month_to_date", today: "2026-11-19" }));
    expect([p.current.startLocal, p.current.lastLocal, p.current.days]).toEqual(["2026-11-01", "2026-11-19", 19]);
    expect([p.comparison.startLocal, p.comparison.lastLocal, p.comparison.days]).toEqual(["2026-10-01", "2026-10-19", 19]);
    expect(p.current.endLocalExclusive).toBe("2026-11-20");
    expect(p.partial).toBe(true);
    expect(p.clamped).toBe(false);
    expect(p.currentLabel).toBe("Month to date: 1–19 Nov 2026 (19 days)");
    expect(p.notes.join(" ")).toContain("Today's visits count once they are marked complete.");
  });
  it("clamps the comparison when the previous month is shorter, and says so", () => {
    const p = ok(resolvePeriod({ kind: "month_to_date", today: "2026-03-31" }));
    expect(p.comparison.lastLocal).toBe("2026-02-28");
    expect(p.comparison.days).toBe(28);
    expect(p.current.days).toBe(31);
    expect(p.clamped).toBe(true);
    expect(p.notes.join(" ")).toContain("February has only 28 days");
  });
  it("first day of the month is one day against one day", () => {
    const p = ok(resolvePeriod({ kind: "month_to_date", today: "2026-12-01" }));
    expect([p.current.days, p.comparison.days, p.comparison.startLocal]).toEqual([1, 1, "2026-11-01"]);
  });
});

describe("previous month", () => {
  it("is the whole previous month against the whole month before it, across a year boundary", () => {
    const p = ok(resolvePeriod({ kind: "previous_month", today: "2026-01-15" }));
    expect([p.current.startLocal, p.current.lastLocal]).toEqual(["2025-12-01", "2025-12-31"]);
    expect([p.comparison.startLocal, p.comparison.lastLocal]).toEqual(["2025-11-01", "2025-11-30"]);
    expect(p.partial).toBe(false);
    expect(p.notes.join(" ")).toContain("different numbers of days");
  });
});

describe("year to date", () => {
  it("compares the same dates of the previous year", () => {
    const p = ok(resolvePeriod({ kind: "year_to_date", today: "2026-11-19" }));
    expect([p.current.startLocal, p.current.days]).toEqual(["2026-01-01", 323]);
    expect([p.comparison.startLocal, p.comparison.lastLocal, p.comparison.days]).toEqual(["2025-01-01", "2025-11-19", 323]);
    expect(p.currentLabel).toBe("Year to date: 1 Jan–19 Nov 2026 (323 days)");
  });
  it("29 February against a common year stops at 28 February and says so", () => {
    const p = ok(resolvePeriod({ kind: "year_to_date", today: "2028-02-29" }));
    expect(p.comparison.lastLocal).toBe("2027-02-28");
    expect(p.clamped).toBe(true);
    expect(p.notes.join(" ")).toContain("29 February does not exist");
    expect(sameDateInYear("2028-02-29", 2027)).toEqual({ date: "2027-02-28", clamped: true });
  });
});

describe("custom", () => {
  const today = "2026-11-19";
  it("default comparison is the same number of days immediately before", () => {
    const p = ok(resolvePeriod({ kind: "custom", today, from: "2026-11-10", to: "2026-11-14" }));
    expect([p.current.days, p.comparison.startLocal, p.comparison.lastLocal]).toEqual([5, "2026-11-05", "2026-11-09"]);
    expect(p.partial).toBe(true);
  });
  it("the last-year comparison is the same dates a year earlier", () => {
    const p = ok(resolvePeriod({ kind: "custom", today, from: "2026-11-10", to: "2026-11-14", customComparison: "last_year" }));
    expect([p.comparison.startLocal, p.comparison.lastLocal]).toEqual(["2025-11-10", "2025-11-14"]);
  });
  it("previous_month compares ONE whole calendar month with the calendar month before it, and refuses any other range", () => {
    const p = ok(resolvePeriod({ kind: "custom", today, from: "2026-03-01", to: "2026-03-31", customComparison: "previous_month" }));
    expect([p.comparison.startLocal, p.comparison.lastLocal, p.partial, p.comparisonLabel]).toEqual(["2026-02-01", "2026-02-28", false, "February 2026 (complete month, 28 days)"]);
    const bad = (from: string, to: string) => { const r = resolvePeriod({ kind: "custom", today, from, to, customComparison: "previous_month" }); return r.ok ? "ok" : r.error; };
    expect(bad("2026-03-02", "2026-03-31")).toBe("invalid_comparison"); // part of a month
    expect(bad("2026-02-01", "2026-03-31")).toBe("invalid_comparison"); // two months
  });
  it("isWholeCalendarMonth is true for exactly one whole calendar month and nothing else", () => {
    expect(isWholeCalendarMonth("2026-03-01", "2026-03-31")).toBe(true);
    expect(isWholeCalendarMonth("2024-02-01", "2024-02-29")).toBe(true);
    expect(isWholeCalendarMonth("2026-02-01", "2026-02-28")).toBe(true);
    for (const [a, b] of [["2026-03-02", "2026-03-31"], ["2026-03-01", "2026-03-30"], ["2026-02-01", "2026-03-31"], ["2026-03-01", "2026-04-30"], ["x", "2026-03-31"], ["2026-02-01", "2026-02-30"]]) expect(isWholeCalendarMonth(a, b), `${a}..${b}`).toBe(false);
    expect(isWholeCalendarMonth(undefined, undefined)).toBe(false);
  });
  it("refuses bad input and never silently shortens or clamps it", () => {
    const e = (o: Partial<Parameters<typeof resolvePeriod>[0]>) => {
      const r = resolvePeriod({ kind: "custom", today, from: "2026-11-01", to: "2026-11-02", ...o });
      return r.ok ? "ok" : r.error;
    };
    expect(e({ from: undefined })).toBe("custom_dates_missing");
    expect(e({ to: "" })).toBe("custom_dates_missing");
    expect(e({ from: "2026-02-30" })).toBe("invalid_date");
    expect(e({ from: "2026-11-05", to: "2026-11-04" })).toBe("from_after_to");
    expect(e({ to: "2026-11-20" })).toBe("future_date");
    expect(e({ customComparison: "weekly" })).toBe("invalid_comparison");
    expect(e({ from: "2025-11-18", to: "2026-11-19" })).toBe("range_too_long"); // 367 days
    expect(MAX_CUSTOM_DAYS).toBe(366);
    expect(e({ from: "2025-11-19", to: "2026-11-19" })).toBe("ok"); // 366 days inclusive is the limit
  });
  it("accepts exactly 366 days", () => {
    expect(resolvePeriod({ kind: "custom", today: "2028-12-31", from: "2028-01-01", to: "2028-12-31" }).ok).toBe(true);
  });
  it("refuses an unknown kind or a bad today", () => {
    expect(resolvePeriod({ kind: "week", today })).toEqual({ ok: false, error: "invalid_kind" });
    expect(resolvePeriod({ kind: "month_to_date", today: "2026-02-30" })).toEqual({ ok: false, error: "invalid_date" });
  });
});

describe("labels", () => {
  it("prints ranges in fixed English words", () => {
    expect(rangeLabel({ startLocal: "2026-11-19", lastLocal: "2026-11-19" })).toBe("19 Nov 2026");
    expect(rangeLabel({ startLocal: "2025-12-29", lastLocal: "2026-01-19" })).toBe("29 Dec 2025–19 Jan 2026");
    expect(rangeLabel({ startLocal: "2026-01-01", lastLocal: "2026-11-19" })).toBe("1 Jan–19 Nov 2026");
  });
});

describe("DST day windows (studio time zone)", () => {
  const tz = "America/Toronto";
  const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
  it("spring-forward day is 23 hours, fall-back day is 25 hours, each end converted on its own", () => {
    const spring = windowInstants({ startLocal: "2026-03-08", endLocalExclusive: "2026-03-09" }, tz);
    expect(spring).toEqual({ startUtc: "2026-03-08T05:00:00.000Z", endUtc: "2026-03-09T04:00:00.000Z" });
    expect(hours(spring.startUtc, spring.endUtc)).toBe(23);
    const fall = windowInstants({ startLocal: "2026-11-01", endLocalExclusive: "2026-11-02" }, tz);
    expect(fall).toEqual({ startUtc: "2026-11-01T04:00:00.000Z", endUtc: "2026-11-02T05:00:00.000Z" });
    expect(hours(fall.startUtc, fall.endUtc)).toBe(25);
  });
  it("a month window containing the change is not start + 30 days", () => {
    const nov = windowInstants({ startLocal: "2026-11-01", endLocalExclusive: "2026-12-01" }, tz);
    expect(hours(nov.startUtc, nov.endUtc)).toBe(30 * 24 + 1);
  });
  it("the half-open end is exclusive: an instant at the end belongs to the next window", () => {
    const w = windowInstants({ startLocal: "2026-11-01", endLocalExclusive: "2026-11-02" }, tz);
    expect("2026-11-02T04:59:59.000Z" < w.endUtc).toBe(true);
    expect("2026-11-02T05:00:00.000Z" < w.endUtc).toBe(false);
  });
});

describe("chart buckets", () => {
  it("uses one bucket per day up to 62 days, covering the window with no gap or overlap", () => {
    const p = ok(resolvePeriod({ kind: "month_to_date", today: "2026-11-19" }));
    const { unit, buckets } = bucketsOf(p.current);
    expect(unit).toBe("day");
    expect(buckets).toHaveLength(19);
    expect(buckets[0].key).toBe("2026-11-01");
    expect(buckets[18].endLocalExclusive).toBe(p.current.endLocalExclusive);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i].startLocal).toBe(buckets[i - 1].endLocalExclusive);
  });
  it("uses calendar months beyond 62 days, clipped to the window", () => {
    const p = ok(resolvePeriod({ kind: "year_to_date", today: "2026-11-19" }));
    const { unit, buckets } = bucketsOf(p.current);
    expect(unit).toBe("month");
    expect(buckets.map((b) => b.key)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(buckets[10]).toMatchObject({ startLocal: "2026-11-01", endLocalExclusive: "2026-11-20" });
    expect(bucketKeyFor("2026-11-19", p.current)).toBe("2026-11");
    expect(bucketKeyFor("2026-11-20", p.current)).toBeNull();
    expect(bucketKeyFor("2025-12-31", p.current)).toBeNull();
  });
});

describe("what may be claimed about Statements (whole-month detection)", () => {
  const claim = (kind: string, today: string, from?: string, to?: string) => statementsClaim(ok(resolvePeriod({ kind, today, from, to })).current);
  it("previous month is one whole month: may say it matches that Statements month", () => {
    expect(claim("previous_month", "2026-11-19")).toEqual({ kind: "one_whole_month", month: "2026-10" });
  });
  it("month to date is NOT a whole month: no 'matches Statements' claim", () => {
    expect(claim("month_to_date", "2026-11-19")).toEqual({ kind: "same_rules_same_dates", months: ["2026-11"] });
  });
  it("a month to date on the last day of the month covers every date of the month, so it may claim a whole month", () => {
    // 30 Nov is today: the window ends at 30 Nov inclusive, which is every date of November.
    expect(claim("month_to_date", "2026-11-30")).toEqual({ kind: "one_whole_month", month: "2026-11" });
  });
  it("year to date is not whole months; two whole months are a sum of months", () => {
    expect(claim("year_to_date", "2026-11-19").kind).toBe("same_rules_same_dates");
    expect(claim("custom", "2026-11-19", "2026-09-01", "2026-10-31")).toEqual({ kind: "several_whole_months", months: ["2026-09", "2026-10"] });
    expect(claim("custom", "2026-11-19", "2026-09-02", "2026-10-31").kind).toBe("same_rules_same_dates");
  });
  it("monthsCovered flags the partial ends", () => {
    const p = ok(resolvePeriod({ kind: "custom", today: "2026-11-19", from: "2026-09-15", to: "2026-11-19" }));
    expect(monthsCovered(p.current).map((m) => [m.month, m.wholeMonth])).toEqual([["2026-09", false], ["2026-10", true], ["2026-11", false]]);
  });
});
