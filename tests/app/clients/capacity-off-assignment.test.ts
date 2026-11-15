import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Sam 1 Nov: an OWNER can choose the assigned practitioner in BOTH capacity modes. Capacity OFF changes
// nothing about collision (the slot search stays studio-wide) and service eligibility is a capacity-ON rule.

const ctx = vi.hoisted(() => ({
  role: "owner" as string,
  capacity: false,
  tables: [] as string[],
  activeRows: [{ id: "p-b", display_name: "Bea" }, { id: "p-a", display_name: "Ann" }],
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p-owner", role: ctx.role, active: true },
    studio: { id: "studio-1", timezone: "UTC", practitioner_capacity_enabled: ctx.capacity },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      ctx.tables.push(table);
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") {
            return (res: (v: unknown) => void) =>
              res({ data: table === "practitioners" ? ctx.activeRows : [], error: null });
          }
          return () => chain;
        },
      });
      return chain;
    },
  }),
}));

import { fetchEligiblePractitionersAction } from "@/app/(app)/clients/[id]/booking-actions";

beforeEach(() => {
  ctx.role = "owner";
  ctx.capacity = false;
  ctx.tables.length = 0;
});

describe("fetchEligiblePractitionersAction", () => {
  it("capacity OFF, owner: every active practitioner, sorted, with NO service-eligibility read", async () => {
    const res = await fetchEligiblePractitionersAction("svc-1");
    expect(res).toEqual({ ok: true, practitioners: [{ id: "p-a", displayName: "Ann" }, { id: "p-b", displayName: "Bea" }] });
    expect(ctx.tables).toEqual(["practitioners"]);
  });
  it("capacity OFF, member: nothing (a member books for themselves)", async () => {
    ctx.role = "practitioner";
    expect(await fetchEligiblePractitionersAction("svc-1")).toEqual({ ok: true, practitioners: [] });
    expect(ctx.tables).toEqual([]);
  });
  it("capacity ON, owner: the service-eligibility filter still applies", async () => {
    ctx.capacity = true;
    await fetchEligiblePractitionersAction("svc-1");
    expect(ctx.tables[0]).toBe("service_practitioners");
  });
});

describe("slot search and booking keep collision studio-wide", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../../..", p), "utf8");
  it("the slot loader validates an owner's target in both modes but only passes it to the generator when capacity is ON", () => {
    const src = read("app/(app)/clients/[id]/booking-actions.ts");
    expect(src).toContain('if (practitioner.role === "owner" && params.practitionerId) {');
    expect(src).toContain("capacityOn ? target : null,");
    // service eligibility is gated on capacity
    expect(src).toMatch(/if \(capacityOn\) \{\s*const \{ data: elig, error: eligErr \}/);
  });
  it("the staff booking action sends an owner's chosen target to the command in both modes and nobody else's", () => {
    const src = read("app/(app)/calendar/actions.ts");
    expect(src).toMatch(/practitioner\.role === "owner" && submittedPractitionerId\s*\?\s*submittedPractitionerId\s*:\s*practitioner\.id/);
  });
  it("reassignment: owner-only in both modes, eligibility only when capacity is ON", () => {
    const src = read("app/(app)/calendar/move-appointment-actions.ts");
    expect(src).toContain('const reassignEnabled = practitioner.role === "owner";');
    expect(src).toContain("studio.practitioner_capacity_enabled === true ? (appt.service_id ?? null) : null");
  });
});
