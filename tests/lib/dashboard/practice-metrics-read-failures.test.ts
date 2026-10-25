import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ fail: "", empty: false, studios: [] as unknown[] }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/supabase/queries", () => ({ getSessionBlockAreasByBlockIds: async () => new Map() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => {
    let columns = "";
    let studio: unknown;
    const run = () => {
      fixture.studios.push(studio);
      const key = table === "appointments"
        ? columns.includes("status") ? "appointments" : "completed"
        : table === "sessions" ? columns.includes("clients(") ? "procedure_sessions" : "linked_sessions"
        : table === "session_blocks" ? columns.includes("sort_order") ? "procedure_blocks" : "charted_blocks"
        : table === "practitioners" ? "procedure_practitioners" : "payments";
      if (fixture.fail === key) return { data: null, error: { message: "synthetic private row diagnostic" } };
      if (fixture.empty) return { data: [], error: null };
      const rows: Record<string, unknown[]> = {
        appointments: [], payments: [], procedure_blocks: [], procedure_practitioners: [],
        completed: [{ id: "appointment", ends_at: "2026-10-20T10:00:00Z" }],
        linked_sessions: [{ id: "session", appointment_id: "appointment" }],
        charted_blocks: [{ session_id: "session", created_at: "2026-10-20T11:00:00Z" }],
        procedure_sessions: [{ id: "session", started_at: "2026-10-20T10:00:00Z", clients: null }],
      };
      return { data: rows[key], error: null };
    };
    const query: Record<string, unknown> = {
      select: (value: string) => { columns = value; return query; },
      eq: (key: string, value: unknown) => { if (key === "studio_id") studio = value; return query; },
      gte: () => query, lt: () => query, lte: () => query,
      order: () => query, limit: () => query, is: () => query, in: () => query,
      then: (resolve: (value: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return query;
  } }),
}));

import { getPracticeDashboardMetrics } from "@/lib/dashboard/practice-metrics";

beforeEach(() => { fixture.fail = ""; fixture.empty = false; fixture.studios = []; });

describe("DAT-002 metrics read failure is unknown, never zero activity", () => {
  it.each([
    "appointments", "payments", "completed", "linked_sessions", "charted_blocks",
    "procedure_sessions", "procedure_blocks", "procedure_practitioners",
  ])("refuses a partial snapshot when %s fails", async (key) => {
    fixture.fail = key;
    const result = await getPracticeDashboardMetrics("studio-A", "America/Toronto", "week", { viewerIsOwner: true }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/^Failed to load (practice metrics|procedure records)$/);
    expect(fixture.studios.every((id) => id === "studio-A")).toBe(true);
  });

  it("returns genuine zero counts only after successful empty reads", async () => {
    fixture.empty = true;
    const metrics = await getPracticeDashboardMetrics("studio-A", "America/Toronto", "week", { viewerIsOwner: true });
    expect(metrics.appointments.total).toBe(0);
    expect(metrics.money?.testPayments).toEqual({ prepared: 0, charged: 0, refunds: 0 });
    expect(metrics.chartedWithin24h).toEqual({ completedCount: 0, chartedWithin24hCount: 0 });
    expect(fixture.studios.length).toBeGreaterThan(0);
    expect(fixture.studios.every((id) => id === "studio-A")).toBe(true);
  });

  it("retains actual charting facts when every read succeeds", async () => {
    const metrics = await getPracticeDashboardMetrics("studio-A", "America/Toronto", "week", { viewerIsOwner: true });
    expect(metrics.chartedWithin24h).toEqual({ completedCount: 1, chartedWithin24hCount: 1 });
    expect(metrics.actions.reviewedSessions).toBe(1);
  });
});
