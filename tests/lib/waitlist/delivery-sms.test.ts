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

type Candidate = { id: string; studio_id: string; phone: string | null; sms_opted_out_at: string | null };

const h: {
  claim: { data: unknown; error: unknown };
  /** "hang": settle_sms_message never answers (a stalled or killed request). */
  settle: "ok" | "hang";
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  /** 0208: opted-out client rows the phone-wide STOP read returns. */
  optedOutClients: Candidate[];
  /** 0208: every prospect row with a phone, as 0202's candidates command returns them. */
  prospectCandidates: Candidate[];
  /** 0208: the phone-wide STOP read fails. */
  lookupFails: boolean;
} = {
  claim: { data: [target()], error: null },
  settle: "ok",
  rpcs: [],
  optedOutClients: [],
  prospectCandidates: [],
  lookupFails: false,
};

function admin(): SupabaseClient {
  // The clients read the phone-wide lookup issues: select + two `not` filters,
  // then awaited. Only opted-out rows are ever returned, as the filter asks.
  const clientsQuery = {
    select: () => clientsQuery,
    not: () => clientsQuery,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        h.lookupFails
          ? { data: null, error: { message: "read failed" } }
          : { data: h.optedOutClients, error: null },
      ).then(resolve),
  };
  return {
    from(table: string) {
      if (table !== "clients") throw new Error(`unexpected table ${table}`);
      return clientsQuery;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      h.rpcs.push({ fn, args });
      if (fn === "claim_waitlist_invitation_sms") return Promise.resolve(h.claim);
      if (fn === "settle_sms_message") {
        return h.settle === "hang"
          ? new Promise(() => undefined)
          : Promise.resolve({ data: "settled", error: null });
      }
      if (fn === "waitlist_prospect_suppression_candidates") {
        return Promise.resolve({ data: h.prospectCandidates, error: null });
      }
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
  h.settle = "ok";
  h.rpcs = [];
  h.optedOutClients = [];
  h.prospectCandidates = [];
  h.lookupFails = false;
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
    ["STOP wins over consent on an unverified number", { sms_opted_out_at: "2026-09-03T00:00:00Z", mobile_verified_at: null }, "opted_out"],
    ["no consent", { sms_consent_at: null }, "no_consent"],
    ["no consent, whatever the verification", { sms_consent_at: null, mobile_verified_at: null }, "no_consent"],
    ["an unusable phone", { phone: "12345" }, "invalid_phone"],
    ["an unusable phone, even with consent and no verification", { phone: "12345", mobile_verified_at: null }, "invalid_phone"],
    ["no phone at all", { phone: null, mobile_verified_at: null }, "invalid_phone"],
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

  // ---- D4(2), Roadmap v1.25: verification is optional; the protections stay ----

  it("VERIFICATION IS OPTIONAL: an unverified number with recorded consent is texted", async () => {
    h.claim = { data: [target({ mobile_verified_at: null })], error: null };
    expect(await send()).toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled()).toEqual([expect.objectContaining({ p_outcome: "accepted", p_provider_message_sid: SID })]);
  });

  it("CONSENT BINDING: the text goes only to the number the claim read beside the consent", async () => {
    // The claim reads phone and consent from one locked row, and the database
    // never lets a stored phone change, so this is the consented number.
    h.claim = { data: [target({ phone: "(604) 555-0142", mobile_verified_at: null })], error: null };
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form().get("To")).toBe("+16045550142");
    expect(form().get("Body")).not.toMatch(/555/);
  });

  it("THE PRODUCTION FENCE: an eligible, unverified prospect on a preview is never texted", async () => {
    process.env.VERCEL_ENV = "preview";
    h.claim = { data: [target({ mobile_verified_at: null })], error: null };
    expect(await send()).toEqual({ state: "skipped", reason: "non_production_deployment" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settled()).toEqual([
      expect.objectContaining({ p_outcome: "skipped", p_skip_reason: "non_production_deployment" }),
    ]);
  });

  it("NO mobile_unverified skip is produced any more", async () => {
    for (const over of [{ mobile_verified_at: null }, {}]) {
      h.claim = { data: [target(over)], error: null };
      expect(await send()).toEqual({ state: "accepted" });
    }
    expect(settled().map((a) => a.p_skip_reason)).not.toContain("mobile_unverified");
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

  // DURABLE: the alert is the operator's only signal for a text that will never
  // be retried, so it must not wait on the ledger's best-effort settle. A
  // settle that stalls, or an invocation killed during it, cannot swallow it.
  for (const [label, providerAnswer, outcome] of [
    ["refused", () => answer(400, { code: 21211 }), "refused"],
    ["lost", () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })), "unknown"],
  ] as const) {
    it(`${label}: the alert is raised even when the ledger settle never answers`, async () => {
      h.settle = "hang";
      fetchMock.mockImplementationOnce(providerAnswer);
      void send();
      await vi.waitFor(() => expect(settled()).toHaveLength(1));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ event: "sms_send_failed", safeDetails: { outcome } });
    });
  }

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

// ===========================================================================
// 0208 — STOP PRECEDENCE AT THE MOMENT OF SENDING, and practitioner consent.
// ===========================================================================

describe("STOP is phone-wide and wins over any recorded consent (0208)", () => {
  const STOPPED_AT = "2026-09-20T10:00:00Z";

  it("a STOP on a CLIENT row in another studio, in another format, blocks the text", async () => {
    // The claimed prospect is (604) 555-0199; the client wrote it as E.164.
    h.optedOutClients = [
      { id: "client-x", studio_id: "studio-other", phone: "+16045550199", sms_opted_out_at: STOPPED_AT },
    ];
    expect(await send()).toEqual({ state: "skipped", reason: "opted_out" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settled()).toEqual([
      expect.objectContaining({ p_message_id: ROW, p_outcome: "skipped", p_skip_reason: "opted_out" }),
    ]);
    expect(alerts).toHaveLength(0);
  });

  it("a STOP on another PROSPECT row with the same number blocks the text", async () => {
    h.prospectCandidates = [
      { id: "entry-old", studio_id: "studio-1", phone: "604-555-0199", sms_opted_out_at: STOPPED_AT },
      { id: "entry-new", studio_id: "studio-1", phone: "604-555-0199", sms_opted_out_at: null },
    ];
    expect(await send()).toEqual({ state: "skipped", reason: "opted_out" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an opt-out on a DIFFERENT number does not block the text", async () => {
    h.optedOutClients = [
      { id: "client-y", studio_id: "studio-1", phone: "604-555-0100", sms_opted_out_at: STOPPED_AT },
    ];
    expect(await send()).toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unreadable STOP check fails CLOSED and says so", async () => {
    h.lookupFails = true;
    expect(await send()).toEqual({ state: "skipped", reason: "suppression_check_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settled()).toEqual([
      expect.objectContaining({ p_outcome: "skipped", p_skip_reason: "suppression_check_failed" }),
    ]);
  });

  it("the row's own STOP still wins before the phone-wide read", async () => {
    h.claim = { data: [target({ sms_opted_out_at: STOPPED_AT })], error: null };
    expect(await send()).toEqual({ state: "skipped", reason: "opted_out" });
    expect(h.rpcs.map((c) => c.fn)).not.toContain("waitlist_prospect_suppression_candidates");
  });
});

describe("a practitioner-recorded consent is texted like any recorded consent (D4(2))", () => {
  it("consent on record, no STOP, no verification: one text", async () => {
    // The claim returns only the consent instant; who recorded it does not
    // change eligibility, and verification is optional.
    h.claim = { data: [target({ mobile_verified_at: null })], error: null };
    expect(await send()).toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no consent on record: no text, whatever the phone", async () => {
    h.claim = { data: [target({ sms_consent_at: null })], error: null };
    expect(await send()).toEqual({ state: "skipped", reason: "no_consent" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
