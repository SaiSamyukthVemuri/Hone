import { describe, it, expect } from "vitest";
import { teamDayGridTemplate, TEAM_DAY_COLUMN_WIDTH_REM } from "@/lib/calendar/team-day-layout";

describe("teamDayGridTemplate", () => {
  it("gives every column the same fixed width, never a stretching fraction", () => {
    for (const n of [1, 2, 5, 12]) {
      const t = teamDayGridTemplate(n);
      expect(t).toBe(`60px repeat(${n}, ${TEAM_DAY_COLUMN_WIDTH_REM}rem)`);
      expect(t).not.toMatch(/fr|minmax/);
    }
  });
  it("keeps one track for zero or invalid counts", () => {
    expect(teamDayGridTemplate(0)).toContain("repeat(1,");
    expect(teamDayGridTemplate(Number.NaN)).toContain("repeat(1,");
  });
});
