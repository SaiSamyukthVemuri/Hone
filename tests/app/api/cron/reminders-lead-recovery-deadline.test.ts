import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLeadAlertDb, fakeResendFetch } from "../../../lib/platform-leads/helpers/fake-transports";

// LEAD-ALERT-01 (Codex P2 4259034271): reminders FAIL, and the lead-alert
// recovery that follows meets a database that never answers. The route still
// answers 500 with cron_route_failed exactly as before, and the recovery --
// its own failure report included -- is over within BUDGET + REPORT: it
// neither masks the reminders' failure nor holds the invocation.

const h = vi.hoisted(() => ({
  alerts: [] as Array<{ event: string; signal: AbortSignal | null }>,
  adminCalls: 0,
  db: null as null | { client: unknown },
  transport: null as unknown,
}));

vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    h.adminCalls += 1;
    // The reminders' own client fails; the recovery's is the stalled fake.
    if (h.adminCalls === 1) throw new Error("appointments query failed");
    return h.db!.client;
  },
}));
vi.mock("@/lib/ops/alerts", () => ({
  // Held until its signal aborts; resolves at once without one (the route's
  // own cron_route_failed alert is not this repair's concern).
  recordOpsAlert: (input: { event: string }, opts: { signal?: AbortSignal | null } = {}) => {
    const signal = opts.signal ?? null;
    h.alerts.push({ event: input.event, signal });
    if (!signal) return Promise.resolve();
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  },
}));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({ recordReminderRunSuccess: async () => undefined }));
vi.mock("@/lib/email/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/client")>()),
  getResendTransport: () => h.transport,
}));
vi.mock("@/lib/app-origin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-origin")>()),
  getRequiredAppOrigin: () => "https://hone.example",
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => undefined,
}));

import { Resend } from "resend";
import { GET } from "@/app/api/cron/appointment-reminders/route";
import {
  REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS as BUDGET,
  REMINDER_TRIGGER_LEAD_ALERT_REPORT_MS as REPORT,
} from "@/lib/platform-leads/alert-delivery";

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-13T12:00:00Z") });
  h.alerts.length = 0;
  h.adminCalls = 0;
  vi.stubEnv("LEAD_ALERT_EMAIL", "ops@hone.example");
  vi.stubEnv("ADMIN_EMAILS", "ops@hone.example");
  vi.stubGlobal("fetch", fakeResendFetch().fetch);
  h.transport = new Resend("re_test_not_a_key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reminders fail; the recovery's database stalls", () => {
  for (const fn of ["expire_platform_lead_alerts", "claim_platform_lead_alert"]) {
    it(`${fn} never answers: still 500 / cron_route_failed, and done within BUDGET + REPORT`, async () => {
      const db = fakeLeadAlertDb();
      db.add("a1");
      db.stalls[fn] = "before";
      h.db = db;

      const started = Date.now();
      let res: Response | undefined;
      const pending = GET(new Request("https://hone.example/api/cron/appointment-reminders")).then((r) => { res = r; });
      for (let t = 0; t < BUDGET + REPORT && res === undefined; t += 50) await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(res, "answered within BUDGET + REPORT").toBeDefined();
      expect(Date.now() - started).toBeLessThanOrEqual(BUDGET + REPORT);
      expect(res!.status).toBe(500);
      const body = await res!.json();
      expect(body).toMatchObject({ ok: false, error: "cron_failed", lead_alerts: { ran: true, ok: false, timed_out: true } });
      // The reminders' failure is reported first and unchanged; the
      // recovery's report follows, and was cut off rather than left running.
      expect(h.alerts.map((a) => a.event)).toEqual(["cron_route_failed", "lead_alert_recovery_failed"]);
      expect(h.alerts[1].signal?.aborted).toBe(true);
      expect(db.inflight).toBe(0);
    });
  }
});
