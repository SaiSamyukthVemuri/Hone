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

describe("links back to the Overview", () => {
  const base = { periodKind: "month_to_date", compare: "preceding", practitioner: { kind: "all" }, series: "money" } as const;
  it("defaults are left out, so a plain link is empty", async () => {
    const { overviewQuery } = await import("@/lib/business-analytics/overview-params");
    expect(overviewQuery(base)).toBe("");
  });
  it("carries every non-default choice and takes a change", async () => {
    const { overviewQuery } = await import("@/lib/business-analytics/overview-params");
    const q = overviewQuery({ ...base, periodKind: "custom", from: "2026-11-01", to: "2026-11-10", compare: "last_year", practitioner: { kind: "one", practitionerId: "pr-1" } }, { series: "visits" });
    expect(new URLSearchParams(q).get("period")).toBe("custom");
    expect(new URLSearchParams(q).get("compare")).toBe("last_year");
    expect(new URLSearchParams(q).get("practitioner")).toBe("pr-1");
    expect(new URLSearchParams(q).get("series")).toBe("visits");
  });
  it("custom dates are dropped when the period is not custom, and a link round-trips through the parser", async () => {
    const { overviewQuery, parseOverviewParams } = await import("@/lib/business-analytics/overview-params");
    expect(overviewQuery({ ...base, from: "2026-11-01", to: "2026-11-10" })).toBe("");
    const params = { ...base, periodKind: "previous_month", practitioner: { kind: "unattributed" }, series: "visits" } as const;
    const back = parseOverviewParams(Object.fromEntries(new URLSearchParams(overviewQuery(params))), { strict: true, practitionerIds: new Set() });
    expect(back).toMatchObject({ ok: true, params: { periodKind: "previous_month", practitioner: { kind: "unattributed" }, series: "visits" } });
  });
});

describe("the previous calendar month follows the period, and is never an error", () => {
  it("Last month's comparison IS the previous calendar month, whatever the address says", () => {
    for (const compare of [undefined, "preceding", "last_year", "previous_month"]) {
      const r = page({ period: "previous_month", compare });
      expect(r.ok && r.params.compare, String(compare)).toBe("previous_month");
      expect(r.ok && r.notices).toEqual([]);
    }
  });
  it("Last month switched to a Custom range with a PARTIAL range: compared with the period just before, and said", () => {
    const r = page({ period: "custom", from: "2026-10-03", to: "2026-10-20", compare: "previous_month" });
    expect(r.ok && r.params.compare).toBe("preceding");
    expect(r.ok && r.notices).toEqual(["The previous calendar month applies to one whole calendar month, so this range is compared with the period just before it."]);
  });
  it("a MULTI-month range and a half-given range fall back the same way", () => {
    for (const range of [{ from: "2026-09-01", to: "2026-10-31" }, { from: "2026-10-01", to: undefined }, { from: undefined, to: undefined }]) {
      const r = page({ period: "custom", compare: "previous_month", ...range });
      expect(r.ok && r.params.compare, JSON.stringify(range)).toBe("preceding");
      expect(r.ok && r.notices).toHaveLength(1);
    }
  });
  it("it falls back even in strict mode: a stale choice is not a bad request", () => {
    expect(strict({ period: "custom", from: "2026-10-03", to: "2026-10-20", compare: "previous_month" })).toMatchObject({ ok: true });
  });
  it("one whole calendar month keeps it, with no notice", () => {
    const r = page({ period: "custom", from: "2026-10-01", to: "2026-10-31", compare: "previous_month" });
    expect(r.ok && r.params.compare).toBe("previous_month");
    expect(r.ok && r.notices).toEqual([]);
  });
});
