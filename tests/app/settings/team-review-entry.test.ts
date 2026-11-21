import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Sam, DQ-7 (#1336): the review page keeps a quiet PERMANENT entry in Settings for whoever can already reach it, ALWAYS shown, whether or
// not the prominent reminder is (the reminder appears in addition when something needs review). No authorization changes. Two kinds of
// test: source pins for structure, and a behavioural render of the real Team page for each role (below). The browser behaviour is in
// e2e/review-link-solo-owner.spec.ts.

const team = readFileSync("app/(app)/settings/team/page.tsx", "utf8");
const review = readFileSync("app/(app)/calendar/check-practitioner/page.tsx", "utf8");
const calendar = readFileSync("app/(app)/calendar/page.tsx", "utf8");

describe("the Settings entry to the assignment review", () => {
  it("is unconditional: the reminder is the only conditional link, and the quiet entry is a separate element after it", () => {
    expect(team).toMatch(/\{showReviewLink && \(/);
    expect(team).not.toMatch(/showReviewLink \? \(/);
    const reminderAt = team.indexOf('data-testid="team-review-assignments"');
    const quietAt = team.indexOf('data-testid="team-review-assignments-quiet"');
    expect(reminderAt).toBeGreaterThan(-1);
    expect(quietAt).toBeGreaterThan(reminderAt);
    // between the end of the reminder block and the quiet link there is no opening of another conditional on showReviewLink
    const between = team.slice(team.indexOf("</p>", reminderAt), quietAt);
    expect(between).not.toContain("showReviewLink");
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
    // V-1b A moved the read off the critical path; who gets it and when it hides are unchanged (behaviour: review-link-off-critical-path.test.ts)
    expect(calendar).toContain("? shouldShowReviewLink(studio.id).then(");
    expect(calendar).toContain('(show) => (show ? "/calendar/check-practitioner" : undefined)');
    expect(calendar).toMatch(/isOwner\s*\? shouldShowReviewLink/);
  });
  it("the Team page still hides the prominent reminder through shouldShowReviewLink", () => {
    expect(team).toContain("const showReviewLink = await shouldShowReviewLink(studio.id);");
  });
});

describe("behaviour of the real Team page, by role (queries mocked, page and components real)", () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock("@/lib/supabase/queries"); });
  const load = async (role: string, reminder: boolean) => {
    vi.resetModules();
    const getPractitionersForStudio = vi.fn(async () => [{ id: "p-1", display_name: "Solo", email: "solo@example.test", role: "owner", active: true }]);
    const shouldShowReviewLink = vi.fn(async () => reminder);
    vi.doMock("@/lib/supabase/queries", () => ({
      requirePractitionerWithStudio: async () => ({ practitioner: { id: "p-1", role }, studio: { id: "studio-synthetic" } }),
      getPractitionersForStudio,
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }) }) }),
    }));
    vi.doMock("@/lib/appointments/review-link", () => ({ shouldShowReviewLink }));
    vi.doMock("../../../app/(app)/settings/team/actions", () => ({ removePractitionerAction: vi.fn(), revokeInvitationAction: vi.fn() }));
    const { default: Page } = await import("../../../app/(app)/settings/team/page");
    return { html: renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })), getPractitionersForStudio, shouldShowReviewLink };
  };
  const QUIET = 'data-testid="team-review-assignments-quiet"';
  const REMINDER = 'data-testid="team-review-assignments"';

  it("authorized solo owner, nothing to review: the quiet entry is shown, the reminder is not", async () => {
    const { html } = await load("owner", false);
    expect(html).toContain(QUIET);
    expect(html).not.toContain(REMINDER);
    expect(html).toContain('href="/calendar/check-practitioner"');
  });
  it("owner with something to review: the quiet entry is STILL shown, and the reminder appears in addition", async () => {
    const { html } = await load("owner", true);
    expect(html).toContain(QUIET);
    expect(html).toContain(REMINDER);
  });
  for (const role of ["receptionist", "practitioner"]) {
    for (const reminder of [false, true]) {
      it(`${role} (reminder condition ${reminder}): sees neither link, is told owners only, and nothing about the team is read`, async () => {
        const { html, getPractitionersForStudio, shouldShowReviewLink } = await load(role, reminder);
        expect(html).not.toContain(QUIET);
        expect(html).not.toContain(REMINDER);
        expect(html).not.toContain("/calendar/check-practitioner");
        expect(html).toContain("Only studio owners can manage the team.");
        expect(getPractitionersForStudio).not.toHaveBeenCalled();
        expect(shouldShowReviewLink).not.toHaveBeenCalled();
      });
    }
  }
});
