import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  WAITLIST_JOIN_ACK_SMS_RETRY_DELAY_MS,
  sendWaitlistJoinAckSms,
} from "@/lib/waitlist/delivery/join-ack-sms";
import { buildWaitlistJoinAckSms } from "@/lib/sms/templates";
import { pagedSource } from "@/tests/lib/sms/helpers/postgrest-pages";

const alerts: Array<Record<string, unknown>> = [];
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (input: Record<string, unknown>) => {
    alerts.push(input);
    return Promise.resolve();
  },
}));

// ===========================================================================
// SMS-04 — the ONE text a genuinely new waitlist join gets.
//
// Real: prospectMayReceiveSms (the one eligibility authority), phone
// normalisation, the template, the transport's answer classification, the
// production fence and the ledger mapping. Substituted: the database (claim,
// settle, the phone-wide STOP reads) and the network.
//
// The claim's own rules -- only a fresh public-form Yes, once per entry, once
// per number per day, the studio switch -- are the DATABASE's, proved against
// a real database in tests/db/sms-waitlist-join-ack.db.test.ts. Here: every
// refusal sends nothing, and after a claim the same protections as the
// invitation text apply in the same order.
// ===========================================================================

const ROW = "6d1f2a0e-3b7c-4e55-9a1d-1c2b3d4e5f60";
const SID = `SM${"7a".repeat(16)}`;

type Claim = Record<string, unknown>;
const target = (over: Claim = {}): Claim => ({
  result: "claimed",
  message_id: ROW,
  phone: "(604) 555-0199",
  sms_consent_at: "2026-10-10T15:00:01Z",
  sms_opted_out_at: null,
  mobile_verified_at: null,
  ...over,
});

type Candidate = { id: string; studio_id: string; phone: string | null; sms_opted_out_at: string | null };

const h: {
  claim: { data: unknown; error: unknown };
  settle: "ok" | "hang";
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  optedOutClients: Candidate[];
  prospectCandidates: Candidate[];
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
  const clients = pagedSource(() => h.optedOutClients, { fail: () => h.lookupFails });
  const prospects = pagedSource(() => h.prospectCandidates);
  return {
    from(table: string) {
      if (table !== "clients") throw new Error(`unexpected table ${table}`);
      return clients.query();
    },
    rpc(fn: string, args: Record<string, unknown>) {
      h.rpcs.push({ fn, args });
      if (fn === "claim_waitlist_join_ack_sms") return Promise.resolve(h.claim);
      if (fn === "settle_sms_message") {
        return h.settle === "hang"
          ? new Promise(() => undefined)
          : Promise.resolve({ data: "settled", error: null });
      }
      if (fn === "waitlist_prospect_suppression_candidates") return prospects.query();
      return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
    },
  } as unknown as SupabaseClient;
}

const sleeps: number[] = [];
const send = () =>
  sendWaitlistJoinAckSms({
    admin: admin(),
    studio: { id: "studio-1", name: "Willow" },
    entryId: "entry-1",
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

describe("the text itself", () => {
  it("is the approved copy, with the studio first", () => {
    expect(buildWaitlistJoinAckSms({ studioName: "Willow Electrolysis" })).toBe(
      "Willow Electrolysis: you've joined our waitlist. We'll contact you when you're invited to book. Reply STOP to opt out.",
    );
  });

  it("carries no link: there is nothing to do yet, and a link could read as a way to rejoin", () => {
    const body = buildWaitlistJoinAckSms({ studioName: "Willow" });
    expect(body).not.toMatch(/https?:|\/invitation\/|\/book\//i);
  });

  it("stays in one GSM-7 segment: plain ASCII, at most 160 characters for a long studio name", () => {
    const body = buildWaitlistJoinAckSms({ studioName: "A".repeat(50) });
    expect(body.length).toBeLessThanOrEqual(160);
    // No typographic quote or other non-ASCII character in the fixed copy.
    expect(buildWaitlistJoinAckSms({ studioName: "Studio" })).toMatch(/^[\x20-\x7E]+$/);
  });

  it("an empty studio name still names a sender", () => {
    expect(buildWaitlistJoinAckSms({ studioName: "   " })).toMatch(/^Your clinic: you've joined/);
  });
});

describe("a claimed join is texted once", () => {
  it("sends ONE text to the number the claim read, and records it accepted", async () => {
    expect(await send()).toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form().get("Body")).toBe(buildWaitlistJoinAckSms({ studioName: "Willow" }));
    expect(form().get("To")).toBe("+16045550199");
    expect(form().get("StatusCallback")).toBe(`https://hone.care/api/twilio/message-status?m=${ROW}`);
    expect(settled()).toEqual([
      expect.objectContaining({ p_message_id: ROW, p_outcome: "accepted", p_provider_message_sid: SID }),
    ]);
    expect(alerts).toHaveLength(0);
  });

  it("claims for exactly this studio and entry", async () => {
    await send();
    expect(h.rpcs[0]).toEqual({
      fn: "claim_waitlist_join_ack_sms",
      args: { p_studio_id: "studio-1", p_entry_id: "entry-1" },
    });
  });
});

describe("every database refusal sends nothing and settles nothing", () => {
  for (const result of [
    "already_claimed",
    "recently_acknowledged",
    "not_eligible",
    "not_fresh",
    "studio_disabled",
    "not_found",
    "invalid_input",
  ]) {
    it(`${result} -> no text`, async () => {
      h.claim = { data: [{ result }], error: null };
      expect(await send()).toEqual({ state: "not_claimed", reason: result });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(settled()).toEqual([]);
      expect(alerts).toHaveLength(0);
    });
  }

  it("a claim that cannot be reached fails CLOSED", async () => {
    h.claim = { data: null, error: { message: "function does not exist" } };
    expect(await send()).toEqual({ state: "not_claimed", reason: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unrecognised answer, or a claim without a ledger row id, fails CLOSED", async () => {
    for (const data of [[{ result: "maybe" }], [{ result: "claimed", message_id: "not-a-uuid" }], [], null]) {
      h.claim = { data, error: null };
      expect(await send()).toEqual({ state: "not_claimed", reason: "unavailable" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("after the claim: the invitation text's protections, in the same order", () => {
  for (const [label, over, reason] of [
    ["the row's own STOP", { sms_opted_out_at: "2026-10-10T15:01:00Z" }, "opted_out"],
    ["no consent on the row", { sms_consent_at: null }, "no_consent"],
    ["an unusable phone", { phone: "12345" }, "invalid_phone"],
    ["no phone at all", { phone: null }, "invalid_phone"],
  ] as const) {
    it(`${label} -> skipped (${reason}), no text`, async () => {
      h.claim = { data: [target(over)], error: null };
      expect(await send()).toEqual({ state: "skipped", reason });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(settled()).toEqual([expect.objectContaining({ p_outcome: "skipped", p_skip_reason: reason })]);
    });
  }

  it("STOP IS PHONE-WIDE: a client in another studio who said STOP, written differently, blocks it", async () => {
    h.optedOutClients = [
      { id: "client-x", studio_id: "studio-other", phone: "+16045550199", sms_opted_out_at: "2026-09-20T10:00:00Z" },
    ];
    expect(await send()).toEqual({ state: "skipped", reason: "opted_out" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settled()).toEqual([
      expect.objectContaining({ p_message_id: ROW, p_outcome: "skipped", p_skip_reason: "opted_out" }),
    ]);
  });

  it("STOP IS PHONE-WIDE: an older prospect row with the same number that said STOP blocks it", async () => {
    h.prospectCandidates = [
      { id: "entry-old", studio_id: "studio-1", phone: "604-555-0199", sms_opted_out_at: "2026-09-20T10:00:00Z" },
    ];
    expect(await send()).toEqual({ state: "skipped", reason: "opted_out" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an opt-out on a DIFFERENT number does not block it", async () => {
    h.optedOutClients = [
      { id: "client-y", studio_id: "studio-1", phone: "604-555-0100", sms_opted_out_at: "2026-09-20T10:00:00Z" },
    ];
    expect(await send()).toEqual({ state: "accepted" });
  });

  it("an unreadable STOP check fails CLOSED and says so", async () => {
    h.lookupFails = true;
    expect(await send()).toEqual({ state: "skipped", reason: "suppression_check_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("THE PRODUCTION FENCE: a preview deployment records the skip and calls no provider", async () => {
    process.env.VERCEL_ENV = "preview";
    expect(await send()).toEqual({ state: "skipped", reason: "non_production_deployment" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settled()).toEqual([
      expect.objectContaining({ p_outcome: "skipped", p_skip_reason: "non_production_deployment" }),
    ]);
  });

  it("verification is optional (D4(2)): an unverified number with the join's own Yes is texted", async () => {
    h.claim = { data: [target({ mobile_verified_at: null })], error: null };
    expect(await send()).toEqual({ state: "accepted" });
  });
});

describe("provider failures", () => {
  it("a definite refusal is recorded, alerted once, and not retried", async () => {
    fetchMock.mockImplementationOnce(() => answer(400, { code: 21211 }));
    expect(await send()).toEqual({ state: "refused" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled()).toEqual([expect.objectContaining({ p_outcome: "refused", p_provider_error_code: 21211 })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "warning",
      event: "sms_send_failed",
      studioId: "studio-1",
      route: "lib/waitlist/delivery/join-ack-sms",
      safeDetails: {
        purpose: "waitlist_join_acknowledgement",
        sms_message_id: ROW,
        outcome: "refused",
        provider_error_code: 21211,
      },
    });
  });

  it("rate-limited (definitely not sent) is tried ONCE more after a short gap", async () => {
    fetchMock.mockImplementationOnce(() => answer(429, { code: 20429 }));
    expect(await send()).toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([WAITLIST_JOIN_ACK_SMS_RETRY_DELAY_MS]);
    expect(settled()).toHaveLength(1);
  });

  it("an AMBIGUOUS answer is never retried: it may already have reached the person", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    expect(await send()).toEqual({ state: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ safeDetails: { outcome: "unknown" } });
  });

  it("the alert is raised even when the ledger settle never answers", async () => {
    h.settle = "hang";
    fetchMock.mockImplementationOnce(() => answer(400, { code: 21211 }));
    const done = send();
    await vi.waitFor(() => expect(alerts).toHaveLength(1));
    void done;
  });
});

describe("no number reaches a log", () => {
  it("the phone appears in no log line or alert, on any path", async () => {
    await send();
    h.claim = { data: [target({ sms_consent_at: null })], error: null };
    await send();
    fetchMock.mockImplementationOnce(() => answer(400, { code: 21211 }));
    h.claim = { data: [target()], error: null };
    await send();
    const all = [...logs, ...alerts.map((a) => JSON.stringify(a))].join("\n");
    expect(all).not.toMatch(/6045550199|604\) 555-0199|604-555-0199/);
    expect(all).not.toContain("you've joined our waitlist");
  });
});
