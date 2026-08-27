import { describe, expect, it } from "vitest";

import {
  isReportingPeriod,
  resolvePeriodRange,
  type ReportingPeriod,
} from "@/lib/booking/reporting-period";

// The range algorithm's behaviour — the Sunday anchor, DST, month and year
// rollover — is already pinned in depth by tests/lib/dashboard/practice-metrics-week
// and tests/app/dashboard/practice-dashboard, both of which now import it from
// here. This file covers the part of the extracted contract that had no test at
// all: the guard that decides whether an untrusted string is a period.

describe("isReportingPeriod — the boundary between a URL and the contract", () => {
  it("accepts exactly the three members, and nothing else", () => {
    for (const ok of ["today", "week", "month"]) expect(isReportingPeriod(ok)).toBe(true);
  });

  it("rejects everything else, including near-misses and the undefined case", () => {
    for (const bad of [
      undefined,
      "",
      "Today",
      "WEEK",
      "day",
      "year",
      "quarter",
      "today ",
      " week",
      "month;",
      "todaytoday",
      "custom",
    ]) {
      expect(isReportingPeriod(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("narrows the type, so a caller cannot pass an unchecked string through", () => {
    const raw: string | undefined = "week";
    if (isReportingPeriod(raw)) {
      const period: ReportingPeriod = raw;
      expect(resolvePeriodRange("2026-06-11", period).label).toBe("this week");
    } else {
      throw new Error("expected 'week' to narrow");
    }
  });

  it("every accepted member resolves to a usable half-open range", () => {
    // Anti-vacuity for the guard above: accepting a value the resolver cannot
    // handle would be worse than rejecting a valid one.
    for (const period of ["today", "week", "month"] as const) {
      const r = resolvePeriodRange("2026-06-11", period);
      expect(r.startLocal, period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.endLocalExclusive, period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.endLocalExclusive > r.startLocal, period).toBe(true);
      expect(r.label.length, period).toBeGreaterThan(0);
    }
  });
});
