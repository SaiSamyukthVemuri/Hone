import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isInitialCalendarEntry, isTeamCalendar } from "@/app/(app)/calendar/initial-view";

// HON-48 (Sam decision 17): Day is the INITIAL view for a team studio. The rule
// is the pure pair in initial-view.ts; the page applies it only to an entry with
// no calendar parameter, so every explicit link keeps its meaning (that is how a
// user's remembered view survives: it lives in the URL of each toggle, step and
// return link). Permissions are untouched: the same queries run for every role.

const PAGE = readFileSync("app/(app)/calendar/page.tsx", "utf8");
const MOBILE = readFileSync("app/(app)/calendar/CalendarMobileDayView.tsx", "utf8");

describe("what counts as the initial entry", () => {
  it("is a bare /calendar", () => {
    expect(isInitialCalendarEntry({})).toBe(true);
  });
  it.each([
    [{ view: "week" }],
    [{ view: "day" }],
    [{ view: "month" }],
    [{ view: "garbage" }],
    [{ day: "2026-10-26" }],
    [{ week: "2026-10-25" }],
    [{ month: "2026-10-01" }],
    [{ view: "week", week: "2026-10-25", day: "2026-10-26" }],
  ])("is NOT an initial entry with %j (an explicit choice keeps its meaning)", (params) => {
    expect(isInitialCalendarEntry(params)).toBe(false);
  });
});

describe("what counts as a team calendar", () => {
  const two = [{ id: "a" }, { id: "b" }];
  it("needs capacity on AND more than one active practitioner", () => {
    expect(isTeamCalendar(true, two)).toBe(true);
    expect(isTeamCalendar(true, [{ id: "a" }])).toBe(false);
    expect(isTeamCalendar(true, [])).toBe(false);
    expect(isTeamCalendar(false, two)).toBe(false);
  });
});

describe("the page applies the rule to the initial entry only", () => {
  it("overrides the view only for an initial entry on a capacity-on studio, through the shared helpers", () => {
    expect(PAGE).toContain('import { isInitialCalendarEntry, isTeamCalendar } from "./initial-view";');
    expect(PAGE).toMatch(
      /if \(isInitialCalendarEntry\(params\) && studio\.practitioner_capacity_enabled === true\) \{\s*const active = await getPractitionersForStudio\(studio\.id\);\s*if \(isTeamCalendar\(true, active\)\) view = "day";\s*\}/,
    );
    // The default is still the week, and parseView is untouched.
    expect(PAGE).toContain('return raw === "month" ? "month" : raw === "day" ? "day" : "week";');
  });

  it("no capacity-off studio ever runs the extra practitioner read", () => {
    expect(PAGE).not.toMatch(/isInitialCalendarEntry\(params\)\) \{/);
  });

  it("a week-view 'Today' names the week, or a team studio would be sent to the Day view", () => {
    expect(PAGE).toContain('todayHref="/calendar?view=week"');
    expect(PAGE).not.toMatch(/todayHref="\/calendar"/);
    expect(MOBILE).toContain('router.push("/calendar?view=week")');
    expect(MOBILE).not.toContain('router.push("/calendar")');
  });

  it("every other in-page link already carries a parameter, so none re-enters the default", () => {
    const hrefs = [...PAGE.matchAll(/(?:weekHref|monthHref|dayHref|prevHref|todayHref|nextHref)=\{?[`"]([^`"]+)[`"]/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(8);
    for (const h of hrefs) expect(h, h).toMatch(/^\/calendar\?/);
  });

  it("the Day view's non-team redirect and Week tab keep a parameter, so there is no redirect loop", () => {
    expect(PAGE).toContain("redirect(`/calendar?day=${date}`)");
    expect(PAGE).toContain("weekHref={`/calendar?day=${date}`}");
  });

  it("permissions are not read here: no role or owner check decides the initial view", () => {
    const block = PAGE.slice(PAGE.indexOf("HON-48 (Sam decision 17)"), PAGE.indexOf("The week view continues"));
    expect(block).not.toMatch(/isOwner|role|practitioner\./);
  });
});

// #1131 regression: practitioner-quick-book-studio-b did page.goto("/calendar") on a
// capacity-ON studio with several practitioners and looked for the WEEK grid's
// "Open quick-book draft for <date>" button; since #1131 that URL opens the team
// Day view. The rule below keeps the next spec from repeating it: a spec that
// turns capacity ON and seeds more practitioners (a team studio) must name its
// view when it navigates to /calendar. team-day-view.spec.ts is the one spec whose
// subject IS the bare entry.
describe("e2e specs on a team studio never rely on the bare /calendar default", () => {
  const BARE_CALENDAR = /(?:goto|waitForURL)\(\s*["'`]\/calendar["'`]\s*[,)]/;
  const files = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts"));

  it("finds the specs it is meant to police", () => {
    expect(files.length).toBeGreaterThan(90);
    const team = files.filter((f) => {
      const src = readFileSync(`e2e/${f}`, "utf8");
      return /setStudioCapacityEnabled\([^)]*true/.test(src) && /seedE2eMember|seedFettStudio/.test(src);
    });
    expect(team).toEqual(expect.arrayContaining(["team-day-view.spec.ts", "practitioner-quick-book-studio-b.spec.ts"]));
  });

  it("a spec that enables capacity and seeds practitioners has no bare /calendar navigation, except team-day-view", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f === "team-day-view.spec.ts") continue;
      const src = readFileSync(`e2e/${f}`, "utf8");
      const team = /setStudioCapacityEnabled\([^)]*true/.test(src) && /seedE2eMember|seedFettStudio/.test(src);
      if (team && BARE_CALENDAR.test(src)) offenders.push(f);
    }
    expect(offenders, "name the view: /calendar?view=week (or view=day)").toEqual([]);
  });

  it("the guard sees the pre-fix shape", () => {
    expect(BARE_CALENDAR.test('  await page.goto("/calendar");')).toBe(true);
    expect(BARE_CALENDAR.test('  await page.goto("/calendar?view=week");')).toBe(false);
    expect(BARE_CALENDAR.test("await ipadPage.goto(`/calendar`);")).toBe(true);
  });
});
