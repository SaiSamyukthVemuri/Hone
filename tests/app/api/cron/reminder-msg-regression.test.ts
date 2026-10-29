import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MSG-REMINDER-REGRESSION: behavioural cases for MSG-001/004/005/006 criteria
// that previously had only a source-text pin, exercised through the real cron
// route. Synthetic rows, fake provider seams, no database and no network.
//
// The fake candidate query HONOURS the route's filters (status, not-sent,
// attempt cap, window, keyset), and the fake claim/record seams mutate the
// row the way claim_email_send / record_email_result do, so the attempt cap
// is proved by behaviour across fires rather than by reading the source.

type Row = {
  id: string;
  studio_id: string;
  client_id: string;
  status: string;
  starts_at: string;
  reminder_24h_sent_at: string | null;
  reminder_2h_sent_at: string | null;
  sms_reminder_24h_sent_at: string | null;
  sms_reminder_2h_sent_at: string | null;
  reminder_24h_send_attempts: number;
  reminder_2h_send_attempts: number;
  sms_reminder_24h_send_attempts: number;
  sms_reminder_2h_send_attempts: number;
};
type Filters = { eq: Array<[string, unknown]>; is: Array<[string, unknown]>; lt: Array<[string, number]>; gte: Array<[string, string]>; lte: Array<[string, string]> };

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  emailOn: true,
  smsOn: false,
  // Statuses returned by successive single-row appointment reads, per id.
  // Empty means "the row's own status".
  statusReads: new Map<string, string[]>(),
  candidateQueries: [] as Filters[],
  store: new Map<string, { value: string; expiry: number }>(),
  send: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string; retryable?: boolean }),
  smsSend: vi.fn(async () => ({ ok: true, intakeLinkIncluded: false }) as Record<string, unknown>),
  claim: vi.fn(),
  record: vi.fn(),
  alerts: vi.fn(async () => undefined),
  heartbeat: vi.fn(async () => undefined),
}));

vi.mock("@/lib/cron/reminder-scan-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cron/reminder-scan-coordinator")>();
  const get = (key: string) => {
    const entry = h.store.get(key);
    if (entry && entry.expiry <= Date.now()) { h.store.delete(key); return null; }
    return entry?.value ?? null;
  };
  return { ...actual, createUpstashReminderScanCoordinator: () => actual.createReminderScanCoordinator({
    async set(key, value, opts) {
      if (get(key)) return null;
      h.store.set(key, { value, expiry: Date.now() + opts.ex * 1000 }); return "OK";
    },
    async eval(script, keys, args) {
      if (script.includes("return {0,''}")) return get(keys[0]) === args[0] ? [1, get(keys[1]) ?? ""] : [0, ""];
      if (get(keys[0]) !== args[0]) return 0;
      if (script.includes("pexpireat")) {
        if (Number(args[2]) <= Date.now()) return 0;
        h.store.set(keys[1], { value: String(args[1]), expiry: Number(args[2]) });
        h.store.set(keys[2], { value: String(args[3]), expiry: Date.now() + Number(args[4]) * 1000 });
        h.store.set(keys[0], { value: String(args[0]), expiry: Date.now() + Number(args[5]) * 1000 }); return 1;
      }
      if (script.includes("'del'")) { h.store.delete(keys[0]); return 1; }
      h.store.set(keys[0], { value: String(args[0]), expiry: Date.now() + Number(args[1]) * 1000 }); return 1;
    },
  }) };
});
// 0247 compatibility: these suites drive the PRE-0247 (legacy claim) email path. The
// operation-authority path and the mode choice are proved in reminder-authority-dispatch.test.ts.
vi.mock("@/lib/email/reminder-authority-mode", () => ({ detectReminderAuthorityMode: async () => "legacy" }));
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://example.invalid" }));
vi.mock("@/lib/intake/queries", () => ({ generateIntakeLinkUrl: () => "https://example.invalid/intake/synthetic", stampIntakeLinkIssued: async () => undefined }));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "synthetic-token" }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({ recordReminderRunSuccess: h.heartbeat }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: h.alerts }));
vi.mock("@/lib/email/send-appointment", () => ({
  claimEmailSendOutcome: h.claim,
  recordEmailResult: h.record,
  logEmailFailure: vi.fn(),
  send24hReminderToClient: h.send,
  send2hReminderToClient: h.send,
  sendIntakeReminderToClient: h.send,
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  createLedgerBudget: () => ({}),
  send24hReminderSmsToClient: h.smsSend,
  send2hReminderSmsToClient: h.smsSend,
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const f: Filters = { eq: [], is: [], lt: [], gte: [], lte: [] };
      let selected = "";
      let cursor: string | null = null;
      let limit = 50;
      const joined = (r: Row, status = r.status) => ({
        ...r, status,
        studio: { id: r.studio_id, name: "Synthetic", timezone: "UTC", send_intake_reminders: false,
          show_treatment_time_to_clients: false,
          send_24h_reminders: h.emailOn, send_2h_reminders: h.emailOn,
          send_24h_sms_reminders: h.smsOn, send_2h_sms_reminders: h.smsOn },
        client: { name: "Synthetic", email: "synthetic@example.invalid", phone: "+15555550123",
          sms_consent_at: "2026-10-01T00:00:00Z", sms_opted_out_at: null },
        service: null, practitioner: null,
      });
      const b = {
        select: (s: string) => { selected = s; return b; },
        eq: (c: string, v: unknown) => { f.eq.push([c, v]); return b; },
        is: (c: string, v: unknown) => { f.is.push([c, v]); return b; },
        lt: (c: string, v: number) => { f.lt.push([c, v]); return b; },
        gte: (c: string, v: string) => { f.gte.push([c, v]); return b; },
        lte: (c: string, v: string) => { f.lte.push([c, v]); return b; },
        order: () => b,
        abortSignal: () => b,
        limit: (n: number) => { limit = n; return b; },
        or: (filter: string) => {
          const match = filter.match(/id\.gt\.("[^"]+")/);
          if (!match) throw new Error("Expected keyset tie-breaker");
          cursor = JSON.parse(match[1]);
          return b;
        },
        maybeSingle: async () => {
          if (table !== "appointments") return { data: null, error: null };
          const id = f.eq.find(([c]) => c === "id")?.[1];
          const r = h.rows.find((x) => x.id === id);
          if (!r) return { data: null, error: null };
          const next = h.statusReads.get(r.id)?.shift();
          return { data: joined(r, next ?? r.status), error: null };
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table !== "appointments" || !selected.startsWith("*")) throw new Error(`Unexpected list read on ${table}`);
          h.candidateQueries.push(f);
          const t = (iso: string) => Date.parse(iso);
          const data = h.rows
            .filter((r) => f.eq.every(([c, v]) => (r as Record<string, unknown>)[c] === v))
            .filter((r) => f.is.every(([c, v]) => (r as Record<string, unknown>)[c] === v))
            .filter((r) => f.lt.every(([c, v]) => ((r as Record<string, unknown>)[c] as number) < v))
            .filter((r) => f.gte.every(([, v]) => t(r.starts_at) >= t(v)))
            .filter((r) => f.lte.every(([, v]) => t(r.starts_at) <= t(v)))
            .filter((r) => !cursor || r.id > cursor)
            .slice(0, limit)
            .map((r) => joined(r));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return b;
    },
  }),
}));

import { GET } from "@/app/api/cron/appointment-reminders/route";

const BASE = Date.parse("2026-10-21T12:00:00.000Z");
const ID = "00000000-0000-4000-8000-000000000001";
const ATTEMPT_COLUMN = { reminder_24h: "reminder_24h_send_attempts", reminder_2h: "reminder_2h_send_attempts" } as const;
const SENT_COLUMN = { reminder_24h: "reminder_24h_sent_at", reminder_2h: "reminder_2h_sent_at" } as const;

function seedRow(over: Partial<Row> = {}): Row {
  const r: Row = {
    id: ID, studio_id: "synthetic-studio", client_id: "synthetic-client", status: "confirmed",
    starts_at: new Date(BASE + 24 * 60 * 60_000).toISOString(),
    reminder_24h_sent_at: null, reminder_2h_sent_at: null,
    sms_reminder_24h_sent_at: null, sms_reminder_2h_sent_at: null,
    reminder_24h_send_attempts: 0, reminder_2h_send_attempts: 0,
    sms_reminder_24h_send_attempts: 0, sms_reminder_2h_send_attempts: 0,
    ...over,
  };
  h.rows.push(r);
  return r;
}

async function fire(): Promise<{ status: number; body: Record<string, { attempted: number; succeeded: number; failed: number; skipped: number }> }> {
  const response = await GET(new Request("https://example.invalid"));
  return { status: response.status, body: await response.json() };
}

const exhaustionAlerts = () =>
  h.alerts.mock.calls.filter((c) => (c as unknown as [{ event: string }])[0].event === "reminder_send_exhausted");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE));
  h.rows = []; h.emailOn = true; h.smsOn = false; h.statusReads.clear(); h.candidateQueries = [];
  h.store.clear();
  h.store.set("reminder_scan:v1:rotation", { value: JSON.stringify({ version: 1, next: "email24h", known: [] }), expiry: Date.now() + 10_800_000 });
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.smsSend.mockReset().mockResolvedValue({ ok: true, intakeLinkIncluded: false });
  // claim_email_send (0080): atomic attempt increment, refused once sent.
  h.claim.mockReset().mockImplementation(async (_admin: unknown, id: string, type: keyof typeof ATTEMPT_COLUMN) => {
    const r = h.rows.find((x) => x.id === id);
    if (!r || r[SENT_COLUMN[type]] !== null) return "not_claimed";
    r[ATTEMPT_COLUMN[type]] += 1;
    return "claimed";
  });
  // record_email_result: success stamps sent_at; failure only clears the claim.
  h.record.mockReset().mockImplementation(async (_admin: unknown, id: string, type: keyof typeof SENT_COLUMN, ok: boolean) => {
    const r = h.rows.find((x) => x.id === id);
    if (r && ok) r[SENT_COLUMN[type]] = new Date().toISOString();
  });
  h.alerts.mockReset().mockResolvedValue(undefined);
  h.heartbeat.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe("MSG-006: an exhausted email reminder raises an ops alert (route behaviour)", () => {
  it.each([0, 1])("a failing attempt %i+1 below the cap records unsent and raises no exhaustion alert", async (prior) => {
    seedRow({ reminder_24h_send_attempts: prior });
    h.send.mockResolvedValue({ ok: false, error: "synthetic refusal", retryable: true });
    const { body } = await fire();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(expect.anything(), ID, "reminder_24h", false);
    expect(body.reminder_24h).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(exhaustionAlerts()).toHaveLength(0);
  });

  it("the third failing attempt raises exactly one reminder_send_exhausted alert with safe metadata only", async () => {
    seedRow({ reminder_24h_send_attempts: 2 });
    h.send.mockResolvedValue({ ok: false, error: "synthetic refusal", retryable: true });
    await fire();
    const alerts = exhaustionAlerts();
    expect(alerts).toHaveLength(1);
    const alert = (alerts[0] as unknown as [Record<string, unknown>])[0];
    expect(alert).toMatchObject({
      event: "reminder_send_exhausted",
      appointmentId: ID,
      safeDetails: { reminder_type: "reminder_24h", attempt_count: 3, retryable: true, reason: "send_failed", intake_cta_included: false },
    });
    const text = JSON.stringify(alert);
    for (const secret of ["synthetic@example.invalid", "+15555550123", "synthetic-token", "synthetic refusal"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a third attempt that succeeds raises no exhaustion alert", async () => {
    seedRow({ reminder_24h_send_attempts: 2 });
    const { body } = await fire();
    expect(body.reminder_24h).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(exhaustionAlerts()).toHaveLength(0);
  });
});

describe("retries are bounded by the three-attempt cap", () => {
  it("every candidate query, in all four passes, filters confirmed + unsent + attempts < 3", async () => {
    h.smsOn = true;
    await fire();
    const columns = new Set(h.candidateQueries.flatMap((q) => q.lt.map(([c]) => c)));
    expect(columns).toEqual(new Set([
      "reminder_24h_send_attempts", "reminder_2h_send_attempts",
      "sms_reminder_24h_send_attempts", "sms_reminder_2h_send_attempts",
    ]));
    for (const q of h.candidateQueries) {
      expect(q.lt).toHaveLength(1);
      expect(q.lt[0][1]).toBe(3);
      expect(q.eq).toContainEqual(["status", "confirmed"]);
      expect(q.is).toHaveLength(1);
      expect(q.is[0][0]).toBe(q.lt[0][0].replace("_send_attempts", "_sent_at"));
      expect(q.is[0][1]).toBeNull();
    }
  });

  it("a row already at the cap is never claimed or sent, on email or SMS", async () => {
    h.smsOn = true;
    seedRow({ reminder_24h_send_attempts: 3, sms_reminder_24h_send_attempts: 3 });
    await fire();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.smsSend).not.toHaveBeenCalled();
  });

  it("a persistently failing provider gets exactly three sends and one exhaustion alert across five fires", async () => {
    const row = seedRow();
    h.send.mockResolvedValue({ ok: false, error: "synthetic refusal", retryable: true });
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(BASE + i * 15 * 60_000));
      await fire();
    }
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(row.reminder_24h_send_attempts).toBe(3);
    expect(row.reminder_24h_sent_at).toBeNull();
    expect(exhaustionAlerts()).toHaveLength(1);
  });
});

describe("an ambiguous provider outcome is never reported as a successful send", () => {
  it("email: a timeout-shaped retryable failure records unsent and counts failed, never succeeded", async () => {
    // lib/email/send-appointment maps a Resend timeout or thrown transport
    // error to { ok: false, retryable: true } (appointment-send-transport.test).
    seedRow();
    h.send.mockResolvedValue({ ok: false, error: "Resend timeout after 15000ms", retryable: true });
    const { body } = await fire();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(expect.anything(), ID, "reminder_24h", false);
    expect(body.reminder_24h).toMatchObject({ succeeded: 0, failed: 1 });
    expect(h.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ emailSucceeded: 0, emailFailed: 1 }));
  });

  it("SMS: a possibly-sent answer counts failed in the run and the heartbeat, never succeeded", async () => {
    h.emailOn = false; h.smsOn = true;
    seedRow();
    h.smsSend.mockResolvedValue({ ok: false, skipped: false, possiblySent: true, intakeLinkIncluded: false });
    const { body } = await fire();
    expect(h.smsSend).toHaveBeenCalledTimes(1);
    expect(body.sms_reminder_24h).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(h.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ smsSucceeded: 0, smsFailed: 1 }));
  });
});

describe("a reminder for an appointment cancelled after it was queued is not sent", () => {
  it("email: cancelled between candidate selection and the post-claim read sends nothing and records no success", async () => {
    seedRow();
    h.statusReads.set(ID, ["cancelled"]);
    const { body } = await fire();
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalledWith(expect.anything(), ID, "reminder_24h", true);
    expect(body.reminder_24h).toMatchObject({ attempted: 0, succeeded: 0, skipped: 1 });
  });

  it("SMS: cancelled before the pre-filter read sends nothing", async () => {
    h.emailOn = false; h.smsOn = true;
    seedRow();
    h.statusReads.set(ID, ["cancelled"]);
    const { body } = await fire();
    expect(h.smsSend).not.toHaveBeenCalled();
    expect(body.sms_reminder_24h).toMatchObject({ attempted: 0, skipped: 1 });
  });

  it("SMS: cancelled between the pre-filter and the recipient refresh sends nothing", async () => {
    h.emailOn = false; h.smsOn = true;
    seedRow();
    h.statusReads.set(ID, ["confirmed", "cancelled"]);
    const { body } = await fire();
    expect(h.smsSend).not.toHaveBeenCalled();
    expect(body.sms_reminder_24h).toMatchObject({ attempted: 0, skipped: 1 });
  });
});
