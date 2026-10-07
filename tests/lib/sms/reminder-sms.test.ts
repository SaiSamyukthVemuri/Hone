import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
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
  begin: { data: unknown; error: unknown };
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
} = {
  claim: { result: "claimed", starts_at: START },
  begin: { data: LEDGER_ROW, error: null },
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
      if (fn === "begin_appointment_sms_message") return Promise.resolve(h.begin);
      if (fn === "settle_sms_message") return Promise.resolve({ data: "settled", error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      throw new Error("the reminder path must not read the appointment outside its claim");
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
  h.rpcs = [];
  alerts.length = 0;
  manageFor.length = 0;
  fetchMock = vi.fn(() => twilioAnswer(201, { sid: SID }));
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

const calls = (fn: string) => h.rpcs.filter((c) => c.fn === fn);
const recorded = () => calls("record_sms_result").map((c) => c.args.p_success);
const settled = () => calls("settle_sms_message").map((c) => c.args);
const sentForm = () => new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body));
// Vitest's flush: logSmsFailure raises its alert in a detached async task.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a reminder that sends", () => {
  it("claims, sends once in the studio's timezone, records it sent, and ledgers it", async () => {
    const r = await send24hReminderSmsToClient(input());
    expect(r).toEqual({ ok: true, messageSid: SID });
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
    expect(r).toEqual({ ok: false, error: "twilio_timeout", retryable: false });
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
    expect(await send24hReminderSmsToClient(input())).toEqual({
      ok: false,
      error: "reminder_claim_unavailable",
      retryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded(), "nothing was claimed, so nothing is released").toEqual([]);
  });

  it("the appointment is never read outside the claim (the mock throws if it is)", async () => {
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
