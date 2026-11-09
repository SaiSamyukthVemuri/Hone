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
    expect(html).toContain("Answers will be erased on");
    expect(html).toContain("Answers will be erased on Feb 7, 2027.");
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
  it("an erased row shows no answers and no erase date", () => {
    const html = render([row({ whyNotWork: null, betterTimes: null, answersErasedAt: "2026-11-20T10:00:00Z" })]);
    expect(html).toContain("Their answers have been erased.");
    expect(html).not.toContain("WHYMARK");
    expect(html).not.toContain("Answers will be erased on");
  });
  it("Erase answers is offered on open, handled and closed rows while answers exist, and only behind a confirm step", () => {
    for (const status of ["open", "handled", "kept", "booked", "removed"] as const) {
      const html = render([row({ status })]);
      expect(html, status).toContain('data-testid="erase-control"');
      // the summary opens the disclosure; the submit button lives inside the same <details>, so it is not a one-click action
      const d = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
      expect(d).toContain("<summary");
      expect(d).toContain("This cannot be undone");
      expect(d).toContain("Yes, erase the answers");
      expect(html.match(/Yes, erase the answers/g)).toHaveLength(1);
    }
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
    expect(html).not.toContain("Answers will be erased on");
    expect(render([row({ eraseBy: "not a date" })])).toContain("Erase date unavailable");
    expect(render([row()])).not.toContain("Erase date unavailable");
  });
  it("never renders an email address", () => {
    expect(render([row()])).not.toContain("@");
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
  it("an empty list says so", () => {
    expect(render([])).toContain("No responses need follow-up");
  });
});
