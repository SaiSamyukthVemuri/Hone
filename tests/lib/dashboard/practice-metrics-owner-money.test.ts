import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-44 (b): studio money totals are owner-only at the SERVER read, not just
// in the rendered card. A non-owner practitioner's dashboard must never query
// payment_charge_attempts or service prices, and must get no money object to
// render, so a later UI change cannot leak a figure that was never read.

const fixture = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; columns: string }>,
}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/supabase/queries", () => ({ getSessionBlockAreasByBlockIds: async () => new Map() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => {
    const read = { table, columns: "" };
    fixture.reads.push(read);
    const rows = (): unknown[] => {
      if (table === "payment_charge_attempts") {
        return [{ status: "succeeded", refund_status: null }];
      }
      if (table === "appointments" && read.columns.includes("status")) {
        return [{
          status: "completed",
          starts_at: "2026-10-20T10:00:00Z",
          cancellation_reason: null,
          service: { price_cents: 12000 },
        }];
      }
      return [];
    };
    const query: Record<string, unknown> = {
      select: (value: string) => { read.columns = value; return query; },
      eq: () => query, gte: () => query, lt: () => query, lte: () => query,
      order: () => query, limit: () => query, is: () => query, in: () => query,
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return query;
  } }),
}));

import { getPracticeDashboardMetrics } from "@/lib/dashboard/practice-metrics";

beforeEach(() => { fixture.reads = []; });

describe("HON-44 practice metrics money is owner-only at the read", () => {
  it("a non-owner never reads payment attempts or service prices", async () => {
    const metrics = await getPracticeDashboardMetrics(
      "studio-A", "America/Toronto", "week", { viewerIsOwner: false },
    );
    expect(fixture.reads.some((r) => r.table === "payment_charge_attempts")).toBe(false);
    expect(fixture.reads.some((r) => /price_cents|services\(/.test(r.columns))).toBe(false);
    expect(metrics.money).toBeNull();
    expect(JSON.stringify(metrics)).not.toMatch(/ValueCents|testPayments|12000/);
  });

  it("a non-owner keeps the non-money operational counts", async () => {
    const metrics = await getPracticeDashboardMetrics(
      "studio-A", "America/Toronto", "week", { viewerIsOwner: false },
    );
    expect(metrics.appointments.total).toBe(1);
    expect(metrics.appointments.completed).toBe(1);
    expect(metrics.chartedWithin24h).toBeDefined();
    expect(metrics.actions).toBeDefined();
  });

  it("the owner still reads and receives service value and payment counts", async () => {
    const metrics = await getPracticeDashboardMetrics(
      "studio-A", "America/Toronto", "week", { viewerIsOwner: true },
    );
    expect(fixture.reads.some((r) => r.table === "payment_charge_attempts")).toBe(true);
    expect(metrics.money).not.toBeNull();
    expect(metrics.money?.bookedValueCents).toBe(12000);
    expect(metrics.money?.completedValueCents).toBe(12000);
    expect(metrics.money?.testPayments.charged).toBe(1);
  });
});
