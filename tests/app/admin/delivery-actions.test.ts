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

const { resolveDeliveryIncidentAction, closeDeliveryConcernAction } = await import("@/app/admin/delivery/actions");

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

  it("refuses an unknown resolution or a malformed id before any command, and audits both (Codex P2 4244834158)", async () => {
    h.email = "support@hone.test";
    await expect(resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "deleted" }))).rejects.toThrow();
    await expect(resolveDeliveryIncidentAction(form({ incident_id: "1; drop", resolution: "fixed" }))).rejects.toThrow();
    expect(h.rpcCalls).toEqual([]);
    expect(h.audits).toEqual([
      expect.objectContaining({ outcome: "failed", targetId: ID, metadata: { result: "invalid_input", invalid: "resolution" } }),
      expect.objectContaining({ outcome: "failed", targetId: null, metadata: { result: "invalid_input", invalid: "incident_id" } }),
    ]);
    // The submitted values themselves are never logged.
    expect(JSON.stringify(h.audits)).not.toContain("1; drop");
    expect(JSON.stringify(h.audits)).not.toContain("deleted");
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

describe("closeDeliveryConcernAction (DELIVERY-VISIBILITY-04)", () => {
  it("refuses a non-admin, audited, without reaching the command", async () => {
    h.email = "owner@studio.test";
    await expect(closeDeliveryConcernAction(form({ concern_id: ID, resolution: "explained" }))).rejects.toThrow("Unauthorized.");
    expect(h.audits).toEqual([expect.objectContaining({ action: "delivery_concern_closed", outcome: "blocked" })]);
    expect(h.rpcCalls).toEqual([]);
  });

  it("closes through the service-role command and audits the resolution word only", async () => {
    h.email = "support@hone.test";
    h.answer = { data: "closed", error: null };
    await closeDeliveryConcernAction(form({ concern_id: ID, resolution: "provider_issue" }));
    expect(h.rpcCalls).toEqual([["close_delivery_concern", { p_concern_id: ID, p_resolution: "provider_issue" }]]);
    expect(h.audits[0]).toMatchObject({ outcome: "succeeded", metadata: { resolution: "provider_issue", result: "closed" } });
  });

  it("refuses an unknown resolution or a malformed id before any command, and audits both", async () => {
    h.email = "support@hone.test";
    await expect(closeDeliveryConcernAction(form({ concern_id: ID, resolution: "deleted" }))).rejects.toThrow();
    await expect(closeDeliveryConcernAction(form({ concern_id: "1; drop", resolution: "explained" }))).rejects.toThrow();
    expect(h.rpcCalls).toEqual([]);
    expect(h.audits).toEqual([
      expect.objectContaining({ action: "delivery_concern_closed", outcome: "failed", targetId: ID, metadata: { result: "invalid_input", invalid: "resolution" } }),
      expect.objectContaining({ action: "delivery_concern_closed", outcome: "failed", targetId: null, metadata: { result: "invalid_input", invalid: "concern_id" } }),
    ]);
    expect(JSON.stringify(h.audits)).not.toContain("1; drop");
    expect(JSON.stringify(h.audits)).not.toContain("deleted");
  });
});

describe("the support queue page", () => {
  const PAGE = readFileSync("app/admin/delivery/page.tsx", "utf8");

  it("reads only through the service-role support commands", () => {
    expect(PAGE).toContain('admin.rpc("support_delivery_incidents"');
    expect(PAGE).toContain('admin.rpc("support_email_receipt_outcomes")');
    expect(PAGE).toContain('admin.rpc("support_delivery_concerns"');
    expect(PAGE).not.toMatch(/\.from\(/);
  });

  it("treats an unreadable health row as unknown, not healthy", () => {
    expect(PAGE).toContain("Treat it as unknown, not healthy.");
  });

  it("treats an unreadable event summary as unknown, never as no events (Codex P2 4244834156)", () => {
    expect(PAGE).toMatch(/outcomesRes\.error \|\| !Array\.isArray\(outcomesRes\.data\) \? null/);
    expect(PAGE).toContain("Treat it as unknown, not as no events.");
    expect(PAGE).not.toContain("outcomesRes.data ?? []");
  });
});
