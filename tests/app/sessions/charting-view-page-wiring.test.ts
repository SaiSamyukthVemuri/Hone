import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
const code = page
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

describe("the charting page's Current / New switch wiring", () => {
  it("puts the switch beside the session title, in the same row", () => {
    expect(code).toMatch(/<\/h1>\s*\{chartingToggleVisible \? <ChartingViewToggle \/> : null\}/);
  });
  it("when the switch is hidden the page is returned exactly as before (no wrapper)", () => {
    expect(code).toMatch(/if \(!chartingToggleVisible\) return page;/);
  });
  it("keys the shell by the session, so another session can never inherit this one's view state", () => {
    expect(code).toMatch(/<ChartingViewShell\s+key=\{session\.id\}/);
  });
  it("opts no editor into retained state (a switch never remounts one, so nothing is retained or left behind)", () => {
    const files = [
      "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
      "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
      "components/charting-view-shell.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(src, f).not.toMatch(/retainKey\s*=/);
      expect(src, f).not.toMatch(/ChartingStateProvider/);
    }
  });
  it("reads the preference through the single page decision, not directly", () => {
    expect(code).toMatch(/chartingViewForPage\(/);
    expect(code).not.toMatch(/chartingViewFromMetadata|resolveChartingView|readChartingView/);
  });
  it("the switch component submits nothing: no form, no server action import other than remembering the choice", () => {
    const shell = readFileSync("components/charting-view-shell.tsx", "utf8");
    expect(shell).not.toMatch(/<form\b/);
    const actionImports = shell.match(/from "@\/app\/[^"]*"/g) ?? [];
    expect(actionImports).toEqual(['from "@/app/(app)/charting-view-actions"']);
  });
});
