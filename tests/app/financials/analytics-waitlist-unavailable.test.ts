import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildWaitlistAnalytics } from "@/lib/business-analytics/waitlist-model";
import type { WaitlistRead } from "@/lib/business-analytics/server/waitlist-read";
import type { CommandCounts, OutcomeCounts } from "@/lib/waitlist/invitation-booking-summary";

vi.mock("@/components/pending-link", () => ({ PendingLink: ({ href, className, children }: { href: string; className: string; children: string }) => createElement("a", { href, className }, children) }));
vi.mock("@/components/pending-button", () => ({ PendingButton: ({ children, disabled }: { children: string; disabled?: boolean }) => createElement("button", { type: "submit", disabled }, children) }));
import { WaitlistScreen } from "@/app/(app)/financials/analytics/waitlist-screen";

// The whole rendered page, with the real builders: a figure that cannot be supported reads in words, never as 0.
const NOW = new Date("2026-11-22T12:00:00Z");
const full: OutcomeCounts = { total: 10, linkUsed: 5, declined: 1, expiredRecorded: 1, deadlinePassed: 1, released: 1, open: 1 };
const command: CommandCounts = { invitationsTotal: 10, peopleInvited: 8, bookedLinkedLive: 3, bookedThenCancelled: 1, convertedUnlinked: 1 };
const nulls = (o: OutcomeCounts) => Object.fromEntries(Object.keys(o).map((k) => [k, null])) as unknown as OutcomeCounts;
const zeros = (o: OutcomeCounts) => Object.fromEntries(Object.keys(o).map((k) => [k, 0])) as unknown as OutcomeCounts;
const unreadDelivery = { accepted: null, refused: null, unknown: null, unrecorded: null };

function page(over: { command?: CommandCounts | null; outcomes?: OutcomeCounts; delivery?: typeof unreadDelivery | { accepted: number; refused: number; unknown: number; unrecorded: number } }) {
  const view = buildWaitlistAnalytics({
    now: NOW, timezone: "UTC", periodStartIso: "2026-10-23T12:00:00Z",
    command: "command" in over ? over.command! : command, outcomes: over.outcomes ?? full, pool: null,
    delivery: over.delivery ?? { accepted: 10, refused: 0, unknown: 0, unrecorded: 0 },
  });
  const read: Extract<WaitlistRead, { access: "granted" }> = { access: "granted", view, services: [], servicesAvailable: false, params: { days: 7, serviceId: null, notices: [] } };
  return renderToStaticMarkup(createElement(WaitlistScreen, { read, capacity: null })).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}
const unsupported = (t: string) => {
  expect(t).toContain("Invitation-page views Not tracked");
  expect(t).toContain("Email opens Not tracked");
  expect(t).not.toMatch(/(?:Invitation-page views|Email opens) 0\b/);
};

describe("waitlist analytics: unsupported figures read in words, never zero", () => {
  it("opens and page visits are never tracked, in every state", () => {
    for (const t of [page({}), page({ command: null }), page({ outcomes: nulls(full) }), page({ outcomes: zeros(full), command: { ...command, invitationsTotal: 0, peopleInvited: 0, bookedLinkedLive: 0, bookedThenCancelled: 0, convertedUnlinked: 0 } })]) unsupported(t);
  });
  it("a missing booking-count command: bookings and people invited are unavailable, not 0, and no rate", () => {
    const t = page({ command: null });
    expect(t).toContain("Booked through invitation Not available");
    expect(t).toContain("People invited Not available");
    expect(t).toContain("Invitation-to-booking rate Not available");
    expect(t).not.toMatch(/Booked through invitation 0\b/);
    expect(t).not.toMatch(/Still booked 0\b/);
  });
  it("outcomes unread while the command answered: outcome counts and the booking figure are unavailable, and no rate", () => {
    const t = page({ outcomes: nulls(full) });
    expect(t).toContain("Invitations issued 10");
    expect(t).toContain("Booked through invitation Not available");
    expect(t).toContain("Invitation-to-booking rate Not available");
    for (const label of ["Link used", "Declined", "Expired", "Still open"]) expect(t).toContain(`${label} Not available`);
  });
  it("nothing readable at all: every count is unavailable, nothing falls back to 0", () => {
    const t = page({ command: null, outcomes: nulls(full), delivery: unreadDelivery });
    expect(t).toContain("Invitations issued Not available");
    expect(t).toContain("People invited Not available");
    expect(t).toContain("Booked through invitation Not available");
    expect(t).toContain("Invitation-to-booking rate Not available");
    expect(t).toContain("Link used Not available");
    for (const label of ["Accepted for delivery", "Delivery refused", "Delivery outcome unknown", "Delivery not recorded"]) expect(t).toContain(`${label} Not available`);
    expect(t).not.toMatch(/(?:Invitations issued|Booked through invitation|Link used|Accepted for delivery) 0\b/);
  });
  it("a count that does not add up shows no rate and no booked figure", () => {
    const t = page({ outcomes: { ...full, open: 2 } });
    expect(t).toContain("Invitation-to-booking rate Not available");
    expect(t).toContain("Booked through invitation Not available");
  });
  it("an empty cohort has no rate; its real zero counts are stated as counts, not as a 0% rate", () => {
    const t = page({ outcomes: zeros(full), command: { invitationsTotal: 0, peopleInvited: 0, bookedLinkedLive: 0, bookedThenCancelled: 0, convertedUnlinked: 0 } });
    expect(t).toContain("Invitation-to-booking rate Not available");
    expect(t).not.toContain("0%");
  });
  it("the one place a figure is a real zero is a resolved cohort that booked nobody, and it says 0%", () => {
    const t = page({ command: { ...command, bookedLinkedLive: 0, bookedThenCancelled: 0 } });
    expect(t).toContain("Booked through invitation 0");
    expect(t).toContain("0%");
  });
});
