import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// DELIVERY-VISIBILITY-02 — support resolves a delivery incident from /admin.
// Admin-only, re-checked inside the action; every attempt is audited, blocked
// ones included; only the resolution word and the command's result are logged.
// ===========================================================================

const h: {
  email: string | null;
  audits: Array<Record<string, unknown>>;
  rpcCalls: Array<[string, unknown]>;
  answer: { data: unknown; error: unknown };
} = { email: null, audits: [], rpcCalls: [], answer: { data: "resolved", error: null } };

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.email ? { id: "u-1", email: h.email } : null } }) },
  }),
}));
vi.mock("@/lib/admin", () => ({ isAdmin: (email: string | null | undefined) => email === "support@hone.test" }));
vi.mock("@/lib/audit/admin-actions", () => ({
  logAdminAction: async (input: Record<string, unknown>) => {
    h.audits.push(input);
  },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: unknown) => {
      h.rpcCalls.push([fn, args]);
      return Promise.resolve(h.answer);
    },
  }),
}));

const { resolveDeliveryIncidentAction } = await import("@/app/admin/delivery/actions");

const ID = "6e5d4c3b-2a19-4807-a6b5-c4d3e2f1a0b9";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  h.email = null;
  h.audits = [];
  h.rpcCalls = [];
  h.answer = { data: "resolved", error: null };
});

describe("resolveDeliveryIncidentAction", () => {
  it("refuses a non-admin, audits the block and never reaches the database command", async () => {
    h.email = "owner@studio.test";
    await expect(resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "fixed" }))).rejects.toThrow("Unauthorized.");
    expect(h.audits).toEqual([expect.objectContaining({ action: "delivery_incident_resolved", outcome: "blocked" })]);
    expect(h.rpcCalls).toEqual([]);
  });

  it("refuses an unknown resolution or a malformed id before any command", async () => {
    h.email = "support@hone.test";
    await expect(resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "deleted" }))).rejects.toThrow();
    await expect(resolveDeliveryIncidentAction(form({ incident_id: "1; drop", resolution: "fixed" }))).rejects.toThrow();
    expect(h.rpcCalls).toEqual([]);
  });

  it("resolves through the service-role command and audits the outcome", async () => {
    h.email = "support@hone.test";
    await resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "acknowledged" }));
    expect(h.rpcCalls).toEqual([["resolve_delivery_incident", { p_incident_id: ID, p_resolution: "acknowledged" }]]);
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: "delivery_incident_resolved",
        targetType: "delivery_incident",
        targetId: ID,
        outcome: "succeeded",
        metadata: { resolution: "acknowledged", result: "resolved" },
      }),
    ]);
  });

  it("audits a failed command as failed and surfaces it", async () => {
    h.email = "support@hone.test";
    h.answer = { data: null, error: { message: "db down" } };
    await expect(resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "fixed" }))).rejects.toThrow();
    expect(h.audits[0]).toMatchObject({ outcome: "failed" });
  });
});

describe("the support queue page", () => {
  const PAGE = readFileSync("app/admin/delivery/page.tsx", "utf8");

  it("reads only through the service-role support commands", () => {
    expect(PAGE).toContain('admin.rpc("support_delivery_incidents"');
    expect(PAGE).toContain('admin.rpc("support_email_receipt_outcomes")');
    expect(PAGE).not.toMatch(/\.from\(/);
  });

  it("treats an unreadable health row as unknown, not healthy", () => {
    expect(PAGE).toContain("Treat it as unknown, not healthy.");
  });
});
