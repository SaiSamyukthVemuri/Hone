import { beforeEach, describe, expect, it, vi } from "vitest";

// LEAD-ALERT-01 (Codex P2 4254097611): when reminder processing FAILS, the
// route still answers 500 with cron_route_failed exactly as before -- and the
// bounded lead-alert recovery still runs, so an unrelated reminders failure
// cannot stop lead retries.

const h = vi.hoisted(() => ({ alerts: [] as Array<Record<string, unknown>>, recoveries: 0, order: [] as string[] }));

vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    throw new Error("appointments query failed");
  },
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: Record<string, unknown>) => {
    h.alerts.push(a);
    h.order.push(`alert:${String(a.event)}`);
  },
}));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({ recordReminderRunSuccess: async () => undefined }));
vi.mock("@/lib/platform-leads/alert-delivery", () => ({
  recoverLeadAlertsOnReminderTrigger: async () => {
    h.recoveries += 1;
    h.order.push("lead_recovery");
    return { ran: true, summary: { ok: true, drained: true, attempted: 1, accepted: 1, failed: 0, expired: 0, retryScheduled: 0, other: 0, blocked: null, blockedAlerts: 0 } };
  },
}));

import { GET } from "@/app/api/cron/appointment-reminders/route";

beforeEach(() => {
  h.alerts.length = 0;
  h.recoveries = 0;
  h.order.length = 0;
});

describe("reminders fail; lead recovery still runs", () => {
  it("answers 500 with cron_route_failed as before, THEN runs the bounded lead recovery", async () => {
    const res = await GET(new Request("https://hone.example/api/cron/appointment-reminders"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "cron_failed", lead_alerts: { ran: true, ok: true, attempted: 1 } });
    expect(h.alerts.map((a) => a.event)).toEqual(["cron_route_failed"]);
    expect(h.recoveries).toBe(1);
    expect(h.order).toEqual(["alert:cron_route_failed", "lead_recovery"]);
  });
});
