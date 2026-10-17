import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, asRole, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";
import { stopPreflightVerdict } from "@/lib/sms/stop-preflight-record";
import { bindingSenderFrom, parseLiveRegistrationState, stopPreflightFor } from "@/lib/sms/sender-registration";
import { decideStudioRoute } from "@/lib/sms/send-time-route";

// 0230 (SMS-STOP-PREFLIGHT-RECORD-01, HON-50 G6) against a real database: the
// one writer, its refusals, constraints and compare-and-set, the privileges,
// and the snapshot the send path reads, end to end through the pure verdict
// and the route decision. Senders are created through the real lifecycle
// (0191 claim + finalize), never by writing provisioned_at directly.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ORIGIN = "https://hone.care";
const BASE = "https://hone.care";
const ENV = { TWILIO_WEBHOOK_BASE_URL: BASE };
const hex = (n: number) => randomBytes(n).toString("hex");
const mg = () => `MG${hex(16)}`;
const PASS = [
  { id: "one_base", status: "pass" },
  { id: "inbound_reaches", status: "pass" },
  { id: "signature_account", status: "pass" },
];
const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
let controls: typeof import("@/lib/sms/sender-controls");
let admin: SupabaseClient;

async function freshNumber(area: string): Promise<string> {
  for (;;) {
    const n = `+1${area}555${String(1000 + Math.floor(Math.random() * 8999))}`;
    const { rows } = await adminQuery(
      "select 1 from public.studio_sms_senders where phone_number = $1 or claimed_phone_number = $1 limit 1",
      [n],
    );
    if (rows.length === 0) return n;
  }
}

async function adopt(s: SeededStudio, number: string, service: string) {
  const provider = new FakeSmsProvisioningProvider({
    preOwnedNumbers: { [number]: `PN${hex(16)}` },
    accountServices: [
      { sid: service, numbers: [number], inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`, statusUrl: `${ORIGIN}/api/twilio/message-status` },
    ],
  });
  return controls.runSenderAdoption(
    { admin, provider, appOrigin: ORIGIN, testDestination: "+14165553199" },
    { studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: number, messagingServiceSid: service },
  );
}

const currentCheckedAt = async (senderId: string): Promise<string | null> =>
  ((await adminQuery(
    "select to_jsonb(checked_at) #>> '{}' as t from public.studio_sms_sender_stop_preflights where sender_id = $1",
    [senderId],
  )).rows[0]?.t as string | undefined) ?? null;

const record = async (
  studioId: string,
  senderId: string,
  phone: string,
  service: string,
  checks: unknown,
  opts: { base?: string; epoch?: string | null; context?: string; expected?: string | null } = {},
) =>
  (await adminQuery(
    "select * from public.record_studio_sms_stop_preflight($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)",
    [
      studioId, senderId, phone, service, JSON.stringify(checks), opts.base ?? BASE, opts.epoch ?? null, null,
      opts.context ?? "evidence",
      opts.expected === undefined ? await currentCheckedAt(senderId) : opts.expected,
    ],
  )).rows[0] as { result: string; preflight_id: string | null };

const snapshot = async (studioId: string) =>
  (await adminQuery("select public.get_live_studio_sms_sender_registration_state($1) as s", [studioId])).rows[0].s as Record<string, unknown>;

const liveSender = async (studioId: string) =>
  (await adminQuery("select id, phone_number, messaging_service_sid, provisioned_at from public.studio_sms_senders where studio_id = $1 and status <> 'released'", [studioId])).rows[0] as {
    id: string; phone_number: string; messaging_service_sid: string; provisioned_at: Date | null;
  };

async function verdictFor(studioId: string, env: Record<string, string> = ENV) {
  const state = parseLiveRegistrationState(await snapshot(studioId), studioId);
  if (!state.ok) return "unreadable" as const;
  const sender = bindingSenderFrom(state.senders[0]);
  return stopPreflightVerdict(stopPreflightFor(state, sender.id), sender, env);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  controls = await import("@/lib/sms/sender-controls");
  admin = (await import("@/lib/supabase/admin-server")).createAdminClient();
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  await closePool();
});

describe("the recorded STOP preflight, the snapshot, and the verdict", () => {
  it("adopted sender: missing until recorded; a passing record is ok end to end; a failed re-check replaces it", async () => {
    const s = await seedStudio("sp-adopt");
    const number = await freshNumber("416");
    const service = mg();
    expect(await adopt(s, number, service)).toMatchObject({ ok: true, result: "adopted" });
    const sender = await liveSender(s.studioId);
    expect(sender.provisioned_at).not.toBeNull();

    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "missing" });
    expect(await record(s.studioId, sender.id, number, service, PASS)).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: true });

    // ready is DERIVED by the writer: one failing check makes the row not ready.
    expect(
      await record(s.studioId, sender.id, number, service, [...PASS.slice(0, 2), { id: "signature_account", status: "fail" }], { context: "cutover" }),
    ).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "not_ready" });
    const rows = (await adminQuery("select ready, context from public.studio_sms_sender_stop_preflights where sender_id = $1", [sender.id])).rows;
    expect(rows).toEqual([{ ready: false, context: "cutover" }]);
    // An empty check list is recorded as NOT ready.
    expect(await record(s.studioId, sender.id, number, service, [])).toMatchObject({ result: "recorded" });
    expect((await adminQuery("select ready from public.studio_sms_sender_stop_preflights where sender_id = $1", [sender.id])).rows[0].ready).toBe(false);
  });

  it("the base the routes verify against moved: base_changed", async () => {
    const s = await seedStudio("sp-base");
    const number = await freshNumber("416");
    const service = mg();
    await adopt(s, number, service);
    const sender = await liveSender(s.studioId);
    await record(s.studioId, sender.id, number, service, PASS);
    expect(await verdictFor(s.studioId, { TWILIO_WEBHOOK_BASE_URL: "https://moved.example" })).toEqual({ ok: false, reason: "base_changed" });
  });

  it("observed for another service: mismatch", async () => {
    const s = await seedStudio("sp-mismatch");
    const number = await freshNumber("416");
    await adopt(s, number, mg());
    const sender = await liveSender(s.studioId);
    expect(await record(s.studioId, sender.id, number, mg(), PASS)).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("re-adoption after release is a NEW sender: the old preflight never carries over, and recording on the released one is refused", async () => {
    const s = await seedStudio("sp-readopt");
    const first = await freshNumber("416");
    const service = mg();
    await adopt(s, first, service);
    const old = await liveSender(s.studioId);
    await record(s.studioId, old.id, first, service, PASS);
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [old.id]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [old.id]);

    const second = await freshNumber("416");
    expect(await adopt(s, second, mg())).toMatchObject({ ok: true, result: "adopted" });
    const state = parseLiveRegistrationState(await snapshot(s.studioId), s.studioId);
    expect(state.ok && state.stopPreflights).toEqual([]);
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "missing" });
    expect(await record(s.studioId, old.id, first, service, PASS)).toEqual({ result: "no_live_sender", preflight_id: null });
  });

  it("the route decision, end to end from the real snapshot: refused until proven, then served", async () => {
    const s = await seedStudio("sp-route");
    const number = await freshNumber("416");
    const service = mg();
    await adopt(s, number, service);
    const sender = await liveSender(s.studioId);
    const route = async () => {
      const state = parseLiveRegistrationState(await snapshot(s.studioId), s.studioId);
      const read = state.ok
        ? { ok: true as const, senders: state.senders as never, registrations: state.registrations, campaignBindings: state.campaignBindings, stopPreflights: state.stopPreflights }
        : { ok: false as const };
      return decideStudioRoute({ studioId: s.studioId, recipientE164: "+14165550123", read, env: ENV });
    };
    expect(await route()).toEqual({ ok: false, reason: "stop_preflight_missing" });
    await record(s.studioId, sender.id, number, service, PASS);
    // Past G6 now; the CA long code is then decided by readiness (#841), so
    // the refusal is no longer the preflight's.
    const after = await route();
    expect(after).not.toEqual({ ok: false, reason: "stop_preflight_missing" });
    expect((after as { reason?: string }).reason ?? "").not.toMatch(/^stop_preflight_/);
  });
});

describe("the snapshot keeps every 0217/0229 key and adds only stop_preflights", () => {
  it("top-level keys and sender keys", async () => {
    const s = await seedStudio("sp-keys");
    await adopt(s, await freshNumber("416"), mg());
    const snap = await snapshot(s.studioId);
    expect(Object.keys(snap).sort()).toEqual(["campaign_bindings", "registrations", "senders", "stop_preflights"]);
    const sender = (snap.senders as Array<Record<string, unknown>>)[0];
    expect(Object.keys(sender).sort()).toEqual(["id", "messaging_service_sid", "phone_number", "provisioned_at", "status", "studio_id"]);
  });
});

describe("compare-and-set: overlapping preflights cannot land out of order", () => {
  it("a delayed passing preflight read before a newer failing one is refused; the newer result stands", async () => {
    const s = await seedStudio("sp-race");
    const number = await freshNumber("416");
    const service = mg();
    await adopt(s, number, service);
    const sender = await liveSender(s.studioId);
    const seenBySlow = await currentCheckedAt(sender.id);
    const seenByFast = await currentCheckedAt(sender.id);
    expect(seenBySlow).toBeNull();
    expect(await record(s.studioId, sender.id, number, service, [{ id: "inbound_reaches", status: "fail" }], { expected: seenByFast })).toMatchObject({ result: "recorded" });
    expect(await record(s.studioId, sender.id, number, service, PASS, { expected: seenBySlow })).toEqual({ result: "preflight_changed", preflight_id: null });
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "not_ready" });
  });
});

describe("record_studio_sms_stop_preflight refusals", () => {
  let s: SeededStudio;
  let sender: { id: string; phone_number: string; messaging_service_sid: string };
  beforeAll(async () => {
    s = await seedStudio("sp-refuse");
    await adopt(s, await freshNumber("416"), mg());
    sender = await liveSender(s.studioId);
  });

  it("refuses another studio's sender, and a number the sender no longer holds", async () => {
    const other = await seedStudio("sp-refuse-other");
    expect(await record(other.studioId, sender.id, sender.phone_number, mg(), PASS)).toEqual({ result: "no_live_sender", preflight_id: null });
    expect(await record(s.studioId, sender.id, await freshNumber("212"), mg(), PASS)).toEqual({ result: "sender_changed", preflight_id: null });
  });

  it("refuses malformed input without writing: detail text, unknown statuses, duplicate ids, unsafe bases, bad epochs", async () => {
    const p = sender.phone_number;
    const m = sender.messaging_service_sid;
    const cases: Array<[string, unknown, Record<string, string | null>]> = [
      ["a check with detail text (could carry a URL)", [{ id: "one_base", status: "pass", detail: "https://x/?token=1" }], {}],
      ["an unknown status", [{ id: "one_base", status: "ok" }], {}],
      ["a non-object check", ["pass"], {}],
      ["a bad check id", [{ id: "One Base", status: "pass" }], {}],
      ["duplicate check ids", [{ id: "a", status: "pass" }, { id: "a", status: "pass" }], {}],
      ["checks not an array", { one_base: "pass" }, {}],
      ["an http base", PASS, { base: "http://hone.care" }],
      ["a base with a query", PASS, { base: "https://hone.care/?token=abc" }],
      ["a base with userinfo", PASS, { base: "https://user:pw@hone.care" }],
      ["an epoch with spaces", PASS, { epoch: "rotated today" }],
      ["an unknown context", PASS, { context: "whenever" }],
    ];
    for (const [name, checks, opts] of cases) {
      expect(await record(s.studioId, sender.id, p, m, checks, opts), name).toEqual({ result: "invalid_input", preflight_id: null });
    }
    expect((await adminQuery("select count(*)::int as n from public.studio_sms_sender_stop_preflights where sender_id = $1", [sender.id])).rows[0].n).toBe(0);
    // A non-secret epoch is accepted and stored.
    expect(await record(s.studioId, sender.id, p, m, PASS, { epoch: "2026-10-17.1" })).toMatchObject({ result: "recorded" });
    expect((await adminQuery("select credentials_epoch from public.studio_sms_sender_stop_preflights where sender_id = $1", [sender.id])).rows[0].credentials_epoch).toBe("2026-10-17.1");
  });
});

describe("privileges", () => {
  it("no client role reads the table or calls the writer; service_role calls the functions but cannot read the table", async () => {
    const call = `select public.record_studio_sms_stop_preflight(gen_random_uuid(), gen_random_uuid(), '+14165550101', '${mg()}', '[]'::jsonb, 'https://hone.care', null, null, 'evidence', null)`;
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(role, (q) => q("select 1 from public.studio_sms_sender_stop_preflights limit 1"))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, (q) => q(call))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, (q) => q("select public.get_live_studio_sms_sender_registration_state(gen_random_uuid())"))).rejects.toThrow(/permission denied/);
    }
    await expect(asRole("service_role", (q) => q("select 1 from public.studio_sms_sender_stop_preflights limit 1"))).rejects.toThrow(/permission denied/);
    await expect(asRole("service_role", (q) => q(call))).resolves.toBeDefined();
  });
});
