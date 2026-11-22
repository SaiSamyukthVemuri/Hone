import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeclinedSection } from "@/components/waitlist/declined-section";
import type { DeclinedPerson } from "@/lib/waitlist/decline-visibility";
import type { FollowUpList, FollowUpRow } from "@/lib/waitlist/followups-owner";

const person = (over: Partial<DeclinedPerson> = {}): DeclinedPerson => ({ entryId: "e1", invitationId: "i1", declinedAt: "2026-08-21T10:00:00Z", name: "Alex Rivers", entryStatus: "waiting", ...over });
const fu = (over: Partial<FollowUpRow> = {}): FollowUpRow => ({
  followupId: "f1", kind: "decline", invitationId: "i1", entryId: "e1", clientName: "Alex Rivers", openedAt: "2026-08-21T10:00:00Z", status: "open",
  whyNotWork: "Mornings are hard", betterTimes: "Weekday evenings", answersErasedAt: null, submittedAt: "2026-08-21T10:00:00Z", closedAt: null, eraseBy: null, ...over,
});
const render = (over: Partial<Parameters<typeof DeclinedSection>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(DeclinedSection, {
      people: [person()], total: 1, timeZone: "America/Toronto", answersOn: true,
      followUps: { kind: "ok", rows: [fu()] } as FollowUpList,
      contacts: new Map([["e1", { kind: "entry" as const, email: "alex@example.invalid", phone: "+14165550100" }]]),
      entryFactsUnreadable: false, linkableStatuses: new Set(["waiting", "invited", "released"]), backHref: "/settings/waitlist", ...over,
    }),
  );

describe("DeclinedSection", () => {
  it("shows the name, when they declined, their own answers, the entry link and a closed contact disclosure", () => {
    const html = render();
    expect(html).toContain("Alex Rivers");
    expect(html).toContain("Declined Aug 21, 2026, 6:00 AM EDT");
    expect(html).toContain("Mornings are hard");
    expect(html).toContain("Weekday evenings");
    expect(html).toContain('href="/settings/waitlist?section=waiting#entry-e1"');
    expect(html).toMatch(/<details[^>]*data-testid="declined-contact"/);
    expect(html).not.toMatch(/<details[^>]*open/);
  });
  it("the people's own words are text, never markup", () => {
    const html = render({ followUps: { kind: "ok", rows: [fu({ whyNotWork: "<b>x</b><script>alert(1)</script>" })] } });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it.each([
    ["erased", { kind: "ok", rows: [fu({ answersErasedAt: "2026-09-01T00:00:00Z", whyNotWork: null, betterTimes: null })] } as FollowUpList, true, "removed from view"],
    ["none on record", { kind: "ok", rows: [] } as FollowUpList, true, "No answers on record."],
    ["unreadable", { kind: "unknown" } as FollowUpList, true, "couldn’t load their answers"],
    ["not collected", null, false, "not being collected yet"],
  ])("answers state %s", (_n, followUps, answersOn, text) => {
    const html = render({ followUps, answersOn });
    expect(html).toContain(text);
    expect(html).not.toContain("Mornings are hard");
  });
  it("a person whose entry is gone has no link, only the honest sentence", () => {
    const html = render({ people: [person({ entryStatus: "removed" })] });
    expect(html).not.toContain("declined-entry-link");
    expect(html).toContain("no longer on the waitlist");
  });
  it("unreadable decline records say so and never 'nobody declined'", () => {
    const html = render({ people: [], total: null });
    expect(html).toContain("declined-unknown");
    expect(html).not.toContain("Nobody has declined");
  });
  it("zero declines says nobody has declined", () => {
    expect(render({ people: [], total: 0 })).toContain("Nobody has declined the times offered.");
  });
  it("lists at most 50 and says how many of the total", () => {
    const many = Array.from({ length: 60 }, (_, i) => person({ entryId: `e${i}`, invitationId: `i${i}`, name: `P${i}` }));
    const html = render({ people: many, total: 60, contacts: null, followUps: null, answersOn: false });
    expect((html.match(/data-testid="declined-row"/g) ?? []).length).toBe(50);
    expect(html).toContain("Showing the 50 most recent of 60.");
  });
  it("contact details never appear outside the disclosure, and the component has no form or action", () => {
    const html = render();
    const outside = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(outside).not.toContain("alex@example.invalid");
    expect(outside).not.toContain("5550100");
    expect(html).not.toMatch(/<form|<button[^>]*type="submit"/);
  });
});
