import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// HON-48: the Day view takes its geometry from lib/calendar/team-day-layout.ts (columns share the full
// width equally, with a named minimum) and says so when nobody is working or nobody is selected,
// rather than render an empty grid.
const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
const team = page.slice(page.indexOf("async function renderTeamDayView"));

describe("team day view layout contract", () => {
  it("sizes columns from the shared template, with no inline fixed or fractional track", () => {
    expect(team).toContain("teamDayGridTemplate(columns.length)");
    expect(team).not.toMatch(/minmax\(|\d+fr\b|repeat\(\$\{/);
  });
  it("exposes the column count and explicit empty states for Team's spec", () => {
    expect(team).toContain("data-column-count={columns.length}");
    expect(team).toContain('data-testid="team-day-empty"');
    expect(team).toContain("<EmptySelection />");
  });
  it("renders no grid when there are no columns", () => {
    expect(team).toMatch(/columns\.length === 0 \? \(/);
  });
  it("the column header carries the name, an initials avatar and the hours line", () => {
    expect(page).toContain('data-testid="team-day-column-avatar"');
    expect(page).toContain("practitionerInitials(column.name)");
  });
});
