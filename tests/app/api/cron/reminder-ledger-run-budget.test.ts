import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// SMS-02 — ONE LEDGER BUDGET PER REMINDER-CRON RUN (Codex P1 4232680578),
// driven through the real route and the real send helper.
//
// The SMS ledger is best-effort bookkeeping, and the cron's two SMS passes
// send one reminder after another. A bound per ledger step alone is paid again
// for every reminder, so a stalled ledger would cost the run 5 s per reminder
// (500 s with both passes at PER_RUN_LIMIT) and a slow one about twice that.
// The run therefore holds ONE 5-second budget, shared by both SMS passes:
// every ledger step waits at most what is left and is charged its wait, a step
// that runs out of time spends the rest, and once it is spent no further
// ledger request is started. Every reminder is still claimed, sent and
// recorded, record before settle; only its ledger row is lost.
//
// Real: the route's passes, the send helper, the consent gate, the fence, the
// reminder claim wrapper and the transport. Substituted: the database, cron
// auth, the heartbeat writer, ops alerts and the network.
// ===========================================================================

/** The budget under test: five seconds of cumulative ledger wait per run. */
const RUN_BUDGET_MS = 5_000;
const TICK_MS = 100;

const h = vi.hoisted(() => {
  const START = "2026-10-09T17:00:00.000Z";
  /** How long a ledger call takes to answer: milliseconds, or "hang" (never). */
  type Delay = number | "hang";
  const state = {
    /** Rows each SMS window returns. The email windows stay empty. */
    rows: { "24h": 2, "2h": 2 } as Record<"24h" | "2h", number>,
    /** Per call, by its index across the whole run. */
    beginDelay: (() => 0) as (call: number) => Delay,
    settleDelay: (() => 0) as (call: number) => Delay,
    calls: { begin: 0, settle: 0 },
    rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    heartbeat: [] as Array<Record<string, unknown>>,
  };
  const appt = (id: string) => ({
    id,
    studio_id: "studio-1",
    client_id: "client-1",
    status: "confirmed",
    starts_at: START,
    service: { name: "Consultation", default_duration_minutes: 30, pre_care_instructions: null },
    studio: {
      id: "studio-1",
      name: "Willow",
      timezone: "America/Vancouver",
      send_confirmation_sms: false,
      send_24h_sms_reminders: true,
      send_2h_sms_reminders: true,
      // Off, so the passes make no intake read: this file is about the ledger.
      send_intake_reminders: false,
    },
    client: {
      name: "Client",
      email: null,
      phone: "604-555-0199",
      sms_consent_at: "2026-09-01T00:00:00Z",
      sms_opted_out_at: null,
    },
    practitioner: null,
  });

  type Filter = [op: string, column: string, value: unknown];
  function query(table: string) {
    const filters: Filter[] = [];
    const answer = () => {
      const kind = filters.some(([op, c]) => op === "is" && c === "sms_reminder_24h_sent_at")
        ? "24h"
        : filters.some(([op, c]) => op === "is" && c === "sms_reminder_2h_sent_at")
          ? "2h"
          : null;
      if (table !== "appointments" || !kind) return { data: [], error: null };
      const tag = kind === "24h" ? "a24" : "a2";
      return { data: Array.from({ length: state.rows[kind] }, (_, i) => appt(`${tag}-${i + 1}`)), error: null };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    for (const op of ["eq", "is", "lt", "gte", "lte"]) {
      b[op] = (column: string, value: unknown) => {
        filters.push([op, column, value]);
        return b;
      };
    }
    b.maybeSingle = () => Promise.resolve({ data: { status: "confirmed" }, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject);
    return b;
  }

  function after<T>(delay: Delay, value: T): Promise<T> {
    if (delay === "hang") return new Promise(() => undefined);
    if (delay === 0) return Promise.resolve(value);
    return new Promise((r) => setTimeout(() => r(value), delay));
  }

  const admin = {
    from: (table: string) => query(table),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      if (fn === "claim_reminder_sms_send") {
        return Promise.resolve({ data: [{ result: "claimed", starts_at: START }], error: null });
      }
      if (fn === "begin_appointment_sms_message") {
        const call = state.calls.begin++;
        // A well-formed row id (the ledger accepts only a uuid), one per call.
        const row = `0b8f1c1e-6a52-4c0e-9f3e-${(call + 1).toString(16).padStart(12, "0")}`;
        return after(state.beginDelay(call), { data: row, error: null });
      }
      if (fn === "settle_sms_message") {
        const delay = state.settleDelay(state.calls.settle++);
        return after(delay, { data: "settled", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { state, admin };
});

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({
  recordReminderRunSuccess: (x: Record<string, unknown>) => {
    h.state.heartbeat.push(x);
    return Promise.resolve();
  },
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: () => Promise.resolve() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));

import { GET } from "@/app/api/cron/appointment-reminders/route";
import { LEDGER_RUN_BUDGET_MS, LEDGER_STEP_BOUND_MS } from "@/lib/sms/send-appointment";

const ENV_KEYS = [
  "VERCEL_ENV",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_WEBHOOK_BASE_URL",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://hone.care";
  h.state.rows = { "24h": 2, "2h": 2 };
  h.state.beginDelay = () => 0;
  h.state.settleDelay = () => 0;
  h.state.calls = { begin: 0, settle: 0 };
  h.state.rpcs = [];
  h.state.heartbeat = [];
  fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ sid: `SM${"3c".repeat(16)}` }), { status: 201 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const fns = (fn: string) => h.state.rpcs.filter((r) => r.fn === fn);
const statusCallbacks = () =>
  fetchMock.mock.calls.map(([, init]) => new URLSearchParams(String((init as { body?: unknown }).body)).has("StatusCallback"));

/** Run the route on fake time; report the time it needed. */
async function runTimed(capMs = 300_000) {
  vi.useFakeTimers();
  let done = false;
  const pending = GET(new Request("https://hone.care/api/cron/appointment-reminders")).then((r) => {
    done = true;
    return r;
  });
  let elapsedMs = 0;
  while (!done && elapsedMs < capMs) {
    await vi.advanceTimersByTimeAsync(TICK_MS);
    elapsedMs += TICK_MS;
  }
  expect(done, "the run never finished").toBe(true);
  const res = await pending;
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, Record<string, number>>;
  return { elapsedMs, body };
}

describe("the reminder cron holds ONE five-second ledger budget per run", () => {
  it("the budget is the five seconds this file drives", () => {
    expect(LEDGER_RUN_BUDGET_MS).toBe(RUN_BUDGET_MS);
  });

  it("a ledger that never answers costs the WHOLE run one budget, then no further ledger request", async () => {
    h.state.beginDelay = () => "hang";
    const { elapsedMs, body } = await runTimed();
    // Every reminder in BOTH passes is still sent and recorded.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fns("record_sms_result")).toHaveLength(4);
    expect(body.sms_reminder_24h).toMatchObject({ attempted: 2, succeeded: 2, failed: 0 });
    expect(body.sms_reminder_2h).toMatchObject({ attempted: 2, succeeded: 2, failed: 0 });
    expect(h.state.heartbeat).toHaveLength(1);
    // Paid ONCE per run, not once per reminder.
    expect(elapsedMs, "ledger wait paid per reminder, not per run").toBeLessThanOrEqual(RUN_BUDGET_MS + TICK_MS);
    expect(fns("begin_appointment_sms_message"), "ledger requests kept being started").toHaveLength(1);
    expect(fns("settle_sms_message")).toHaveLength(0);
    expect(statusCallbacks()).toEqual([false, false, false, false]);
  });

  it("a SLOW ledger (each step answering just inside its bound) is capped by the same budget", async () => {
    h.state.rows = { "24h": 3, "2h": 3 };
    h.state.beginDelay = () => LEDGER_STEP_BOUND_MS - 1;
    h.state.settleDelay = () => LEDGER_STEP_BOUND_MS - 1;
    const { elapsedMs } = await runTimed();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fns("record_sms_result")).toHaveLength(6);
    expect(h.state.heartbeat).toHaveLength(1);
    expect(elapsedMs, "cumulative ledger wait exceeded the run's budget").toBeLessThanOrEqual(
      RUN_BUDGET_MS + 2 * TICK_MS,
    );
  });

  it("BOTH passes draw on the same budget: what the 24h pass spends, the 2h pass cannot", async () => {
    // One reminder per pass, each ledger step answering after 2 s. The 24h
    // reminder's row and settle spend 4 s; the 2h reminder's row then has 1 s
    // left, runs out, and spends the rest. Per-pass budgets would take 8 s.
    h.state.rows = { "24h": 1, "2h": 1 };
    h.state.beginDelay = () => 2_000;
    h.state.settleDelay = () => 2_000;
    const { elapsedMs } = await runTimed();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fns("record_sms_result")).toHaveLength(2);
    expect(elapsedMs).toBeLessThanOrEqual(RUN_BUDGET_MS + TICK_MS);
    expect(fns("begin_appointment_sms_message").map((r) => r.args.p_purpose)).toEqual([
      "appointment_reminder_24h",
      "appointment_reminder_2h",
    ]);
    expect(fns("settle_sms_message"), "only the 24h reminder's row came back in time").toHaveLength(1);
    expect(statusCallbacks()).toEqual([true, false]);
  });
});

describe("a ledger answer that arrives LATE changes nothing", () => {
  it("a row that comes back after its step ran out of time: never settled, and no request after it", async () => {
    h.state.beginDelay = (i) => (i === 0 ? LEDGER_STEP_BOUND_MS + 2_000 : 0);
    const { elapsedMs } = await runTimed();
    expect(elapsedMs).toBeLessThanOrEqual(RUN_BUDGET_MS + TICK_MS);
    const before = h.state.rpcs.length;
    await vi.advanceTimersByTimeAsync(3_000); // the late row lands now
    expect(h.state.rpcs.length, "the late answer started a request").toBe(before);
    expect(fns("begin_appointment_sms_message")).toHaveLength(1);
    expect(fns("settle_sms_message")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fns("record_sms_result")).toHaveLength(4);
    expect(statusCallbacks()).toEqual([false, false, false, false]);
  });

  it("a settle that answers late: the reminder was recorded first, and the run moves on without the ledger", async () => {
    h.state.settleDelay = (i) => (i === 0 ? LEDGER_STEP_BOUND_MS + 2_000 : 0);
    const { elapsedMs } = await runTimed();
    expect(elapsedMs).toBeLessThanOrEqual(RUN_BUDGET_MS + TICK_MS);
    const before = h.state.rpcs.length;
    await vi.advanceTimersByTimeAsync(3_000); // the late settle lands now
    expect(h.state.rpcs.length).toBe(before);
    const order = h.state.rpcs.map((r) => r.fn);
    expect(order.indexOf("record_sms_result"), "record before settle").toBeLessThan(order.indexOf("settle_sms_message"));
    expect(fns("begin_appointment_sms_message")).toHaveLength(1);
    expect(fns("settle_sms_message")).toHaveLength(1);
    expect(fns("record_sms_result")).toHaveLength(4);
    expect(h.state.heartbeat).toHaveLength(1);
  });
});

describe("controls: a healthy ledger is untouched", () => {
  it("every reminder in both passes gets its row and its settle", async () => {
    h.state.rows = { "24h": 3, "2h": 3 };
    await runTimed();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fns("begin_appointment_sms_message")).toHaveLength(6);
    expect(fns("settle_sms_message")).toHaveLength(6);
    expect(statusCallbacks().every(Boolean)).toBe(true);
  });

  it("a full run (both passes at 50) with 20 ms ledger answers is ledgered end to end", async () => {
    h.state.rows = { "24h": 50, "2h": 50 };
    h.state.beginDelay = () => 20;
    h.state.settleDelay = () => 20;
    await runTimed();
    expect(fetchMock).toHaveBeenCalledTimes(100);
    expect(fns("begin_appointment_sms_message")).toHaveLength(100);
    expect(fns("settle_sms_message")).toHaveLength(100);
  });

  it("the budget belongs to ONE run: the next run ledgers again", async () => {
    h.state.beginDelay = () => "hang";
    await runTimed();
    vi.useRealTimers();
    h.state.beginDelay = () => 0;
    h.state.rpcs = [];
    fetchMock.mockClear();
    await runTimed();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fns("begin_appointment_sms_message")).toHaveLength(4);
    expect(fns("settle_sms_message")).toHaveLength(4);
  });
});
