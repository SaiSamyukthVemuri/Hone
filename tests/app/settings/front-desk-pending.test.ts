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
// HON-124 item 20: the control moved into one client form that reads the action result.
const CONTROL = code("app/(app)/settings/team/ReceptionistActiveForm.tsx");
const FRONT_DESK = PAGE.slice(PAGE.indexOf("function FrontDesk("), PAGE.indexOf("function CurrentPractitioners("));

describe("Team settings: the Front desk control reports its own progress", () => {
  it("found the FrontDesk section (the slice below is not empty)", () => {
    expect(FRONT_DESK.length).toBeGreaterThan(200);
    expect(FRONT_DESK).toContain("setReceptionistActiveAction");
  });

  it("Deactivate / Reactivate is a PendingButton inside the action's form, and no raw submit button survives", () => {
    expect(FRONT_DESK).toContain("<ReceptionistActiveForm action={setReceptionistActiveAction}");
    expect(CONTROL).toMatch(/<form[\s\S]*<PendingButton variant="secondary" size="sm">[\s\S]*<\/PendingButton>[\s\S]*<\/form>/);
    expect(FRONT_DESK).not.toMatch(/<button\b/);
    expect(CONTROL).not.toMatch(/<button\b/);
    expect(CONTROL).not.toContain('type="submit"');
  });

  it("the hidden fields the action reads are unchanged (id, and the state to move to)", () => {
    expect(CONTROL).toContain('name="id" value={receptionistId}');
    expect(CONTROL).toContain('name="active" value={active ? "false" : "true"}');
  });
});
