import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Sam, DQ-7 (#1336): the prominent reminder is hidden when nothing needs review, but the review page keeps a quiet PERMANENT entry in
// Settings for whoever can already reach it. No authorization changes. Source-contract tests: the page and the entry are server-rendered
// and their rules are structural; the browser behaviour of the reminder is in e2e/review-link-solo-owner.spec.ts.

const team = readFileSync("app/(app)/settings/team/page.tsx", "utf8");
const review = readFileSync("app/(app)/calendar/check-practitioner/page.tsx", "utf8");
const calendar = readFileSync("app/(app)/calendar/page.tsx", "utf8");

describe("the Settings entry to the assignment review", () => {
  it("is present whenever the reminder is not: the ternary's other branch renders the quiet link to the same page", () => {
    expect(team).toMatch(/\{showReviewLink \? \(/);
    const quiet = team.slice(team.indexOf('data-testid="team-review-assignments-quiet"') - 200);
    expect(quiet).toContain('href="/calendar/check-practitioner"');
    expect(team).toContain('data-testid="team-review-assignments"'); // the reminder is still there, unchanged
  });
  it("is reachable only through the owner-only Team page: non-owners are stopped before anything renders", () => {
    const guard = team.indexOf('if (practitioner.role !== "owner")');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(team.indexOf("team-review-assignments-quiet"));
    expect(team).toMatch(/Only studio owners can manage the team\./);
  });
  it("is the only new link: the entry points at the same URL as the reminder and nowhere else", () => {
    expect(team.match(/href="\/calendar\/check-practitioner"/g)!.length).toBe(2);
  });
});

describe("authorization is unchanged (a source pin)", () => {
  it("the review page still resolves the practitioner and answers 404 to everyone but an owner", () => {
    expect(review).toContain("requirePractitionerWithStudio()");
    expect(review).toContain('if (practitioner.role !== "owner") notFound();');
    expect(review.indexOf("requirePractitionerWithStudio()")).toBeLessThan(review.indexOf('if (practitioner.role !== "owner") notFound();'));
  });
  it("the calendar reminder is still owner-only and still hidden when nothing needs review", () => {
    expect(calendar).toContain('isOwner && (await shouldShowReviewLink(studio.id)) ? "/calendar/check-practitioner" : undefined');
  });
  it("the Team page still hides the prominent reminder through shouldShowReviewLink", () => {
    expect(team).toContain("const showReviewLink = await shouldShowReviewLink(studio.id);");
  });
});
