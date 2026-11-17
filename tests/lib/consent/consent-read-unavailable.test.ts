import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// A failed consent-template read is UNAVAILABLE, never "no forms" or "all done". Staff surfaces: profile consent card, Settings editor. Client surface: the portal.
const state = vi.hoisted(() => ({ result: { data: [] as unknown, error: null as unknown } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "in"]) q[m] = () => q;
    q.order = () => (q.__second ? Promise.resolve(state.result) : ((q.__second = true), q));
    return q;
  },
}));

const STAFF = "Couldn’t check consent forms. Reload to try again.";
const PORTAL = "We couldn’t check for forms just now. Please reload this page to try again.";
afterEach(() => vi.restoreAllMocks());

describe("loaders: error is unavailable, empty is ok", () => {
  const run = async () => {
    const m = await import("@/lib/consent/queries");
    return { staff: await m.checkConsentTemplatesForStudio("s", { includeCardAuthorization: true }), wrapper: await m.getConsentTemplatesForStudio("s", { includeCardAuthorization: true }) };
  };
  it("a read error is unavailable (wrapper still degrades to [])", async () => {
    state.result = { data: null, error: { code: "57014", message: "secret detail host=db.internal" } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run();
    expect(r.staff).toEqual({ status: "unavailable" });
    expect(r.wrapper).toEqual([]);
  });
  it("a successful empty read is ok with no templates, distinct from unavailable", async () => {
    state.result = { data: [], error: null };
    expect((await run()).staff).toEqual({ status: "ok", templates: [] });
  });
  it("a successful read returns the templates", async () => {
    state.result = { data: [{ id: "t1" }], error: null };
    const r = await run();
    expect(r.staff.status === "ok" && r.staff.templates.length).toBe(1);
  });
  it("the failure log is one JSON line with a classified code and no raw error text", async () => {
    state.result = { data: null, error: { code: "57014", message: "secret detail host=db.internal" } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await run();
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toContain("consent_templates_for_studio_failed");
      expect(l).toContain("57014");
      expect(l).not.toMatch(/secret|db\.internal/);
    }
  });
});

describe("profile consent card", () => {
  const props = { clientName: "Synthetic", activeTemplates: [], latestSignatures: [] };
  it("unavailable shows the exact staff line and neither the empty state nor a summary", async () => {
    const { ConsentSignaturesCard } = await import("@/components/consent-signatures-card");
    const html = renderToStaticMarkup(createElement(ConsentSignaturesCard, { ...props, unavailable: true }));
    expect(html).toContain("consent-forms-unavailable");
    expect(html).toContain(STAFF);
    expect(html).not.toContain("No active consent forms");
    expect(html).not.toMatch(/up to\s*date|need attention/);
  });
  it("a successful read with no forms shows the empty state and no failure line", async () => {
    const { ConsentSignaturesCard } = await import("@/components/consent-signatures-card");
    const html = renderToStaticMarkup(createElement(ConsentSignaturesCard, props));
    expect(html).toContain("No active consent forms");
    expect(html).not.toContain("consent-forms-unavailable");
  });
});

describe("Settings consent editor", () => {
  const base = { templates: [], createAction: async () => ({ ok: true }), updateAction: async () => ({ ok: true }), setStatusAction: async () => ({ ok: true }), setLiveAction: async () => ({ ok: true }) } as never;
  it("unavailable shows the exact staff line and not 'No consent forms yet'", async () => {
    const { ConsentTemplatesEditor } = await import("@/app/(app)/settings/consent/ConsentTemplatesEditor");
    const html = renderToStaticMarkup(createElement(ConsentTemplatesEditor, { ...(base as object), unavailable: true } as never));
    expect(html).toContain(STAFF);
    expect(html).not.toContain("No consent forms yet");
  });
  it("a successful empty read shows 'No consent forms yet' and no failure line", async () => {
    const { ConsentTemplatesEditor } = await import("@/app/(app)/settings/consent/ConsentTemplatesEditor");
    const html = renderToStaticMarkup(createElement(ConsentTemplatesEditor, base));
    expect(html).toContain("No consent forms yet");
    expect(html).not.toContain("consent-forms-unavailable");
  });
});

describe("portal and page wiring (source pins)", () => {
  const portal = readFileSync("app/portal/page.tsx", "utf8");
  const profile = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
  const settings = readFileSync("app/(app)/settings/consent/page.tsx", "utf8");
  it("the portal uses the checking loader and shows the exact client line only when the read failed", () => {
    expect(portal).toContain("checkActiveConsentTemplatesForPortal(");
    expect(portal).toContain(PORTAL);
    expect(portal).toMatch(/consentFormsUnavailable\s*=\s*consentTemplatesCheck\.status === "unavailable"/);
    expect(portal).toMatch(/\{consentFormsUnavailable && \(\s*<p role="status" data-testid="portal-forms-unavailable"/);
    expect(portal).not.toContain("Couldn’t check consent forms");
  });
  it("a successful empty portal read still renders no forms section", () => {
    expect(portal).toMatch(/const hasUnsignedForms = unsignedConsentTemplates\.length > 0;/);
    expect(portal).toMatch(/\{hasUnsignedForms && \(\s*<section\s+id="forms-to-sign"/);
  });
  it("the notice grants nothing: it is a status line with no link, button, form or action", () => {
    for (const src of [portal, readFileSync("components/consent-signatures-card.tsx", "utf8")]) {
      const m = src.match(/<p role="status" data-testid="(?:portal-forms|consent-forms)-unavailable"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
      expect(m.length).toBeGreaterThan(0);
      expect(m).not.toMatch(/<(a|button|form|Link|input)\b|onClick|action=/);
    }
  });
  it("the staff surfaces keep their existing gates: Settings checks the owner BEFORE reading, and the profile reads only when consent is needed", () => {
    expect(settings.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(-1);
    expect(settings.indexOf('practitioner.role !== "owner"')).toBeLessThan(settings.indexOf("checkConsentTemplatesForStudio("));
    expect(profile).toMatch(/needsConsent\s*\?\s*checkConsentTemplatesForStudio\(/);
    expect(profile).toContain("unavailable={consentTemplatesUnavailable}");
  });
});

describe("staff profile: pending portal tasks never read as 'nothing pending' when consent is unknown (Insurance N3)", () => {
  it("computePortalPendingTasks flags consentUnknown, and keeps the old shape otherwise", async () => {
    const { computePortalPendingTasks } = await import("@/lib/portal/pending-tasks");
    const base = { intakeStatus: null, activeConsentTemplates: [], latestSignatures: [], portalMessages: [] };
    expect(computePortalPendingTasks({ ...base, consentUnavailable: true }).consentUnknown).toBe(true);
    expect(computePortalPendingTasks(base).consentUnknown).toBe(false);
  });
  it("the Portal access card says it could not check, and does not say 'No pending portal tasks'", async () => {
    const { PortalAccessCard } = await import("@/app/(app)/clients/[id]/PortalAccessCard");
    const { computePortalPendingTasks } = await import("@/lib/portal/pending-tasks");
    const mk = (unavail: boolean) => {
      const pendingTasks = computePortalPendingTasks({ intakeStatus: null, activeConsentTemplates: [], latestSignatures: [], portalMessages: [], consentUnavailable: unavail });
      return renderToStaticMarkup(createElement(PortalAccessCard as never, { clientId: "c", portalLoginUrl: "/portal/login?studio=s", clientHasEmail: true, lastLinkSentAt: null, lastSeenAt: null, recentEvents: [], pendingTasks } as never));
    };
    const bad = mk(true);
    expect(bad).toContain("portal-tasks-consent-unavailable");
    expect(bad).toContain(STAFF);
    expect(bad).not.toContain("No pending portal tasks");
    const ok = mk(false);
    expect(ok).toContain("No pending portal tasks");
    expect(ok).not.toContain("portal-tasks-consent-unavailable");
  });
});
