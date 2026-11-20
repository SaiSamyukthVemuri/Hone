import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The reconciliation checks are only reachable with real data when the assembly itself is wrong, which cannot be built from honest rows. These tests
// force each check to fail and pin that the model then shows NO money figure, so a removed or weakened check cannot go unnoticed.
const force = vi.hoisted(() => ({ reconcile: true, buckets: true, filterTotal: null as number | null }));

vi.mock("@/lib/business-analytics/reconcile", async (orig) => {
  const actual = await orig<typeof import("@/lib/business-analytics/reconcile")>();
  return { ...actual, reconcileWithStatement: (a: Parameters<typeof actual.reconcileWithStatement>[0]) => (force.reconcile ? actual.reconcileWithStatement(a) : { reconciled: false as const, reason: "clients_and_other_differ_from_statements" as const, differenceCents: 1 }) };
});
vi.mock("@/lib/business-analytics/money-metrics", async (orig) => {
  const actual = await orig<typeof import("@/lib/business-analytics/money-metrics")>();
  return {
    ...actual,
    practitionerBucketsReconcile: (s: Parameters<typeof actual.practitionerBucketsReconcile>[0]) => (force.buckets ? actual.practitionerBucketsReconcile(s) : false),
    collectedForFilter: (s: Parameters<typeof actual.collectedForFilter>[0], f: Parameters<typeof actual.collectedForFilter>[1]) => (force.filterTotal === null ? actual.collectedForFilter(s, f) : force.filterTotal),
  };
});

import { buildOverview } from "@/lib/business-analytics/overview-model";
import { resolvePeriod } from "@/lib/business-analytics/period";

const appts = [
  { id: "a1", clientId: "c1", startsAt: "2026-11-05T15:00:00Z", status: "completed", practitionerId: "pr-1", serviceId: null, durationMinutes: 60 },
  { id: "a2", clientId: "c2", startsAt: "2026-11-06T15:00:00Z", status: "completed", practitionerId: "pr-2", serviceId: null, durationMinutes: 60 },
];
const money = { cardRows: [], settlementRows: [{ appointmentId: "a1", method: "paid_cash", amountCents: 5000, currency: "cad", quotedAmountCents: 5000 }, { appointmentId: "a2", method: "paid_cash", amountCents: 4000, currency: "cad", quotedAmountCents: 4000 }], legacyFeeRows: [] };
const p = resolvePeriod({ kind: "custom", today: "2026-11-30", from: "2026-11-01", to: "2026-11-30" });
if (!p.ok) throw new Error(p.error);
const run = (filter: { kind: "all" } | { kind: "one"; practitionerId: string }) =>
  buildOverview({
    timezone: "America/Toronto", currency: "cad", nowIso: "2026-11-30T20:00:00Z", period: p.period, filter,
    current: { ok: true, value: { appointments: appts, money } }, comparison: { ok: false, reason: "read_failed" },
    practitioners: [{ id: "pr-1", displayName: "Ada Example", active: true }, { id: "pr-2", displayName: "Grace Example", active: true }], classesRead: ["recorded_at_visit"],
  });
const MONEY_KEYS = ["collected", "averagePaid", "series", "serviceValue", "reconciliation"] as const;

beforeEach(() => Object.assign(force, { reconcile: true, buckets: true, filterTotal: null }));

describe("each reconciliation check is wired in", () => {
  it("healthy: everything is available", () => {
    const v = run({ kind: "all" });
    for (const k of MONEY_KEYS) expect(v[k].available, k).toBe(true);
  });
  it("the identity against Statements failing removes every money figure, and visits still show", () => {
    force.reconcile = false;
    const v = run({ kind: "all" });
    for (const k of MONEY_KEYS) expect(v[k], k).toEqual({ available: false, reason: "not_reconciled" });
    expect(v.completedVisits.available).toBe(true);
  });
  it("the practitioner buckets not adding up removes the by-practitioner figure, and a filtered money figure", () => {
    force.buckets = false;
    expect(run({ kind: "all" }).byPractitioner).toEqual({ available: false, reason: "not_reconciled" });
    const one = run({ kind: "one", practitionerId: "pr-1" });
    for (const k of MONEY_KEYS) expect(one[k], k).toEqual({ available: false, reason: "not_reconciled" });
  });
  it("a filtered total that differs from the statement's own bucket removes the filtered money figures", () => {
    force.filterTotal = 1;
    const one = run({ kind: "one", practitionerId: "pr-1" });
    for (const k of MONEY_KEYS) expect(one[k], k).toEqual({ available: false, reason: "not_reconciled" });
    expect(run({ kind: "all" }).collected.available).toBe(true); // the filter check applies only to a filter
  });
});
