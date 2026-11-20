import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const calls = vi.hoisted(() => ({ jurisdiction: 0, load: 0, role: "owner", result: null as unknown }));

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ practitioner: { role: calls.role }, studio: { id: "studio-1", timezone: "America/Toronto" } }),
}));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: async () => {
    calls.jurisdiction++;
    return { ok: true, jurisdiction: { currency: "cad" } };
  },
}));
vi.mock("@/lib/business-analytics/server/overview-read", () => ({
  loadOverview: async () => {
    calls.load++;
    return calls.result ?? { access: "granted", ok: false, reason: "read_failed", notices: [] };
  },
}));

import AnalyticsOverviewPage from "@/app/(app)/financials/analytics/page";
import { STATEMENTS_OWNER_ONLY } from "@/lib/finance/statement-screen";

beforeEach(() => Object.assign(calls, { jurisdiction: 0, load: 0, role: "owner", result: null }));

describe("the Overview page: owner gate before any read", () => {
  it("every role but owner sees the owner-only sentence and NO read is made", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      Object.assign(calls, { jurisdiction: 0, load: 0, role });
      const tree = await AnalyticsOverviewPage({ searchParams: Promise.resolve({}) });
      expect(JSON.stringify(tree), role).toContain(STATEMENTS_OWNER_ONLY);
      expect(calls.jurisdiction, role).toBe(0);
      expect(calls.load, role).toBe(0);
    }
  });
  it("an owner whose read fails sees a stated failure, not a partial page", async () => {
    const tree = await AnalyticsOverviewPage({ searchParams: Promise.resolve({}) });
    expect(calls.load).toBe(1);
    expect(JSON.stringify(tree)).toContain("Nothing is shown rather than a partial figure");
  });
});

describe("dates that were not accepted keep the controls, so the range can be corrected", () => {
  it("shows the header, the controls with what was submitted, and the reason beside them, not an error that replaces the screen", async () => {
    calls.result = {
      access: "granted",
      ok: false,
      reason: "period_invalid",
      notices: ["The dates were not accepted (range reversed)."],
      params: { periodKind: "custom", from: "2026-12-01", to: "2026-11-01", compare: "last_year", practitioner: { kind: "one", practitionerId: "pr-1" }, series: "money" },
      practitionerOptions: [{ id: "pr-1", label: "Ada Example" }],
    };
    const tree = await AnalyticsOverviewPage({ searchParams: Promise.resolve({ period: "custom", from: "2026-12-01", to: "2026-11-01" }) });
    const html = renderToStaticMarkup(tree as never);
    expect(html).toContain("<h1");
    expect(html).toContain("<form");
    expect(html).toContain('value="2026-12-01"');
    expect(html).toContain('value="2026-11-01"');
    expect(html).toContain("The dates were not accepted (range reversed).");
    expect(html).toContain("Ada Example");
    expect(html).not.toContain("could not be read right now");
    expect(html).not.toMatch(/data-figure=/); // no figure is drawn without a period
  });
});
