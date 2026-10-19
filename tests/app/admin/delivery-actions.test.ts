import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

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
  // Per-RPC answers for the page render below; `answer` stays the fallback so
  // the action cases are untouched.
  byFn: Record<string, { data: unknown; error: unknown }>;
  /** What `delivery_incidents.resolution` holds, for the conflict path. */
  storedResolution: { resolution: string } | null;
  tableReads: string[];
  readError: { message: string } | null;
  readThrows: boolean;
} = {
  email: null,
  audits: [],
  rpcCalls: [],
  answer: { data: "resolved", error: null },
  byFn: {},
  storedResolution: null,
  tableReads: [],
  readError: null,
  readThrows: false,
};

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
      return Promise.resolve(h.byFn[fn] ?? h.answer);
    },
    // The conflicting-resolution path reads the STORED resolution, because the
    // command returns only a result word and never says what is on record.
    from: (table: string) => {
      h.tableReads.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (h.readThrows) throw new Error("fake read failure");
          return { data: h.storedResolution, error: h.readError };
        },
      };
      return chain;
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
  h.byFn = {};
  h.storedResolution = null;
  h.tableReads = [];
  h.readError = null;
  h.readThrows = false;
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

describe("a conflicting second resolution is not a success (Codex P2 4307695064)", () => {
  it("already_resolved with a DIFFERENT resolution fails, and the audit never shows the submitted word", async () => {
    // `resolve_delivery_incident` returns already_resolved WITHOUT updating
    // (0215:343), so the row keeps the FIRST admin's resolution. Recording the
    // submitted word as a success made the audit assert a resolution that was
    // never committed — and the audit is the one place a reviewer looks to find
    // out what an incident was closed as.
    h.email = "support@hone.test";
    h.answer = { data: "already_resolved", error: null };
    h.storedResolution = { resolution: "acknowledged" };

    await expect(
      resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "fixed" })),
    ).rejects.toThrow(/already resolved as "acknowledged"/i);

    expect(h.tableReads, "it must read what IS recorded").toContain("delivery_incidents");
    const audit = h.audits[0]!;
    expect(audit).toMatchObject({
      outcome: "failed",
      metadata: {
        result: "already_resolved_conflict",
        applied: false,
        recorded_resolution: "acknowledged",
      },
    });
    // THE LOAD-BEARING ABSENCE: the submitted word must not appear anywhere in
    // the audit, because it was not applied.
    expect(JSON.stringify(audit)).not.toContain("fixed");
  });

  it("already_resolved with the SAME resolution stays idempotent success", async () => {
    // The outcome the caller asked for is the outcome on record, so there is
    // nothing to warn about and nothing to undo.
    h.email = "support@hone.test";
    h.answer = { data: "already_resolved", error: null };
    h.storedResolution = { resolution: "fixed" };

    await resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "fixed" }));

    expect(h.audits[0]).toMatchObject({
      outcome: "succeeded",
      metadata: { resolution: "fixed", result: "already_resolved" },
    });
  });

  it("a first resolution still succeeds, and reads nothing extra", async () => {
    // CONTROL: the ordinary path must not have grown a read, or every resolve
    // pays for the conflict case.
    h.email = "support@hone.test";
    h.answer = { data: "resolved", error: null };

    await resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "fixed" }));

    expect(h.audits[0]).toMatchObject({ outcome: "succeeded", metadata: { result: "resolved" } });
    expect(h.tableReads, "no stored-resolution read on the happy path").toEqual([]);
  });
});

describe("the capped incident list is not presented as a total (Codex P2 4307533285)", () => {
  // RENDERED, not grepped. The sibling cases in this file are source guards,
  // and a source guard cannot tell whether the indicator actually appears at
  // the cap — which is the whole property. `support_delivery_incidents` applies
  // `limit 300` inside 0215, so at 300 rows this page is holding a SLICE.
  const CAP = 300;
  const incidentRow = (i: number) => ({
    incident_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    studio_id: "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b",
    studio_name: "Studio",
    channel: "email",
    purpose: "appointment_reminder_24h",
    failure_class: "bounced",
    occurrences: 1,
    first_seen_at: "2026-10-12T15:00:00Z",
    last_seen_at: "2026-10-12T18:00:00Z",
    last_reason: "no_email",
    last_appointment_id: null,
    resolved_at: null,
    resolution: null,
  });

  const renderWith = async (count: number): Promise<string> => {
    h.byFn = {
      support_delivery_incidents: {
        data: Array.from({ length: count }, (_, i) => incidentRow(i)),
        error: null,
      },
      support_email_receipt_outcomes: { data: [], error: null },
      email_delivery_health: { data: [], error: null },
    };
    const { default: Page } = await import("@/app/admin/delivery/page");
    return renderToStaticMarkup(await Page());
  };

  const INDICATOR = "Showing the most recent 300 incidents. Older incidents, if any, are not listed.";

  it("AT the cap: says the list is truncated", async () => {
    const html = await renderWith(CAP);
    expect(html).toContain(INDICATOR);
  });

  it("BELOW the cap: no indicator, because nothing is hidden", async () => {
    // One short of the cap. The boundary is the point: an indicator that is
    // always on is as untrue as one that never is.
    const html = await renderWith(CAP - 1);
    expect(html).not.toContain("Older incidents, if any, are not listed");
  });

  it("the counts say SHOWN, never implying a total", async () => {
    const html = await renderWith(CAP);
    expect(html).toContain("shown");
    // The bare "Open incidents (300)" form is what read as authoritative.
    expect(html).not.toMatch(/Open incidents \(\d+\)</);
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

  it("treats an unreadable event summary as unknown, never as no events (Codex P2 4244834156)", () => {
    expect(PAGE).toMatch(/outcomesRes\.error \|\| !Array\.isArray\(outcomesRes\.data\) \? null/);
    expect(PAGE).toContain("Treat it as unknown, not as no events.");
    expect(PAGE).not.toContain("outcomesRes.data ?? []");
  });
});


it.each(["missing", "read-error", "throw", "invalid-resolution"])(
  "already_resolved %s is failed/unknown without claiming the submitted resolution (4310059463)", async (mode) => {
    h.email = "support@hone.test";
    h.answer = { data: "already_resolved", error: null };
    h.storedResolution = mode === "missing" ? null : { resolution: mode === "invalid-resolution" ? "invalid" : "fixed" };
    if (mode === "read-error") h.readError = { message: "fake permission/read failure" };
    if (mode === "throw") h.readThrows = true;
    await expect(resolveDeliveryIncidentAction(form({ incident_id: ID, resolution: "fixed" })))
      .rejects.toThrow("could not be verified");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ outcome: "failed", metadata: {
      result: "already_resolved_unknown", applied: false, recorded_resolution: null,
    } });
    expect(h.audits[0]!.metadata).not.toHaveProperty("resolution");
  },
);
