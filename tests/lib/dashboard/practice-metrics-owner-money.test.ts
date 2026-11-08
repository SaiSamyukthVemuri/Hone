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

import {
  getPracticeDashboardMetrics,
  getProcedureActionMetrics,
} from "@/lib/dashboard/practice-metrics";

beforeEach(() => { fixture.reads = []; });

describe("HON-44 practice metrics money is owner-only at the read", () => {
  it("the loader REFUSES a non-owner before issuing any read", async () => {
    // WS-DB: it no longer runs for a non-owner at all. The cast stands in for a
    // caller that bypasses the `true`-only type.
    await expect(
      getPracticeDashboardMetrics("studio-A", "America/Toronto", "week", {
        viewerIsOwner: false as unknown as true,
      }),
    ).rejects.toThrow("Practice metrics are owner-only");
    expect(fixture.reads).toEqual([]);
  });

  it("a non-owner gets the procedure roll-up with no appointment, payment or price read", async () => {
    const actions = await getProcedureActionMetrics("studio-A");
    expect(actions).toBeDefined();
    expect(fixture.reads.some((r) => r.table === "payment_charge_attempts")).toBe(false);
    expect(fixture.reads.some((r) => r.table === "appointments")).toBe(false);
    expect(fixture.reads.some((r) => /price_cents|services\(/.test(r.columns))).toBe(false);
    expect(JSON.stringify(actions)).not.toMatch(/ValueCents|testPayments|12000/);
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
