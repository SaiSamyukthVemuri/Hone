import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

// The charting view is a display preference. It must be read ONLY by the preference modules: never by anything that
// decides who may do what. A new reader has to be added here on purpose, and a reviewer will see it.
const ALLOWED = new Set([
  "lib/charting/view-preference.ts",
  "app/(app)/charting-view-actions.ts",
  "tests/lib/charting/view-preference.test.ts",
  "tests/lib/charting/view-preference-display-only.test.ts",
  "tests/app/charting-view-actions.test.ts",
]);

describe("the charting view preference is display only", () => {
  it("is named in no other source file", () => {
    const out = execFileSync("git", ["grep", "-l", "-E", "charting_view|CHARTING_VIEW_KEY|HONE_CHARTING_NEW_VIEW", "--", "app", "lib", "components", "tests", "middleware.ts"], {
      encoding: "utf8",
    }).trim();
    const files = out.split("\n").filter(Boolean);
    expect(files.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
  it("stores a closed value and no free text", async () => {
    const mod = await import("@/lib/charting/view-preference");
    expect([...mod.CHARTING_VIEWS]).toEqual(["current", "new"]);
  });
});
