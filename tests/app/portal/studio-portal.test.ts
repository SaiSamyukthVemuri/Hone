import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPortalPresentation, type PortalPresentation } from "@/lib/portal/presentation";
import type { PortalUpcomingAppointment } from "@/lib/portal/queries";

const studio = { name: "Harbour Studio", timezone: "America/Toronto", postcareContactEmail: "care@example.test" };
const validIdentity = { studio, client: { firstName: "Alex" } };
const visit = { id: "visit-1", serviceName: "Follow-up visit", startsAt: "2026-12-02T01:30:00Z", endsAt: "2026-12-02T02:00:00Z", durationMinutes: 30, manageToken: "test-visit" };
const template = { id: "consent", title: "Consent to treatment", form_type: "treatment_consent", version: 2, body: "Example body" };
const signature = { signed_at: "2026-10-01T12:30:00Z", template_id: "consent", template_version: 2, response: "granted" };
const data = {
  session: "active" as "active" | "none" | "unavailable",
  identity: validIdentity as typeof validIdentity | undefined | null,
  presentation: null as PortalPresentation | null,
  upcoming: [visit] as PortalUpcomingAppointment[] | null,
  templates: [template],
  signatures: new Map([["consent", signature]]) as Map<string, typeof signature> | null,
  activeCard: true as boolean | undefined,
  unread: true,
};
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error("redirect " + url); } }));
vi.mock("@/app/_components/MarketingFooter", () => ({ MarketingFooter: () => null }));
vi.mock("@/app/portal/logout/actions", () => ({ portalLogoutAction: async () => {} }));
vi.mock("@/app/portal/portal-message-actions", () => ({ markPortalMessageReviewedAction: async () => {} }));
vi.mock("@/app/portal/PortalReplyForm", () => ({ PortalReplyForm: () => createElement("button", null, "Reply to studio") }));
vi.mock("@/app/portal/PortalConsentForms", () => ({ PortalConsentForms: () => createElement("button", null, "Read and sign") }));
vi.mock("@/app/portal/PortalCardOnFileCard", () => ({ PortalCardOnFileCard: () => null }));
vi.mock("@/app/portal/PortalPaymentMethodForm", () => ({ PortalPaymentMethodForm: () => null }));
vi.mock("@/app/portal/PortalRebookCard", () => ({ PortalRebookCard: () => createElement("div", null, "Booking form") }));
vi.mock("@/lib/portal/session", () => ({ requirePortalSessionForAction: async () => data.session === "active"
  ? { ok: true, session: { studioId: "s", clientId: "c", expiresAt: "2026-12-07T00:00:00Z" } }
  : { ok: false, code: data.session === "none" ? "session_expired" : "unavailable" } }));
vi.mock("@/lib/portal/presentation-server", () => ({ getPublishedPortalPresentation: async () => data.presentation }));
vi.mock("@/lib/portal/queries", () => ({
  getPortalIdentity: async () => data.identity,
  getPortalBookableServices: async () => [{ id: "service" }],
  getPortalBookingReadiness: async () => true,
  getPortalBookingWindow: async () => ({ timezone: "America/Toronto", publicBookingHorizonMonths: 1 }),
  getPortalIntakeStatus: async () => ({ kind: "complete" }),
  getPortalMessagesForClient: async () => data.unread ? [{ id: "message", subject: "Studio message", body: "Please review", published_at: "2026-11-30T14:00:00Z", client_reviewed_at: null }] : [],
  getPortalRepliesForClient: async () => [],
  getPortalUpcomingPreCare: async () => [],
  getPortalUpcomingAppointments: async () => data.upcoming,
}));
vi.mock("@/lib/consent/queries", () => ({
  checkActiveConsentTemplatesForPortal: async () => ({ status: "ok", templates: data.templates }),
  getLatestSignaturesByTemplateForPortal: async () => data.signatures,
}));
vi.mock("@/lib/payment-methods/queries", () => ({ readActiveCardForStudioClient: async () => data.activeCard === undefined ? undefined : data.activeCard ? { brand: "Visa", last4: "4242", expMonth: 2, expYear: 2030 } : null }));
vi.mock("@/lib/stripe/publishable-key", () => ({ resolveStripePublishableKey: () => ({ ok: false }) }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
import Page from "@/app/portal/page";

async function show(view = "overview") {
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ view }) }));
}

beforeEach(() => {
  data.session = "active";
  data.identity = validIdentity;
  data.upcoming = [visit];
  data.presentation = defaultPortalPresentation();
  data.signatures = new Map([["consent", signature]]);
  data.templates = [template];
  data.activeCard = true;
  data.unread = true;
});

describe("production portal renderer", () => {
  it("renders the real appointment in studio time and starts a returning client with their visit", async () => {
    const html = await show();
    expect(html).toContain('data-testid="studio-portal"');
    expect(html).toContain("Tuesday, December 1, 2026");
    expect(html).toContain("8:30 PM EST");
    expect(html.match(/data-portal-appointment-id="visit-1"/g)).toHaveLength(1);
    expect(html.indexOf("Your next appointment")).toBeLessThan(html.indexOf("1 unread message"));
    expect(html).toContain('href="/manage/test-visit"');
  });
  it("prioritizes a required form and keeps the actual signing, review, reply and saved-card surfaces reachable", async () => {
    data.signatures = new Map();
    data.presentation!.ownerName = "Rowan";
    const html = await show();
    expect(html.indexOf("1 form to complete")).toBeLessThan(html.indexOf("Your next appointment"));
    expect(html).toContain("Email Rowan");
    expect(html).not.toContain("Chloe");
    const records = await show("records");
    for (const text of ['id="forms-to-sign"', "Read and sign", "Studio message", "Mark as reviewed", "Reply to studio", "4242"]) expect(records).toContain(text);
  });
  it("hiding overview cards leaves history, unread messages, and booking accessible through navigation", async () => {
    data.presentation!.sections.forEach(section => { section.visible = false; });
    expect(await show()).toContain('href="/portal?view=records"');
    const records = await show("records");
    for (const text of ["Mark as reviewed", "Consent to treatment", "Completed forms", "4242"]) expect(records).toContain(text);
    expect(await show("booking")).toContain("Booking form");
    expect(await show("appointments")).toContain("Follow-up visit");
  });
  it("an unavailable key and signed current card authorization produces a card setup explanation", async () => {
    data.templates = [{ ...template, form_type: "card_authorization" }];
    data.activeCard = false;
    expect(await show("records")).toContain("Card setup is unavailable right now.");
  });
  it.each([false,true])("error, empty and unavailable consent remain distinct (classic=%s)", async classic => {
    data.presentation = classic ? null : defaultPortalPresentation();
    data.upcoming = null;
    expect(await show()).toContain("portal-appointments-unavailable");
    expect(await show()).not.toContain("No upcoming appointments");
    data.upcoming = [];
    expect(await show()).toContain("No upcoming appointments");
    data.signatures = null;
    const records = await show("records");
    expect(records).toContain("portal-forms-unavailable");
    expect(records).not.toMatch(/Read and sign|No completed forms|0 completed forms|not activated its card authorization/);
  });
  it.each([false, true])("a failed saved-card lookup never opens add-card (classic=%s)", async classic => {
    data.presentation = classic ? null : defaultPortalPresentation();
    data.templates = [{ ...template, form_type: "card_authorization" }];
    data.activeCard = undefined;
    const html = await show("records");
    expect(html).toContain("We couldn’t check your saved card.");
    expect(html).not.toMatch(/Add payment method|You have signed card authorization|Card authorization needed/);
  });
  it.each(["identity", "session"])("offers retry and sign-out when the %s read fails", async (read) => {
    if (read === "session") data.session = "unavailable";
    else data.identity = undefined;
    const html = await show();
    expect(html).toContain("Try again");
    expect(html).toContain("Sign out");
    expect(html).not.toMatch(/Harbour|Alex|4242|Follow-up visit/);
  });
  it("redirects an archived or removed identity, including archival after session resolution", async () => {
    data.identity = null;
    await expect(show()).rejects.toThrow("redirect /portal/login");
    data.session = "none";
    await expect(show()).rejects.toThrow("redirect /portal/login");
  });
  it("switching back with the same session keeps the existing booking, unread message, signed forms and card usable", async () => {
    data.presentation = null;
    const html = await show("records");
    expect(html).not.toContain('data-testid="studio-portal"');
    for (const text of ["Booking form", "Follow-up visit", "Mark as reviewed", "Consent to treatment", "4242"]) expect(html).toContain(text);
  });
});
