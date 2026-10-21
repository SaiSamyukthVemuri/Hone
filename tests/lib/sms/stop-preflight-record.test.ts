import { describe, expect, it } from "vitest";
import {
  stopPreflightVerdict,
  stopPreflightsFromSnapshot,
  type RecordedStopPreflight,
} from "@/lib/sms/stop-preflight-record";
import { parseLiveRegistrationState, stopPreflightFor } from "@/lib/sms/sender-registration";
import type { BindingSender } from "@/lib/sms/campaign-binding";
import { STOP_PREFLIGHT_CHECKLIST, STOP_PREFLIGHT_CHECKLIST_VERSION } from "@/lib/sms/inbound-stop-preflight";

const FULL = STOP_PREFLIGHT_CHECKLIST.map((id) => ({ id, status: "pass" as const }));

// HON-50 G6: the pure verdict over a recorded STOP preflight (0230), and the
// snapshot parser that feeds it, as strict as campaignBindingsFromSnapshot.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NUMBER = "+14165550100";
const MSID = `MG${"a".repeat(32)}`;
const BASE = "https://hone.test";
const ENV = { TWILIO_WEBHOOK_BASE_URL: BASE };

const sender: BindingSender = {
  id: "sender-a-1",
  studioId: A,
  phoneNumber: NUMBER,
  messagingServiceSid: MSID,
  provisionedAt: "2026-10-01T10:00:00.000Z",
};

const record = (over: Partial<RecordedStopPreflight> = {}): RecordedStopPreflight => ({
  senderId: "sender-a-1",
  studioId: A,
  phoneNumber: NUMBER,
  messagingServiceSid: MSID,
  ready: true,
  checklistVersion: STOP_PREFLIGHT_CHECKLIST_VERSION,
  checks: FULL.map((c) => ({ ...c })),
  webhookBase: BASE,
  credentialsEpoch: null,
  checkedAt: "2026-10-02T10:00:00.000Z",
  ...over,
});

describe("stopPreflightVerdict", () => {
  it("a passing record, checked after provisioning, against today's base: ok", () => {
    expect(stopPreflightVerdict(record(), sender, ENV)).toEqual({ ok: true });
  });

  it("a trailing slash on either base is the same base", () => {
    expect(stopPreflightVerdict(record({ webhookBase: `${BASE}/` }), sender, { TWILIO_WEBHOOK_BASE_URL: `${BASE}/` })).toEqual({
      ok: true,
    });
  });

  it.each<[string, RecordedStopPreflight | null, BindingSender, Record<string, string>, string]>([
    ["no record", null, sender, ENV, "missing"],
    ["another sender's record", record({ senderId: "sender-a-0" }), sender, ENV, "mismatch"],
    ["another studio's record", record({ studioId: B }), sender, ENV, "mismatch"],
    ["checked for another number", record({ phoneNumber: "+14165550199" }), sender, ENV, "mismatch"],
    ["an unparseable recorded number never matches", record({ phoneNumber: "4165550100" }), sender, ENV, "mismatch"],
    ["checked for another service", record({ messagingServiceSid: `MG${"b".repeat(32)}` }), sender, ENV, "mismatch"],
    ["the sender has no service", record(), { ...sender, messagingServiceSid: null }, ENV, "mismatch"],
    ["ready false", record({ ready: false }), sender, ENV, "not_ready"],
    ["ready true with no checks", record({ checks: [] }), sender, ENV, "not_ready"],
    ["checked BEFORE the sender was provisioned", record({ checkedAt: "2026-09-30T10:00:00.000Z" }), sender, ENV, "stale"],
    ["the sender's provisioning time unknown", record(), { ...sender, provisionedAt: null }, ENV, "stale"],
    ["an unparseable checked_at", record({ checkedAt: "yesterday" }), sender, ENV, "stale"],
    ["the base has moved", record(), sender, { TWILIO_WEBHOOK_BASE_URL: "https://other.test" }, "base_changed"],
    ["the base is unset now", record(), sender, {}, "base_changed"],
  ])("%s → %s", (_name, rec, s, env, reason) => {
    expect(stopPreflightVerdict(rec, s, env)).toEqual({ ok: false, reason });
  });

  it("there is no wall-clock expiry: (control) the complete all-pass checklist is ready", () => {
    expect(STOP_PREFLIGHT_CHECKLIST.length).toBe(14);
    expect(stopPreflightVerdict(record(), sender, ENV)).toEqual({ ok: true });
  });

  it("there is no wall-clock expiry: a record a year old still passes", () => {
    expect(stopPreflightVerdict(record({ checkedAt: "2025-10-02T10:00:00.000Z" }), { ...sender, provisionedAt: "2025-10-01T10:00:00.000Z" }, ENV)).toEqual({
      ok: true,
    });
  });
});

// Codex P1 4304864063: ANY nonempty all-pass list used to be ready, even
// [{"id":"anything","status":"pass"}]. Only the COMPLETE checklist is.
describe("stopPreflightVerdict requires the COMPLETE versioned STOP checklist", () => {
  const without = (id: string) => FULL.filter((c) => c.id !== id);
  it.each(STOP_PREFLIGHT_CHECKLIST.map((id) => [id]))("(a) incomplete: missing %s → not_ready", (id) => {
    expect(stopPreflightVerdict(record({ checks: without(id) }), sender, ENV)).toEqual({ ok: false, reason: "not_ready" });
  });

  it("(a) the old exploit: a single arbitrary passing check → not_ready", () => {
    expect(stopPreflightVerdict(record({ checks: [{ id: "anything", status: "pass" }] }), sender, ENV)).toEqual({ ok: false, reason: "not_ready" });
  });

  it("(b) an unknown id, in place of a required one or in addition to the full set → not_ready", () => {
    const swapped = [...without("stop_forwarded"), { id: "stop_forwarded_v2", status: "pass" as const }];
    expect(stopPreflightVerdict(record({ checks: swapped }), sender, ENV)).toEqual({ ok: false, reason: "not_ready" });
    expect(stopPreflightVerdict(record({ checks: [...FULL, { id: "extra", status: "pass" }] }), sender, ENV)).toEqual({ ok: false, reason: "not_ready" });
  });

  it("(c) a duplicate id (padding the count) → not_ready", () => {
    const dup = [...without("one_base"), { id: "base_url", status: "pass" as const }];
    expect(dup).toHaveLength(STOP_PREFLIGHT_CHECKLIST.length);
    expect(stopPreflightVerdict(record({ checks: dup }), sender, ENV)).toEqual({ ok: false, reason: "not_ready" });
  });

  it.each(STOP_PREFLIGHT_CHECKLIST.flatMap((id) => [[id, "fail"], [id, "unknown"]]))(
    "(d) %s is %s → not_ready (re-derived, never trusted from ready)",
    (id, status) => {
      const checks = FULL.map((c) => (c.id === id ? { id, status: status as "fail" | "unknown" } : c));
      expect(stopPreflightVerdict(record({ checks, ready: true }), sender, ENV)).toEqual({ ok: false, reason: "not_ready" });
    },
  );

  it.each([[0], [2], [Number.NaN]])("(e) checklist version %s → not_ready", (v) => {
    expect(stopPreflightVerdict(record({ checklistVersion: v }), sender, ENV)).toEqual({ ok: false, reason: "not_ready" });
  });

  it("(e) a snapshot row with no checklist_version is unreadable, never ready", () => {
    const noVersion: Record<string, unknown> = { ...raw() };
    delete noVersion.checklist_version;
    expect(stopPreflightsFromSnapshot({ stop_preflights: [noVersion] }, A, listed)).toBeNull();
  });
});

const raw = (over: Record<string, unknown> = {}) => ({
  sender_id: "sender-a-1",
  studio_id: A,
  phone_number: NUMBER,
  messaging_service_sid: MSID,
  ready: true,
  checklist_version: 1,
  checks: FULL,
  webhook_base: BASE,
  credentials_epoch: null,
  checked_at: "2026-10-02T10:00:00.000Z",
  ...over,
});
const listed = new Set(["sender-a-1", "sender-a-2"]);

describe("stopPreflightsFromSnapshot: strict, like campaignBindingsFromSnapshot", () => {
  it("absent key (0230 unapplied) → [] (every verdict then 'missing')", () => {
    expect(stopPreflightsFromSnapshot({ senders: [] }, A, listed)).toEqual([]);
  });

  it("a well-formed row is parsed", () => {
    expect(stopPreflightsFromSnapshot({ stop_preflights: [raw()] }, A, listed)).toEqual([
      {
        senderId: "sender-a-1",
        studioId: A,
        phoneNumber: NUMBER,
        messagingServiceSid: MSID,
        ready: true,
        checklistVersion: 1,
        checks: FULL,
        webhookBase: BASE,
        credentialsEpoch: null,
        checkedAt: "2026-10-02T10:00:00.000Z",
      },
    ]);
  });

  it.each<[string, unknown]>([
    ["not an array", { stop_preflights: { x: 1 } }],
    ["two rows for one sender", { stop_preflights: [raw(), raw()] }],
    ["a row for an unlisted sender", { stop_preflights: [raw({ sender_id: "sender-z-9" })] }],
    ["a row for another studio", { stop_preflights: [raw({ studio_id: B })] }],
    ["a non-object row", { stop_preflights: [null] }],
    ["ready not a boolean", { stop_preflights: [raw({ ready: "true" })] }],
    ["checks not an array", { stop_preflights: [raw({ checks: "pass" })] }],
    ["a check with an unknown status", { stop_preflights: [raw({ checks: [{ id: "one_base", status: "ok" }] })] }],
    ["duplicate check ids", { stop_preflights: [raw({ checks: [{ id: "a", status: "pass" }, { id: "a", status: "pass" }] })] }],
    ["no webhook base", { stop_preflights: [raw({ webhook_base: null })] }],
    ["no checked_at", { stop_preflights: [raw({ checked_at: "" })] }],
  ])("%s → null (the whole read is unreadable)", (_name, snapshot) => {
    expect(stopPreflightsFromSnapshot(snapshot, A, listed)).toBeNull();
  });
});

describe("parseLiveRegistrationState carries stopPreflights, and a bad value makes the WHOLE read unreadable", () => {
  const senders = [{ id: "sender-a-1", studio_id: A, status: "active", phone_number: NUMBER, messaging_service_sid: MSID, provisioned_at: "2026-10-01T10:00:00.000Z" }];

  it("parsed after the bindings, and found per sender", () => {
    const state = parseLiveRegistrationState({ senders, registrations: [], campaign_bindings: [], stop_preflights: [raw()] }, A);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(stopPreflightFor(state, "sender-a-1")?.ready).toBe(true);
    expect(stopPreflightFor(state, "sender-a-2")).toBeNull();
  });

  it("absent → [] with the rest of the read intact", () => {
    const state = parseLiveRegistrationState({ senders, registrations: [] }, A);
    expect(state).toMatchObject({ ok: true, stopPreflights: [], campaignBindings: [] });
  });

  it("a malformed stop_preflights → { ok: false }", () => {
    expect(parseLiveRegistrationState({ senders, registrations: [], stop_preflights: [raw(), raw()] }, A)).toEqual({ ok: false });
  });

  it("a malformed campaign_bindings still → { ok: false } (either parser failing fails the read)", () => {
    expect(parseLiveRegistrationState({ senders, registrations: [], campaign_bindings: "x", stop_preflights: [raw()] }, A)).toEqual({
      ok: false,
    });
  });
});
