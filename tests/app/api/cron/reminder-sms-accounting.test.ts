import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// SMS-02 — the reminder cron's SMS ACCOUNTING, driven through the real route
// and the real send helper (Codex P2 4212849211).
//
// The route's stated semantics: `attempted` / `succeeded` / `failed` count
// actual provider requests, and anything that never reached Twilio is
// `skipped`. A reminder claim that cannot be reached (a database outage) makes
// no provider request and spends no attempt, so it must land in `skipped`,
// in both the response and the heartbeat. A real provider refusal is still
// an attempt that failed.
//
// Substituted: the database client, cron auth, the heartbeat writer, ops
// alerts and the network. Real: the route's passes, the consent gate, the
// fence, the reminder claim wrapper and the transport's classification.
// ===========================================================================

const h = vi.hoisted(() => {
  const START = "2026-10-09T17:00:00.000Z";
  const state = {
    claim: "error" as "error" | "claimed",
    rpcs: [] as string[],
    heartbeat: [] as Array<Record<string, unknown>>,
    alerts: [] as Array<Record<string, unknown>>,
  };
  const APPT = {
    id: "appt-1",
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
      // Off, so the pass makes no intake read: this file is about accounting.
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
  };

  type Filter = [op: string, column: string, value: unknown];
  function query(table: string) {
    const filters: Filter[] = [];
    const answer = () => {
      // Only the 24h SMS window has a row; every email window and the 2h SMS
      // window are empty.
      const sms24 = filters.some(([op, c]) => op === "is" && c === "sms_reminder_24h_sent_at");
      return { data: table === "appointments" && sms24 ? [APPT] : [], error: null };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    for (const op of ["eq", "is", "lt", "gte", "lte"]) {
      b[op] = (column: string, value: unknown) => {
        filters.push([op, column, value]);
        return b;
      };
    }
    // The pass's cheap "still confirmed?" pre-filter.
    b.maybeSingle = () => Promise.resolve({ data: { status: "confirmed" }, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject);
    return b;
  }

  const admin = {
    from: (table: string) => query(table),
    rpc: (fn: string) => {
      state.rpcs.push(fn);
      if (fn === "claim_reminder_sms_send") {
        return Promise.resolve(
          state.claim === "error"
            ? { data: null, error: { message: "connection refused" } }
            : { data: [{ result: "claimed", starts_at: START }], error: null },
        );
      }
      if (fn === "begin_appointment_sms_message") {
        return Promise.resolve({ data: "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10", error: null });
      }
      if (fn === "settle_sms_message") return Promise.resolve({ data: "settled", error: null });
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
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (x: Record<string, unknown>) => {
    h.state.alerts.push(x);
    return Promise.resolve();
  },
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));

import { GET } from "@/app/api/cron/appointment-reminders/route";

const ENV_KEYS = ["VERCEL_ENV", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  h.state.claim = "error";
  h.state.rpcs = [];
  h.state.heartbeat = [];
  h.state.alerts = [];
  fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ sid: `SM${"3c".repeat(16)}` }), { status: 201 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function run() {
  const res = await GET(new Request("https://hone.care/api/cron/appointment-reminders"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, Record<string, number>>;
  return { sms24: body.sms_reminder_24h!, heartbeat: h.state.heartbeat[0]! };
}

describe("the reminder cron counts provider requests, not database misses", () => {
  it("a reminder claim that cannot be reached is SKIPPED: no attempt, no failure, no provider call", async () => {
    h.state.claim = "error";
    const { sms24, heartbeat } = await run();
    expect(h.state.rpcs).toEqual(["claim_reminder_sms_send"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sms24).toEqual({ attempted: 0, succeeded: 0, failed: 0, skipped: 1, intakeCtaIncluded: 0 });
    expect(heartbeat).toMatchObject({ smsAttempted: 0, smsSucceeded: 0, smsFailed: 0 });
  });

  it("control: a claimed reminder that Twilio accepts is one attempt that succeeded", async () => {
    h.state.claim = "claimed";
    const { sms24, heartbeat } = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sms24).toEqual({ attempted: 1, succeeded: 1, failed: 0, skipped: 0, intakeCtaIncluded: 0 });
    expect(heartbeat).toMatchObject({ smsAttempted: 1, smsSucceeded: 1, smsFailed: 0 });
  });

  it("control: a real provider refusal is still an attempt that failed", async () => {
    h.state.claim = "claimed";
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ code: 21211 }), { status: 400 })),
    );
    const { sms24, heartbeat } = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sms24).toEqual({ attempted: 1, succeeded: 0, failed: 1, skipped: 0, intakeCtaIncluded: 0 });
    expect(heartbeat).toMatchObject({ smsAttempted: 1, smsFailed: 1 });
  });
});
