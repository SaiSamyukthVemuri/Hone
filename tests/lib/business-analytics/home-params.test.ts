import { describe, expect, it } from "vitest";

import { analyticsRawFor, HOME_PERIOD_NOTICE, homeQuery, parseHomeParams, statementMonthFor } from "@/lib/business-analytics/home-params";
import { resolvePeriod } from "@/lib/business-analytics/period";

// Business → Overview: the reporting period in the address. Hostile input falls back to Month to date and says so; the three named periods and a chosen
// month each resolve to exactly the window they say; and every selection round-trips through its own link.
const NOW = "2026-11-24"; // the studio's current month is 2026-11

describe("parseHomeParams", () => {
  it("no period is Month to date, silently", () => {
    expect(parseHomeParams({}, "2026-11")).toEqual({ selection: { period: "month_to_date", month: null }, notices: [] });
  });
  it.each(["month_to_date", "previous_month", "year_to_date"] as const)("accepts %s", (p) => {
    expect(parseHomeParams({ period: p }, "2026-11").selection).toEqual({ period: p, month: null });
  });
  it("a chosen past month is kept", () => {
    expect(parseHomeParams({ period: "month", month: "2026-03" }, "2026-11")).toEqual({ selection: { period: "month", month: "2026-03" }, notices: [] });
  });
  it("a chosen month that is the current or the previous month is the named period: one window never has two addresses", () => {
    expect(parseHomeParams({ period: "month", month: "2026-11" }, "2026-11").selection.period).toBe("month_to_date");
    expect(parseHomeParams({ period: "month", month: "2026-10" }, "2026-11").selection.period).toBe("previous_month");
    expect(parseHomeParams({ period: "month", month: "2026-01" }, "2026-02").selection.period).toBe("previous_month");
  });
  it.each([
    [{ period: "custom" }],
    [{ period: "bogus" }],
    [{ period: ["year_to_date", "month_to_date"] }],
    [{ period: "month" }],
    [{ period: "month", month: "2026-12" }], // a future month is never read
    [{ period: "month", month: "1999-12" }],
    [{ period: "month", month: "2026-13" }],
    [{ period: "month", month: "2026-3" }],
    [{ period: "month", month: ["2026-03", "2026-04"] }],
    [{ period: "month", month: "2026-03-01" }],
    [{ month: "2026-03" }], // a month without period=month is not honoured silently
  ])("falls back to Month to date WITH a notice for %j", (raw) => {
    expect(parseHomeParams(raw, "2026-11")).toEqual({ selection: { period: "month_to_date", month: null }, notices: [HOME_PERIOD_NOTICE] });
  });
});

describe("homeQuery round-trips every selection through its own link", () => {
  const cases = [
    { period: "month_to_date", month: null },
    { period: "previous_month", month: null },
    { period: "year_to_date", month: null },
    { period: "month", month: "2026-03" },
  ] as const;
  it.each(cases)("%j", (sel) => {
    const q = Object.fromEntries(new URLSearchParams(homeQuery(sel)));
    expect(parseHomeParams(q, "2026-11").selection).toEqual(sel);
  });
  it("leaves the default out so the link stays short", () => {
    expect(homeQuery({ period: "month_to_date", month: null })).toBe("");
  });
});

describe("analyticsRawFor picks the existing Analytics window, with the right dates", () => {
  const dates = (sel: Parameters<typeof analyticsRawFor>[0]) => {
    const raw = analyticsRawFor(sel);
    const r = resolvePeriod({ kind: raw.period as never, today: NOW, from: raw.from as string | undefined, to: raw.to as string | undefined });
    if (!r.ok) throw new Error(r.error);
    return [r.period.current.startLocal, r.period.current.lastLocal];
  };
  it("the three named periods", () => {
    expect(dates({ period: "month_to_date", month: null })).toEqual(["2026-11-01", "2026-11-24"]);
    expect(dates({ period: "previous_month", month: null })).toEqual(["2026-10-01", "2026-10-31"]);
    expect(dates({ period: "year_to_date", month: null })).toEqual(["2026-01-01", "2026-11-24"]);
  });
  it("a chosen month is the whole month, to its true last day (leap February, 30-day month, December)", () => {
    expect(dates({ period: "month", month: "2024-02" })).toEqual(["2024-02-01", "2024-02-29"]);
    expect(dates({ period: "month", month: "2026-09" })).toEqual(["2026-09-01", "2026-09-30"]);
    expect(dates({ period: "month", month: "2025-12" })).toEqual(["2025-12-01", "2025-12-31"]);
  });
});

describe("statementMonthFor: Overview opens the matching Statements month", () => {
  it("each period names its month; Year to date has none", () => {
    expect(statementMonthFor({ period: "month_to_date", month: null }, "2026-11")).toBe("2026-11");
    expect(statementMonthFor({ period: "previous_month", month: null }, "2026-11")).toBe("2026-10");
    expect(statementMonthFor({ period: "previous_month", month: null }, "2026-01")).toBe("2025-12");
    expect(statementMonthFor({ period: "month", month: "2026-03" }, "2026-11")).toBe("2026-03");
    expect(statementMonthFor({ period: "year_to_date", month: null }, "2026-11")).toBeNull();
  });
});
