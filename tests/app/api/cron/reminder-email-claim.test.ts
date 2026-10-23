import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #189. The email reminder pass previously did select -> send ->
// record with no reservation between the select and the send, so two
// overlapping cron runs could both email the same appointment. These
// tests pin the claimed shape of the cron route: claim BEFORE send,
// skip on a lost claim, record via record_email_result (which clears
// the claim and does not double-increment attempts).

const ROUTE = readFileSync(
  path.resolve(
    __dirname,
    "../../../../app/api/cron/appointment-reminders/route.ts",
  ),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CODE = codeOnly(ROUTE);

// The appointment email pass is sendReminderPass only; scope assertions there
// so the SMS pass (which has its own claim_sms_send slot) cannot satisfy them.
// Since 0186 the separate intake-reminder pass is gone - the intake nudge is
// composed INTO this pass under this pass's single claim - so the slice now
// ends at the SMS pass. The lookup is kept tolerant of either name so the
// slice can never silently become the whole file.
const EMAIL_PASS_END = Math.min(
  ...[
    CODE.indexOf("async function sendIntakeReminderPass"),
    CODE.indexOf("async function sendSmsReminderPass"),
  ].filter((i) => i > -1),
);
const EMAIL_PASS = CODE.slice(
  CODE.indexOf("async function sendReminderPass"),
  EMAIL_PASS_END,
);

describe("email reminder pass: claim before send", () => {
  it("imports claimEmailSend + recordEmailResult from the email module", () => {
    expect(ROUTE).toMatch(/claimEmailSendOutcome,/);
    expect(ROUTE).toMatch(/recordEmailResult,/);
    expect(ROUTE).toMatch(/from "@\/lib\/email\/send-appointment"/);
  });

  it("every send is claimed first: claim call precedes the send dispatch", () => {
    const claimIdx = EMAIL_PASS.indexOf(
      "await claimEmailSendOutcome(admin, appt.id, emailType)",
    );
    const sendIdx = EMAIL_PASS.indexOf("result = await sendFn(");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(claimIdx);
  });

  it("a lost claim skips the row without sending", () => {
    expect(EMAIL_PASS).toMatch(
      /if \(!claimed\) \{\s*\n?\s*stats\.skipped \+= 1;\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("the claim also precedes the missing-token failure record", () => {
    const claimIdx = EMAIL_PASS.indexOf("await claimEmailSendOutcome(");
    const tokenIdx = EMAIL_PASS.indexOf("if (!token) {");
    expect(tokenIdx).toBeGreaterThan(claimIdx);
  });

  it("outcomes are recorded via record_email_result, never record_email_attempt", () => {
    // recordEmailAttempt increments attempts; the claim already did.
    // Using it after a claim would double-count, so the claimed pass
    // must not reference it at all.
    expect(EMAIL_PASS).toMatch(
      /await recordEmailResult\(admin, appt\.id, emailType, false\);/,
    );
    expect(EMAIL_PASS).toMatch(
      /await recordEmailResult\(admin, appt\.id, emailType, result\.ok\);/,
    );
    expect(EMAIL_PASS).not.toMatch(/recordEmailAttempt/);
    expect(CODE).not.toMatch(/recordEmailAttempt/);
  });

  it("duplicate cron passes cannot double-send: no send path bypasses the claim", () => {
    // Exactly one sendFn dispatch exists in the email pass and exactly
    // one claim call guards it (asserted in order above). If a second
    // unclaimed dispatch is ever added, this count catches it.
    const sends = EMAIL_PASS.match(/await sendFn\(/g) ?? [];
    expect(sends.length).toBe(1);
    const claims = EMAIL_PASS.match(/await claimEmailSendOutcome\(/g) ?? [];
    expect(claims.length).toBe(1);
  });
});

describe("email reminder pass: preserved behavior", () => {
  it("the selection query is unchanged (sent-is-null + attempts cap + window)", () => {
    expect(CODE).toMatch(/\.is\(opts\.notSentColumn, null\)/);
    expect(CODE).toMatch(/\.lt\(opts\.attemptsColumn, MAX_ATTEMPTS\)/);
  });

  it("attempt numbering for failure logs is unchanged", () => {
    expect(EMAIL_PASS).toMatch(
      /const attemptNumber = \(appt\[attemptsColumn\] as number\) \+ 1;/,
    );
  });

  it("the cheap row guards are all evaluated before any claim", () => {
    // Since 0186 the studio reminder toggle is no longer a SKIP - it is an
    // input to which email gets composed, because a studio with the reminder
    // off may still owe a standalone intake reminder. What must not regress is
    // that nothing claims a slot before the cheap in-memory guards have run:
    // a claim costs an attempt off the 3-strike cap.
    const toggleIdx = EMAIL_PASS.indexOf("[studioToggle]");
    const emailIdx = EMAIL_PASS.indexOf("if (!appt.client?.email) return;");
    const claimIdx = EMAIL_PASS.indexOf("await claimEmailSendOutcome(");
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(toggleIdx);
    expect(claimIdx).toBeGreaterThan(emailIdx);
    // A row that can produce no email at all never reaches the claim.
    expect(EMAIL_PASS).toMatch(
      /if \(!wantsReminder && !intakeEnabled\) return;/,
    );
  });

  it("the SMS pass still uses its own claim (claim_sms_send path untouched)", () => {
    const smsPass = CODE.slice(CODE.indexOf("async function sendSmsReminderPass"));
    expect(smsPass).toMatch(/send24hReminderSmsToClient/);
    expect(ROUTE).not.toMatch(/claim_sms_send"/);
  });

  it("response keys reminder_24h / reminder_2h are unchanged", () => {
    expect(CODE).toMatch(/reminder_24h,\s*\n?\s*reminder_2h,/);
  });
});

describe("PR #189 boundaries (cron route)", () => {
  it("no payment / Stripe code", () => {
    expect(CODE).not.toMatch(
      /paymentIntents|refunds\.create|charges\.create|checkout\.sessions|STRIPE_ALLOW_LIVE_MODE/,
    );
  });

  it("cron auth gate unchanged", () => {
    expect(CODE).toMatch(/if \(!isAuthorizedCronRequest\(req\)\)/);
  });
});


// Exercise the real route across the query/claim boundary with synthetic rows.
const race = vi.hoisted(() => ({
  start: "2026-10-22T12:00:00.000Z",
  freshStart: "2026-10-22T12:00:00.000Z" as string | null,
  readError: false,
  intakeOnly: false,
  intakeEnabled: false,
  intakeReads: [] as Array<{ data: { id: string; status: string } | null; error: { message: string } | null }>,
  freshMissing: false,
  readErrorWithData: false,
  claimRpcMode: "normal" as "normal" | "error" | "throw" | "malformed",
  claimRpc: vi.fn(),
  incidentRead: "none" as "none" | "db_error" | "timeout" | "invalid_row" | "throw" | "timeout_once",
  incidentThrown: undefined as unknown,
  setupThrown: undefined as unknown,
  originThrown: undefined as unknown,
  incidentCoordinationError: undefined as unknown,
  incidentSqlState: "42703" as unknown,
  backlog: null as null | { channel: "email" | "sms"; skipped: number; eligible: number; reason: "toggle" | "destination" | "consent" | "claim" },
  sent: new Set<string>(),
  heartbeat: vi.fn(async () => undefined),
  alerts: vi.fn(async () => undefined),
  store: new Map<string, { value: string; expiry: number }>(),
  failStore: false,
  pages: [] as Array<{ cursor: string | null; orders: string[] }>,
  smsSend: vi.fn(async () => ({ ok: true, intakeLinkIncluded: false })),
  send: vi.fn(async () => ({ ok: true })),
  claim: vi.fn(async (_admin?: unknown, _id?: string, _kind?: string) => { void [_admin, _id, _kind]; return true; }),
  record: vi.fn(async () => undefined),
}));
vi.mock("@/lib/cron/reminder-scan-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cron/reminder-scan-coordinator")>();
  const get = (key: string) => {
    const entry = race.store.get(key);
    if (entry && entry.expiry <= Date.now()) { race.store.delete(key); return null; }
    return entry?.value ?? null;
  };
  return { ...actual, createUpstashReminderScanCoordinator: () => actual.createReminderScanCoordinator({
    async set(key, value, opts) {
      if (race.failStore) throw new Error("synthetic storage failure");
      if (get(key)) return null;
      race.store.set(key, { value, expiry: Date.now() + opts.ex * 1000 }); return "OK";
    },
    async eval(script, keys, args) {
      if (race.incidentCoordinationError !== undefined && script.includes("return {0,''}")) throw race.incidentCoordinationError;
      if (race.failStore) throw new Error("synthetic storage failure");
      if (script.includes("return {0,''}")) return get(keys[0]) === args[0] ? [1, get(keys[1]) ?? ""] : [0, ""];
      if (get(keys[0]) !== args[0]) return 0;
      if (script.includes("pexpireat")) {
        if (Number(args[2]) <= Date.now()) return 0;
        race.store.set(keys[1], { value: String(args[1]), expiry: Number(args[2]) });
        race.store.set(keys[2], { value: String(args[3]), expiry: Date.now() + Number(args[4]) * 1000 });
        race.store.set(keys[0], { value: String(args[0]), expiry: Date.now() + Number(args[5]) * 1000 }); return 1;
      }
      if (script.includes("'del'")) { race.store.delete(keys[0]); return 1; }
      race.store.set(keys[0], { value: String(args[0]), expiry: Date.now() + Number(args[1]) * 1000 }); return 1;
    },
  }) };
});
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => { if (race.originThrown !== undefined) throw race.originThrown; return "https://example.invalid"; } }));
vi.mock("@/lib/intake/queries", () => ({ generateIntakeLinkUrl: () => "https://example.invalid/intake/synthetic", stampIntakeLinkIssued: async () => undefined }));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "synthetic-token" }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({ recordReminderRunSuccess: race.heartbeat }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: race.alerts }));
vi.mock("@/lib/email/send-appointment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send-appointment")>();
  const invokeClaim = async (original: Parameters<typeof actual.claimEmailSend>, richer = false) => {
    const admin = { rpc: async () => {
      race.claimRpc();
      if (race.claimRpcMode === "throw") throw new Error("SYNTHETIC_PRIVATE unavailable claim");
      if (race.claimRpcMode === "error") return { data: null, error: new Error("SYNTHETIC_PRIVATE unavailable claim") };
      if (race.claimRpcMode === "malformed") return { data: null, error: null };
      return { data: await race.claim(...original), error: null };
    } } as unknown as Parameters<typeof actual.claimEmailSend>[0];
    return richer ? actual.claimEmailSendOutcome(admin, original[1], original[2]) : actual.claimEmailSend(admin, original[1], original[2]);
  };
  return { claimEmailSend: (...args: Parameters<typeof actual.claimEmailSend>) => invokeClaim(args),
    claimEmailSendOutcome: (...args: Parameters<typeof actual.claimEmailSend>) => invokeClaim(args, true),
    recordEmailResult: race.record, logEmailFailure: vi.fn(),
    send24hReminderToClient: race.send, send2hReminderToClient: race.send, sendIntakeReminderToClient: race.send };
});
vi.mock("@/lib/sms/send-appointment", () => ({
  createLedgerBudget: () => ({}),
  send24hReminderSmsToClient: race.smsSend,
  send2hReminderSmsToClient: race.smsSend,
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => { if (race.setupThrown !== undefined) throw race.setupThrown; return ({
    from: (table: string) => {
      let candidateColumn = "";
      let cursor: string | null = null;
      let limit = 50;
      const orders: string[] = [];
      const row = (id: string, skipped = false) => {
        const reason = race.backlog?.reason;
        return {
          id, studio_id: "synthetic-studio", client_id: "synthetic-client",
          status: "confirmed", starts_at: race.start, reminder_24h_send_attempts: 0,
          studio: { id: "synthetic-studio", name: "Synthetic", timezone: "UTC",
            send_24h_reminders: !race.intakeOnly && !(skipped && reason === "toggle"), send_intake_reminders: race.intakeOnly || race.intakeEnabled,
            send_24h_sms_reminders: !(skipped && reason === "toggle") },
          client: { name: "Synthetic", email: skipped && reason === "destination" ? null : "synthetic@example.invalid",
            phone: skipped && reason === "destination" ? null : "+15555550123",
            sms_consent_at: skipped && reason === "consent" ? null : "2026-10-01T00:00:00Z", sms_opted_out_at: null },
          service: null, practitioner: null,
        };
      };
      const answer = () => {
        const channel = race.backlog?.channel ?? "email";
        if (candidateColumn !== (channel === "email" ? "reminder_24h_sent_at" : "sms_reminder_24h_sent_at")) {
          return { data: [], error: null };
        }
        race.pages.push({ cursor, orders });
        if (race.incidentRead === "db_error") return { data: null, error: { message: "SYNTHETIC_PRIVATE PostgREST read failure", code: race.incidentSqlState } };
        if (race.incidentRead === "invalid_row") return { data: [row("SYNTHETIC_PRIVATE invalid row")], error: null };
        if (race.pages.length > 100) throw new Error("Candidate cursor did not advance");
        const rows = race.backlog ? Array.from({ length: race.backlog.skipped + race.backlog.eligible }, (_, i) =>
          row(`00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, i < race.backlog!.skipped),
        ) : [row("00000000-0000-4000-8000-000000000001")];
        return { data: rows.filter((r) => !race.sent.has(r.id) && (!cursor || r.id > cursor)).slice(0, limit), error: null };
      };
      const b = {
        select: () => b,
        eq: () => b,
        is: (column: string) => { candidateColumn = column; return b; },
        lt: () => b, gte: () => b, lte: () => b, abortSignal: () => b,
        order: (column: string) => { orders.push(column); return b; },
        limit: (n: number) => { limit = n; return b; },
        or: (filter: string) => {
          const match = filter.match(/id\.gt\.("[^"]+")/);
          if (!match) throw new Error("Expected keyset tie-breaker");
          cursor = JSON.parse(match[1]);
          return b;
        },
        maybeSingle: async () => {
          if (table === "client_intake_forms") {
            const answer = race.intakeReads.shift();
            if (!answer) throw new Error("Synthetic intake fixture exhausted");
            return answer;
          }
          return ({
          data: race.freshMissing || (race.readError && !race.readErrorWithData) ? null : { ...row("00000000-0000-4000-8000-000000000001"), starts_at: race.freshStart },
          error: race.readError ? { message: "synthetic read failure" } : null,
        }); },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          if (race.incidentRead === "throw") { answer(); return Promise.reject(race.incidentThrown).then(resolve, reject); }
          if (race.incidentRead === "timeout_once" && race.pages.length === 0) { answer(); return new Promise(() => undefined); }
          if (race.incidentRead === "timeout") { answer(); return new Promise(() => undefined); }
          return Promise.resolve(answer()).then(resolve);
        },
      };
      return b;
    },
  }); },
}));

import { GET } from "@/app/api/cron/appointment-reminders/route";
import { ReminderScanReadFailure } from "@/lib/cron/reminder-scan-coordinator";

describe("MSG-001 candidate eligibility and keyset paging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
    race.store.clear(); race.store.set("reminder_scan:v1:rotation", { value: JSON.stringify({version:1,next:"email24h",known:[]}), expiry: Date.now() + 10800000 }); race.failStore = false; race.heartbeat.mockClear(); race.alerts.mockClear();
    race.start = "2026-10-22T12:00:00.000Z"; race.freshStart = race.start;
    race.claimRpcMode = "normal"; race.claimRpc.mockClear();
    race.intakeEnabled = false;
    race.intakeOnly = false; race.intakeReads = [];
    race.readError = false; race.freshMissing = false; race.readErrorWithData = false; race.incidentRead = "none"; race.incidentSqlState = "42703"; race.incidentThrown = undefined; race.incidentCoordinationError = undefined;
    race.backlog = null; race.sent.clear(); race.pages = [];
    race.setupThrown = undefined; race.originThrown = undefined;
    race.heartbeat.mockReset().mockResolvedValue(undefined); race.alerts.mockReset().mockResolvedValue(undefined);
    race.send.mockClear(); race.smsSend.mockClear();
    race.claim.mockReset().mockResolvedValue(true);
    race.record.mockReset().mockImplementation(async () => undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([["probe", false], ["live", false], ["probe", true], ["live", true]] as const)("INTAKE_AUTH %s error with data=%s cannot masquerade as submitted", async (stage, withData) => {
    race.intakeOnly = true;
    const incomplete = { data: { id: "synthetic-intake", status: "in_progress" }, error: null };
    const unavailable = { data: withData ? incomplete.data : null, error: { message: "SYNTHETIC_PRIVATE intake read error" } };
    race.intakeReads = stage === "probe" ? [unavailable] : [incomplete, unavailable];
    const response = await GET(new Request("https://example.invalid"));
    console.info(JSON.stringify({ event: "synthetic_intake_authority_observation", stage, status: response.status,
      claims: race.claimRpc.mock.calls.length, sdk_calls: race.send.mock.calls.length,
      settlement_calls: race.record.mock.calls.length, failed_settlement_calls: race.record.mock.calls.filter((c) => (c as unknown[])[3] === false).length,
      heartbeats: race.heartbeat.mock.calls.length }));
    expect(race.send).not.toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(race.record).not.toHaveBeenCalled();
    expect(race.heartbeat).not.toHaveBeenCalled();
    expect(race.claimRpc).toHaveBeenCalledTimes(stage === "probe" ? 0 : 1);
    expect(race.alerts).toHaveBeenCalledWith(expect.objectContaining({ safeDetails: expect.objectContaining({
      reason: "read_or_handler", failure_stage: "handler", failure_category: "handler_error",
    }) }));
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
  });

  it("INTAKE_AUTH known incomplete standalone intake still sends once", async () => {
    race.intakeOnly = true;
    race.intakeReads = Array.from({ length: 2 }, () => ({ data: { id: "synthetic-intake", status: "in_progress" }, error: null }));
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).toHaveBeenCalledTimes(1);
    expect(race.record).toHaveBeenCalledWith(expect.anything(), "00000000-0000-4000-8000-000000000001", "reminder_24h", true);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("INTAKE_AUTH known submission after probe retains existing no-send settlement", async () => {
    race.intakeOnly = true;
    race.intakeReads = [{ data: { id: "synthetic-intake", status: "in_progress" }, error: null },
      { data: { id: "synthetic-intake", status: "submitted" }, error: null }];
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).not.toHaveBeenCalled();
    expect(race.record).toHaveBeenCalledWith(expect.anything(), "00000000-0000-4000-8000-000000000001", "reminder_24h", false);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("INTAKE_AUTH plain appointment reminder keeps no-CTA error degradation", async () => {
    race.intakeEnabled = true;
    race.intakeReads = [{ data: null, error: { message: "SYNTHETIC_PRIVATE intake error" } }];
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.send).toHaveBeenCalledTimes(1);
    expect(race.send).toHaveBeenCalledWith(expect.objectContaining({ intakeUrl: null }));
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("INTAKE_AUTH SMS keeps no-CTA error degradation", async () => {
    race.intakeEnabled = true;
    race.backlog = { channel: "sms", reason: "toggle", skipped: 0, eligible: 1 };
    race.intakeReads = [{ data: null, error: { message: "SYNTHETIC_PRIVATE intake error" } }];
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.smsSend).toHaveBeenCalledTimes(1);
    expect(race.smsSend).toHaveBeenCalledWith(expect.objectContaining({ intakeUrl: null }));
    expect(race.send).not.toHaveBeenCalled();
    expect(race.record).not.toHaveBeenCalled();
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("POSTCLAIM_READ failure must not become a healthy completed scan", async () => {
    race.readError = true;
    const response = await GET(new Request("https://example.invalid"));
    const saved = race.store.get("reminder_scan:v1:checkpoint:email24h");
    const checkpoint = saved ? JSON.parse(saved.value) : null;
    console.info(JSON.stringify({ event: "synthetic_postclaim_read_observation", status: response.status,
      claim_calls: race.claimRpc.mock.calls.length, sdk_calls: race.send.mock.calls.length,
      settlement_calls: race.record.mock.calls.length, heartbeat_calls: race.heartbeat.mock.calls.length,
      checkpoint_complete: checkpoint?.complete ?? null, checkpoint_after_null: checkpoint?.after === null }));
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).not.toHaveBeenCalled();
    expect(race.record).not.toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(race.heartbeat).not.toHaveBeenCalled();
    if (checkpoint) expect(checkpoint.complete).toBe(false);
  });

  it("POSTCLAIM_READ error with returned data remains unavailable", async () => {
    race.readError = true;
    race.readErrorWithData = true;
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).not.toHaveBeenCalled();
    expect(race.record).not.toHaveBeenCalled();
    expect(race.heartbeat).not.toHaveBeenCalled();
    expect(race.alerts).toHaveBeenCalledWith(expect.objectContaining({ safeDetails: expect.objectContaining({
      reason: "read_or_handler", failure_stage: "handler", failure_category: "handler_error",
    }) }));
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("synthetic read failure");
  });

  it("POSTCLAIM_READ definite missing row without error remains an ordinary skip", async () => {
    race.freshMissing = true;
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).not.toHaveBeenCalled();
    expect(race.record).not.toHaveBeenCalled();
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("POSTCLAIM_READ known successful current read retains normal send and heartbeat", async () => {
    const response = await GET(new Request("https://example.invalid"));
    expect(response.status).toBe(200);
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).toHaveBeenCalledTimes(1);
    expect(race.record).toHaveBeenCalledWith(expect.anything(), "00000000-0000-4000-8000-000000000001", "reminder_24h", true);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["moved outside window", "2026-10-23T12:00:00.000Z"],
    ["moved within window", "2026-10-22T12:15:00.000Z"],
    ["missing current start", null],
    ["invalid current start", "invalid"],
  ])("MSG002 refuses cached reminder when %s without settling the claim", async (_label, freshStart) => {
    race.freshStart = freshStart;
    const response = await GET(new Request("https://example.invalid"));
    expect(response.status).toBe(200);
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).not.toHaveBeenCalled();
    expect(race.record).not.toHaveBeenCalled();
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("MSG002 accepts an unchanged instant with an equivalent timezone offset", async () => {
    race.freshStart = "2026-10-22T08:00:00-04:00";
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.send).toHaveBeenCalledTimes(1);
    expect(race.record).toHaveBeenCalledWith(expect.anything(), "00000000-0000-4000-8000-000000000001", "reminder_24h", true);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["email", "toggle"], ["email", "destination"],
    ["sms", "toggle"], ["sms", "destination"], ["sms", "consent"],
  ] as const)("pages past 100 %s candidates skipped for %s", async (channel, reason) => {
    race.backlog = { channel, reason, skipped: 100, eligible: 1 };
    const response = await GET(new Request("https://example.invalid/api/cron/appointment-reminders"));
    expect(response.status).toBe(200);
    const send = channel === "email" ? race.send : race.smsSend;
    expect(send).toHaveBeenCalledTimes(1);
    expect(race.pages).toHaveLength(3);
    expect(race.pages[1].cursor).toBe("00000000-0000-4000-8000-000000000050");
    expect(race.pages.every((p) => p.orders.join(",") === "starts_at,id")).toBe(true);
  });

  it("does not skip unsent rows when earlier successful sends leave the selection", async () => {
    race.backlog = { channel: "email", reason: "claim", skipped: 50, eligible: 1 };
    race.claim.mockImplementation(async (_admin?: unknown, id?: string) => {
      const n = Number(id?.slice(-12));
      // Half the first page succeeds and disappears; half loses its claim.
      return n > 50 || n % 2 === 0;
    });
    race.record.mockImplementation(async (_admin?: unknown, id?: string, _kind?: unknown, success?: boolean) => {
      if (id && success) race.sent.add(id);
    });
    const response = await GET(new Request("https://example.invalid/api/cron/appointment-reminders"));
    expect(response.status).toBe(200);
    expect(race.send).toHaveBeenCalledTimes(26);
    expect(race.claim).toHaveBeenCalledTimes(51);
    expect(race.pages).toHaveLength(2);
  });

  it.each(["email", "sms"] as const)("caps actual %s attempts at 50 despite a larger eligible backlog", async (channel) => {
    race.backlog = { channel, reason: "toggle", skipped: 0, eligible: 120 };
    const response = await GET(new Request("https://example.invalid/api/cron/appointment-reminders"));
    expect(response.status).toBe(500);
    expect(race.heartbeat).not.toHaveBeenCalled();
    expect(channel === "email" ? race.send : race.smsSend).toHaveBeenCalledTimes(50);
    expect(race.pages).toHaveLength(1);
  });

  it.each([["email", "toggle"], ["sms", "consent"], ["email", "claim"]] as const)("#995 bounded continuation reaches the tail behind 1000 %s %s skips", async (channel, reason) => {
    race.backlog = { channel, reason, skipped: 1000, eligible: 1 };
    if (reason === "claim") race.claim.mockImplementation(async (_admin?: unknown, id?: string) => Number(id?.slice(-12)) > 1000);
    let finalStatus = 0;
    for (let invocation = 0; invocation < 6; invocation++) {
      const before = race.pages.length;
      const claims = race.claim.mock.calls.length;
      const response = await GET(new Request("https://example.invalid/api/cron/appointment-reminders"));
      finalStatus = response.status;
      expect(race.pages.length - before).toBeLessThanOrEqual(8);
      expect(race.claim.mock.calls.length - claims).toBeLessThanOrEqual(200);
      if (invocation < 5) { expect(response.status).toBe(500); expect(race.heartbeat).not.toHaveBeenCalled(); }
    }
    expect(finalStatus).toBe(200);
    expect(channel === "email" ? race.send : race.smsSend).toHaveBeenCalledTimes(1);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("00000000-");
  });

  it("#995 unavailable claim stops after one row and rotates to the other passes next invocation", async () => {
    race.backlog = { channel: "sms", reason: "toggle", skipped: 0, eligible: 1001 };
    race.smsSend.mockResolvedValueOnce({ ok: false, skipped: true, reason: "reminder_claim_unavailable" } as never);
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.smsSend).toHaveBeenCalledTimes(1);
    expect(race.pages).toHaveLength(1);
    expect(race.heartbeat).not.toHaveBeenCalled();
    const checkpoint = JSON.parse(race.store.get("reminder_scan:v1:checkpoint:sms24h")!.value);
    expect(checkpoint.after).toBeNull();
    expect(JSON.parse(race.store.get("reminder_scan:v1:rotation")!.value).next).toBe("sms2h");
    const retried = await GET(new Request("https://example.invalid"));
    expect(retried.status).toBe(500); // still a bounded, unfinished backlog
    expect(race.smsSend).toHaveBeenNthCalledWith(2, expect.objectContaining({ appointmentId: "00000000-0000-4000-8000-000000000001" }));
    expect(race.smsSend).toHaveBeenCalledTimes(51); // one refused claim + max50 attempts
    expect(race.heartbeat).not.toHaveBeenCalled();
  });

  it("#995 overlapping GET cannot read candidates or dispatch while the first lease is held", async () => {
    let entered!: () => void; let release!: () => void;
    const gate = new Promise<void>((resolve) => { entered = resolve; });
    race.send.mockImplementationOnce(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { ok: true }; });
    const first = GET(new Request("https://example.invalid"));
    await gate;
    const pages = race.pages.length;
    const second = await GET(new Request("https://example.invalid"));
    expect(second.status).toBe(500);
    expect(race.pages).toHaveLength(pages);
    expect(race.send).toHaveBeenCalledTimes(1);
    expect(race.heartbeat).not.toHaveBeenCalled();
    release(); expect((await first).status).toBe(200);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("#995 corrupt cursor refuses dispatch, success heartbeat and private diagnostic data", async () => {
    race.store.set("reminder_scan:v1:checkpoint:email24h", { value: "PRIVATE malformed cursor", expiry: Date.now() + 10800000 });
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.pages).toEqual([]); expect(race.send).not.toHaveBeenCalled(); expect(race.heartbeat).not.toHaveBeenCalled();
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("PRIVATE");
  });

  it("#995 storage outage is fail closed before any query, claim or provider dispatch", async () => {
    race.failStore = true;
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.alerts).toHaveBeenCalledWith(expect.objectContaining({ safeDetails: expect.objectContaining({
      failure_stage: "acquire", failure_category: "coordination_unavailable",
    }) }));
    expect(race.pages).toEqual([]); expect(race.claim).not.toHaveBeenCalled();
    expect(race.send).not.toHaveBeenCalled(); expect(race.smsSend).not.toHaveBeenCalled(); expect(race.heartbeat).not.toHaveBeenCalled();
  });

  it("#995 all-state expiry after unfinished work cannot become a healthy empty-window run", async () => {
    race.backlog = { channel: "email", reason: "toggle", skipped: 1000, eligible: 1 };
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    vi.advanceTimersByTime(10800001);
    race.start = new Date(Date.now() + 86400000).toISOString(); race.freshStart = race.start;
    race.backlog = { channel: "email", reason: "toggle", skipped: 0, eligible: 0 };
    race.heartbeat.mockClear();
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.heartbeat).not.toHaveBeenCalled();
    expect(race.alerts).toHaveBeenLastCalledWith(expect.objectContaining({ safeDetails: expect.objectContaining({ coverage_unconfirmed: true }) }));
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("#995 a definite fake email failure preserves its counted result and subsequent work", async () => {
    race.send.mockResolvedValueOnce({ ok: false, error: "synthetic refusal" } as never);
    const response = await GET(new Request("https://example.invalid"));
    expect(response.status).toBe(200);
    expect((await response.json()).reminder_24h).toMatchObject({ attempted: 1, failed: 1, succeeded: 0 });
    expect(race.record).toHaveBeenCalledWith(expect.anything(), "00000000-0000-4000-8000-000000000001", "reminder_24h", false);
  });

  it.each(["db_error", "timeout"] as const)("16:15 incident signature: first-page %s fails before any claim/SDK and a later healthy fake run recovers without resets", async (failure) => {
    race.incidentRead = failure;
    const pending = GET(new Request("https://example.invalid/api/cron/appointment-reminders"));
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "cron_failed", lead_alerts: { ran: false, reason: "recipient_not_configured" } });
    expect(race.alerts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: "cron_route_failed", severity: "critical",
      message: "Reminder scan incomplete. Check scheduler progress before retrying work.",
      safeDetails: { reason: "read_or_handler", candidates_scanned: 0, candidate_queries: failure === "timeout" ? 2 : 1, attempted: 0, coverage_unconfirmed: false,
        ...(failure === "timeout" ? { read_timeouts: 2, read_retries: 1, read_retry_recovered: false } : {}),
        failure_stage: "read", failure_category: failure === "timeout" ? "read_timeout" : "rejected_query",
        ...(failure === "db_error" ? { sql_state: "42703" } : {}),
      },
    }));
    expect(race.pages).toHaveLength(failure === "timeout" ? 2 : 1);
    expect(race.claim).not.toHaveBeenCalled(); expect(race.send).not.toHaveBeenCalled();
    expect(race.smsSend).not.toHaveBeenCalled(); expect(race.record).not.toHaveBeenCalled();
    expect(race.heartbeat).not.toHaveBeenCalled();
    expect(race.store.has("reminder_scan:v1:checkpoint:email24h")).toBe(false);
    expect(race.store.has("reminder_scan:v1:lock")).toBe(false);
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    // Synthetic subsequent invocation only, NOT the production cron. Keep
    // all persisted fixture state; no cursor/claim reset or alert resolution.
    race.incidentRead = "none";
    const recovered = await GET(new Request("https://example.invalid/api/cron/appointment-reminders"));
    expect(recovered.status).toBe(200);
    expect(race.claim).toHaveBeenCalledTimes(1); expect(race.send).toHaveBeenCalledTimes(1);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
    expect(race.alerts).toHaveBeenCalledTimes(1);
  });

  it("16:15 incident ambiguity: a first-row handler can throw after fake acceptance with the same zero-attempt aggregate", async () => {
    race.record.mockRejectedValueOnce(Object.assign(new Error("SYNTHETIC_PRIVATE settlement transport exception"), { code: "40001" }));
    const response = await GET(new Request("https://example.invalid/api/cron/appointment-reminders"));
    expect(response.status).toBe(500);
    expect(race.alerts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: "cron_route_failed", severity: "critical",
      safeDetails: { reason: "read_or_handler", candidates_scanned: 0, candidate_queries: 1, attempted: 0, coverage_unconfirmed: false,
        failure_stage: "handler", failure_category: "handler_error", sql_state: "40001",
      },
    }));
    expect(race.claim).toHaveBeenCalledTimes(1);
    expect(race.send).toHaveBeenCalledTimes(1); // fake only; aggregate is NOT a no-send proof
    expect(race.record).toHaveBeenCalledTimes(1);
    expect(race.heartbeat).not.toHaveBeenCalled();
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    expect(race.store.has("reminder_scan:v1:checkpoint:email24h")).toBe(false);
    // Deliberately no subsequent fake retry in this case: a possible accepted
    // effect requires independent claim/result reconciliation before resend.
  });

  it("incident diagnostics distinguish invalid rows from reads without exposing the rejected cursor", async () => {
    race.incidentRead = "invalid_row";
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.alerts).toHaveBeenCalledWith(expect.objectContaining({ safeDetails: expect.objectContaining({
      failure_stage: "validate", failure_category: "invalid_row", candidates_scanned: 0, candidate_queries: 1,
    }) }));
    expect(race.claim).not.toHaveBeenCalled(); expect(race.send).not.toHaveBeenCalled();
    expect(race.heartbeat).not.toHaveBeenCalled();
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
  });

  it.each(["PGRST200", "SYNTHETIC_PRIVATE", "42703 private suffix"])("incident diagnostics withhold non-allowlisted SQLSTATE %s", async (code) => {
    race.incidentRead = "db_error"; race.incidentSqlState = code;
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.alerts).toHaveBeenCalledWith(expect.objectContaining({ safeDetails: expect.objectContaining({
      failure_stage: "read", failure_category: "rejected_query",
    }) }));
    const details = race.alerts.mock.calls[0] as unknown as [{ safeDetails: Record<string, unknown> }];
    expect(details[0].safeDetails).not.toHaveProperty("sql_state");
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain(code);
    expect(race.claim).not.toHaveBeenCalled(); expect(race.heartbeat).not.toHaveBeenCalled();
  });

  it.each(["read", "rotation", "timedOut"] as const)("Privacy incident diagnostics contain hostile %s classification without raw outer-route alerts", async (boundary) => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("SYNTHETIC_PRIVATE getPrototypeOf classifier failure"); } });
    if (boundary === "rotation") race.incidentCoordinationError = hostile;
    else {
      race.incidentRead = "throw";
      race.incidentThrown = boundary === "read" ? hostile : Object.defineProperty(new ReminderScanReadFailure(undefined, false), "timedOut", {
        get() { throw new Error("SYNTHETIC_PRIVATE timedOut classifier failure"); },
      });
    }
    const response = await GET(new Request("https://example.invalid"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    expect(race.alerts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: "Reminder scan incomplete. Check scheduler progress before retrying work.",
      safeDetails: expect.objectContaining({ reason: "read_or_handler", candidates_scanned: 0, attempted: 0,
        candidate_queries: boundary === "rotation" ? 0 : 1,
        failure_stage: boundary === "rotation" ? "rotation" : "read",
        failure_category: boundary === "rotation" ? "coordination_error" : "rejected_query",
      }),
    }));
    expect(race.claim).not.toHaveBeenCalled(); expect(race.send).not.toHaveBeenCalled();
    expect(race.smsSend).not.toHaveBeenCalled(); expect(race.heartbeat).not.toHaveBeenCalled();
  });

  it.each(["admin", "origin", "heartbeat"] as const)("MSG007 outer catch contains hostile %s rejection with fixed diagnostics", async (boundary) => {
    const inspected = vi.fn(() => { throw new Error("SYNTHETIC_PRIVATE rejection inspected"); });
    const hostile = new Proxy({}, { getPrototypeOf: inspected, get: inspected });
    if (boundary === "admin") race.setupThrown = hostile;
    else if (boundary === "origin") race.originThrown = hostile;
    else race.heartbeat.mockRejectedValueOnce(hostile);
    const response = await GET(new Request("https://example.invalid"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "cron_failed", lead_alerts: { ran: false, reason: "recipient_not_configured" } });
    expect(inspected).not.toHaveBeenCalled();
    expect(race.alerts).toHaveBeenCalledExactlyOnceWith({
      severity: "critical", event: "cron_route_failed",
      message: "Reminder run failed. Check scheduler progress before retrying work.",
      route: "/api/cron/appointment-reminders",
      safeDetails: { duration_ms: expect.any(Number),
        failure_stage: boundary === "heartbeat" ? "heartbeat" : "setup",
        failure_category: boundary === "heartbeat" ? "heartbeat_failed" : "setup_failed" },
    });
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    if (boundary !== "heartbeat") {
      expect(race.claim).not.toHaveBeenCalled(); expect(race.send).not.toHaveBeenCalled();
      expect(race.smsSend).not.toHaveBeenCalled(); expect(race.heartbeat).not.toHaveBeenCalled();
    } else {
      expect(race.claim).toHaveBeenCalledTimes(1); expect(race.send).toHaveBeenCalledTimes(1);
      expect(race.heartbeat).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["admin", "heartbeat"] as const)("MSG007 outer catch preserves 500 when %s diagnostic writer rejects", async (boundary) => {
    if (boundary === "admin") race.setupThrown = new Error("SYNTHETIC_PRIVATE admin setup");
    else race.heartbeat.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE heartbeat"));
    race.alerts.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE alert writer"));
    const response = await GET(new Request("https://example.invalid"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "cron_failed", lead_alerts: { ran: false, reason: "recipient_not_configured" } });
    expect(race.alerts).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
  });
  it.each([false, true])("bounded READ retry retains recovered timeout observation; writer rejects=%s", async (writerRejects) => {
    race.incidentRead = "timeout_once";
    if (writerRejects) race.alerts.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE diagnostic writer"));
    const pending = GET(new Request("https://example.invalid"));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(200);
    expect(race.alerts).toHaveBeenCalledExactlyOnceWith({ severity: "warning", event: "reminder_read_timeout",
      message: "A reminder candidate read timed out before a bounded retry recovered. Check scheduler progress.",
      route: "/api/cron/appointment-reminders", safeDetails: { failure_stage: "read", failure_category: "read_timeout",
        read_timeouts: 1, read_retries: 1, read_retry_recovered: true, candidate_queries: 5 } });
    expect(race.claim).toHaveBeenCalledTimes(1); expect(race.send).toHaveBeenCalledTimes(1);
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
  });

  it.each(["error", "throw", "malformed"] as const)("email claim %s keeps the candidate unacknowledged and heartbeat unhealthy", async (mode) => {
    race.claimRpcMode = mode;
    const response = await GET(new Request("https://example.invalid"));
    expect(response.status).toBe(500);
    expect(race.claimRpc).toHaveBeenCalledTimes(1);
    expect(race.send).not.toHaveBeenCalled(); expect(race.record).not.toHaveBeenCalled(); expect(race.heartbeat).not.toHaveBeenCalled();
    const saved = race.store.get("reminder_scan:v1:checkpoint:email24h");
    if (saved) expect(JSON.parse(saved.value).after).toBeNull();
    expect(race.alerts).toHaveBeenCalledWith(expect.objectContaining({ safeDetails: expect.objectContaining({ reason: "claim_unavailable", attempted: 0 }) }));
    expect(JSON.stringify(race.alerts.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
  });
  it("a definite false claim remains a legitimate skip that can complete the pass", async () => {
    race.claim.mockResolvedValue(false);
    expect((await GET(new Request("https://example.invalid"))).status).toBe(200);
    expect(race.claimRpc).toHaveBeenCalledTimes(1); expect(race.send).not.toHaveBeenCalled(); expect(race.record).not.toHaveBeenCalled();
    expect(race.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("an unavailable second claim preserves the already-handled prefix without acknowledging that row", async () => {
    race.backlog = { channel: "email", reason: "toggle", skipped: 0, eligible: 3 };
    race.claim.mockImplementationOnce(async () => { race.claimRpcMode = "error"; return true; });
    expect((await GET(new Request("https://example.invalid"))).status).toBe(500);
    expect(race.claimRpc).toHaveBeenCalledTimes(2); expect(race.send).toHaveBeenCalledTimes(1); expect(race.record).toHaveBeenCalledTimes(1);
    expect(race.heartbeat).not.toHaveBeenCalled();
    const saved = race.store.get("reminder_scan:v1:checkpoint:email24h"); expect(saved).toBeDefined();
    expect(JSON.parse(saved!.value).after.id).toBe("00000000-0000-4000-8000-000000000001");
  });

});
