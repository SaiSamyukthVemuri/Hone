import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The day-navigation ARITHMETIC is proved in tests/lib/dashboard. This file
// proves the page is actually WIRED to it — the class of defect that unit
// tests of a pure module cannot see, and that the browser lane sees only when
// its group is selected.
//
// Source pins, because the Dashboard is an async server component with a dozen
// awaited loaders and the repo has no harness that renders it. Same idiom as
// operational-hierarchy.test.ts.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAGE = read("app/(app)/dashboard/page.tsx");
const SNAPSHOT = read("app/(app)/dashboard/practice-snapshot.tsx");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const PAGE_CODE = stripComments(PAGE);
const SNAPSHOT_CODE = stripComments(SNAPSHOT);

describe("the selected day is resolved once, defensively, from the URL", () => {
  it("the raw param is never used directly — it goes through resolveSelectedDay", () => {
    expect(PAGE_CODE).toMatch(
      /const selectedDayLocal = resolveSelectedDay\(\s*sp\.day,\s*todayLocal,?\s*\)/,
    );
    // No other reader of the raw param. A second, unvalidated read is how a
    // `2026-02-31` reaches the date helpers.
    expect((PAGE_CODE.match(/sp\.day/g) ?? []).length).toBe(1);
  });

  it("actual-today is still its own value and is NOT redefined from the URL", () => {
    // The single most dangerous edit in this feature. `todayLocal` also drives
    // the birthdays month, the supply-expiry horizon, the To-do supply labels
    // and the birthday "Today" badge — none of which may follow a day the
    // practitioner is merely LOOKING at.
    expect(PAGE_CODE).toMatch(/const todayLocal = todayInTz\(studio\.timezone\)/);
    expect((PAGE_CODE.match(/const todayLocal =/g) ?? []).length).toBe(1);
    expect(PAGE_CODE).not.toMatch(/todayLocal = selectedDay/);
  });
});

describe("the roster window is the SELECTED day, and it is DST-correct", () => {
  it("both bounds come from local midnight — never start-plus-24h", () => {
    // A Toronto day is 23 or 25 hours twice a year. `start + 86_400_000` drops
    // a real appointment on the fall-back day.
    expect(PAGE_CODE).toMatch(
      /utcInstantFromLocal\(\s*selectedDayLocal,\s*"00:00",\s*studio\.timezone,?\s*\)/,
    );
    expect(PAGE_CODE).toMatch(
      /utcInstantFromLocal\(\s*selectedDayEndLocal,\s*"00:00",\s*studio\.timezone,?\s*\)/,
    );
    expect(PAGE_CODE).toMatch(
      /const selectedDayEndLocal = addDays\(selectedDayLocal, 1\)/,
    );
    expect(PAGE_CODE).not.toMatch(/86_?400_?000|24 \* 60 \* 60 \* 1000/);
  });
});

describe("time-relative surfaces stay anchored to the REAL present", () => {
  it("the Current pill cannot appear on a day that is not today", () => {
    // Gated by CONSTRUCTION — the empty set is built when the briefing is not
    // on today, so no downstream reader can reintroduce the highlight.
    expect(PAGE_CODE).toMatch(
      /const currentAppointmentIdSet = !viewingToday\s*\?\s*new Set<string>\(\)\s*:\s*currentAppointmentIds\(/,
    );
  });

  it("'Before today' is bounded by the APPOINTMENT, not gated off the day", () => {
    // The first version of this feature gated the load off on non-today
    // briefings. That stopped a past day seeing a later session and, in the
    // same stroke, told the practitioner that tomorrow's returning clients
    // were new. The load now always runs and each appointment carries its own
    // cutoff, so both facts survive.
    expect(PAGE_CODE).not.toMatch(/beforeTodayPreviews = viewingToday/);
    expect(PAGE_CODE).toMatch(
      /const historyByAppointment = await getAppointmentHistory\(/,
    );
    expect(PAGE_CODE).toMatch(/before: a\.starts_at/);
    // Keyed by appointment id — the whole reason the map exists.
    expect(PAGE_CODE).toMatch(/historyByAppointment\.get\(appt\.id\)/);
  });
});

describe("the two controls do not fight each other", () => {
  it("day links carry the period", () => {
    // `period` here is the VALIDATED value (isDashboardPeriod), not the raw
    // param, so an unsupported period is not laundered back into a link.
    // Every day control builds its href through the one shared builder.
    for (const id of ["dashboard-prev-day", "dashboard-today", "dashboard-next-day"]) {
      expect(PAGE, id).toMatch(new RegExp(`data-testid="${id}"`));
    }
    // Three day links, three uses of the one builder — no hand-rolled href.
    const uses = [...PAGE_CODE.matchAll(/dashboardDayHref\(\{[\s\S]*?\}\)/g)];
    expect(uses).toHaveLength(3);
    // Every one of them passes the period through.
    for (const u of uses) expect(u[0]).toMatch(/\bperiod,?\s*\}/);
    expect(PAGE_CODE).not.toMatch(/href="\/dashboard\?day=/);
  });

  it("period links carry the DAY — they are not hardcoded back to /dashboard", () => {
    // The regression this pins: `href={`/dashboard?period=${p.key}`}` silently
    // dropped the selected day, so clicking a period pill snapped the roster
    // back to today while appearing to change something else entirely.
    expect(SNAPSHOT_CODE).not.toMatch(/`\/dashboard\?period=\$\{/);
    expect(SNAPSHOT_CODE).toMatch(
      /href=\{dashboardDayHref\(\{ day: selectedDay, todayLocal, period: p\.key \}\)\}/,
    );
    expect(PAGE_CODE).toMatch(
      /<PracticeSnapshot[\s\S]{0,300}?selectedDay=\{selectedDayLocal\}[\s\S]{0,120}?todayLocal=\{todayLocal\}/,
    );
  });
});
