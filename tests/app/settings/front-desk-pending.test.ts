import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The Front desk Deactivate / Reactivate control must acknowledge the press and refuse a second one while the action runs (DESIGN.md: every async
// control reports its own progress). PendingButton is the canonical control: pending disables it, so the duplicate-submit guard is not advisory.

const code = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PAGE = code("app/(app)/settings/team/page.tsx");
const FRONT_DESK = PAGE.slice(PAGE.indexOf("function FrontDesk("), PAGE.indexOf("function CurrentPractitioners("));

describe("Team settings: the Front desk control reports its own progress", () => {
  it("found the FrontDesk section (the slice below is not empty)", () => {
    expect(FRONT_DESK.length).toBeGreaterThan(200);
    expect(FRONT_DESK).toContain("setReceptionistActiveAction");
  });

  it("Deactivate / Reactivate is a PendingButton inside the action's form, and no raw submit button survives in the section", () => {
    expect(FRONT_DESK).toMatch(/<form action=\{setReceptionistActiveAction\}>[\s\S]*<PendingButton variant="secondary" size="sm">[\s\S]*<\/PendingButton>[\s\S]*<\/form>/);
    expect(FRONT_DESK).not.toMatch(/<button\b/);
    expect(FRONT_DESK).not.toContain('type="submit"');
    expect(PAGE).toContain('import { PendingButton } from "@/components/pending-button";');
  });

  it("the hidden fields the action reads are unchanged (id, and the state to move to)", () => {
    expect(FRONT_DESK).toContain('name="id" value={r.id}');
    expect(FRONT_DESK).toContain('name="active" value={r.active ? "false" : "true"}');
  });
});
