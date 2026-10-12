import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// DELIVERY-VISIBILITY-01 — the recovery sweep route.
//
// Substituted: the database (rpc + one ops_alerts read) and the ops-alert
// writer. Real: CRON_SECRET auth, the drain wrapper, the health reader and the
// findings decision.
// ===========================================================================

const h: {
  rpc: Record<string, Array<{ data: unknown; error: unknown }>>;
  calls: string[];
  openAlerts: Set<string>;
  alerts: Array<Record<string, unknown>>;
  admins: number;
} = { rpc: {}, calls: [], openAlerts: new Set(), alerts: [], admins: 0 };

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    h.admins += 1;
    return {
      rpc(fn: string) {
        h.calls.push(fn);
        const q = h.rpc[fn] ?? [];
        return Promise.resolve(q.length > 1 ? q.shift()! : (q[0] ?? { data: null, error: { message: "unscripted" } }));
      },
      from(table: string) {
        expect(table).toBe("ops_alerts");
        let event = "";
        const chain = {
          select: () => chain,
          eq: (_c: string, v: string) => {
            event = v;
            return chain;
          },
          is: () => chain,
          limit: () => Promise.resolve({ data: h.openAlerts.has(event) ? [{ id: "x" }] : [], error: null }),
        };
        return chain;
      },
    };
  },
}));

vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (input: Record<string, unknown>) => {
    h.alerts.push(input);
    return Promise.resolve();
  },
}));

const { GET } = await import("@/app/api/cron/email-delivery-sweep/route");

const ok = (data: unknown) => ({ data, error: null });
const healthRow = (over: Record<string, unknown> = {}) =>
  ok([
    {
      pending_receipts: 0,
      oldest_pending_seconds: null,
      exhausted_24h: 0,
      quarantined_24h: 0,
      unmatched_24h: 0,
      unreported_accepted: 0,
      open_incidents: 0,
      last_sweep_at: "2026-10-12T00:00:00Z",
      last_sweep_failed: 0,
      ...over,
    },
  ]);

const call = (auth?: string) =>
  GET(new Request("https://hone.care/api/cron/email-delivery-sweep", { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => {
  h.rpc = {};
  h.calls = [];
  h.openAlerts = new Set();
  h.alerts = [];
  h.admins = 0;
  process.env.CRON_SECRET = "sweep-test-secret";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe("auth", () => {
  it("refuses a missing or wrong bearer with 401 and no database work", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(h.admins).toBe(0);
  });
});

describe("a healthy run", () => {
  it("drains, records its heartbeat, reads health and raises nothing", async () => {
    h.rpc = {
      claim_email_provider_events: [ok([])],
      record_email_sweep_run: [ok("recorded")],
      email_delivery_health: [healthRow()],
    };
    const res = await call("Bearer sweep-test-secret");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, heartbeat: true, raised: [], sweep: { claimed: 0, processed: 0, failed: 0 } });
    expect(h.calls).toEqual(["claim_email_provider_events", "record_email_sweep_run", "email_delivery_health"]);
  });
});

describe("findings become DEDUPED ops alerts", () => {
  it("raises each finding once while an unresolved alert for it is open", async () => {
    h.rpc = {
      claim_email_provider_events: [ok([])],
      record_email_sweep_run: [ok("recorded")],
      email_delivery_health: [healthRow({ pending_receipts: 3, oldest_pending_seconds: 3600, unreported_accepted: 2 })],
    };
    h.openAlerts.add("email_delivery_unreported");
    const body = await (await call("Bearer sweep-test-secret")).json();
    expect(body.raised).toEqual(["email_delivery_backlog_stale"]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ severity: "warning", event: "email_delivery_backlog_stale" });
    // Operational counts only.
    expect(JSON.stringify(h.alerts[0]!.safeDetails)).toBe('{"pending_receipts":3,"oldest_pending_seconds":3600}');
  });

  it("never records a critical alert, because a critical ops alert is emailed (#828 gate)", async () => {
    h.rpc = {
      claim_email_provider_events: [ok([])],
      record_email_sweep_run: [ok("recorded")],
      email_delivery_health: [healthRow({ pending_receipts: 2, oldest_pending_seconds: 7 * 60 * 60 })],
    };
    const body = await (await call("Bearer sweep-test-secret")).json();
    expect(body.raised).toEqual(["email_delivery_backlog_stale"]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      severity: "warning",
      safeDetails: { pending_receipts: 2, oldest_pending_seconds: 25200, assessed_severity: "critical" },
    });
    expect(h.alerts.every((a) => a.severity !== "critical")).toBe(true);
  });

  it("treats a sweep or health read that failed as a finding, never as healthy", async () => {
    h.rpc = {
      claim_email_provider_events: [{ data: null, error: { message: "db down" } }],
      email_delivery_health: [{ data: null, error: { message: "db down" } }],
    };
    const res = await call("Bearer sweep-test-secret");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.raised).toEqual(["email_delivery_sweep_failing"]);
    expect(h.calls).not.toContain("record_email_sweep_run");
  });
});
