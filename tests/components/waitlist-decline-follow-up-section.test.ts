import { readFileSync } from "node:fs";
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

const row = (o: Partial<FollowUpRow> = {}): FollowUpRow => ({
  followupId: "33333333-3333-4333-8333-333333333333",
  kind: "decline",
  invitationId: "i1",
  entryId: "e1",
  clientName: "Synthetic Person",
  openedAt: "2026-11-09T10:00:00Z",
  status: "open",
  whyNotWork: "WHYMARK",
  betterTimes: "BETTERMARK",
  answersErasedAt: null,
  submittedAt: "2026-11-09T10:00:00Z",
  closedAt: null,
  eraseBy: "2027-02-07T10:00:00Z",
  ...o,
});
const render = (rows: FollowUpRow[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(DeclineFollowUpSection, {
      rows,
      timeZone: "UTC",
      emailEnabled: true,
      outbox: new Map([["i1", { ...emptyOutboxCounts(), sent: 1 }]]),
      linkable: new Map(),
      notice: null,
      ...over,
    }),
  );

describe("the owner follow-up section", () => {
  it("is the #follow-up anchor and shows the answers and the erase date", () => {
    const html = render([row()]);
    expect(html).toContain('id="follow-up"');
    expect(html).toContain("WHYMARK");
    expect(html).toContain("BETTERMARK");
    expect(html).toContain("Answers will be removed from view on");
    expect(html).toContain("Answers will be removed from view on Feb 7, 2027.");
  });
  it("shows the saved line only when the owner just arrived from a save", () => {
    expect(render([row()], { justSaved: true })).toContain("Response saved. Review the follow-up below.");
    expect(render([row()])).not.toContain("Response saved.");
  });
  it("bell and email are separate lines, and email off reads off, not sent", () => {
    const on = render([row()]);
    expect(on).toContain("Bell:");
    expect(on).toContain("accepted by the email provider");
    expect(on).not.toMatch(/Bell:[^<]*Email:/);
    expect(render([row()], { emailEnabled: false })).toContain("Email: off, not sent");
  });
  it("never says delivered, queued or pending about the email", () => {
    const heldAndFailed = new Map([["i1", { ...emptyOutboxCounts(), held: 2, failed: 1 }]]);
    for (const html of [render([row()]), render([row()], { emailEnabled: false }), render([row()], { outbox: null }), render([row()], { outbox: heldAndFailed })]) {
      expect(html.toLowerCase()).not.toMatch(/delivered|queued|pending/);
    }
  });
  it("an erased or overdue row shows no answers and no 'will be removed' date, only the marker with the date they were removed from view", () => {
    const html = render([row({ whyNotWork: null, betterTimes: null, answersErasedAt: "2026-11-20T10:00:00Z" })]);
    expect(html).toMatch(/Answers removed from view on [A-Z][a-z]{2} \d{1,2}, 2026\./);
    expect(html).not.toMatch(/Answers erased on/);
    expect(html).not.toContain("WHYMARK");
    expect(html).not.toContain("Answers will be removed from view on");
  });
  it("Erase is offered on open, handled and closed rows while answers exist, behind More actions AND a confirm step", () => {
    for (const status of ["open", "handled", "kept", "booked", "removed"] as const) {
      const html = render([row({ status })]);
      expect(html, status).toContain('data-testid="more-actions"');
      expect(html, status).toContain('data-testid="erase-control"');
      // More actions opens the erase disclosure; the submit button lives inside the inner <details>, so it is not a one-click action
      const d = html.slice(html.indexOf('<details data-testid="erase-control"'), html.indexOf("</details>", html.indexOf('<details data-testid="erase-control"')));
      expect(d).toContain("<summary");
      expect(d).toContain("This cannot be undone");
      expect(d).toContain("Yes, erase all of this person&#x27;s answers");
      expect(html.match(/Yes, erase all of this person&#x27;s answers/g)).toHaveLength(1);
      expect(html).not.toContain("Yes, erase the answers");
    }
  });
  it("the erase copy says it is every answer of this person, on other responses earlier or later, and that downloaded copies are not affected", () => {
    const html = render([row()]);
    expect(html).toContain("Erase all of this person&#x27;s answers now, including those on their other responses, earlier or later?");
    expect(html).toContain("Copies you have already downloaded are not affected.");
    expect(html).not.toContain("on the waitlist now");
  });
  it("More actions has an accessible name that includes the person and the action, and is a native keyboard-operable disclosure", () => {
    const html = render([row({ clientName: "Ada Lovelace" })]);
    expect(html).toContain('aria-label="More actions for Ada Lovelace: erase answers"');
    expect(html).toMatch(/<details data-testid="more-actions"[^>]*><summary/);
    expect(html).not.toMatch(/<button[^>]*tabindex="-1"/);
    expect(render([row({ clientName: "" })])).toContain('aria-label="More actions for this person: erase answers"');
  });
  it("More actions sits in the row header, right after the name and BEFORE the answers and the primary actions, so an opened panel grows downward", () => {
    const html = render([row({ clientName: "Ada Lovelace" })]);
    const name = html.indexOf("Ada Lovelace");
    const more = html.indexOf('data-testid="more-actions"');
    expect(name).toBeGreaterThan(-1);
    expect(more).toBeGreaterThan(name);
    expect(more).toBeLessThan(html.indexOf("WHYMARK"));
    expect(more).toBeLessThan(html.indexOf("Book now"));
    expect(html).not.toContain("flex-col-reverse");
  });
  it("Book now, Mark handled and Keep on the waitlist stay visible OUTSIDE More actions", () => {
    const html = render([row(), row({ followupId: "44444444-4444-4444-8444-444444444444", kind: "withdrawal" })]);
    const outside = html.replace(/<details data-testid="more-actions"[\s\S]*?<\/details><\/div><\/details>/g, "");
    expect(outside).toContain("Book now");
    expect(outside).toContain("Mark handled");
    expect(outside).toContain("Keep on the waitlist");
    const inside = html.match(/<details data-testid="more-actions"[\s\S]*?<\/details><\/div><\/details>/g)?.join("") ?? "";
    expect(inside).toContain("Erase all of this person");
    expect(inside).not.toContain("Book now");
    expect(inside).not.toContain("Mark handled");
    expect(inside).not.toContain("Keep on the waitlist");
  });
  it("open and closed responses are split: closed ones sit in a collapsed 'Closed (n)' disclosure and the heading counts only open ones", () => {
    const html = render([
      row({ clientName: "OpenOne" }),
      row({ followupId: "55555555-5555-4555-8555-555555555555", status: "handled", clientName: "ClosedOne" }),
      row({ followupId: "66666666-6666-4666-8666-666666666666", status: "booked", clientName: "ClosedTwo" }),
    ]);
    expect(html).toContain("Waitlist responses (1)");
    const closedAt = html.indexOf('data-testid="closed-responses"');
    expect(closedAt).toBeGreaterThan(-1);
    expect(html).toContain("Closed (2)");
    expect(html.indexOf("OpenOne")).toBeLessThan(closedAt);
    expect(html.indexOf("ClosedOne")).toBeGreaterThan(closedAt);
    expect(html.indexOf("ClosedTwo")).toBeGreaterThan(closedAt);
    // not open by default
    expect(html.slice(closedAt - 10, closedAt + 40)).not.toContain(" open");
    // no closed rows: no Closed disclosure
    expect(render([row()])).not.toContain("closed-responses");
  });
  it("only closed rows: says there are no open responses, still lists the closed ones", () => {
    const html = render([row({ status: "handled" })]);
    expect(html).toContain("No open responses.");
    expect(html).toContain("Closed (1)");
    expect(html).toContain("Waitlist responses (0)");
  });
  it("Erase answers is hidden once the answers are erased, for every status", () => {
    for (const status of ["open", "handled", "removed"] as const) {
      const html = render([row({ status, whyNotWork: null, betterTimes: null, answersErasedAt: "2026-11-20T10:00:00Z" })]);
      expect(html, status).not.toContain("erase-control");
    }
  });
  it("a withdrawal with no answers has nothing to erase", () => {
    expect(render([row({ kind: "withdrawal", whyNotWork: null, betterTimes: null })])).not.toContain("erase-control");
  });
  it("a missing erase date shows a neutral fallback, not nothing; a present one shows the date", () => {
    const html = render([row({ eraseBy: null })]);
    expect(html).toContain("Erase date unavailable. You can erase these answers now, or contact support.");
    expect(html).not.toContain("Answers will be removed from view on");
    expect(render([row({ eraseBy: "not a date" })])).toContain("Erase date unavailable");
    expect(render([row()])).not.toContain("Erase date unavailable");
  });
  it("never renders an email address", () => {
    expect(render([row()])).not.toContain("@");
  });
  it("a person with more than 10 eligible appointments is told which are shown; with 10 or fewer nothing is said", () => {
    const withList = (more: boolean) => new Map([["33333333-3333-4333-8333-333333333333", { items: [{ id: "ap1", label: "Fri, Nov 13, 10:00 AM" }], more }]]);
    expect(render([row()], { linkable: withList(true) })).toContain("Showing the 10 most recently booked appointments");
    expect(render([row()], { linkable: withList(false) })).not.toContain("most recently booked");
    expect(render([row()], { linkable: withList(false) })).toContain("Link booking: Fri, Nov 13, 10:00 AM");
  });
  it("500 rows (capped) shows the notice and a 500+ style count; 499 shows neither", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => row({ followupId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, invitationId: `i${i}` }));
    const capped = render(many(500), { capped: true });
    expect(capped).toContain('data-testid="follow-up-capped"');
    expect(capped).toContain("Showing the first 500 responses. More are waiting; contact support to see the rest.");
    expect(capped).toContain("Waitlist responses (500+)");
    const under = render(many(499));
    expect(under).not.toContain("follow-up-capped");
    expect(under).not.toContain("Showing the first 500");
    expect(under).toContain("Waitlist responses (499)");
  });
  it("the settings page hands the cap flag from the read to the section, so a partial list is never rendered as complete", () => {
    const page = readFileSync("app/(app)/settings/waitlist/page.tsx", "utf8");
    expect(page).toContain("capped={followUps.capped === true}");
  });
  // X1 (Photos, ae4e592cb): opening /settings/waitlist#follow-up scrolled the section so its heading sat at 17 px under a sticky bar reaching 69 px
  // (hit-test: covered at 1280 and 390). The anchor target needs the same scroll offset the invite composer uses for its own anchor: the settings
  // shell hands the header height down as --settings-top; below 700px a second sticky bar sits under it.
  const SCROLL_MT = "scroll-mt-[calc(var(--settings-top,4.5rem)+4rem)]";
  const SCROLL_MT_WIDE = "min-[700px]:scroll-mt-[calc(var(--settings-top,4.5rem)+1rem)]";
  it("X1: the #follow-up anchor target clears the sticky bars (section, both widths)", () => {
    const html = render([row()]);
    const section = html.match(/<section[^>]*id="follow-up"[^>]*>/)?.[0] ?? "";
    expect(section).toContain(SCROLL_MT);
    expect(section).toContain(SCROLL_MT_WIDE);
  });
  it("X1: the load-failure fallback that also carries id=follow-up has the same offset", () => {
    const page = readFileSync("app/(app)/settings/waitlist/page.tsx", "utf8");
    const fallback = page.match(/<p id="follow-up"[^>]*>/)?.[0] ?? "";
    expect(fallback).toContain(SCROLL_MT);
    expect(fallback).toContain(SCROLL_MT_WIDE);
  });
  it("an empty list says so", () => {
    expect(render([])).toContain("No responses need follow-up");
  });
});
