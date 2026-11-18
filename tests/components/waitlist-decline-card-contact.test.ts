import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/settings/waitlist/follow-up-actions", () => ({
  markHandledAction: vi.fn(),
  keepWithdrawalAction: vi.fn(),
  eraseAnswersAction: vi.fn(),
  linkAppointmentAction: vi.fn(),
}));
import { DeclineFollowUpSection } from "@/components/waitlist/decline-follow-up-section";
import { emptyOutboxCounts } from "@/lib/waitlist/decline-status-lines";
import type { FollowUpRow } from "@/lib/waitlist/followups-owner";
import type { ReplyContact } from "@/lib/waitlist/reply-contact-pure";

const E1 = "00000000-0000-4000-8000-0000000000e1";
const E2 = "00000000-0000-4000-8000-0000000000e2";
const row = (o: Partial<FollowUpRow> = {}): FollowUpRow => ({
  followupId: "33333333-3333-4333-8333-333333333333",
  kind: "decline",
  invitationId: "i1",
  entryId: E1,
  clientName: "Synthetic Person",
  openedAt: "2026-11-09T10:00:00Z",
  status: "open",
  whyNotWork: "WHYMARK",
  betterTimes: "Weekday evenings",
  answersErasedAt: null,
  submittedAt: "2026-11-09T10:00:00Z",
  closedAt: null,
  eraseBy: "2027-02-07T10:00:00Z",
  ...o,
});
const render = (rows: FollowUpRow[], contacts: Map<string, ReplyContact> | null, rendered: Set<string> | null = null) =>
  renderToStaticMarkup(
    createElement(DeclineFollowUpSection, {
      rows, timeZone: "UTC", emailEnabled: true,
      outbox: new Map([["i1", { ...emptyOutboxCounts(), sent: 1 }]]),
      linkable: new Map(), notice: null, contacts, renderedEntryIds: rendered,
    }),
  );

describe("the decline response card shows the entry's contact", () => {
  it("email and phone present: both, with mailto, tel, copy and the entry link", () => {
    const html = render([row()], new Map([[E1, { kind: "entry", email: "a@example.test", phone: "+1 555 0100" }]]), new Set([E1]));
    expect(html).toContain("Weekday evenings");
    expect(html).toContain("a@example.test");
    expect(html).toContain('href="mailto:a@example.test"');
    expect(html).toContain('href="tel:+15550100"');
    expect(html).toContain(`href="/settings/waitlist#entry-${E1}"`);
    expect(html).toContain("Copy email");
  });
  it("phone missing and email missing use the plain wording", () => {
    expect(render([row()], new Map([[E1, { kind: "entry", email: "a@example.test", phone: null }]]))).toContain("No phone number on this entry");
    expect(render([row()], new Map([[E1, { kind: "entry", email: null, phone: "555 0101" }]]))).toContain("No email on this entry");
  });
  it("two people with the SAME name each show their own entry's contact", () => {
    const html = render(
      [row({ followupId: "33333333-3333-4333-8333-333333333331", entryId: E1 }), row({ followupId: "33333333-3333-4333-8333-333333333332", entryId: E2 })],
      new Map<string, ReplyContact>([
        [E1, { kind: "entry", email: "first@example.test", phone: null }],
        [E2, { kind: "entry", email: "second@example.test", phone: "555 0102" }],
      ]),
    );
    const cards = html.split('data-testid="reply-contact"').slice(1);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain("first@example.test");
    expect(cards[0]).not.toContain("second@example.test");
    expect(cards[1]).toContain("second@example.test");
  });
  it("erased answers stay erased and are never reconstructed; contact is still the entry's own", () => {
    const html = render(
      [row({ whyNotWork: null, betterTimes: null, answersErasedAt: "2026-12-01T00:00:00Z", eraseBy: null })],
      new Map([[E1, { kind: "entry", email: "a@example.test", phone: null }]]),
    );
    expect(html).toContain("Answers removed from view on");
    expect(html).not.toContain("WHYMARK");
    expect(html).not.toContain("Weekday evenings");
    expect(html).toContain("a@example.test");
  });
  it("an erased or removed entry says so and shows nothing guessed", () => {
    const html = render([row()], new Map([[E1, { kind: "gone" }]]));
    expect(html).toContain("no longer exists");
    expect(html).not.toContain("mailto:");
  });
  it("the entry link is offered only for an entry rendered on this page (no dangling anchor for a paged-out entry)", () => {
    const m = new Map<string, ReplyContact>([[E1, { kind: "entry", email: "a@example.test", phone: null }]]);
    const mk = (ids: Set<string> | null) =>
      renderToStaticMarkup(createElement(DeclineFollowUpSection, { rows: [row()], timeZone: "UTC", emailEnabled: true, outbox: null, linkable: new Map(), notice: null, contacts: m, renderedEntryIds: ids }));
    expect(mk(new Set([E1]))).toContain(`href="/settings/waitlist#entry-${E1}"`);
    expect(mk(new Set([E2]))).not.toContain("Open this waitlist entry");
    expect(mk(null)).not.toContain("Open this waitlist entry");
  });
  it("an unreadable contact read says so, and a removed response offers no entry link", () => {
    expect(render([row()], null)).toContain("couldn’t load this person’s contact");
    const removed = render([row({ status: "removed" })], new Map([[E1, { kind: "entry", email: "a@example.test", phone: null }]]));
    expect(removed).toContain("a@example.test");
    expect(removed).not.toContain("Open this waitlist entry");
  });
  it("adds no new form or action: the only forms are the existing response actions", () => {
    const html = render([row()], new Map([[E1, { kind: "entry", email: "a@example.test", phone: "555 0100" }]]), new Set([E1]));
    const start = html.indexOf('data-testid="reply-contact"');
    const contactPart = html.slice(start, html.indexOf("Open this waitlist entry", start));
    expect(contactPart).not.toContain("<form");
    expect(contactPart).not.toContain("<input");
  });
});

describe("source guards", () => {
  const PAGE = readFileSync(join(__dirname, "..", "..", "app/(app)/settings/waitlist/page.tsx"), "utf8");
  it("the contact read comes after the owner check and joins on entry id", () => {
    expect(PAGE.indexOf("loadReplyContacts(")).toBeGreaterThan(PAGE.indexOf("readFollowUps("));
    expect(PAGE).toMatch(/followUps\.rows\.map\(\(r\) => r\.entryId\)/);
  });
});
