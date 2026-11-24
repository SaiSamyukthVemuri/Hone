import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildWaitlistAnalytics } from "@/lib/business-analytics/waitlist-model";
import type { WaitlistRead } from "@/lib/business-analytics/server/waitlist-read";
import type { WindowCapacityResult } from "@/app/(app)/settings/waitlist/window-capacity-actions";

vi.mock("@/components/pending-link", () => ({ PendingLink: ({ href, className, children }: { href: string; className: string; children: string }) => createElement("a", { href, className }, children) }));
vi.mock("@/components/pending-button", () => ({ PendingButton: ({ children, disabled }: { children: string; disabled?: boolean }) => createElement("button", { type: "submit", disabled }, children) }));
import { WaitlistScreen } from "@/app/(app)/financials/analytics/waitlist-screen";
const view = () => buildWaitlistAnalytics({ now: new Date("2026-11-22T12:00:00Z"), timezone: "America/Toronto", periodStartIso: "2026-10-23T12:00:00Z", command: null, outcomes: { total: 7, declined: 1, linkUsed: 1, expiredRecorded: 1, deadlinePassed: 1, released: 1, open: 2 }, pool: { total: 5, waiting: 3, claimed: 1, invited: 1, agedCount: 5, medianDays: 12, longestDays: 31 }, delivery: { accepted: 4, refused: 1, unknown: 1, unrecorded: 1 } });
const read = (): Extract<WaitlistRead, { access: "granted" }> => ({ access: "granted", view: view(), services: [{ id: "consult", name: "First consultation" }], servicesAvailable: true, params: { days: 14, serviceId: "consult", notices: [] } });
const render = (r = read(), capacity: WindowCapacityResult | null = { ok: true, fit: 5, outstanding: 2, open: 3, outstandingScope: "window" }) => renderToStaticMarkup(createElement(WaitlistScreen, { read: r, capacity }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
describe("Waitlist Analytics uses the existing tabs and factual presentation", () => {
  it("has the shared Analytics title, active Waitlist tab, existing theme and waitlist review navigation", () => {
    const html = render(); const plain = text(html);
    expect(plain).toContain("Analytics");
    expect(html).toContain('aria-current="page"'); expect(html).toContain('href="/financials/analytics"'); expect(html).toContain('href="/financials/analytics/clients"');
    expect(html).toContain('href="/waitlist"'); expect(html).toContain("bg-surface"); expect(html).toContain("border-line");
    expect(plain).toContain("Capacity for up to 3 more invitations."); expect(plain).toContain("minimums");
    expect(html).not.toMatch(/bg-emerald|bg-green|style=/i);
  });
  it("does not turn page visits or missing attribution into 0 or inferred bookings", () => {
    const plain = text(render());
    expect(plain).toContain("Invitations issued in the last 30 days");
    expect(plain).toContain("Invitation-page views Not tracked"); expect(plain).toContain("Email opens Not tracked");
    expect(plain).toContain("Booked through invitation Not available");
    expect(plain).toContain("Invitation-to-booking rate Not available"); expect(plain).toContain("People needed to keep the studio full Not available");
    expect(plain).not.toContain("Invitations sent in the last");
  });
  it("distinguishes provider acceptance from delivery and nested bookings from the link-used total", () => {
    const html = render();
    expect(text(html)).toContain("Accepted for delivery 4"); expect(text(html)).toContain("does not prove delivery");
    expect(html).toMatch(/class="[^"]*pl-4[^"]*">Still booked/);
    expect(text(html)).toContain("Link used, no attributed booking");
  });
  it("controls change capacity only, preserve the service/horizon and do not offer unsupported practitioner filtering", () => {
    const html = render(); expect(html).toContain('aria-label="Consultation capacity"');
    expect(html).toContain('value="14" selected=""'); expect(html).toContain('value="consult" selected=""');
    expect(html).not.toContain('name="practitioner"'); expect(text(html)).toContain("not the 30-day invitation cohort");
  });
  it("renders a failed capacity read without an invite recommendation", () => {
    const plain = text(render(read(), { ok: false })); expect(plain).toContain("No invitation count is suggested."); expect(plain).toContain("Consultations that fit Not available");
  });
  it("describes the all-live fallback and known empty pool honestly", () => {
    const r = read(); r.view.pool = { total: 0, waiting: 0, claimed: 0, invited: 0, agedCount: 0, medianDays: null, longestDays: null };
    const plain = text(render(r, { ok: true, fit: 3, outstanding: 5, open: 0, outstandingScope: "all" }));
    expect(plain).toContain("No one waiting"); expect(plain).toContain("whatever its dates"); expect(plain).toContain("Review the invitations already outstanding.");
  });
  it("unknown pool and service lists are words rather than zeros or eligible invitations", () => {
    const r = read(); r.view.pool = null; r.services = []; r.servicesAvailable = false; r.params.serviceId = null;
    const plain = text(render(r, null)); expect(plain).toContain("Active waitlist Not available"); expect(plain).toContain("consultation service list could not be read");
  });
  it("entries with no recorded join date are named as excluded, and the waits are from the known ones only", () => {
    const r = read(); r.view.pool = { total: 5, waiting: 3, claimed: 1, invited: 1, agedCount: 3, medianDays: 12, longestDays: 31 };
    const plain = text(render(r));
    expect(plain).toContain("2 entries have no recorded join date and are excluded from the wait figures.");
    expect(plain).toContain("Active waitlist 5"); expect(plain).toContain("Longest wait 31 days");
    const one = read(); one.view.pool = { total: 4, waiting: 4, claimed: 0, invited: 0, agedCount: 3, medianDays: 5, longestDays: 9 };
    expect(text(render(one))).toContain("1 entry has no recorded join date and is excluded from the wait figures.");
  });
  it("no entry has a known join date: waits are Not available, never zero, and the counts remain", () => {
    const r = read(); r.view.pool = { total: 3, waiting: 2, claimed: 0, invited: 1, agedCount: 0, medianDays: null, longestDays: null };
    const plain = text(render(r));
    expect(plain).toContain("Median wait Not available"); expect(plain).toContain("Longest wait Not available");
    expect(plain).not.toMatch(/(?:Median|Longest) wait 0/); expect(plain).toContain("Active waitlist 3"); expect(plain).toContain("3 entries have no recorded join date");
  });
  it("when every date is known there is no exclusion sentence", () => {
    expect(text(render())).not.toContain("excluded from the wait figures");
  });
});
