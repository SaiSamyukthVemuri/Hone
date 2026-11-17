import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Insurance B1 (#1519): the portal home, RENDERED, for a client with nothing else pending. A failed consent read must show the notice and must NOT say
// "You're all caught up."; a successful empty read must still say it.
const state = vi.hoisted(() => ({ consent: { status: "ok", templates: [] } as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("next/link", () => ({ default: (p: { children?: unknown }) => p.children ?? null }));
vi.mock("@/app/_components/MarketingFooter", () => ({ MarketingFooter: () => null }));
vi.mock("@/app/_components/MarkdownLiteBlock", () => ({ MarkdownLiteBlock: () => null }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/app/portal/PortalRebookCard", () => ({ PortalRebookCard: () => null }));
vi.mock("@/app/portal/logout/actions", () => ({ portalLogoutAction: async () => {} }));
vi.mock("@/app/portal/portal-message-actions", () => ({ markPortalMessageReviewedAction: async () => {} }));
vi.mock("@/app/portal/PortalReplyForm", () => ({ PortalReplyForm: () => null }));
vi.mock("@/app/portal/PortalConsentForms", () => ({ PortalConsentForms: () => null }));
vi.mock("@/app/portal/PortalPaymentMethodForm", () => ({ PortalPaymentMethodForm: () => null }));
vi.mock("@/app/portal/PortalCardOnFileCard", () => ({ PortalCardOnFileCard: () => null }));
vi.mock("@/lib/portal/session", () => ({ getCurrentPortalSession: async () => ({ studioId: "s", clientId: "c" }) }));
vi.mock("@/lib/portal/queries", () => ({
  getPortalBookableServices: async () => [],
  getPortalBookingReadiness: async () => false,
  getPortalBookingWindow: async () => null,
  getPortalIdentity: async () => ({ client: { id: "c", firstName: "Synthetic", first_name: "Synthetic" }, studio: { name: "Studio", timezone: "UTC" } }),
  getPortalIntakeStatus: async () => ({ kind: "none" }),
  getPortalMessagesForClient: async () => [],
  getPortalRepliesForClient: async () => [],
  getPortalUpcomingAppointments: async () => [],
  getPortalUpcomingPreCare: async () => [],
}));
vi.mock("@/lib/consent/queries", () => ({
  checkActiveConsentTemplatesForPortal: async () => state.consent,
  getLatestSignaturesByTemplateForPortal: async () => new Map(),
}));
vi.mock("@/lib/payment-methods/queries", () => ({ getActiveCardForStudioClient: async () => ({ id: "card" }) }));
vi.mock("@/lib/stripe/publishable-key", () => ({ resolveStripePublishableKey: () => ({ ok: false, reason: "missing" }) }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

const PORTAL = "We couldn’t check for forms just now. Please reload this page to try again.";
beforeEach(() => vi.resetModules());

describe("portal home with nothing else pending", () => {
  it("a failed consent read shows the notice and NOT 'all caught up'", async () => {
    state.consent = { status: "unavailable" };
    const { default: Page } = await import("@/app/portal/page");
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("portal-forms-unavailable");
    expect(html).toContain(PORTAL);
    expect(html).not.toMatch(/all caught up/i);
  });
  it("a successful empty read still says all caught up and shows no notice", async () => {
    state.consent = { status: "ok", templates: [] };
    const { default: Page } = await import("@/app/portal/page");
    const html = renderToStaticMarkup(await Page());
    expect(html).toMatch(/all caught up/i);
    expect(html).not.toContain("portal-forms-unavailable");
  });
});
