import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Roles R4 (OPS, 3 Nov): derived outputs of treatment data must not leak. Every practitioner-visible aggregate reader asks clin.view_records
// BEFORE it reads; when the answer is no it returns its empty shape and issues no table read at all.

const { fromSpy, allowed } = vi.hoisted(() => ({ fromSpy: vi.fn(), allowed: { value: false } }));

vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: vi.fn(async () => ({ allowed: allowed.value, mode: "enforce", engine: allowed.value })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (...a: unknown[]) => {
      fromSpy(...a);
      throw new Error("a table was read while clin.view_records was off");
    },
    rpc: () => {
      throw new Error("unexpected rpc");
    },
  }),
}));

const NOW = "2026-11-03T12:00:00.000Z";

beforeEach(() => {
  fromSpy.mockClear();
  allowed.value = false;
});

describe("without clin.view_records the aggregate readers read nothing and return empty", () => {
  it("clients needing attention", async () => {
    const { getClientsNeedingAttention } = await import("@/lib/dashboard/clients-needing-attention");
    const r = await getClientsNeedingAttention("studio");
    expect(JSON.stringify(r)).not.toContain("clientId");
    expect(fromSpy).not.toHaveBeenCalled();
  });
  it("missing-records assistant", async () => {
    const { getMissingRecordsAssistant } = await import("@/lib/dashboard/missing-records-assistant");
    const r = await getMissingRecordsAssistant("studio", NOW);
    expect(r.items).toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
  });
  it("procedure action metrics", async () => {
    const { getProcedureActionMetrics } = await import("@/lib/dashboard/practice-metrics");
    await getProcedureActionMetrics("studio");
    expect(fromSpy).not.toHaveBeenCalled();
  });
  it("personal charting", async () => {
    const { getPersonalChartedWithin24h } = await import("@/lib/dashboard/personal-charting");
    expect(await getPersonalChartedWithin24h("studio", "p", NOW)).toEqual({ completedCount: 0, chartedWithin24hCount: 0 });
    expect(fromSpy).not.toHaveBeenCalled();
  });
  it("before-today previews", async () => {
    const { getBeforeTodayPreviews } = await import("@/lib/dashboard/before-today-previews");
    const r = await getBeforeTodayPreviews("studio", ["c1"], [{ clientId: "c1", appointmentId: "a1", startsAt: NOW }]);
    expect(r.size).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
  });
  it("previous charted treatment (prep loads)", async () => {
    const { loadLastChartedTreatmentsForClients } = await import("@/lib/sessions/last-treatment-loader");
    const r = await loadLastChartedTreatmentsForClients({
      studioId: "studio",
      requests: [{ requestKey: "a1", clientId: "c1", before: NOW, excludeAppointmentId: "a1" }],
    });
    expect(r.size).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
  });
  it("actual minutes per plan stay zero", async () => {
    const { getActualMinutesForPlans } = await import("@/lib/treatment-time/queries");
    const r = await getActualMinutesForPlans("studio", ["plan1"]);
    expect(r.get("plan1")).toEqual({ minutes: 0, sessionCount: 0 });
    expect(fromSpy).not.toHaveBeenCalled();
  });
});

describe("the readers that stay in the page are gated at their call sites", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("getting-started issues neither the blocks nor the notes read without the key", () => {
    const s = read("lib/onboarding/getting-started.ts");
    expect(s).toContain('"clin.view_records"');
    expect(s.match(/!canViewRecords\s*\?\s*Promise\.resolve/g)?.length).toBe(2);
  });
  it("the client list shows last visit as unknown without the key", () => {
    const s = read("app/(app)/clients/page.tsx");
    expect(s).toMatch(/archived \|\| !canViewRecords/);
  });
  it("the dashboard's charted-visit lookup needs the key", () => {
    const s = read("app/(app)/dashboard/page.tsx");
    expect(s).toMatch(/apptIds\.length > 0 && canViewRecords/);
  });
});
