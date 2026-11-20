import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const calls = vi.hoisted(() => ({ jurisdiction: 0, load: 0, role: "owner" }));

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
    return { access: "granted", ok: false, reason: "read_failed", notices: [] };
  },
}));

import AnalyticsOverviewPage from "@/app/(app)/financials/analytics/page";
import { STATEMENTS_OWNER_ONLY } from "@/lib/finance/statement-screen";

beforeEach(() => Object.assign(calls, { jurisdiction: 0, load: 0, role: "owner" }));

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
