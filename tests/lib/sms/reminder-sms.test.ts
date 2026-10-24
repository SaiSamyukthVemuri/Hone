import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LEDGER_RUN_BUDGET_MS,
  LEDGER_STEP_BOUND_MS,
  createLedgerBudget,
  claimSmsSend,
  recordSmsResult,
  logSmsFailure,
  sendBookingConfirmationSmsToClient,
  send24hReminderSmsToClient,
  send2hReminderSmsToClient,
  type SendReminderInput,
} from "@/lib/sms/send-appointment";

// ===========================================================================
// SMS-02 — the appointment reminder SMS, end to end through the send helper.
//
// Real: the consent gate, the deployment fence, the templates (and so the
// studio-timezone rendering), the transport's answer classification and the
// ledger mapping. Substituted: the database (the atomic reminder claim, record
// and ledger commands) and the network.
//
// The cases are the P0 acceptance list: duplicates, cancellation, moves made
// before the reminder is sent (decided inside the atomic claim), missing
// consent and opt-out, provider failure (refused, unreachable, ambiguous) and
// the studio's timezone. A move AFTER the send is the specified follow-up
// SMS-03 and is deliberately not exercised here.
// ===========================================================================

const alerts: Array<Record<string, unknown>> = [];
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (input: Record<string, unknown>) => {
    alerts.push(input);
    return Promise.resolve();
  },
}));

const LEDGER_ROW = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";
const SID = `SM${"3c".repeat(16)}`;
const START = "2026-10-09T17:00:00.000Z"; // 10:00 AM in Vancouver (PDT)
const WINDOW = { startIso: "2026-10-09T16:00:00.000Z", endIso: "2026-10-09T18:00:00.000Z" };

type ClaimAnswer = { result: string; starts_at?: string | null } | "error";
const h: {
  claim: ClaimAnswer;
  /** "hang": never answers. { afterMs }: answers with the row after that long. */
  begin: { data: unknown; error: unknown } | "hang" | { afterMs: number };
  /** "hang": settle_sms_message never answers (a stalled or killed request). */
  settle: "ok" | "hang";
  attemptNumber: unknown;
  sentAt: string | null;
  laterClaim: string | null;
  recordError: boolean;
  readMode: "row" | "error" | "hang";
  attemptReads: Array<{ columns: string; filters: Array<[string, string]>; signal?: AbortSignal; rpcsBefore: string[] }>;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
} = {
  claim: { result: "claimed", starts_at: START },
  begin: { data: LEDGER_ROW, error: null },
  settle: "ok",
  attemptNumber: 1, sentAt: null, laterClaim: null, recordError: false, readMode: "row", attemptReads: [],
  rpcs: [],
};

function admin(): SupabaseClient {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      h.rpcs.push({ fn, args });
      if (fn === "claim_reminder_sms_send") {
        return Promise.resolve(
          h.claim === "error"
            ? { data: null, error: { message: "boom" } }
            : { data: [h.claim], error: null },
        );
      }
      if (fn === "record_sms_result" && h.recordError) return Promise.resolve({ data: null, error: { message: "synthetic record failure" } });
      // The confirmation path's plain claim (0049).
      if (fn === "claim_sms_send") return Promise.resolve({ data: true, error: null });
      if (fn === "begin_appointment_sms_message") {
        const begin = h.begin;
        if (begin === "hang") return new Promise(() => undefined);
        if ("afterMs" in begin) {
          return new Promise((r) => setTimeout(() => r({ data: LEDGER_ROW, error: null }), begin.afterMs));
        }
        return Promise.resolve(begin);
      }
      if (fn === "settle_sms_message") {
        return h.settle === "hang"
          ? new Promise(() => undefined)
          : Promise.resolve({ data: "settled", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      if (table !== "appointments") throw new Error("unexpected observer table");
      return { select(columns: string) {
        const match = columns.match(/^(sms_reminder_(?:24h|2h))_send_attempts, \1_sent_at, \1_claimed_at$/);
        if (!match) throw new Error("appointment timing/status must remain inside the atomic claim");
        const read = { columns, filters: [] as Array<[string, string]>, signal: undefined as AbortSignal | undefined, rpcsBefore: h.rpcs.map(call => call.fn) };
        h.attemptReads.push(read);
        const query = {
          eq: (column: string, value: string) => { read.filters.push([column, value]); return query; },
          abortSignal: (signal: AbortSignal) => { read.signal = signal; return query; },
          maybeSingle: async () => {
            if (h.readMode === "hang") return new Promise<never>(() => undefined); // ignores abort deliberately
            return { data: h.readMode === "error" ? null : {
              [`${match[1]}_send_attempts`]: h.attemptNumber,
              [`${match[1]}_sent_at`]: h.sentAt,
              [`${match[1]}_claimed_at`]: h.laterClaim,
            }, error: h.readMode === "error" ? { message: "SYNTHETIC_PRIVATE observer read" } : null };
          },
        };
        return query;
      } };
    },
  } as unknown as SupabaseClient;
}

const manageFor: Date[] = [];
function input(over: Partial<SendReminderInput> = {}): SendReminderInput {
  return {
    admin: admin(),
    appointmentId: "appt-1",
    window: WINDOW,
    timezone: "America/Vancouver",
    studio: {
      id: "studio-1",
      name: "Willow",
      send_confirmation_sms: false,
      send_24h_sms_reminders: true,
      send_2h_sms_reminders: true,
    },
    client: { phone: "604-555-0199", sms_consent_at: "2026-09-01T00:00:00Z", sms_opted_out_at: null },
    manageUrlFor: (d) => {
      manageFor.push(d);
      return `https://hone.care/manage/token-${d.toISOString()}`;
    },
    intakeUrl: null,
    ...over,
  };
}

const ENV_KEYS = [
  "VERCEL_ENV",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_WEBHOOK_BASE_URL",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fetchMock: ReturnType<typeof vi.fn>;
const twilioAnswer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://hone.care";
  h.claim = { result: "claimed", starts_at: START };
  h.begin = { data: LEDGER_ROW, error: null };
  h.settle = "ok";
  h.rpcs = []; h.attemptNumber = 1; h.sentAt = null; h.laterClaim = null; h.recordError = false; h.readMode = "row"; h.attemptReads = [];
  alerts.length = 0;
  manageFor.length = 0;
  fetchMock = vi.fn(() => twilioAnswer(201, { sid: SID }));
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

const calls = (fn: string) => h.rpcs.filter((c) => c.fn === fn);
const recorded = () => calls("record_sms_result").map((c) => c.args.p_success);
const settled = () => calls("settle_sms_message").map((c) => c.args);
const sentForm = () => new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body));
// Vitest's flush: logSmsFailure raises its alert in a detached async task.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a reminder that sends", () => {
  it("claims, sends once in the studio's timezone, records it sent, and ledgers it", async () => {
    const r = await send24hReminderSmsToClient(input());
    expect(r).toEqual({ ok: true, messageSid: SID, intakeLinkIncluded: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = sentForm().get("Body")!;
    expect(body).toContain("Willow");
    expect(body).toContain("10:00"); // Vancouver, not 17:00 UTC
    expect(body).not.toMatch(/\b5:00\b/);
    expect(sentForm().get("To")).toBe("+16045550199");

    expect(recorded()).toEqual([true]);
    expect(calls("begin_appointment_sms_message")[0]?.args).toMatchObject({
      p_studio_id: "studio-1",
      p_appointment_id: "appt-1",
      p_purpose: "appointment_reminder_24h",
    });
    expect(sentForm().get("StatusCallback")).toBe(
      `https://hone.care/api/twilio/message-status?m=${LEDGER_ROW}`,
    );
    expect(settled()).toEqual([
      expect.objectContaining({ p_outcome: "accepted", p_provider_message_sid: SID }),
    ]);
  });

  it("the 2h reminder carries its own purpose", async () => {
    await send2hReminderSmsToClient(input());
    expect(calls("begin_appointment_sms_message")[0]?.args.p_purpose).toBe("appointment_reminder_2h");
  });

  it("a ledger that cannot be written never stops the reminder", async () => {
    h.begin = { data: null, error: { message: "function does not exist" } };
    expect((await send24hReminderSmsToClient(input())).ok).toBe(true);
    expect(sentForm().has("StatusCallback")).toBe(false);
    expect(settled()).toEqual([]);
    expect(recorded()).toEqual([true]);
  });
});

describe("duplicates", () => {
  it("a slot another run holds (or already sent) is skipped with no provider call", async () => {
    h.claim = { result: "not_claimed", starts_at: START };
    expect(await send24hReminderSmsToClient(input())).toEqual({
      ok: false,
      skipped: true,
      reason: "not_claimed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded()).toEqual([]);
  });

  it("an AMBIGUOUS answer is recorded as sent: never retried automatically", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    const r = await send24hReminderSmsToClient(input());
    expect(r).toEqual({
      ok: false,
      possiblySent: true,
      error: "twilio_timeout",
      retryable: false,
      intakeLinkIncluded: false,
    });
    expect(recorded(), "a possibly-sent reminder must not be re-sent").toEqual([true]);
    expect(settled()).toEqual([expect.objectContaining({ p_outcome: "unknown" })]);
    await flush();
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).toContain("outcome_unknown");
  });
});

describe("missing consent, opt-out and the studio switch: no claim at all", () => {
  for (const [label, over, reason] of [
    ["no consent", { client: { phone: "604-555-0199", sms_consent_at: null, sms_opted_out_at: null } }, "client_no_consent"],
    ["opted out", { client: { phone: "604-555-0199", sms_consent_at: "2026-09-01T00:00:00Z", sms_opted_out_at: "2026-09-02T00:00:00Z" } }, "client_opted_out"],
    ["no usable phone", { client: { phone: "12", sms_consent_at: "2026-09-01T00:00:00Z", sms_opted_out_at: null } }, "invalid_phone"],
  ] as const) {
    it(`${label} -> skipped (${reason})`, async () => {
      expect(await send24hReminderSmsToClient(input(over as Partial<SendReminderInput>))).toEqual({
        ok: false,
        skipped: true,
        reason,
      });
      expect(h.rpcs).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("the studio's 24h SMS switch off -> skipped", async () => {
    const i = input();
    i.studio = { ...i.studio, send_24h_sms_reminders: false };
    expect(await send24hReminderSmsToClient(i)).toMatchObject({ skipped: true, reason: "studio_toggle_off" });
    expect(h.rpcs).toEqual([]);
  });

  it("a preview deployment -> skipped before the claim", async () => {
    process.env.VERCEL_ENV = "preview";
    expect(await send24hReminderSmsToClient(input())).toMatchObject({
      skipped: true,
      reason: "non_production_deployment",
    });
    expect(h.rpcs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cancellation and moves before the send", () => {
  it("the claim receives this cron window and the reminder type", async () => {
    await send24hReminderSmsToClient(input());
    expect(calls("claim_reminder_sms_send")[0]?.args).toEqual({
      p_appointment_id: "appt-1",
      p_sms_type: "reminder_24h",
      p_window_start: WINDOW.startIso,
      p_window_end: WINDOW.endIso,
    });
  });

  it("cancelled: refused by the claim, nothing sent, nothing recorded (no attempt spent)", async () => {
    h.claim = { result: "not_confirmed", starts_at: START };
    expect(await send24hReminderSmsToClient(input())).toEqual({
      ok: false,
      skipped: true,
      reason: "not_confirmed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded()).toEqual([]);
  });

  it("moved OUT of this window: refused by the claim, nothing sent, nothing recorded", async () => {
    h.claim = { result: "outside_window", starts_at: "2026-10-12T17:00:00.000Z" };
    expect(await send24hReminderSmsToClient(input())).toMatchObject({ skipped: true, reason: "outside_window" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded()).toEqual([]);
  });

  it("moved WITHIN the window: the message names the start the claim returned, and so does its manage link", async () => {
    h.claim = { result: "claimed", starts_at: "2026-10-09T17:30:00.000Z" };
    await send24hReminderSmsToClient(input());
    expect(sentForm().get("Body")).toContain("10:30");
    expect(manageFor.map((d) => d.toISOString())).toEqual(["2026-10-09T17:30:00.000Z"]);
    expect(recorded()).toEqual([true]);
  });

  it("an unreachable claim spends NOTHING: no send, no record, retried on a later fire", async () => {
    h.claim = "error";
    // A SKIP, not a failure: no provider request was made, so the cron must
    // not count it as an attempt (Codex P2 4212849211). It is still logged.
    expect(await send24hReminderSmsToClient(input())).toEqual({
      ok: false,
      skipped: true,
      reason: "reminder_claim_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded(), "nothing was claimed, so nothing is released").toEqual([]);
    expect(
      vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes("reminder_claim_unavailable")),
      "the unreachable claim is still logged for the operator",
    ).toBe(true);
    await flush();
    expect(alerts, "a retryable miss raises no alert").toEqual([]);
  });

  it("appointment timing/status is never read outside the atomic claim", async () => {
    expect((await send24hReminderSmsToClient(input())).ok).toBe(true);
  });
});

describe("provider failure", () => {
  it("a refusal is recorded unsent (the next fire may retry within the budget) and ledgered with its code", async () => {
    fetchMock.mockImplementationOnce(() => twilioAnswer(400, { code: 21211 }));
    expect(await send24hReminderSmsToClient(input())).toEqual({
      ok: false,
      error: "twilio_http_400",
      retryable: false,
    });
    expect(recorded()).toEqual([false]);
    expect(settled()).toEqual([
      expect.objectContaining({ p_outcome: "refused", p_provider_error_code: 21211 }),
    ]);
  });

  it("a connection that never opened is a definite non-send and may be retried", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })),
    );
    expect(await send24hReminderSmsToClient(input())).toEqual({
      ok: false,
      error: "twilio_unreachable",
      retryable: true,
    });
    expect(recorded()).toEqual([false]);
    expect(settled()).toEqual([expect.objectContaining({ p_outcome: "refused" })]);
  });
});

// ===========================================================================
// THE AUTHORITATIVE RECORD COMES BEFORE THE BEST-EFFORT SETTLE (Codex P1
// 4212849205). record_sms_result decides whether a reminder may be sent again;
// settle_sms_message is bookkeeping. If the settle hangs, or the invocation is
// killed during it, an accepted or possibly-accepted reminder must already be
// stamped sent. Otherwise only its claim remains, the claim goes stale after
// five minutes, and a later fire sends the reminder again.
// ===========================================================================
describe("the slot is recorded before the ledger is settled", () => {
  it("in order: claim, ledger row, provider, slot record, ledger settle", async () => {
    await send24hReminderSmsToClient(input());
    expect(h.rpcs.map((c) => c.fn)).toEqual([
      "claim_reminder_sms_send",
      "begin_appointment_sms_message",
      "record_sms_result",
      "settle_sms_message",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  for (const [label, answer, outcome] of [
    ["an accepted", () => twilioAnswer(201, { sid: SID }), "accepted"],
    [
      "an AMBIGUOUS",
      () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      "unknown",
    ],
  ] as const) {
    it(`a settle that never answers cannot leave ${label} reminder unrecorded`, async () => {
      h.settle = "hang";
      fetchMock.mockImplementationOnce(answer);
      void send24hReminderSmsToClient(input());
      await vi.waitFor(() => expect(settled()).toHaveLength(1));
      expect(recorded(), "stamped sent before the settle was even started").toEqual([true]);
      expect(settled()[0]).toMatchObject({ p_outcome: outcome });
    });
  }

  it("a refusal is released before the settle as well, so it stays retryable", async () => {
    h.settle = "hang";
    fetchMock.mockImplementationOnce(() => twilioAnswer(400, { code: 21211 }));
    void send24hReminderSmsToClient(input());
    await vi.waitFor(() => expect(settled()).toHaveLength(1));
    expect(recorded()).toEqual([false]);
  });

  it("the booking confirmation follows the same order (one send discipline)", async () => {
    h.settle = "hang";
    void sendBookingConfirmationSmsToClient({
      admin: admin(),
      appointmentId: "appt-1",
      startsAt: new Date(START),
      timezone: "America/Vancouver",
      studio: {
        id: "studio-1",
        name: "Willow",
        send_confirmation_sms: true,
        send_24h_sms_reminders: true,
        send_2h_sms_reminders: true,
      },
      client: { phone: "604-555-0199", sms_consent_at: "2026-09-01T00:00:00Z", sms_opted_out_at: null },
      intakeUrl: null,
      manageUrl: null,
    });
    await vi.waitFor(() => expect(settled()).toHaveLength(1));
    expect(h.rpcs.map((c) => c.fn)).toEqual([
      "claim_sms_send",
      "begin_appointment_sms_message",
      "record_sms_result",
      "settle_sms_message",
    ]);
    expect(recorded()).toEqual([true]);
  });
});

// ===========================================================================
// THE LEDGER CAN NEVER HOLD UP A REMINDER (Codex P1 4224110912, P2 4224110922).
// Each ledger step is bounded well inside the five-minute claim lease:
// - a ledger row that stalls cannot keep this worker paused until another run
//   reclaims the stale slot and sends it too;
// - a settle that stalls cannot keep the cron's sequential batch from moving
//   on and writing its heartbeat.
// A step that runs out of time is abandoned: the reminder goes, or returns,
// as it would without a ledger.
// ===========================================================================
describe("each ledger step is bounded inside the claim lease", () => {
  it("the bound is far inside the five-minute lease", () => {
    expect(LEDGER_STEP_BOUND_MS).toBeGreaterThan(0);
    expect(LEDGER_STEP_BOUND_MS).toBeLessThanOrEqual(10_000);
  });

  it("a ledger row that never answers: the reminder still goes once, within the bound, without a StatusCallback", async () => {
    vi.useFakeTimers();
    h.begin = "hang";
    const pending = send24hReminderSmsToClient(input());
    await vi.advanceTimersByTimeAsync(LEDGER_STEP_BOUND_MS - 1);
    expect(fetchMock, "not before the bound").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true, messageSid: SID, intakeLinkIncluded: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentForm().has("StatusCallback")).toBe(false);
    expect(recorded()).toEqual([true]);
    expect(settled(), "no row id came back, so there is nothing to settle").toEqual([]);
  });

  it("a settle that never answers: the reminder returns within the bound, its slot already recorded", async () => {
    vi.useFakeTimers();
    h.settle = "hang";
    const pending = send24hReminderSmsToClient(input());
    await vi.advanceTimersByTimeAsync(LEDGER_STEP_BOUND_MS);
    await expect(pending).resolves.toEqual({ ok: true, messageSid: SID, intakeLinkIncluded: false });
    expect(recorded()).toEqual([true]);
    expect(settled()).toHaveLength(1);
  });

  it("the booking confirmation is bounded the same way", async () => {
    vi.useFakeTimers();
    h.begin = "hang";
    const pending = sendBookingConfirmationSmsToClient({
      admin: admin(),
      appointmentId: "appt-1",
      startsAt: new Date(START),
      timezone: "America/Vancouver",
      studio: {
        id: "studio-1",
        name: "Willow",
        send_confirmation_sms: true,
        send_24h_sms_reminders: true,
        send_2h_sms_reminders: true,
      },
      client: { phone: "604-555-0199", sms_consent_at: "2026-09-01T00:00:00Z", sms_opted_out_at: null },
      intakeUrl: null,
      manageUrl: null,
    });
    await vi.advanceTimersByTimeAsync(LEDGER_STEP_BOUND_MS);
    await expect(pending).resolves.toEqual({ ok: true, messageSid: SID });
    expect(recorded()).toEqual([true]);
  });
});

// ===========================================================================
// POSSIBLY SENT, AND WHAT THE MESSAGE CARRIED (Codex P2 4232680581). An
// ambiguous answer is recorded as sent and never retried, as before; the
// helper now says so explicitly instead of returning the shape of a definite
// failure, and reports whether the message carried the intake link, read from
// the message itself, so the cron can account for that link.
// ===========================================================================
describe("a possibly-sent reminder is named as such, with what it carried", () => {
  const INTAKE = "https://hone.care/intake/fixture-token";
  const ambiguous: Array<[label: string, answer: () => Promise<Response>, error: string]> = [
    ["a 5xx", () => twilioAnswer(503, {}), "twilio_http_503"],
    ["a success without a readable SID", () => twilioAnswer(201, { sid: "not-a-sid" }), "twilio_unreadable_success"],
    [
      "a reset mid-request",
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })),
      "twilio_network",
    ],
    ["a timeout", () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })), "twilio_timeout"],
  ];
  for (const [label, answer, error] of ambiguous) {
    it(`${label}: possibly sent, recorded sent, never retryable, carrying the link`, async () => {
      fetchMock.mockImplementationOnce(answer);
      const r = await send24hReminderSmsToClient(input({ intakeUrl: INTAKE }));
      expect(r).toEqual({ ok: false, possiblySent: true, error, retryable: false, intakeLinkIncluded: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(recorded()).toEqual([true]);
    });
  }

  it("control: a definite refusal is NOT possibly sent, and reports no composition", async () => {
    fetchMock.mockImplementationOnce(() => twilioAnswer(400, { code: 21211 }));
    expect(await send24hReminderSmsToClient(input({ intakeUrl: INTAKE }))).toEqual({
      ok: false,
      error: "twilio_http_400",
      retryable: false,
    });
    expect(recorded()).toEqual([false]);
  });

  it("control: a connection that never opened is NOT possibly sent", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
    );
    expect(await send24hReminderSmsToClient(input({ intakeUrl: INTAKE }))).toEqual({
      ok: false,
      error: "twilio_unreachable",
      retryable: true,
    });
  });

  it("an accepted reminder reports whether its message carried the link", async () => {
    expect(await send2hReminderSmsToClient(input({ intakeUrl: INTAKE }))).toEqual({
      ok: true,
      messageSid: SID,
      intakeLinkIncluded: true,
    });
    expect(sentForm().get("Body")).toContain(INTAKE);
    fetchMock.mockClear();
    expect(await send2hReminderSmsToClient(input({ intakeUrl: null }))).toEqual({
      ok: true,
      messageSid: SID,
      intakeLinkIncluded: false,
    });
    expect(sentForm().get("Body")).not.toContain("/intake/");
  });
});

// ===========================================================================
// ONE LEDGER BUDGET PER CRON RUN (Codex P1 4232680578). The run's two SMS
// passes share it (driven through the real route in
// tests/app/api/cron/reminder-ledger-run-budget.test.ts); here, one reminder's
// steps against it. Each step waits at most what is left and is charged its
// wait; a step that runs out of time spends the rest; once it is spent no
// ledger request is started. The reminder is still claimed, sent and recorded,
// and the record still comes before the settle.
// ===========================================================================
describe("one ledger budget per cron run", () => {
  it("is five seconds, whole for each run", () => {
    expect(LEDGER_RUN_BUDGET_MS).toBe(5_000);
    expect(LEDGER_RUN_BUDGET_MS).toBeLessThanOrEqual(LEDGER_STEP_BOUND_MS);
    const a = createLedgerBudget();
    expect(a).toEqual({ remainingMs: LEDGER_RUN_BUDGET_MS });
    expect(createLedgerBudget(), "a fresh budget per run, never a shared module value").not.toBe(a);
  });

  it("a spent budget starts NO ledger request; the reminder is still claimed, sent and recorded", async () => {
    const r = await send24hReminderSmsToClient(input({ ledgerBudget: { remainingMs: 0 } }));
    expect(r).toEqual({ ok: true, messageSid: SID, intakeLinkIncluded: false });
    expect(h.rpcs.map((c) => c.fn)).toEqual(["claim_reminder_sms_send", "record_sms_result"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentForm().has("StatusCallback")).toBe(false);
  });

  it("a step waits at most what is left, and running out of time spends the rest", async () => {
    vi.useFakeTimers();
    h.begin = "hang";
    const budget = { remainingMs: 1_000 };
    const pending = send24hReminderSmsToClient(input({ ledgerBudget: budget }));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock, "not before what was left of the budget").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(budget.remainingMs).toBe(0);
    expect(recorded()).toEqual([true]);
    expect(settled(), "no row came back, so there is nothing to settle").toEqual([]);
  });

  it("a step that answers in time is charged what it waited", async () => {
    vi.useFakeTimers();
    h.begin = { afterMs: 1_200 };
    const budget = createLedgerBudget();
    const pending = send24hReminderSmsToClient(input({ ledgerBudget: budget }));
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(budget.remainingMs).toBe(LEDGER_RUN_BUDGET_MS - 1_200);
    expect(settled()).toHaveLength(1);
  });

  it("a LATE answer, arriving after its step ran out of time, is ignored: no settle, no further request", async () => {
    vi.useFakeTimers();
    h.begin = { afterMs: LEDGER_RUN_BUDGET_MS + 2_000 };
    const budget = createLedgerBudget();
    const pending = send24hReminderSmsToClient(input({ ledgerBudget: budget }));
    await vi.advanceTimersByTimeAsync(LEDGER_RUN_BUDGET_MS);
    await expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(3_000); // the late row lands now
    expect(sentForm().has("StatusCallback"), "sent before any row existed").toBe(false);
    expect(h.rpcs.map((c) => c.fn)).toEqual([
      "claim_reminder_sms_send",
      "begin_appointment_sms_message",
      "record_sms_result",
    ]);
    expect(budget.remainingMs).toBe(0);
  });

  it("under a budget the record still comes before the settle", async () => {
    await send24hReminderSmsToClient(input({ ledgerBudget: createLedgerBudget() }));
    expect(h.rpcs.map((c) => c.fn)).toEqual([
      "claim_reminder_sms_send",
      "begin_appointment_sms_message",
      "record_sms_result",
      "settle_sms_message",
    ]);
  });
});


describe("MSG006 production final-failure observer", () => {
  function definiteNonSend() {
    fetchMock.mockImplementationOnce(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })));
  }
  it.each([["reminder_24h", send24hReminderSmsToClient], ["reminder_2h", send2hReminderSmsToClient]] as const)("%s third definite failure uses scoped settled accounting and existing alert", async (smsType, send) => {
    h.attemptNumber = 3; definiteNonSend();
    expect(await send(input())).toEqual({ ok: false, error: "twilio_unreachable", retryable: true });
    await flush();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ event: "sms_send_failed", severity: "warning", safeDetails: { sms_type: smsType, attempt_number: 3, retryable: true } });
    expect(h.attemptReads).toHaveLength(1);
    const read = h.attemptReads[0];
    expect(read.columns).toBe(`sms_${smsType}_send_attempts, sms_${smsType}_sent_at, sms_${smsType}_claimed_at`);
    expect(read.filters).toEqual([["id", "appt-1"], ["studio_id", "studio-1"]]);
    expect(read.signal).toBeInstanceOf(AbortSignal);
    expect(read.rpcsBefore).toEqual(["claim_reminder_sms_send", "begin_appointment_sms_message", "record_sms_result", "settle_sms_message"]);
    expect(recorded()).toEqual([false]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1, 2])("attempt %s remains below the existing alert threshold", async (count) => {
    h.attemptNumber = count; definiteNonSend();
    expect((await send24hReminderSmsToClient(input())).ok).toBe(false); await flush();
    expect(h.attemptReads).toHaveLength(1); expect(alerts).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([null, "3", -1, 1.5])("malformed accounting %s cannot manufacture exhaustion", async (count) => {
    h.attemptNumber = count; definiteNonSend();
    expect((await send24hReminderSmsToClient(input())).ok).toBe(false); await flush();
    expect(h.attemptReads).toHaveLength(1); expect(alerts).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["sent", "later claim", "read error"] as const)("%s cannot manufacture exhaustion", async (state) => {
    h.attemptNumber = 3;
    if (state === "sent") h.sentAt = START;
    if (state === "later claim") h.laterClaim = START;
    if (state === "read error") h.readMode = "error";
    definiteNonSend();
    expect((await send24hReminderSmsToClient(input())).ok).toBe(false); await flush();
    expect(h.attemptReads).toHaveLength(1); expect(alerts).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["accepted", "ambiguous", "terminal refusal"] as const)("%s does not start the accounting observer", async (state) => {
    if (state === "ambiguous") fetchMock.mockImplementationOnce(() => twilioAnswer(201, {}));
    if (state === "terminal refusal") fetchMock.mockImplementationOnce(() => twilioAnswer(400, { code: 21211 }));
    const result = await send24hReminderSmsToClient(input());
    expect(result.ok).toBe(state === "accepted"); expect(h.attemptReads).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorded()).toEqual([state !== "terminal refusal"]);
  });
  it("a throwing observer diagnostic preserves the definite failure without private payloads or retry", async () => {
    h.readMode = "error"; definiteNonSend();
    vi.mocked(console.error).mockImplementation((value) => {
      if (String(value).includes("sms_reminder_attempt_read_failed")) throw new Error("SYNTHETIC_PRIVATE sink failure");
    });
    expect(await send24hReminderSmsToClient(input())).toEqual({ ok: false, error: "twilio_unreachable", retryable: true });
    const observer = vi.mocked(console.error).mock.calls.filter(call => String(call[0]).includes("sms_reminder_attempt_read_failed"));
    expect(observer).toHaveLength(1);
    expect(JSON.parse(String(observer[0][0]))).toEqual({ event: "sms_reminder_attempt_read_failed", smsType: "reminder_24h", timestamp: expect.any(String) });
    expect(JSON.stringify(observer)).not.toMatch(/SYNTHETIC_PRIVATE|appt-1|studio-1|555/);
    expect(h.attemptReads).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1); expect(recorded()).toEqual([false]);
  });
  it("an observer that ignores abort still returns within1000ms without extra sends", async () => {
    vi.useFakeTimers(); h.readMode = "hang"; definiteNonSend(); let finished = false;
    const pending = send24hReminderSmsToClient(input()).then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(999); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: "twilio_unreachable", retryable: true });
    expect(h.attemptReads).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1); expect(recorded()).toEqual([false]);
  });
  it("failed result recording with an active claim remains unknown accounting", async () => {
    h.recordError = true; h.laterClaim = START; h.attemptNumber = 3; definiteNonSend();
    expect((await send24hReminderSmsToClient(input())).ok).toBe(false); await flush();
    expect(h.attemptReads).toHaveLength(1); expect(alerts).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe("MSG-007 SMS diagnostics carry only closed metadata", () => {
  const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
  const PRIVATE = "PRIVATE patient@example.invalid +16045550199 https://example.invalid/manage/SECRET_TOKEN clinical note";
  const output = () => JSON.stringify([vi.mocked(console.error).mock.calls, vi.mocked(console.log).mock.calls]);
  it.each(["claim", "record"] as const)("%s RPC failure never exports raw error/record content", async (operation) => {
    const rpc = vi.fn(async () => ({ data: null, error: new Error(PRIVATE) }));
    const a = { rpc } as unknown as SupabaseClient;
    const result = operation === "claim" ? await claimSmsSend(a, APPOINTMENT_ID, "reminder_24h") : await recordSmsResult(a, APPOINTMENT_ID, "reminder_24h", false);
    expect(result).toBe(operation === "claim" ? false : undefined);
    expect(rpc).toHaveBeenCalledWith(operation === "claim" ? "claim_sms_send" : "record_sms_result", {
      p_appointment_id: APPOINTMENT_ID, p_sms_type: "reminder_24h", ...(operation === "claim" ? {} : { p_success: false }),
    });
    expect(output()).toContain("reminder_24h");
    for (const value of [APPOINTMENT_ID, "PRIVATE", "patient@example.invalid", "SECRET_TOKEN", "clinical note"]) expect(output()).not.toContain(value);
  });
  it("failure alert keeps first-party lineage but excludes arbitrary provider content", async () => {
    logSmsFailure({ appointmentId: APPOINTMENT_ID, smsType: "reminder_24h", error: PRIVATE, retryable: false, attemptNumber: 3 });
    await flush();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ appointmentId: APPOINTMENT_ID, event: "sms_send_failed", safeDetails: { sms_type: "reminder_24h", attempt_number: 3 } });
    expect(output()).not.toContain(APPOINTMENT_ID);
    expect(JSON.stringify([output(), alerts[0]?.safeDetails, alerts[0]?.message])).not.toMatch(/PRIVATE|patient@example|SECRET_TOKEN|clinical note/);
  });
  it("unexpected runtime diagnostic types/counts cannot carry private fields", async () => {
    logSmsFailure({ appointmentId: APPOINTMENT_ID, smsType: PRIVATE as "reminder_24h", error: PRIVATE, retryable: false, attemptNumber: 16045550199 });
    await flush();
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify([output(), alerts[0]?.safeDetails, alerts[0]?.message])).not.toMatch(/PRIVATE|patient@example|SECRET_TOKEN|16045550199/);
    expect(alerts[0]).toMatchObject({ safeDetails: { sms_type: "unknown", attempt_number: null } });
  });
  it.each(["claim", "record"] as const)("throwing diagnostic sink cannot change %s RPC failure semantics", async (operation) => {
    const a = { rpc: vi.fn(async () => ({ data: null, error: new Error(PRIVATE) })) } as unknown as SupabaseClient;
    vi.mocked(console.error).mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE sink"); });
    const result = operation === "claim" ? await claimSmsSend(a, APPOINTMENT_ID, "reminder_24h") : await recordSmsResult(a, APPOINTMENT_ID, "reminder_24h", false);
    expect(result).toBe(operation === "claim" ? false : undefined);
  });
  it("throwing diagnostic sink cannot suppress an existing final-attempt alert", async () => {
    vi.mocked(console.error).mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE sink"); });
    expect(() => logSmsFailure({ appointmentId: APPOINTMENT_ID, smsType: "reminder_24h", error: PRIVATE, retryable: false, attemptNumber: 3 })).not.toThrow();
    await vi.waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0]).toMatchObject({ event: "sms_send_failed", appointmentId: APPOINTMENT_ID });
    expect(JSON.stringify([alerts[0]?.message, alerts[0]?.safeDetails])).not.toContain("PRIVATE");
  });
  it.each(["claim", "record"] as const)("successful %s RPC keeps its return and emits no diagnostic", async (operation) => {
    const a = { rpc: vi.fn(async () => ({ data: true, error: null })) } as unknown as SupabaseClient;
    const result = operation === "claim" ? await claimSmsSend(a, APPOINTMENT_ID, "reminder_24h") : await recordSmsResult(a, APPOINTMENT_ID, "reminder_24h", true);
    expect(result).toBe(operation === "claim" ? true : undefined);
    expect(output()).toBe("[[],[]]");
  });
  it("lower retryable attempt stays log-only with its existing predicate", async () => {
    logSmsFailure({ appointmentId: APPOINTMENT_ID, smsType: "reminder_24h", error: "twilio_http_503", retryable: true, attemptNumber: 1 });
    await flush();
    expect(alerts).toHaveLength(0);
    expect(output()).toContain("sms_send_failed");
  });

});

// ===========================================================================
// MSG-007 — the SUCCESS path logs the minimum necessary.
// ===========================================================================
//
// The failure path was bounded in #1016/#1038 (fixed reasons, no ids). The
// success line `sms_sent` went out through raw console.log with the
// appointment's record id and a masked destination ("+1***99" still discloses
// the last two digits). It now carries the event, the SMS type and the
// provider message SID only. The appointment and destination stay in the
// delivery ledger, which is where an operator correlates them.
describe("MSG-007 success-path log privacy", () => {
  const APPT = "7d3f1c2e-1b4a-4c5d-8e6f-0a1b2c3d4e5f";
  const PHONE = "604-555-0199";

  it("a sent reminder logs sms_sent with no record id, phone fragment or body", async () => {
    const { captureConsole, expectMinimumNecessary } = await import("./helpers/log-capture");
    const logs = captureConsole();
    const r = await send24hReminderSmsToClient(input({ appointmentId: APPT }));
    expect(r.ok).toBe(true);
    const body = sentForm().get("Body")!;
    expectMinimumNecessary(logs.text(), { phones: [PHONE, "+16045550199"], bodies: [body] });
    // Operator-useful fixed facts survive.
    expect(logs.events()).toContainEqual(
      expect.objectContaining({ event: "sms_sent", smsType: "reminder_24h", messageSid: SID }),
    );
  });

  it("a sent booking confirmation logs sms_sent with no record id, phone fragment or body", async () => {
    const { captureConsole, expectMinimumNecessary } = await import("./helpers/log-capture");
    const logs = captureConsole();
    const r = await sendBookingConfirmationSmsToClient({
      admin: admin(),
      appointmentId: APPT,
      startsAt: new Date(START),
      timezone: "America/Vancouver",
      studio: {
        id: "5e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b",
        name: "Synthetic Studio",
        send_confirmation_sms: true,
        send_24h_sms_reminders: true,
        send_2h_sms_reminders: true,
      },
      client: { phone: PHONE, sms_consent_at: "2026-09-01T00:00:00Z", sms_opted_out_at: null },
      intakeUrl: null,
      manageUrl: null,
    });
    expect(r.ok).toBe(true);
    const body = sentForm().get("Body")!;
    expectMinimumNecessary(logs.text(), { phones: [PHONE, "+16045550199"], bodies: [body] });
    expect(logs.events()).toContainEqual(
      expect.objectContaining({ event: "sms_sent", smsType: "confirmation", messageSid: SID }),
    );
  });
});
