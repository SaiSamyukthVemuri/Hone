import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HON-13 (NOTIF-PREFS-01), matrix cells: 24h / 2h reminder email x
// send_24h_reminders / send_2h_reminders / send_intake_reminders, at SEND time.
//
// The SMS reminder pass refreshes the studio's switches immediately before
// dispatch ("STOP/consent/phone/switch changes made while the row was queued
// reach the real sender's gate"). The EMAIL pass decides from the snapshot the
// scan took at the start of the run and re-reads only the appointment's status
// and start. A studio that switches reminders off while a run is mid-batch
// still has the row's reminder emailed.
//
// Fake providers only: the email senders are spies; the database is a fixture.

const h = vi.hoisted(() => {
  const START = "2026-10-09T17:00:00.000Z";
  const state = {
    /** What the studio's switches are NOW, as opposed to at scan time. */
    live: { send_24h_reminders: true, send_2h_reminders: true, send_intake_reminders: false } as Record<string, boolean>,
    sent24: 0,
    sent2: 0,
    intakeOnly: 0,
    results: [] as boolean[],
    heartbeat: [] as Array<Record<string, unknown>>,
    intake: null as { id: string; status: string } | null,
  };
  // The scan snapshot: everything on.
  const APPT = {
    id: "00000000-0000-4000-8000-000000000001",
    studio_id: "studio-1",
    client_id: "client-1",
    status: "confirmed",
    starts_at: START,
    reminder_24h_send_attempts: 0,
    reminder_2h_send_attempts: 0,
    service: { name: "Consultation", default_duration_minutes: 30, pre_care_instructions: null },
    studio: {
      id: "studio-1",
      name: "Willow",
      timezone: "America/Vancouver",
      send_confirmation_sms: false,
      send_24h_sms_reminders: false,
      send_2h_sms_reminders: false,
      send_24h_reminders: true,
      send_2h_reminders: true,
      send_intake_reminders: false,
    },
    client: { name: "Client", email: "client@example.test", phone: null, sms_consent_at: null, sms_opted_out_at: null },
    practitioner: null,
  };

  type Filter = [op: string, column: string, value: unknown];
  function query(table: string) {
    const filters: Filter[] = [];
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "abortSignal", "update"]) b[m] = () => b;
    for (const op of ["eq", "is", "lt", "gte", "lte"]) {
      b[op] = (column: string, value: unknown) => {
        filters.push([op, column, value]);
        return b;
      };
    }
    b.maybeSingle = () =>
      Promise.resolve({
        data:
          table === "studios"
            ? { ...APPT.studio, ...state.live }
            : table === "client_intake_forms"
              ? state.intake
              : APPT,
        error: null,
      });
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const is24 = filters.some(([op, c]) => op === "is" && c === "reminder_24h_sent_at");
      return Promise.resolve({ data: table === "appointments" && is24 ? [APPT] : [], error: null }).then(resolve, reject);
    };
    return b;
  }
  const admin = { from: (table: string) => query(table), rpc: () => Promise.resolve({ data: null, error: null }) };
  return { state, admin };
});

vi.mock("@/lib/cron/reminder-scan-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cron/reminder-scan-coordinator")>();
  return { ...actual, createUpstashReminderScanCoordinator: () => ({
    acquire: async () => "offline-fixture", rotation: async () => ({ version: 1 as const, next: "email24h" as const, known: [] }),
    checkpoint: async () => null, renew: async () => true, save: async () => true, release: async () => undefined,
  }) };
});
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => h.admin }));
// 0247 compatibility: this suite drives the PRE-0247 (legacy claim) email path; the mode choice
// is proved in reminder-authority-dispatch.test.ts.
vi.mock("@/lib/email/reminder-authority-mode", () => ({ detectReminderAuthorityMode: async () => "legacy" }));
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({
  recordReminderRunSuccess: (x: Record<string, unknown>) => {
    h.state.heartbeat.push(x);
    return Promise.resolve();
  },
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: () => Promise.resolve() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));
vi.mock("@/lib/email/send-appointment", () => ({
  claimEmailSendOutcome: async () => "claimed",
  recordEmailResult: async (_a: unknown, _id: unknown, _t: unknown, ok: boolean) => {
    h.state.results.push(ok);
  },
  send24hReminderToClient: async () => {
    h.state.sent24 += 1;
    return { ok: true };
  },
  send2hReminderToClient: async () => {
    h.state.sent2 += 1;
    return { ok: true };
  },
  sendIntakeReminderToClient: async () => {
    h.state.intakeOnly += 1;
    return { ok: true };
  },
}));

import { GET } from "@/app/api/cron/appointment-reminders/route";

beforeEach(() => {
  vi.stubEnv("INTAKE_SIGNING_SECRET", "synthetic-intake-secret-for-tests-only-0123456789");
  vi.stubEnv("APPOINTMENT_SIGNING_SECRET", "synthetic-signing-secret-for-tests-only-0123456789");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T17:00:00.000Z"));
  h.state.live = { send_24h_reminders: true, send_2h_reminders: true, send_intake_reminders: false };
  h.state.sent24 = 0;
  h.state.sent2 = 0;
  h.state.intakeOnly = 0;
  h.state.results = [];
  h.state.heartbeat = [];
  h.state.intake = null;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run() {
  const res = await GET(new Request("https://hone.care/api/cron/appointment-reminders"));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, Record<string, number>>;
}

describe("HON-13: the 24h reminder email honours the switch as it is when the row is sent", () => {
  it("control: switch on at scan and at send, the reminder goes out", async () => {
    await run();
    expect(h.state.sent24).toBe(1);
  });

  it("switch turned OFF after the scan but before the send: no reminder email is sent", async () => {
    h.state.live.send_24h_reminders = false;
    await run();
    expect(h.state.sent24).toBe(0);
    expect(h.state.intakeOnly).toBe(0);
  });

  it("the refused row clears its claim without recording a send", async () => {
    h.state.live.send_24h_reminders = false;
    await run();
    // No success is ever recorded for an email that was not sent.
    expect(h.state.results).not.toContain(true);
  });

  // Codex P2 (1181): turning only the reminder off must not discard an intake
  // reminder that is still enabled and still needed.
  it("reminder OFF after the scan, intake reminders ON and incomplete: the standalone intake reminder goes out", async () => {
    h.state.live = { send_24h_reminders: false, send_2h_reminders: true, send_intake_reminders: true };
    h.state.intake = { id: "intake-1", status: "in_progress" };
    await run();
    expect(h.state.sent24).toBe(0);
    expect(h.state.intakeOnly).toBe(1);
    expect(h.state.results).toContain(true);
  });

  it("reminder OFF after the scan, intake ON but complete: nothing is sent and the claim is cleared", async () => {
    h.state.live = { send_24h_reminders: false, send_2h_reminders: true, send_intake_reminders: true };
    h.state.intake = { id: "intake-1", status: "submitted" };
    await run();
    expect(h.state.sent24 + h.state.intakeOnly).toBe(0);
    expect(h.state.results).not.toContain(true);
  });

  it("both OFF after the scan: nothing is sent", async () => {
    h.state.live = { send_24h_reminders: false, send_2h_reminders: true, send_intake_reminders: false };
    h.state.intake = { id: "intake-1", status: "in_progress" };
    await run();
    expect(h.state.sent24 + h.state.intakeOnly).toBe(0);
  });
});
