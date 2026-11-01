import { describe, it, expect } from "vitest";
import {
  teamDayGridTemplate,
  TEAM_DAY_COLUMN_MIN_WIDTH_REM,
  TEAM_DAY_RAIL_PX,
} from "@/lib/calendar/team-day-layout";

// HON-48 sidebar: Day columns FILL the width equally (one selected = the full width), never narrower
// than a named readable minimum; past it the grid scrolls sideways. Replaces the fixed 13rem track.
describe("teamDayGridTemplate", () => {
  it("shares the width equally: every column is minmax(MIN, 1fr), for 1, 2, 5 and 12 columns", () => {
    for (const n of [1, 2, 5, 12]) {
      const t = teamDayGridTemplate(n);
      expect(t).toBe(`${TEAM_DAY_RAIL_PX}px repeat(${n}, minmax(${TEAM_DAY_COLUMN_MIN_WIDTH_REM}rem, 1fr))`);
    }
  });
  it("a single column is a 1fr track: it takes the whole width beside the rail, not a fixed width", () => {
    expect(teamDayGridTemplate(1)).toMatch(/repeat\(1, minmax\([\d.]+rem, 1fr\)\)/);
    expect(teamDayGridTemplate(1)).not.toMatch(/repeat\(1, [\d.]+rem\)/);
  });
  it("names its readable minimum: an exported constant, in a sane range", () => {
    expect(TEAM_DAY_COLUMN_MIN_WIDTH_REM).toBeGreaterThanOrEqual(10);
    expect(TEAM_DAY_COLUMN_MIN_WIDTH_REM).toBeLessThanOrEqual(16);
    expect(teamDayGridTemplate(3)).toContain(`${TEAM_DAY_COLUMN_MIN_WIDTH_REM}rem`);
  });
  it("the grid needs rail + N minimums, so past the container it scrolls sideways", () => {
    const needPx = (n: number) => TEAM_DAY_RAIL_PX + n * TEAM_DAY_COLUMN_MIN_WIDTH_REM * 16;
    expect(needPx(5)).toBeGreaterThan(960); // five columns overflow a 960px box: horizontal scroll
    expect(needPx(1)).toBeLessThan(960); // one never forces a scroll
  });
  it("keeps one track for zero or invalid counts", () => {
    expect(teamDayGridTemplate(0)).toContain("repeat(1,");
    expect(teamDayGridTemplate(Number.NaN)).toContain("repeat(1,");
  });
});
