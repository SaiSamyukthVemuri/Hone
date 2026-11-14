import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Roles R4 (RO-1) inside the #1308 dashboard structure: a viewer without clin.view_records is told the records follow-up is not available
// to their role. A zero count or an "all caught up" line would claim nothing needs review. Source-contract; the rendering of the panel note is
// covered by needs-attention-unavailable.test.ts.

const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
const panel = readFileSync("app/(app)/dashboard/needs-attention-panel.tsx", "utf8");
const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");

describe("restricted viewer states survive the dashboard restructure", () => {
  // Merge note: production's structure replaced the old per-strip count helpers with HeadingCountValue / resolveVisibleNeeds. RO-1 is re-applied
  // inside them (Team's recorded rule, 3 Nov): a restricted viewer is never given a number, never the all-clear, and no dismissal can reveal records.
  const fnBody = (src: string, start: string) => {
    const a = src.indexOf(start);
    expect(a, start).toBeGreaterThanOrEqual(0);
    return src.slice(a, src.indexOf("\n}\n", a));
  };
  it("the heading count says 'Not available to your role' for a restricted viewer, never a client or item count", () => {
    const body = fnBody(stack, "async function HeadingCountValue");
    expect(body).toContain('v.shown.notAvailableToRole || v.shown.intakeReviewNotAvailable\n      ? "Not available to your role"');
    expect(stack).not.toContain("resolveClientReviewCount"); // the old helper that returned a number is gone, not bypassed
  });
  it("FALL-THROUGH GUARD: in the heading count, the restricted branch comes BEFORE every path that builds a number", () => {
    const body = fnBody(stack, "async function HeadingCountValue");
    const restricted = body.indexOf("v.shown.notAvailableToRole");
    expect(restricted).toBeGreaterThan(-1);
    const numeric = [...body.matchAll(/\$\{(?:clients|items)\}/g)].map((m) => m.index!);
    expect(numeric.length).toBeGreaterThan(0);
    for (const at of numeric) expect(restricted, "a numeric template appears before the restricted branch").toBeLessThan(at);
  });
  it("dismissals cannot reveal records follow-up to a restricted viewer: none is read or applied, and the Dismissed view is withheld", () => {
    const body = fnBody(stack, "function resolveVisibleNeeds");
    const early = body.indexOf("if (model.notAvailableToRole) return");
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(body.indexOf("loadMyDismissals"));
    expect(early).toBeLessThan(body.indexOf("applyDismissals"));
    expect(body.slice(early, body.indexOf("\n", early))).toContain("dismissalsEnabled: false");
    expect(panel).toMatch(/const dismissedView = isOwner && dismissalsEnabled && !needs\.notAvailableToRole \?/);
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
