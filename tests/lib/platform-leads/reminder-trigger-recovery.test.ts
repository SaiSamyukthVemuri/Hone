import { abortableRpc } from "./helpers/abortable-rpc";
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
const afterCtl = vi.hoisted(() => ({ handed: [] as unknown[] }));
vi.mock("next/server", () => ({ after: (task: unknown) => { afterCtl.handed.push(task); } }));

import {
  recoverLeadAlertsOnReminderTrigger,
  LEAD_ALERT_SETTLE_RESERVE_MS,
  REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS,
  REMINDER_TRIGGER_LEAD_ALERT_MAX,
  sweepPlatformLeadAlerts,
} from "@/lib/platform-leads/alert-delivery";

const OPS = "ops@hone.example";
const ENV = { LEAD_ALERT_EMAIL: OPS, ADMIN_EMAILS: OPS };

function recordingAdmin(calls: string[], claims = 10): SupabaseClient {
  let left = claims;
  return {
    rpc: abortableRpc(async (fn: string, args: Record<string, unknown> = {}) => {
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
    }),
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

  it("CONFIGURED: the same worker, draining until empty (drained) or its cap (not drained)", async () => {
    const small: string[] = [];
    const drained = await recoverLeadAlertsOnReminderTrigger({ admin: recordingAdmin(small, 3), transport, env: ENV, appOrigin: () => "https://hone.example" });
    expect(drained).toMatchObject({ ran: true, summary: { ok: true, attempted: 3, drained: true } });
    const calls: string[] = [];
    const out = await recoverLeadAlertsOnReminderTrigger({ admin: recordingAdmin(calls, 100), transport, env: ENV, appOrigin: () => "https://hone.example" });
    expect(out).toMatchObject({ ran: true, summary: { ok: true, attempted: REMINDER_TRIGGER_LEAD_ALERT_MAX, drained: false } });
    expect(calls.filter((c) => c === "claim_platform_lead_alert")).toHaveLength(REMINDER_TRIGGER_LEAD_ALERT_MAX);
    // One authority: expire, claim, freeze, settle -- nothing else.
    expect([...new Set(calls)].sort()).toEqual(["claim_platform_lead_alert", "expire_platform_lead_alerts", "freeze_platform_lead_alert_message", "settle_platform_lead_alert"]);
  });

  it("never throws: a database that throws is reported, not raised", async () => {
    const admin = { rpc: abortableRpc(async () => { throw new Error("connection reset"); }) } as unknown as SupabaseClient;
    const out = await recoverLeadAlertsOnReminderTrigger({ admin, transport, env: ENV, appOrigin: () => "https://hone.example" });
    expect(out.ran === false || out.summary.ok === false).toBe(true);
  });
});

describe("wiring in the reminders route (source guard)", () => {
  const SRC = readFileSync("app/api/cron/appointment-reminders/route.ts", "utf8");

  it("runs AFTER every reminder pass and the heartbeat on success, and AFTER cron_route_failed on failure (Codex P2 4254097611)", () => {
    // Production's bounded scan (MSG-001) added a third exit: an incomplete or
    // coverage-unconfirmed scan answers 500 BEFORE the heartbeat. A reminders
    // failure must not stop lead-alert retries there either.
    const partial = SRC.indexOf('if (batch.kind !== "complete" || batch.coverageUnconfirmed)');
    const heartbeat = SRC.indexOf("await recordReminderRunSuccess(");
    const catchAt = SRC.indexOf("} catch {\n", heartbeat);
    const calls = [...SRC.matchAll(/await runLeadAlertRecovery\(\)/g)].map((m) => m.index!);
    expect(partial).toBeGreaterThan(0);
    expect(catchAt).toBeGreaterThan(heartbeat);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBeGreaterThan(partial);
    expect(calls[0]).toBeLessThan(heartbeat);
    expect(SRC.slice(calls[0], heartbeat)).toContain(
      'return NextResponse.json({ ok: false, error: "cron_failed", lead_alerts }, { status: 500 });',
    );
    expect(calls[1]).toBeGreaterThan(heartbeat);
    expect(calls[1]).toBeLessThan(catchAt);
    const failureAlert = SRC.indexOf('event: "cron_route_failed"', catchAt);
    expect(failureAlert).toBeGreaterThan(catchAt);
    expect(calls[2]).toBeGreaterThan(failureAlert);
    // The reminders' failure answer is unchanged: still a 500.
    expect(SRC.slice(calls[2])).toMatch(/\{ ok: false, error: "cron_failed", lead_alerts \},\s*\{ status: 500 \}/);
    expect(SRC.match(/recoverLeadAlertsOnReminderTrigger\(/g)).toHaveLength(1);
  });

  it("a lead-alert problem is an ops alert and a response field, never a failed reminders run", () => {
    // The report is written INSIDE the bounded recovery, under its own
    // cancellation (Codex P2 4259034271); the route adds no unbounded write.
    const LIB = readFileSync("lib/platform-leads/alert-delivery.ts", "utf8");
    expect(LIB).toMatch(/event: "lead_alert_recovery_failed"[\s\S]*\{ signal: report\.signal \}/);
    expect(SRC).not.toMatch(/lead_alert_recovery_failed/);
    expect(SRC).toMatch(/lead_alerts,\n\s*\}\);/);
    expect(SRC).toMatch(/unknown: out\.summary\.unknown/);
  });
});

// Codex P2 4253569253: the budget holds DURING a send, not only before it.
describe("the sweep deadline holds during a send", () => {
  it("a provider that never answers is CANCELLED at the send deadline, settled as a retry under the SAME key", async () => {
    afterCtl.handed.length = 0;
    vi.useFakeTimers();
    try {
      const settles: Array<Record<string, unknown>> = [];
      const keys: Array<string | undefined> = [];
      const signals: AbortSignal[] = [];
      const base = recordingAdmin([], 10);
      const admin = {
        rpc: abortableRpc(async (fn: string, args: Record<string, unknown> = {}) => {
          if (fn === "settle_platform_lead_alert") settles.push(args);
          return (base as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<unknown> }).rpc(fn, args);
        }),
      } as unknown as SupabaseClient;
      const hanging: IdempotentEmailTransport = {
        // Like fetch: pending until its signal aborts, then rejects.
        emails: {
          send: (_p, o) => {
            keys.push(o?.idempotencyKey);
            const signal = (o as { signal?: AbortSignal }).signal!;
            signals.push(signal);
            return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
          },
        },
      };
      const started = Date.now();
      const running = recoverLeadAlertsOnReminderTrigger({ admin, transport: hanging, env: ENV, appOrigin: () => "https://hone.example" });
      // Only up to the send deadline (budget minus the settle reserve): the
      // sweep must already be done by then.
      await vi.advanceTimersByTimeAsync(REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS - LEAD_ALERT_SETTLE_RESERVE_MS);
      const out = await running;
      // Finished inside the budget, settle reserve included -- not at the send's own 15 s ceiling.
      expect(Date.now() - started).toBeLessThanOrEqual(REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS - LEAD_ALERT_SETTLE_RESERVE_MS);
      // The request itself was cancelled: nothing is left running, so nothing
      // needs keeping alive past the response (Codex P2 4259034271).
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
      expect(afterCtl.handed).toHaveLength(0);
      expect(out).toMatchObject({ ran: true, summary: { ok: true, attempted: 1 } });
      expect(keys).toHaveLength(1);
      expect(settles).toEqual([expect.objectContaining({ p_outcome: "retry", p_error_code: "provider_timeout" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no claim (a counted attempt) starts when too little of the budget is left", async () => {
    const calls: string[] = [];
    const out = await sweepPlatformLeadAlerts({ admin: recordingAdmin(calls, 10), transport, env: ENV, appOrigin: () => "https://hone.example", maxAlerts: 5, budgetMs: 3_000 });
    expect(out).toMatchObject({ ok: true, attempted: 0 });
    expect(calls).not.toContain("claim_platform_lead_alert");
  });
});
