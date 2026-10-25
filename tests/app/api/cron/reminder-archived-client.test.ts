import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// MSG-ARCH-01 - the reminder cron must not message an ARCHIVED client.
//
// Archival hides a client from the active directory, the portal and public
// booking; it does not cancel their booked visits, and the cron selected those
// visits without ever reading clients.archived_at. So an archived client was
// still emailed and texted.
//
// Criterion: no automatic client message (email or SMS) is sent to a client who
// is archived at SEND time, including one archived after the job discovered or
// claimed the row. An archived client is never recorded as sent, and a claim
// already taken is released through the existing record-a-failure path (the
// CASE 4 -> 5 accounting). Consent, STOP and suppression are unchanged.
//
// Driven through the REAL route and the REAL SMS helper and consent gate.
// Substituted: the database (a small engine that answers embedded client
// columns exactly as the select string asks for them), the email provider
// (a recording fake), Twilio (a fetch fake), cron auth, heartbeat and alerts.
// The mock honors whatever columns a query names, so it does not prescribe how
// the repair reads the flag.
// ===========================================================================

const h = vi.hoisted(() => {
  const START = "2026-10-09T17:00:00.000Z";
  type ClientRow = {
    name: string;
    email: string | null;
    phone: string | null;
    sms_consent_at: string | null;
    sms_opted_out_at: string | null;
    archived_at: string | null;
  };
  const freshClient = (): ClientRow => ({
    name: "Client",
    email: "client@example.test",
    phone: "604-555-0199",
    sms_consent_at: "2026-09-01T00:00:00Z",
    sms_opted_out_at: null,
    archived_at: null,
  });
  const state = {
    client: freshClient(),
    /** Runs once, at the first read AFTER discovery (the post-discovery pre-filter / refresh). */
    archiveAfterDiscovery: false,
    /** Runs when the email claim is taken, i.e. strictly after the claim. */
    archiveAfterClaim: false,
    discovered: false,
    emailSent: new Set<string>(),
    smsSentAt: new Set<string>(),
    emailSends: [] as string[],
    emailClaims: [] as string[],
    emailReleases: [] as Array<{ id: string; ok: boolean }>,
    emailResults: [] as Array<{ id: string; ok: boolean }>,
    rpcs: [] as string[],
    freshClient,
  };
  const APPT = {
    id: "00000000-0000-4000-8000-000000000001",
    studio_id: "studio-1",
    client_id: "client-1",
    status: "confirmed",
    starts_at: START,
    reminder_24h_send_attempts: 0,
    reminder_2h_send_attempts: 0,
    sms_reminder_24h_send_attempts: 0,
    sms_reminder_2h_send_attempts: 0,
    service: { name: "Consultation", default_duration_minutes: 30, pre_care_instructions: null },
    studio: {
      id: "studio-1",
      name: "Willow",
      timezone: "America/Vancouver",
      send_confirmation_sms: false,
      send_24h_reminders: true,
      send_2h_reminders: false,
      send_24h_sms_reminders: true,
      send_2h_sms_reminders: false,
      send_intake_reminders: false,
      show_treatment_time_to_clients: false,
    },
    practitioner: null,
  };

  /** Embedded `client:clients(a, b, c)` columns, as the select string names them. */
  function embeddedClient(select: string) {
    const m = /client:clients\(([^)]*)\)/.exec(select);
    if (!m) return undefined;
    const cols = m[1]!.split(",").map((c) => c.trim()).filter(Boolean);
    const out: Record<string, unknown> = {};
    for (const c of cols) out[c] = (state.client as Record<string, unknown>)[c];
    return out;
  }

  type Filter = [op: string, column: string, value: unknown];
  function query(table: string) {
    const filters: Filter[] = [];
    let select = "";
    const hasIs = (col: string) => filters.some(([op, c]) => op === "is" && c === col);
    const answer = () => {
      if (table !== "appointments") return { data: [], error: null };
      const wants =
        hasIs("reminder_24h_sent_at") ? "email24" : hasIs("sms_reminder_24h_sent_at") ? "sms24" : null;
      if (!wants) return { data: [], error: null };
      const already = wants === "email24" ? state.emailSent.has(APPT.id) : state.smsSentAt.has(APPT.id);
      if (already) return { data: [], error: null };
      state.discovered = true;
      const cl = embeddedClient(select);
      return { data: [{ ...APPT, ...(cl ? { client: cl } : {}) }], error: null };
    };
    const b: Record<string, unknown> = {};
    b.select = (s: string) => {
      select = s;
      return b;
    };
    for (const m of ["order", "limit", "abortSignal", "or"]) b[m] = () => b;
    for (const op of ["eq", "is", "lt", "gte", "lte"]) {
      b[op] = (column: string, value: unknown) => {
        filters.push([op, column, value]);
        return b;
      };
    }
    b.maybeSingle = () => {
      // A read made after discovery, by id: this is where an archive lands
      // "after discovery, before send".
      if (state.discovered && state.archiveAfterDiscovery) {
        state.client.archived_at = "2026-10-09T12:00:00Z";
        state.archiveAfterDiscovery = false;
      }
      if (table === "clients") {
        const cols = select.split(",").map((c) => c.trim()).filter(Boolean);
        const row: Record<string, unknown> = {};
        for (const c of cols) row[c] = (state.client as Record<string, unknown>)[c];
        return Promise.resolve({ data: row, error: null });
      }
      const cl = embeddedClient(select);
      return Promise.resolve({
        data: {
          status: APPT.status,
          starts_at: APPT.starts_at,
          client_id: APPT.client_id,
          studio: {
            send_24h_sms_reminders: APPT.studio.send_24h_sms_reminders,
            send_2h_sms_reminders: APPT.studio.send_2h_sms_reminders,
          },
          ...(cl ? { client: cl } : {}),
        },
        error: null,
      });
    };
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject);
    return b;
  }

  const admin = {
    from: (table: string) => query(table),
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcs.push(fn);
      if (fn === "claim_reminder_sms_send") {
        return Promise.resolve({ data: [{ result: "claimed", starts_at: START }], error: null });
      }
      if (fn === "begin_appointment_sms_message") {
        return Promise.resolve({ data: "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10", error: null });
      }
      if (fn === "settle_sms_message") {
        state.smsSentAt.add(APPT.id);
        return Promise.resolve({ data: "settled", error: null });
      }
      void args;
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { state, admin, APPT };
});

vi.mock("@/lib/cron/reminder-scan-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cron/reminder-scan-coordinator")>();
  return { ...actual, createUpstashReminderScanCoordinator: () => ({
    acquire: async () => "offline-fixture", rotation: async () => ({ version: 1 as const, next: "email24h" as const, known: [] }),
    checkpoint: async () => null, renew: async () => true, save: async () => true, release: async () => undefined,
  }) };
});
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({ recordReminderRunSuccess: () => Promise.resolve() }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: () => Promise.resolve() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));
vi.mock("@/lib/email/send-appointment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send-appointment")>();
  return {
    ...actual,
    // The claim is the only gate the real function adds; model it as a set.
    claimEmailSendOutcome: async (_a: unknown, id: string) => {
      if (h.state.emailClaims.includes(id)) return "lost";
      h.state.emailClaims.push(id);
      if (h.state.archiveAfterClaim) h.state.client.archived_at = "2026-10-09T12:00:00Z";
      return "claimed";
    },
    recordEmailResult: async (_a: unknown, id: string, _t: string, ok: boolean) => {
      h.state.emailResults.push({ id, ok });
      // The real function clears the claim; success also stamps sent_at.
      h.state.emailClaims = h.state.emailClaims.filter((c) => c !== id);
      if (ok) h.state.emailSent.add(id);
      else h.state.emailReleases.push({ id, ok });
    },
    send24hReminderToClient: async (p: { clientEmail: string }) => {
      h.state.emailSends.push(p.clientEmail);
      return { ok: true };
    },
    send2hReminderToClient: async (p: { clientEmail: string }) => {
      h.state.emailSends.push(p.clientEmail);
      return { ok: true };
    },
  };
});

import { GET } from "@/app/api/cron/appointment-reminders/route";

const ENV_KEYS = ["APPOINTMENT_SIGNING_SECRET", "VERCEL_ENV", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "NEXT_PUBLIC_APP_URL"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T17:00:00.000Z"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  process.env.APPOINTMENT_SIGNING_SECRET = "s".repeat(48);
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  const s = h.state;
  s.client = s.freshClient();
  s.archiveAfterDiscovery = false;
  s.archiveAfterClaim = false;
  s.discovered = false;
  s.emailSent = new Set();
  s.smsSentAt = new Set();
  s.emailSends = [];
  s.emailClaims = [];
  s.emailReleases = [];
  s.emailResults = [];
  s.rpcs = [];
  fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ sid: `SM${"3c".repeat(16)}` }), { status: 201 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

async function run() {
  const res = await GET(new Request("https://hone.care/api/cron/appointment-reminders"));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, Record<string, number>>;
}

describe("control: an unarchived client is reminded by email and SMS", () => {
  it("one email and one SMS go out", async () => {
    const body = await run();
    expect(h.state.emailSends).toEqual(["client@example.test"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.reminder_24h).toMatchObject({ succeeded: 1 });
    expect(body.sms_reminder_24h).toMatchObject({ succeeded: 1 });
  });
});

describe("an archived client is not messaged (archived before discovery)", () => {
  it("no email, no SMS, never recorded as sent, no claim left behind", async () => {
    h.state.client.archived_at = "2026-10-01T00:00:00Z";
    await run();
    expect(h.state.emailSends).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.state.emailSent.size).toBe(0);
    expect(h.state.smsSentAt.size).toBe(0);
    expect(h.state.emailClaims).toEqual([]);
    expect(h.state.rpcs).not.toContain("settle_sms_message");
  });
});

describe("a client archived AFTER discovery and before send is not messaged", () => {
  it("SMS: archived between discovery and the pre-dispatch refresh", async () => {
    h.state.archiveAfterDiscovery = true;
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.state.smsSentAt.size).toBe(0);
  });

  it("email: archived after the claim is taken; the claim is released as a failure, never a send", async () => {
    h.state.archiveAfterClaim = true;
    await run();
    expect(h.state.emailSends).toEqual([]);
    expect(h.state.emailSent.size).toBe(0);
    // Released through the existing accounting: recorded as NOT sent.
    expect(h.state.emailResults).toEqual([{ id: h.APPT.id, ok: false }]);
    expect(h.state.emailClaims).toEqual([]);
  });
});

describe("retry safety", () => {
  it("running the cron again after an archived refusal sends nothing", async () => {
    h.state.client.archived_at = "2026-10-01T00:00:00Z";
    await run();
    await run();
    expect(h.state.emailSends).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unarchived client is sent exactly once across two runs", async () => {
    await run();
    await run();
    expect(h.state.emailSends).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a client unarchived after a refusal is sent on the next run (the refusal burned nothing permanent)", async () => {
    h.state.client.archived_at = "2026-10-01T00:00:00Z";
    await run();
    expect(h.state.emailSends).toEqual([]);
    h.state.client.archived_at = null;
    await run();
    expect(h.state.emailSends).toEqual(["client@example.test"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("consent, STOP and suppression are unchanged (archived or not)", () => {
  it("SMS consent never given: no SMS", async () => {
    h.state.client.sms_consent_at = null;
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("STOPped client: no SMS", async () => {
    h.state.client.sms_opted_out_at = "2026-09-20T00:00:00Z";
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("STOPped client: the email reminder is unaffected (STOP is an SMS channel control)", async () => {
    h.state.client.sms_opted_out_at = "2026-09-20T00:00:00Z";
    await run();
    expect(h.state.emailSends).toEqual(["client@example.test"]);
  });

  it("a client with no email gets no email", async () => {
    h.state.client.email = null;
    await run();
    expect(h.state.emailSends).toEqual([]);
  });
});
