import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  WAITLIST_SMS_RETRY_DELAY_MS,
  sendWaitlistInvitationSms,
} from "@/lib/waitlist/delivery/sms";
import { invitationExpiryLabel } from "@/lib/waitlist/delivery/policy";

const alerts: Array<Record<string, unknown>> = [];
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (input: Record<string, unknown>) => {
    alerts.push(input);
    return Promise.resolve();
  },
}));

// ===========================================================================
// SMS-01 — the waitlist invitation's text.
//
// Real: prospectMayReceiveSms (the one eligibility authority), phone
// normalisation, the template, the expiry label shared with the email, the
// transport's answer classification and the ledger mapping. Substituted: the
// database (claim + settle) and the network.
//
// Cases: duplicates (the database claim), the studio switch and liveness,
// missing consent / opt-out / unverified mobile / unusable phone, provider
// failures (refused, retried-once, ambiguous-never-retried), the secure link
// and the shared deadline, and that no secret reaches a log.
// ===========================================================================

const ROW = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";
const SID = `SM${"5e".repeat(16)}`;
const TOKEN = "t".repeat(43);
const URL_ = `https://hone.care/invitation/${TOKEN}`;
const EXPIRES = "2026-10-09T17:00:00.000Z";

type Claim = Record<string, unknown>;
const target = (over: Claim = {}): Claim => ({
  result: "claimed",
  message_id: ROW,
  phone: "(604) 555-0199",
  sms_consent_at: "2026-09-01T00:00:00Z",
  sms_opted_out_at: null,
  mobile_verified_at: "2026-09-01T00:05:00Z",
  expires_at: EXPIRES,
  ...over,
});

const h: { claim: { data: unknown; error: unknown }; rpcs: Array<{ fn: string; args: Record<string, unknown> }> } = {
  claim: { data: [target()], error: null },
  rpcs: [],
};

function admin(): SupabaseClient {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      h.rpcs.push({ fn, args });
      if (fn === "claim_waitlist_invitation_sms") return Promise.resolve(h.claim);
      if (fn === "settle_sms_message") return Promise.resolve({ data: "settled", error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
    },
  } as unknown as SupabaseClient;
}

const sleeps: number[] = [];
const send = () =>
  sendWaitlistInvitationSms({
    admin: admin(),
    studio: { id: "studio-1", name: "Willow" },
    invitationId: "inv-1",
    invitationUrl: URL_,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

const ENV_KEYS = ["VERCEL_ENV", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_WEBHOOK_BASE_URL"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[] = [];
const answer = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VERCEL_ENV;
  process.env.TWILIO_ACCOUNT_SID = `AC${"1".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://hone.care";
  h.claim = { data: [target()], error: null };
  h.rpcs = [];
  sleeps.length = 0;
  alerts.length = 0;
  logs = [];
  fetchMock = vi.fn(() => answer(201, { sid: SID }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const settled = () => h.rpcs.filter((c) => c.fn === "settle_sms_message").map((c) => c.args);
const form = (i = 0) => new URLSearchParams(String(fetchMock.mock.calls[i]![1]!.body));

describe("an eligible prospect is texted once, with the secure link and the email's deadline", () => {
  it("sends one SMS and records it accepted", async () => {
    expect(await send()).toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = form().get("Body")!;
    expect(body).toContain("Willow");
    expect(body).toContain(URL_);
    expect(body).toContain(invitationExpiryLabel(new Date(EXPIRES)));
    expect(body).toMatch(/STOP/);
    expect(form().get("To")).toBe("+16045550199");
    expect(form().get("StatusCallback")).toBe(`https://hone.care/api/twilio/message-status?m=${ROW}`);
    expect(settled()).toEqual([
      expect.objectContaining({ p_message_id: ROW, p_outcome: "accepted", p_provider_message_sid: SID }),
    ]);
  });

  it("claims for exactly this studio and invitation", async () => {
    await send();
    expect(h.rpcs[0]).toEqual({
      fn: "claim_waitlist_invitation_sms",
      args: { p_studio_id: "studio-1", p_invitation_id: "inv-1" },
    });
  });
});

describe("duplicates, the studio switch and liveness are the DATABASE's answer", () => {
  for (const result of ["already_claimed", "studio_disabled", "not_live", "not_found"]) {
    it(`${result} -> no text, nothing settled`, async () => {
      h.claim = { data: [{ result }], error: null };
      expect(await send()).toEqual({ state: "not_claimed", reason: result });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(settled()).toEqual([]);
    });
  }

  it("a claim that cannot be reached fails CLOSED: no text", async () => {
    h.claim = { data: null, error: { message: "function does not exist" } };
    expect(await send()).toEqual({ state: "not_claimed", reason: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("eligibility is prospectMayReceiveSms's, and every 'no' is recorded with its reason", () => {
  for (const [label, over, reason] of [
    ["STOP wins over consent and verification", { sms_opted_out_at: "2026-09-03T00:00:00Z" }, "opted_out"],
    ["an unverified number is not a channel", { mobile_verified_at: null }, "mobile_unverified"],
    ["no consent", { sms_consent_at: null }, "no_consent"],
    ["an unusable phone", { phone: "12345" }, "invalid_phone"],
  ] as const) {
    it(`${label} -> skipped (${reason})`, async () => {
      h.claim = { data: [target(over)], error: null };
      expect(await send()).toEqual({ state: "skipped", reason });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(settled()).toEqual([expect.objectContaining({ p_outcome: "skipped", p_skip_reason: reason })]);
    });
  }

  it("a preview deployment is fenced and recorded as such", async () => {
    process.env.VERCEL_ENV = "preview";
    expect(await send()).toEqual({ state: "skipped", reason: "non_production_deployment" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("provider failures", () => {
  it("a definite refusal is recorded with its code and not retried", async () => {
    fetchMock.mockImplementationOnce(() => answer(400, { code: 21211 }));
    expect(await send()).toEqual({ state: "refused" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled()).toEqual([expect.objectContaining({ p_outcome: "refused", p_provider_error_code: 21211 })]);
  });

  it("rate-limited (definitely not sent) is tried ONCE more after a short gap", async () => {
    fetchMock.mockImplementationOnce(() => answer(429, { code: 20429 }));
    expect(await send()).toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([WAITLIST_SMS_RETRY_DELAY_MS]);
    expect(settled()).toHaveLength(1);
  });

  it("a connection that never opened is tried once more, then recorded refused", async () => {
    const unreachable = () =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    fetchMock.mockImplementationOnce(unreachable).mockImplementationOnce(unreachable);
    expect(await send()).toEqual({ state: "refused" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an AMBIGUOUS answer is never retried: it may already have reached the prospect", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    expect(await send()).toEqual({ state: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(settled()).toEqual([expect.objectContaining({ p_outcome: "unknown" })]);
  });
});

describe("a text that did not go raises ONE ops alert; every other outcome raises none", () => {
  it("refused: one sms_send_failed warning with the provider code and no secret", async () => {
    fetchMock.mockImplementationOnce(() => answer(400, { code: 21211 }));
    await send();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "warning",
      event: "sms_send_failed",
      studioId: "studio-1",
      safeDetails: { purpose: "waitlist_invitation", sms_message_id: ROW, outcome: "refused", provider_error_code: 21211 },
    });
    const text = JSON.stringify(alerts[0]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/6045550199|\/invitation\//);
  });

  it("an answer that was lost: one warning with outcome unknown", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    await send();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ safeDetails: { outcome: "unknown", error: "twilio_timeout" } });
  });

  it("rate-limited twice (the one retry spent): one warning", async () => {
    fetchMock.mockImplementationOnce(() => answer(429, { code: 20429 })).mockImplementationOnce(() => answer(429, { code: 20429 }));
    expect(await send()).toEqual({ state: "refused" });
    expect(alerts).toHaveLength(1);
  });

  it("accepted, skipped and unclaimed raise nothing", async () => {
    await send();
    h.claim = { data: [target({ mobile_verified_at: null })], error: null };
    await send();
    h.claim = { data: [{ result: "studio_disabled" }], error: null };
    await send();
    expect(alerts).toEqual([]);
  });
});

describe("no secret reaches a log", () => {
  it("the token, the link and the phone appear in no log line, on any path", async () => {
    await send();
    h.claim = { data: [target({ sms_opted_out_at: "2026-09-03T00:00:00Z" })], error: null };
    await send();
    fetchMock.mockImplementationOnce(() => answer(400, { code: 21211, message: `bad To ${URL_}` }));
    h.claim = { data: [target()], error: null };
    await send();
    const all = logs.join("\n");
    expect(all).toContain("waitlist_invitation_sms");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("/invitation/");
    expect(all).not.toMatch(/6045550199|604\) 555/);
  });
});
