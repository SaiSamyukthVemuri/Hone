import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLeadAlertDb, fakeResendFetch } from "../../../lib/platform-leads/helpers/fake-transports";

// The reminders route declares no maxDuration, so the lead-alert recovery may only use what is left of a 60 s invocation (the ceiling
// every sibling cron route declares): it needs at least 3 s plus the 1 s report reserve before 50 s from the route's start, its sweep budget
// is cut to fit, and a slow reminders run skips it. The reminders' own answer is unchanged either way.

const h = vi.hoisted(() => ({
  alerts: [] as Array<{ event: string; signal: AbortSignal | null }>,
  adminCalls: 0,
  /** How long the reminders' own (failing) work "takes", on the fake clock. */
  remindersTakeMs: 0,
  db: null as null | { client: unknown },
  transport: null as unknown,
}));

vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    h.adminCalls += 1;
    // The reminders' own client fails; the recovery's is the stalled fake.
    if (h.adminCalls === 1) {
      vi.setSystemTime(Date.now() + h.remindersTakeMs);
      throw new Error("appointments query failed");
    }
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
import { REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS as BUDGET } from "@/lib/platform-leads/alert-delivery";

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-13T12:00:00Z") });
  h.alerts.length = 0;
  h.adminCalls = 0;
  h.remindersTakeMs = 0;
  vi.stubEnv("LEAD_ALERT_RECIPIENTS", "ops@hone.example");
  vi.stubEnv("ADMIN_EMAILS", "ops@hone.example");
  vi.stubGlobal("fetch", fakeResendFetch().fetch);
  h.transport = new Resend("re_test_not_a_key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});


const call = async (stalls: string[] = []) => {
  const db = fakeLeadAlertDb();
  db.add("a1");
  for (const fn of stalls) db.stalls[fn] = "before";
  h.db = db;
  const started = Date.now();
  let res: Response | undefined;
  const pending = GET(new Request("https://hone.example/api/cron/appointment-reminders")).then((r) => { res = r; });
  for (let t = 0; t < 12_000 && res === undefined; t += 50) await vi.advanceTimersByTimeAsync(50);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  return { res: res!, spent: Date.now() - started, db };
};

describe("recovery only uses what is left of the invocation", () => {
  it("a reminders run that already took 48 s skips recovery: no second database client, and the reminders' answer is unchanged", async () => {
    h.remindersTakeMs = 48_000;
    const { res, db } = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "cron_failed", lead_alerts: { ran: false, reason: "no_time" } });
    expect(h.adminCalls).toBe(1);
    expect(db.calls).toEqual([]);
  });

  it("a fast reminders run still gets recovery", async () => {
    h.remindersTakeMs = 1_000;
    const { res } = await call();
    expect(await res.json()).toMatchObject({ lead_alerts: { ran: true } });
    expect(h.adminCalls).toBe(2);
  });

  it("a reminders run that took 45 s leaves 4 s: recovery runs, with its budget cut to fit, so the whole invocation stays under 50 s", async () => {
    h.remindersTakeMs = 45_000;
    const { res, spent } = await call(["claim_platform_lead_alert"]);
    const body = await res.json();
    expect(body.lead_alerts).toMatchObject({ ran: true, timed_out: true });
    // the stalled database holds the sweep to its (cut) budget, and its report to the 1 s reserve
    expect(spent).toBeLessThanOrEqual(50_000); // spent includes the reminders' own 45 s
    expect(spent).toBeGreaterThan(45_000);
  });

  it("the uncut budget is unchanged when plenty of time is left", async () => {
    h.remindersTakeMs = 0;
    const { spent } = await call(["claim_platform_lead_alert"]);
    expect(spent).toBeGreaterThan(4_000 + 1_000); // longer than the cut budget would have allowed
    expect(spent).toBeLessThanOrEqual(BUDGET + 1_000);
  });
});
