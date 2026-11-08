import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liveScopedRows } from "@/lib/calendar/block-scope";
import { teamColumnAllowsCreate } from "@/lib/calendar/team-day";
import { groupMonthBlockedByDate } from "@/app/(app)/calendar/month-blocked";

// Insurance PEER-1280-SCOPE-DELTA S1 and S2. Synthetic data.
const TZ = "America/Los_Angeles";
const START = "2026-11-17T19:00:00Z"; // 11:00 PST
const scopedBlock = { starts_at: START, category: "other", practitioner_id: "p-ana" };
const wideBlock = { starts_at: START, category: "other", practitioner_id: null };
const scopedBreak = { starts_at: START, rule: { label: "Scoped lunch" }, practitioner_id: "p-ana" };
const wideBreak = { starts_at: START, rule: { label: "Studio lunch" }, practitioner_id: null };

describe("S1: liveScopedRows (one rule for day, week and month)", () => {
  it("capacity OFF keeps studio-wide rows only; capacity ON keeps both, in order", () => {
    expect(liveScopedRows(false, [scopedBlock, wideBlock])).toEqual([wideBlock]);
    expect(liveScopedRows(true, [scopedBlock, wideBlock])).toEqual([scopedBlock, wideBlock]);
    expect(liveScopedRows(false, [])).toEqual([]);
  });

  it("the month grid, fed through the rule, shows the studio break and no scoped one when off", () => {
    const month = (capacity: boolean) =>
      groupMonthBlockedByDate(
        [],
        liveScopedRows(capacity, [scopedBlock, wideBlock]),
        liveScopedRows(capacity, [scopedBreak, wideBreak]),
        TZ,
        () => false,
      ).get("2026-11-17")?.labels ?? [];
    const off = month(false);
    expect(off.some((l) => l.includes("Scoped"))).toBe(false);
    expect(off.some((l) => l.includes("Studio"))).toBe(true);
    const on = month(true);
    expect(on.some((l) => l.includes("Scoped"))).toBe(true);
  });

  it("the week, mobile and month paths all read blocks and breaks through the rule, never raw", () => {
    const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
    const week = page.slice(page.indexOf("timedBlocksByDate = new Map"), page.indexOf("const mobileDays"));
    expect(week).toMatch(/of liveScopedRows\(studio\.practitioner_capacity_enabled === true, timedBlocks\)/);
    expect(week).toMatch(/of liveScopedRows\(studio\.practitioner_capacity_enabled === true, recurringOccurrences\)/);
    const month = page.slice(page.indexOf("groupMonthBlockedByDate("), page.indexOf("const lastWeekHref"));
    expect(month).toMatch(/liveScopedRows\(studio\.practitioner_capacity_enabled === true, timedBlocks\)/);
    expect(month).toMatch(/liveScopedRows\(studio\.practitioner_capacity_enabled === true, recurringOccurrences\)/);
    expect(week).not.toMatch(/of timedBlocks\)|of recurringOccurrences\)/);
  });
});

describe("S2: who may create from a Day column", () => {
  const base = { active: true, isOwner: false, columnPractitionerId: "p-ana", viewerPractitionerId: "p-bo" };

  it("capacity OFF: a member who is not the column's practitioner may create, as the week grid allows", () => {
    expect(teamColumnAllowsCreate({ ...base, capacityEnabled: false })).toBe(true);
  });

  it("capacity ON: unchanged. A member books only their own column; an owner any active one", () => {
    expect(teamColumnAllowsCreate({ ...base, capacityEnabled: true })).toBe(false);
    expect(teamColumnAllowsCreate({ ...base, capacityEnabled: true, viewerPractitionerId: "p-ana" })).toBe(true);
    expect(teamColumnAllowsCreate({ ...base, capacityEnabled: true, isOwner: true })).toBe(true);
  });

  it("an inactive column (former practitioner, unassigned) never offers create, in either mode", () => {
    for (const capacityEnabled of [true, false]) {
      expect(teamColumnAllowsCreate({ ...base, capacityEnabled, active: false, isOwner: true })).toBe(false);
    }
  });

  it("the page uses the rule rather than an inline expression", () => {
    const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
    expect(page).toMatch(/allowCreate: teamColumnAllowsCreate\(\{[\s\S]*?capacityEnabled,/);
    expect(page).not.toMatch(/allowCreate: c\.active &&/);
  });
});
