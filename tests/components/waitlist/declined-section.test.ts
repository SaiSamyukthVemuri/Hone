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
      entryPages: new Map([["e1", 1]]), pageWindow: { page: 1, pageCount: 1, from: 0, to: 1 }, contacts: new Map([["e1", { kind: "entry" as const, email: "alex@example.invalid", phone: "+14165550100" }]]),
      entryFactsUnreadable: false, linkableStatuses: new Set(["waiting", "invited", "released"]), backHref: "/waitlist", ...over,
    }),
  );

describe("DeclinedSection", () => {
  it("shows the name, when they declined, their own answers, the entry link and a closed contact disclosure", () => {
    const html = render();
    expect(html).toContain("Alex Rivers");
    expect(html).toContain("Declined Aug 21, 2026, 6:00 AM EDT");
    expect(html).toContain("Mornings are hard");
    expect(html).toContain("Weekday evenings");
    expect(html).toContain('href="/waitlist?section=waiting#entry-e1"');
    expect(html).toMatch(/<details[^>]*data-testid="declined-contact"/);
    expect(html).not.toMatch(/<details[^>]*open/);
  });
  it("the people's own words are text, never markup", () => {
    const html = render({ followUps: { kind: "ok", rows: [fu({ whyNotWork: "<b>x</b><script>alert(1)</script>" })] } });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it.each([
    ["erased", { kind: "ok", rows: [fu({ answersErasedAt: "2026-09-01T00:00:00Z", whyNotWork: null, betterTimes: null })] } as FollowUpList, true, "Answer erased"],
    ["no follow-up exists", { kind: "ok", rows: [] } as FollowUpList, true, "Answer not collected"],
    ["unreadable", { kind: "unknown" } as FollowUpList, true, "couldn’t load their answers"],
    ["gate off", null, false, "Answer not collected"],
  ])("answers state %s", (_n, followUps, answersOn, text) => {
    const html = render({ followUps, answersOn });
    expect(html).toContain(text);
    expect(html).not.toContain("Mornings are hard");
  });
  it("a capped list with no match says the answers may not be shown, and the entry link carries the first-page hint", () => {
    const html = render({ followUps: { kind: "ok", rows: [], capped: true } as FollowUpList });
    expect(html).toContain("Their answers may not be shown: the list is long.");
    expect(html).not.toContain("No answers on record.");
    expect(html).not.toContain("first page of its section");
  });
  it("the entry link carries the page the entry is on (only past the first), and no page means no link", () => {
    const at = (n: number | undefined) => render({ entryPages: n === undefined ? new Map() : new Map([["e1", n]]) });
    expect(at(1)).toContain('href="/waitlist?section=waiting#entry-e1"');
    expect(at(3)).toContain('href="/waitlist?section=waiting&amp;page=3#entry-e1"');
    const none = at(undefined);
    expect(none).not.toContain("declined-entry-link");
    expect(none).toContain("its page could not be worked out");
    expect(render({ entryPages: null })).not.toContain("declined-entry-link");
  });
  it("an erased scoped follow-up reads as removed in the row", () => {
    const erased = { kind: "ok", rows: [fu({ followupId: "f9", status: "handled", whyNotWork: null, betterTimes: null, answersErasedAt: "2026-09-01T00:00:00Z" })] } as FollowUpList;
    const html = render({ followUps: { kind: "ok", rows: [] } as FollowUpList, scopedFollowUps: new Map([["i1", erased]]) });
    expect(html).toContain("Answer erased");
    expect(html).not.toContain("Answer not collected");
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
  it("a page shows its own window of the total with previous and next links that carry a page number only", () => {
    const many = Array.from({ length: 10 }, (_, i) => person({ entryId: `e${i}`, invitationId: `i${i}`, name: `P${i}` }));
    const at = (page: number, pageCount: number, from: number, to: number) => render({ people: many, total: 110, contacts: null, followUps: null, answersOn: false, pageWindow: { page, pageCount, from, to } });
    const first = at(1, 3, 0, 50);
    expect(first).toContain("Showing 1–50 of 110, newest first. Page 1 of 3.");
    expect(first).not.toContain("declined-prev");
    expect(first).toContain('href="/waitlist?view=declined&amp;dpage=2"');
    const mid = at(2, 3, 50, 100);
    expect(mid).toContain("Showing 51–100 of 110");
    expect(mid).toContain('href="/waitlist?view=declined"'); // previous of page 2 is page 1, with no page number
    expect(mid).toContain('href="/waitlist?view=declined&amp;dpage=3"');
    const last = at(3, 3, 100, 110);
    expect(last).toContain("Showing 101–110 of 110");
    expect(last).not.toContain("declined-next");
    for (const html of [first, mid, last]) for (const m of html.matchAll(/data-testid="declined-(?:prev|next)"/g)) expect(m[0]).toBeTruthy();
    expect(last).not.toMatch(/href="[^"]*(P\d|alex|%40)/);
  });
  it("one page of people shows no paging controls", () => {
    const html = render();
    expect(html).not.toContain("declined-pages");
    expect(html).not.toContain("declined-showing");
  });
  it("a page holds at most 50 rows even if handed more", () => {
    const many = Array.from({ length: 60 }, (_, i) => person({ entryId: `e${i}`, invitationId: `i${i}`, name: `P${i}` }));
    expect((render({ people: many, total: 60, contacts: null, followUps: null, answersOn: false, pageWindow: { page: 1, pageCount: 2, from: 0, to: 50 } }).match(/data-testid="declined-row"/g) ?? []).length).toBe(50);
  });
  it("the note names the three outcomes by their exact labels", () => {
    const html = render();
    expect(html).toContain("“Declined”");
    expect(html).toContain("“Expired”");
    expect(html).toContain("“Released — reason not recorded”");
  });
  it("contact details never appear outside the disclosure, and the component has no form or action", () => {
    const html = render();
    const outside = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(outside).not.toContain("alex@example.invalid");
    expect(outside).not.toContain("5550100");
    expect(html).not.toMatch(/<form|<button[^>]*type="submit"/);
  });
});
