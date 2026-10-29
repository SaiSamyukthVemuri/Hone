import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// HON-47. What staff and a visiting client SEE when client portal access is off,
// rendered through react-dom/server (output, not a source grep). The flag is the
// held 0252 column, absent on today's schema, and absent means ON: every default
// case below must look exactly as before. Synthetic data only.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), redirect: () => undefined }));
vi.mock("next/link", async () => {
  const react = await import("react");
  return { default: (props: { href: string; children?: ReactNode }) => react.createElement("a", { href: props.href }, props.children) };
});
vi.mock("@/app/(app)/clients/[id]/portal-link-actions", () => ({ sendPortalLinkAction: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/portal/session", () => ({ getCurrentPortalSession: async () => null }));
const studioRow = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock("@/lib/booking/queries", () => ({ getStudioBySlug: async () => studioRow.value }));
vi.mock("@/app/_components/MarketingFooter", () => ({ MarketingFooter: () => null }));
vi.mock("./LoginForm", () => ({ PortalLoginForm: () => null }));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PortalAccessCard } = await import("@/app/(app)/clients/[id]/PortalAccessCard");
const { TodayPortalLinkButton } = await import("@/app/(app)/dashboard/TodayPortalLinkButton");
const { ClientSelfServiceForm } = await import("@/app/(app)/settings/studio/ClientSelfServiceForm");
const { PORTAL_OFF_STAFF_MESSAGE } = await import("@/lib/booking/client-self-service-policy");

const cardProps = {
  clientId: "c1", portalLoginUrl: "https://example.test/portal/login?studio=s", clientHasEmail: true,
  lastLinkSentAt: null, lastSeenAt: null,
};
const html = (el: unknown) => renderToStaticMarkup(el as never);

describe("PortalAccessCard (client page)", () => {
  it("DEFAULT (flag absent): Send and Copy are offered, no off status", () => {
    const out = html(createElement(PortalAccessCard, cardProps));
    expect(out).toContain("Send portal link");
    expect(out).toContain("Copy login URL");
    expect(out).not.toContain("portal-off-status");
  });
  it("portal off: the status replaces Send and Copy, and says what still works", () => {
    const out = html(createElement(PortalAccessCard, { ...cardProps, portalEnabled: false }));
    expect(out).toContain("portal-off-status");
    expect(out).toContain(PORTAL_OFF_STAFF_MESSAGE);
    expect(out).not.toContain("Send portal link");
    expect(out).not.toContain("Copy login URL");
    expect(out).not.toContain("Add an email to this client");
  });
});

describe("TodayPortalLinkButton (Today roster)", () => {
  it("DEFAULT: an enabled Send portal link button", () => {
    const out = html(createElement(TodayPortalLinkButton, { clientId: "c1", clientHasEmail: true }));
    expect(out).toContain("Send portal link");
    expect(out).not.toContain('disabled=""');
    expect(out).not.toContain("today-portal-off");
  });
  it("portal off: disabled, with the reason, even when the client has an email", () => {
    const out = html(createElement(TodayPortalLinkButton, { clientId: "c1", clientHasEmail: true, portalEnabled: false }));
    expect(out).toContain('disabled=""');
    expect(out).toContain("today-portal-off");
    expect(out).toContain("Client portal is off for your studio");
  });
});

describe("ClientSelfServiceForm (settings)", () => {
  const initial = { cancellation: true, reschedule: true };
  it("DEFAULT: no portal status line", () => {
    expect(html(createElement(ClientSelfServiceForm, { initial }))).not.toContain("client-portal-off-status");
  });
  it("portal off: a read-only status line, and the cancel/reschedule switches are unchanged", () => {
    const out = html(createElement(ClientSelfServiceForm, { initial, portalEnabled: false }));
    expect(out).toContain("client-portal-off-status");
    expect(out).toContain("Let clients reschedule online");
  });
});

describe("/portal/login page", () => {
  async function render(studio: Record<string, unknown> | null, slug = "synthetic") {
    studioRow.value = studio;
    const mod = await import("@/app/portal/login/page");
    const el = await mod.default({ searchParams: Promise.resolve({ studio: slug }) });
    return html(el);
  }
  it("DEFAULT (flag absent): the sign-in form copy and the expiry note", async () => {
    const out = await render({ id: "s1", name: "Synthetic Studio" });
    expect(out).toContain("Sign in to your Synthetic Studio portal");
    expect(out).toContain("The link expires in 1 hour");
    expect(out).not.toContain("portal-login-off");
  });
  it("portal off: the explanation, no form promise of an email", async () => {
    const out = await render({ id: "s1", name: "Synthetic Studio", client_portal_enabled: false });
    expect(out).toContain("portal-login-off");
    expect(out).toContain("Online client access isn&#x27;t available for Synthetic Studio");
    expect(out).not.toContain("The link expires in 1 hour");
    // Codex P2 4407884608: no sign-in instructions or promise of an email anywhere.
    expect(out).not.toContain("Enter the email");
    expect(out).not.toContain("one-time link");
    expect(out).not.toContain("Sign in to your");
    expect(out).not.toMatch(/<form/);
  });
  it("an unknown studio slug looks like the default page (no studio probing)", async () => {
    const out = await render(null, "nope");
    expect(out).not.toContain("portal-login-off");
    expect(out).toContain("Sign in to your secure portal");
  });
});
