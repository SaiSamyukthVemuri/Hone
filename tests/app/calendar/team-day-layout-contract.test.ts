import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// HON-48: the one-practitioner day view stretched its lone column across the
// whole screen because the track was `minmax(9rem, 1fr)`. The page must take
// its geometry from lib/calendar/team-day-layout.ts and must say so when
// nobody is working, rather than render an empty grid.
const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
const team = page.slice(page.indexOf("async function renderTeamDayView"));

describe("team day view layout contract", () => {
  it("sizes columns from the shared fixed-width template, never a fraction", () => {
    expect(team).toContain("teamDayGridTemplate(columns.length)");
    expect(team).not.toMatch(/minmax\(|\d+fr\b|repeat\(\$\{/);
  });
  it("exposes the column count and an explicit empty state for Team's spec", () => {
    expect(team).toContain("data-column-count={columns.length}");
    expect(team).toContain('data-testid="team-day-empty"');
  });
  it("renders no grid when there are no columns", () => {
    expect(team).toMatch(/columns\.length === 0 \? \(/);
  });
});
