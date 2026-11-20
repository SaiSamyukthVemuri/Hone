import { describe, expect, it } from "vitest";

import { parseOverviewParams } from "@/lib/business-analytics/overview-params";

const ids = new Set(["pr-1", "pr-2"]);
const page = (raw: Record<string, string | string[] | undefined>) => parseOverviewParams(raw, { strict: false, practitionerIds: ids });
const strict = (raw: Record<string, string | string[] | undefined>) => parseOverviewParams(raw, { strict: true, practitionerIds: ids });

describe("overview query parameters", () => {
  it("nothing given: month to date, preceding comparison, all practitioners, money chart, no notices", () => {
    expect(page({})).toEqual({ ok: true, notices: [], params: { periodKind: "month_to_date", from: undefined, to: undefined, compare: "preceding", practitioner: { kind: "all" }, series: "money" } });
  });
  it("accepts every valid value", () => {
    const r = page({ period: "custom", from: "2026-11-01", to: "2026-11-10", compare: "last_year", practitioner: "pr-2", series: "visits" });
    expect(r).toMatchObject({ ok: true, notices: [], params: { periodKind: "custom", from: "2026-11-01", to: "2026-11-10", compare: "last_year", practitioner: { kind: "one", practitionerId: "pr-2" }, series: "visits" } });
    expect(page({ practitioner: "unattributed" })).toMatchObject({ params: { practitioner: { kind: "unattributed" } } });
    expect(page({ practitioner: "all" })).toMatchObject({ params: { practitioner: { kind: "all" } } });
  });
  it("a page falls back to the default for a bad value and says so", () => {
    for (const raw of [{ period: "week" }, { compare: "weekly" }, { series: "pie" }, { practitioner: "someone-else" }, { period: ["month_to_date", "previous_month"] }, { practitioner: "" }]) {
      const r = page(raw);
      expect(r.ok && r.notices.length).toBe(1);
    }
    const r = page({ period: "week", practitioner: "nobody" });
    expect(r.ok && r.params.periodKind).toBe("month_to_date");
    expect(r.ok && r.params.practitioner).toEqual({ kind: "all" });
    expect(r.ok && r.notices).toHaveLength(2);
  });
  it("an export or print route refuses a bad value, never silently using today's period", () => {
    for (const raw of [{ period: "week" }, { practitioner: "nobody" }, { series: "x" }, { compare: "x" }, { period: ["a", "b"] }, { from: ["2026-01-01", "2026-01-02"] }]) {
      expect(strict(raw)).toEqual({ ok: false, error: "bad_request" });
    }
    expect(strict({ period: "previous_month" }).ok).toBe(true);
  });
  it("a practitioner id is accepted only when it is the studio's own, and an array of one is the one value", () => {
    expect(page({ practitioner: ["pr-1"] })).toMatchObject({ params: { practitioner: { kind: "one", practitionerId: "pr-1" } } });
    expect(strict({ practitioner: "pr-9" }).ok).toBe(false);
  });
  it("dates are passed through as text: the period resolver decides whether they are real", () => {
    expect(page({ period: "custom", from: "2026-02-30", to: "x" })).toMatchObject({ params: { from: "2026-02-30", to: "x" } });
  });
});
