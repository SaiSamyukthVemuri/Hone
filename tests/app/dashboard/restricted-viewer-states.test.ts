import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Roles R4 (RO-1) inside the #1308 dashboard structure: a viewer without clin.view_records is told the records follow-up is not available
// to their role. A zero count or an "all caught up" line would claim nothing needs review. Source-contract; the rendering of the panel note is
// covered by needs-attention-unavailable.test.ts.

const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
const panel = readFileSync("app/(app)/dashboard/needs-attention-panel.tsx", "utf8");
const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");

describe("restricted viewer states survive the dashboard restructure", () => {
  it("the summary strip and the header pill never show a number for a restricted viewer", () => {
    expect(stack).toContain('if (model.notAvailableToRole) return "restricted";');
    expect(stack.match(/Not available to your role/g)!.length).toBeGreaterThanOrEqual(2);
  });
  it("the model input carries the restriction and the panel states it before any all-clear", () => {
    expect(stack).toContain("notAvailableToRole: followUpAssistant.notAvailable === true || clientsNeedingAttention.notAvailable === true");
    expect(panel.indexOf("restrictedNote")).toBeGreaterThan(-1);
    expect(panel.indexOf("if (restrictedNote)")).toBeLessThan(panel.indexOf("Nothing needs attention right now"));
  });
  it("the lower-row charting card and the today list state the restriction instead of an empty card", () => {
    expect(stack).toContain('data-testid="personal-charting-not-available"');
    expect(page).toContain('data-testid="today-history-not-available"');
  });
});
