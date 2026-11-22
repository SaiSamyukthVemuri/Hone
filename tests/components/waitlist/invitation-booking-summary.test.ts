import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvitationBookingSummary } from "@/components/waitlist/invitation-booking-summary";
import { buildInvitationBookingSummary, type CommandCounts, type OutcomeCounts } from "@/lib/waitlist/invitation-booking-summary";

const START = "2026-10-23T12:00:00.000Z";
const outcomes = (over: Partial<OutcomeCounts> = {}): OutcomeCounts => ({ total: 20, declined: 3, linkUsed: 8, expiredRecorded: 2, released: 1, open: 4, deadlinePassed: 2, ...over });
const command = (over: Partial<CommandCounts> = {}): CommandCounts => ({ invitationsTotal: 20, peopleInvited: 17, bookedLinkedLive: 5, bookedThenCancelled: 1, convertedUnlinked: 1, ...over });
const render = (c: CommandCounts | null = command(), o: OutcomeCounts = outcomes()) =>
  renderToStaticMarkup(createElement(InvitationBookingSummary, { summary: buildInvitationBookingSummary({ periodStartIso: START, command: c, outcomes: o }), timeZone: "America/Toronto" }));
const value = (html: string, key: string) => html.match(new RegExp(`data-row="${key}"[\\s\\S]*?data-value="([^"]*)"`))?.[1];

describe("the summary on the page", () => {
  it("states the period and says every figure counts those invitations, out of the same number", () => {
    const html = render();
    expect(html).toContain("Invitations sent in the last 30 days (since Oct 23, 2026, up to now)");
    expect(html).toContain("each is out of the same number");
    expect(html).toContain("Invitations (of 20)");
  });
  it("shows people and invitations separately, and says one person can have several invitations", () => {
    const html = render();
    expect(html).toMatch(/data-testid="invitation-total">20</);
    expect(html).toMatch(/data-testid="invitation-people">17</);
    expect(html).toContain("One person can have several invitations");
  });
  it("shows each figure, the booked ones, and the attribution line with its plain explanation", () => {
    const html = render();
    expect(value(html, "booked")).toBe("5");
    expect(value(html, "booked-cancelled")).toBe("1");
    expect(value(html, "attribution-unavailable")).toBe("1");
    expect(html).toContain("Booking attribution unavailable");
    expect(html).toContain("is not counted as booked");
    expect(value(html, "declined")).toBe("3");
    expect(value(html, "expired")).toBe("4");
    expect(html).toContain("Released — reason not recorded");
  });
  it("email opens and booking-page visits read Not tracked, and are not numbers", () => {
    const html = render();
    expect(value(html, "email-opens")).toBe("Not tracked");
    expect(value(html, "page-visits")).toBe("Not tracked");
  });
  it("until the command is there, the booking figures read Not available (never 0), and it says nothing is estimated", () => {
    const html = render(null);
    expect(html).toContain('data-testid="invitation-booking-unavailable"');
    expect(html).toContain("Nothing is estimated in their place");
    expect(value(html, "booked")).toBe("unavailable");
    expect(value(html, "booked-cancelled")).toBe("unavailable");
    expect(value(html, "attribution-unavailable")).toBe("unavailable");
    expect(html).toMatch(/data-testid="invitation-people">Not available</);
    // the outcomes that do not need the command still show
    expect(value(html, "declined")).toBe("3");
  });
  it("shows the remainder as Other or not attributable, with a count", () => {
    const html = render(command({ invitationsTotal: 23 }));
    expect(value(html, "other")).toBe("3");
    expect(html).toContain("Other or not attributable");
  });
  it("tells the owner when a count moved while the page loaded", () => {
    expect(render(command({ invitationsTotal: 10 }))).toContain('data-testid="invitation-booking-moved"');
    expect(render()).not.toContain('data-testid="invitation-booking-moved"');
  });
  it("has no percentage, no link, no form and no control: counts only", () => {
    const html = render();
    expect(html).not.toContain("%");
    expect(html).not.toMatch(/<a\b|<form|<button|<input|<select/);
  });
  it("a count that could not be read is Not available in its row, not a zero", () => {
    const html = render(command(), outcomes({ declined: null }));
    expect(value(html, "declined")).toBe("unavailable");
  });
});
