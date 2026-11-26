import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";
import { fakeLeadAlertDb, fakeResendFetch, type Stall } from "./helpers/fake-transports";

// LEAD-ALERT-01 (Codex P2 4259034271; decision on #831): the recovery's
// deadline binds EVERY call it makes -- claim, freeze, send, settle and its
// own failure report -- by CANCELLING the request at the transport, never by
// racing a promise and leaving the request running. A call the deadline
// cancels has an UNKNOWN outcome: never counted as sent or failed, and
// recovered by the lease, the same idempotency key and the frozen message.
//
// Fake clock, fake DB transport (real supabase-js over a fake fetch), fake
// provider transport (the real Resend SDK over a fake fetch).

const ops = vi.hoisted(() => ({ alerts: [] as Array<{ event: string; signal: AbortSignal | null }> }));
vi.mock("@/lib/ops/alerts", () => ({
  // Like the real insert: held until its signal aborts (forever without one).
  recordOpsAlert: (input: { event: string }, opts: { signal?: AbortSignal | null } = {}) => {
    const signal = opts.signal ?? null;
    ops.alerts.push({ event: input.event, signal });
    return new Promise<void>((resolve) => {
      if (!signal) return;
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },
}));
const afterCtl = vi.hoisted(() => ({ handed: [] as unknown[] }));
vi.mock("next/server", () => ({ after: (task: unknown) => { afterCtl.handed.push(task); } }));

import {
  LEAD_ALERT_LEASE_SECONDS,
  LEAD_ALERT_SETTLE_RESERVE_MS,
  REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS as BUDGET,
  REMINDER_TRIGGER_LEAD_ALERT_REPORT_MS as REPORT,
  recoverLeadAlertsOnReminderTrigger,
  type ReminderTriggerLeadAlertResult,
} from "@/lib/platform-leads/alert-delivery";

const OPS = "ops@hone.example";
const ENV = { LEAD_ALERT_EMAIL: OPS, ADMIN_EMAILS: OPS };
const TRIGGER_EVERY_MS = 15 * 60_000;

let db: ReturnType<typeof fakeLeadAlertDb>;
let provider: ReturnType<typeof fakeResendFetch>;
let resend: IdempotentEmailTransport;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-13T12:00:00Z") });
  ops.alerts.length = 0;
  afterCtl.handed.length = 0;
  db = fakeLeadAlertDb();
  provider = fakeResendFetch();
  vi.stubGlobal("fetch", provider.fetch);
  resend = new Resend("re_test_not_a_key") as unknown as IdempotentEmailTransport;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** One trigger, driven by the fake clock to completion. Returns its result and elapsed fake time. */
async function trigger(env: Record<string, string> = ENV): Promise<{ out: ReminderTriggerLeadAlertResult; elapsed: number }> {
  const started = Date.now();
  let out: ReminderTriggerLeadAlertResult | undefined;
  const run = recoverLeadAlertsOnReminderTrigger({ admin: db.client, transport: resend, env, appOrigin: () => "https://hone.example" })
    .then((r) => { out = r; });
  // Never further than the recovery's own ceiling: it must be done by then.
  for (let t = 0; t < BUDGET + REPORT && out === undefined; t += 50) await vi.advanceTimersByTimeAsync(50);
  await vi.advanceTimersByTimeAsync(0);
  await run;
  expect(out, "the recovery finished inside BUDGET + REPORT").toBeDefined();
  return { out: out!, elapsed: Date.now() - started };
}

function summaryOf(out: ReminderTriggerLeadAlertResult) {
  if (!out.ran) throw new Error(`did not run: ${out.reason}`);
  return out.summary;
}

/** Nothing the run started is still running on either transport. */
function nothingLeftRunning() {
  expect(db.inflight, "database requests still running").toBe(0);
  expect(provider.inflight, "provider requests still running").toBe(0);
  expect(afterCtl.handed, "nothing needs keeping alive").toHaveLength(0);
  expect(vi.getTimerCount(), "no deadline timer left behind").toBe(0);
}

describe("a stalled database call is cancelled at the deadline, its outcome unknown", () => {
  for (const [fn, stall] of [
    ["claim_platform_lead_alert", "before"],
    ["claim_platform_lead_alert", "after"],
    ["freeze_platform_lead_alert_message", "before"],
    ["freeze_platform_lead_alert_message", "after"],
  ] as Array<[string, Stall]>) {
    it(`${fn} held ${stall} its effect: no provider request, recovered on a later trigger, delivered once`, async () => {
      db.add("a1");
      db.stalls[fn] = stall;
      const first = await trigger();
      const s = summaryOf(first.out);
      expect(first.elapsed).toBeLessThanOrEqual(BUDGET + REPORT);
      expect(s).toMatchObject({ ok: false, timedOut: true, unknown: 1, accepted: 0, failed: 0, retryScheduled: 0 });
      expect(provider.requests, "nothing is sent before a frozen message exists").toHaveLength(0);
      // The report itself was bounded and was cancelled, not left running.
      expect(ops.alerts.map((a) => a.event)).toEqual(["lead_alert_recovery_failed"]);
      expect(ops.alerts[0].signal?.aborted).toBe(true);
      nothingLeftRunning();

      // The next trigger: the lease (if the call committed) has expired.
      delete db.stalls[fn];
      await vi.advanceTimersByTimeAsync(TRIGGER_EVERY_MS - first.elapsed);
      const second = await trigger();
      expect(summaryOf(second.out)).toMatchObject({ ok: true, accepted: 1, unknown: 0 });
      expect(db.alert("a1").status).toBe("accepted");
      expect(provider.delivered).toBe(1);
      nothingLeftRunning();
    });
  }

  it("settle held BEFORE its effect after an accepted send: unknown, then the same key REPLAYS -- delivered once", async () => {
    db.add("a1");
    db.stalls.settle_platform_lead_alert = "before";
    const first = await trigger();
    expect(first.elapsed).toBeLessThanOrEqual(BUDGET + REPORT);
    expect(summaryOf(first.out)).toMatchObject({ ok: false, timedOut: true, unknown: 1, accepted: 0, failed: 0 });
    expect(provider.delivered).toBe(1);
    expect(db.alert("a1").status).toBe("pending");
    nothingLeftRunning();

    delete db.stalls.settle_platform_lead_alert;
    await vi.advanceTimersByTimeAsync(TRIGGER_EVERY_MS - first.elapsed);
    const second = await trigger();
    expect(summaryOf(second.out)).toMatchObject({ ok: true, accepted: 1 });
    // Same key, same id: a replay, not a second email.
    expect(provider.requests.map((r) => r.key)).toEqual(["lead-alert/a1/1", "lead-alert/a1/1"]);
    expect(provider.delivered).toBe(1);
    expect(db.alert("a1")).toMatchObject({ status: "accepted", messageId: "email-1", attempts: 2 });
  });

  it("settle held AFTER its effect: unknown in this run, yet already settled -- the next trigger sends nothing", async () => {
    db.add("a1");
    db.stalls.settle_platform_lead_alert = "after";
    const first = await trigger();
    expect(summaryOf(first.out)).toMatchObject({ ok: false, timedOut: true, unknown: 1, accepted: 0 });
    nothingLeftRunning();

    delete db.stalls.settle_platform_lead_alert;
    await vi.advanceTimersByTimeAsync(TRIGGER_EVERY_MS - first.elapsed);
    const second = await trigger();
    expect(summaryOf(second.out)).toMatchObject({ ok: true, drained: true, attempted: 0 });
    expect(provider.requests).toHaveLength(1);
    expect(provider.delivered).toBe(1);
  });

  it("the settle keeps its reserve but is still bounded: a send that uses its whole window leaves the settle exactly the reserve", async () => {
    db.add("a1");
    provider.setMode("hang");
    db.stalls.settle_platform_lead_alert = "before";
    const first = await trigger();
    // Cancelled at the send deadline, then the settle at the deadline itself.
    expect(provider.requests[0].signal?.aborted).toBe(true);
    expect(first.elapsed).toBe(BUDGET + REPORT);
    expect(summaryOf(first.out)).toMatchObject({ ok: false, unknown: 1, accepted: 0, failed: 0, retryScheduled: 0 });
    nothingLeftRunning();
  });
});

describe("a timeout AFTER the provider accepted", () => {
  it("the request is cancelled at the send deadline, settled as a retry; the next trigger replays the same key -- delivered once", async () => {
    db.add("a1");
    provider.setMode("accept-then-hang");
    const first = await trigger();
    expect(first.elapsed).toBe(BUDGET - LEAD_ALERT_SETTLE_RESERVE_MS);
    expect(summaryOf(first.out)).toMatchObject({ ok: true, attempted: 1, retryScheduled: 1, accepted: 0, unknown: 0 });
    expect(provider.requests[0].signal?.aborted).toBe(true);
    expect(provider.delivered).toBe(1);
    // Ambiguous, never a provider refusal: the SDK's answer to an aborted
    // request ("application_error") must not be read as one.
    expect(db.settles).toEqual([expect.objectContaining({ p_outcome: "retry", p_error_code: "provider_timeout" })]);
    nothingLeftRunning();

    provider.setMode("ok");
    await vi.advanceTimersByTimeAsync(TRIGGER_EVERY_MS - first.elapsed);
    const second = await trigger();
    expect(summaryOf(second.out)).toMatchObject({ ok: true, accepted: 1 });
    expect(provider.requests.map((r) => r.key)).toEqual(["lead-alert/a1/1", "lead-alert/a1/1"]);
    expect(provider.delivered).toBe(1);
    expect(db.alert("a1")).toMatchObject({ status: "accepted", messageId: "email-1" });
  });
});

describe("an overlapping recovery", () => {
  it("a second trigger while the first is stalled cannot claim the leased alert; neither sends it twice", async () => {
    db.add("a1");
    db.stalls.settle_platform_lead_alert = "before";
    let firstOut: ReminderTriggerLeadAlertResult | undefined;
    const firstRun = recoverLeadAlertsOnReminderTrigger({ admin: db.client, transport: resend, env: ENV, appOrigin: () => "https://hone.example" })
      .then((r) => { firstOut = r; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.requests).toHaveLength(1);
    expect(firstOut).toBeUndefined();

    // Overlap: the same trigger fires again while the first is in its settle.
    const second = await trigger();
    expect(summaryOf(second.out)).toMatchObject({ ok: true, drained: true, attempted: 0 });
    expect(provider.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(BUDGET + REPORT);
    await firstRun;
    expect(summaryOf(firstOut!)).toMatchObject({ ok: false, unknown: 1 });
    nothingLeftRunning();

    // After the lease, one later trigger replays under the same key.
    delete db.stalls.settle_platform_lead_alert;
    await vi.advanceTimersByTimeAsync(LEAD_ALERT_LEASE_SECONDS * 1000);
    const third = await trigger();
    expect(summaryOf(third.out)).toMatchObject({ ok: true, accepted: 1 });
    expect(provider.delivered).toBe(1);
  });
});

describe("disabled configuration", () => {
  it("no database request, no provider request, no timer -- at once", async () => {
    db.add("a1");
    for (const env of [{}, { ADMIN_EMAILS: OPS }, { LEAD_ALERT_EMAIL: "not-an-admin@x.test", ADMIN_EMAILS: OPS }]) {
      const out = await recoverLeadAlertsOnReminderTrigger({ admin: db.client, transport: resend, env, appOrigin: () => "https://hone.example" });
      expect(out.ran).toBe(false);
    }
    expect(db.calls).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(ops.alerts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
