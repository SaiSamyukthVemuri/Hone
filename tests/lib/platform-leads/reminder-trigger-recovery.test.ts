import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";

// LEAD-ALERT-01 (Codex P2 4253278108; decision on #831/#843): bounded lead-alert
// recovery on the existing 15-minute reminders trigger.
//   * GATED before any database or provider call until lead alerts are configured;
//   * BOUNDED (at most two alerts, a short budget) and never throws;
//   * the SAME worker and authority as every other lead-alert send;
//   * wired AFTER every reminder pass and the heartbeat, outside the failure path.

vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));

import {
  recoverLeadAlertsOnReminderTrigger,
  REMINDER_TRIGGER_LEAD_ALERT_MAX,
} from "@/lib/platform-leads/alert-delivery";

const OPS = "ops@hone.example";
const ENV = { LEAD_ALERT_EMAIL: OPS, ADMIN_EMAILS: OPS };

function recordingAdmin(calls: string[], claims = 10): SupabaseClient {
  let left = claims;
  return {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push(fn);
      if (fn === "expire_platform_lead_alerts") return { data: 0, error: null };
      if (fn === "claim_platform_lead_alert") {
        if (left <= 0) return { data: [{ result: "none" }], error: null };
        left -= 1;
        return {
          data: [{
            result: "claimed", alert_id: `a${left}`, claim_token: `t${left}`, attempt: 2, idempotency_key: `lead-alert/a${left}/1`,
            lead_kind: "demo_request", lead_id: "l", event_at: "2026-10-12T00:00:00Z", lead_name: "N", lead_email: "n@x.test",
            practice_name: null, location: null, practice_type: null, practitioner_count: null, current_tool: null, has_notes: false,
            frozen_message: null, frozen_recipient_sha256: null,
          }],
          error: null,
        };
      }
      if (fn === "freeze_platform_lead_alert_message") {
        return { data: [{ result: "frozen", message: args.p_message, recipient_sha256: args.p_recipient_sha256 }], error: null };
      }
      if (fn === "settle_platform_lead_alert") return { data: "retry_scheduled", error: null };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}
const transport: IdempotentEmailTransport = { emails: { send: async () => ({ data: null, error: { name: "internal_server_error", message: "x", statusCode: 500 } }) as never } };

describe("recoverLeadAlertsOnReminderTrigger", () => {
  it("UNCONFIGURED: no database call and no provider call at all (production reminders stay untouched)", async () => {
    for (const env of [{}, { ADMIN_EMAILS: OPS }, { LEAD_ALERT_EMAIL: "not-an-admin@x.test", ADMIN_EMAILS: OPS }]) {
      const calls: string[] = [];
      let sends = 0;
      const out = await recoverLeadAlertsOnReminderTrigger({
        admin: recordingAdmin(calls),
        transport: { emails: { send: async () => { sends += 1; return {} as never; } } },
        env,
        appOrigin: () => "https://hone.example",
      });
      expect(out.ran, JSON.stringify(env)).toBe(false);
      expect(calls, JSON.stringify(env)).toEqual([]);
      expect(sends).toBe(0);
    }
  });

  it("CONFIGURED: the same worker, bounded to two alerts per trigger", async () => {
    const calls: string[] = [];
    const out = await recoverLeadAlertsOnReminderTrigger({ admin: recordingAdmin(calls, 10), transport, env: ENV, appOrigin: () => "https://hone.example" });
    expect(out).toMatchObject({ ran: true, summary: { ok: true, attempted: REMINDER_TRIGGER_LEAD_ALERT_MAX } });
    expect(calls.filter((c) => c === "claim_platform_lead_alert")).toHaveLength(REMINDER_TRIGGER_LEAD_ALERT_MAX);
    // One authority: expire, claim, freeze, settle -- nothing else.
    expect([...new Set(calls)].sort()).toEqual(["claim_platform_lead_alert", "expire_platform_lead_alerts", "freeze_platform_lead_alert_message", "settle_platform_lead_alert"]);
  });

  it("never throws: a database that throws is reported, not raised", async () => {
    const admin = { rpc: async () => { throw new Error("connection reset"); } } as unknown as SupabaseClient;
    const out = await recoverLeadAlertsOnReminderTrigger({ admin, transport, env: ENV, appOrigin: () => "https://hone.example" });
    expect(out.ran === false || out.summary.ok === false).toBe(true);
  });
});

describe("wiring in the reminders route (source guard)", () => {
  const SRC = readFileSync("app/api/cron/appointment-reminders/route.ts", "utf8");

  it("runs AFTER every reminder pass and the heartbeat, inside the success path only", () => {
    const heartbeat = SRC.indexOf("await recordReminderRunSuccess(");
    const recovery = SRC.indexOf("await recoverLeadAlertsOnReminderTrigger(");
    const catchAt = SRC.indexOf("} catch (err) {", heartbeat);
    expect(heartbeat).toBeGreaterThan(0);
    expect(recovery).toBeGreaterThan(heartbeat);
    expect(recovery).toBeLessThan(catchAt);
    expect(SRC.match(/recoverLeadAlertsOnReminderTrigger\(/g)).toHaveLength(1);
  });

  it("a lead-alert problem is an ops alert and a response field, never a failed reminders run", () => {
    expect(SRC).toMatch(/event: "lead_alert_recovery_failed"/);
    expect(SRC).toMatch(/lead_alerts: lead_alerts\.ran/);
  });
});
