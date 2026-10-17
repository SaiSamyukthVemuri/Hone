import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, asRole, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";
import { campaignBindingVerdict } from "@/lib/sms/campaign-binding";
import { bindingSenderFrom, campaignBindingFor, parseLiveRegistrationState } from "@/lib/sms/sender-registration";
import { runCampaignCheck } from "@/lib/sms/campaign-check";

// 0229 (SMS-CAMPAIGN-BINDING-01, HON-50 G4a) against a real database: the one
// writer, its refusals and constraints, the privileges, and the snapshot the
// send path reads, end to end through the pure verdict. Includes the adoption
// case (Willow, point 2): adoption sets provisioned_at, and a re-adoption is a
// new sender row, so an old binding never carries over.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ORIGIN = "https://hone.care";
const hex = (n: number) => randomBytes(n).toString("hex");
const mg = () => `MG${hex(16)}`;
const qe = () => `QE${hex(16)}`;
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

/** Adopt `number` in `service` through the real lifecycle (0191 claim + finalize). */
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

/** The binding's checked_at as the snapshot gives it (the CAS token), or null. */
const currentCheckedAt = async (senderId: string): Promise<string | null> =>
  ((await adminQuery(
    "select to_jsonb(checked_at) #>> '{}' as t from public.studio_sms_sender_campaign_bindings where sender_id = $1",
    [senderId],
  )).rows[0]?.t as string | undefined) ?? null;

/** Record, by default against the row as it is NOW (a fresh read before the provider call). */
const record = async (
  studioId: string,
  senderId: string,
  phone: string,
  service: string,
  campaign: string | null,
  status: string,
  context = "evidence",
  expectedCheckedAt?: string | null,
) =>
  (await adminQuery("select * from public.record_studio_sms_campaign_binding($1, $2, $3, $4, $5, $6, $7, $8)", [
    studioId, senderId, phone, service, campaign, status, context,
    expectedCheckedAt === undefined ? await currentCheckedAt(senderId) : expectedCheckedAt,
  ])).rows[0] as { result: string; binding_id: string | null };

const snapshot = async (studioId: string) =>
  (await adminQuery("select public.get_live_studio_sms_sender_registration_state($1) as s", [studioId])).rows[0].s as unknown;

const liveSender = async (studioId: string) =>
  (await adminQuery("select id, phone_number, messaging_service_sid, provisioned_at from public.studio_sms_senders where studio_id = $1 and status <> 'released'", [studioId])).rows[0] as {
    id: string; phone_number: string; messaging_service_sid: string; provisioned_at: Date | null;
  };

/** The send path's decision for the studio's one live sender, end to end. */
async function verdictFor(studioId: string) {
  const state = parseLiveRegistrationState(await snapshot(studioId), studioId);
  if (!state.ok) return "unreadable" as const;
  const [s] = state.senders;
  const sender = bindingSenderFrom(s);
  return campaignBindingVerdict(campaignBindingFor(state, sender.id), sender);
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

describe("adoption, the recorded binding, and the verdict", () => {
  it("adoption sets provisioned_at; a binding checked after it is ok end to end", async () => {
    const s = await seedStudio("cb-adopt");
    const number = await freshNumber("416");
    const service = mg();
    expect(await adopt(s, number, service)).toMatchObject({ ok: true, result: "adopted" });
    const sender = await liveSender(s.studioId);
    expect(sender.provisioned_at).not.toBeNull();

    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "missing" });
    expect(await record(s.studioId, sender.id, number, service, qe(), "verified")).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: true });

    // Re-checked as pending: one row, now unverified, verified_at cleared.
    expect(await record(s.studioId, sender.id, number, service, qe(), "pending", "cutover")).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "unverified" });
    const rows = (await adminQuery("select campaign_status, verified_at, context from public.studio_sms_sender_campaign_bindings where sender_id = $1", [sender.id])).rows;
    expect(rows).toEqual([{ campaign_status: "pending", verified_at: null, context: "cutover" }]);
  });

  it("a binding checked BEFORE the sender's provisioning is stale", async () => {
    // provisioned_at is write-once (0191), so the fixture INSERTS a sender
    // whose provisioning time is after the check that is about to run.
    const s = await seedStudio("cb-stale");
    const number = await freshNumber("416");
    const service = mg();
    const id = (await adminQuery(
      `insert into public.studio_sms_senders
         (studio_id, provider, status, country, claimed_phone_number, phone_number, phone_number_sid,
          messaging_service_sid, provisioning_claim_key, provisioning_claim_at,
          provisioning_claim_by_practitioner_id, provisioning_lease_generation, provisioned_at, last_test_ok_at)
       values ($1, 'twilio', 'active', 'CA', $2, $2, $3, $4, $5, now(), $6, 1, now() + interval '1 minute', now())
       returning id`,
      [s.studioId, number, `PN${hex(16)}`, service, `hone-sms-${hex(16)}`, s.practitionerId],
    )).rows[0].id as string;
    expect(await record(s.studioId, id, number, service, qe(), "verified")).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "stale" });
  });

  it("a binding observed for another service is a mismatch", async () => {
    const s = await seedStudio("cb-mismatch");
    const number = await freshNumber("416");
    await adopt(s, number, mg());
    const sender = await liveSender(s.studioId);
    expect(await record(s.studioId, sender.id, number, mg(), qe(), "verified")).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("re-adoption after release is a NEW sender row: the old binding never carries over", async () => {
    const s = await seedStudio("cb-readopt");
    const first = await freshNumber("416");
    const service = mg();
    await adopt(s, first, service);
    const old = await liveSender(s.studioId);
    await record(s.studioId, old.id, first, service, qe(), "verified");
    // Fixture: the old sender is released through the LEGAL transitions
    // (active -> releasing -> released, 0191); the release commands are proved elsewhere.
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [old.id]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [old.id]);

    const second = await freshNumber("416");
    const service2 = mg();
    expect(await adopt(s, second, service2)).toMatchObject({ ok: true, result: "adopted" });
    const now = await liveSender(s.studioId);
    expect(now.id).not.toBe(old.id);
    // The released sender's binding is not in the snapshot, so: missing.
    const state = parseLiveRegistrationState(await snapshot(s.studioId), s.studioId);
    expect(state.ok && state.campaignBindings).toEqual([]);
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "missing" });
    // And recording against the released sender is refused.
    expect(await record(s.studioId, old.id, first, service, qe(), "verified")).toEqual({ result: "no_live_sender", binding_id: null });
  });
});

describe("compare-and-set: overlapping checks cannot land out of order (Codex P1 4301502260)", () => {
  it("a delayed `verified` read before a newer `failed` was recorded is refused; the newer result stands", async () => {
    const s = await seedStudio("cb-race");
    const number = await freshNumber("416");
    const service = mg();
    await adopt(s, number, service);
    const sender = await liveSender(s.studioId);

    // Both checks read the row BEFORE their provider calls: no row yet.
    const seenBySlow = await currentCheckedAt(sender.id);
    const seenByFast = await currentCheckedAt(sender.id);
    expect(seenBySlow).toBeNull();
    // The faster check lands first with `failed`...
    expect(await record(s.studioId, sender.id, number, service, qe(), "failed", "cutover", seenByFast)).toMatchObject({ result: "recorded" });
    // ...and the delayed `verified` is refused rather than overwriting it.
    expect(await record(s.studioId, sender.id, number, service, qe(), "verified", "cutover", seenBySlow)).toEqual({ result: "binding_changed", binding_id: null });
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "unverified" });

    // A check that read the CURRENT row may replace it.
    expect(await record(s.studioId, sender.id, number, service, qe(), "verified")).toMatchObject({ result: "recorded" });
    expect(await verdictFor(s.studioId)).toEqual({ ok: true });
    // And a token from before that write is now stale too.
    expect(await record(s.studioId, sender.id, number, service, qe(), "failed", "cutover", seenByFast)).toEqual({ result: "binding_changed", binding_id: null });
  });
});

describe("record_studio_sms_campaign_binding refusals", () => {
  let s: SeededStudio;
  let sender: { id: string; phone_number: string; messaging_service_sid: string };
  beforeAll(async () => {
    s = await seedStudio("cb-refuse");
    const number = await freshNumber("416");
    await adopt(s, number, mg());
    sender = await liveSender(s.studioId);
  });

  it("refuses another studio's sender, and a number the sender no longer holds", async () => {
    const other = await seedStudio("cb-refuse-other");
    expect(await record(other.studioId, sender.id, sender.phone_number, mg(), qe(), "verified")).toEqual({ result: "no_live_sender", binding_id: null });
    expect(await record(s.studioId, sender.id, await freshNumber("212"), mg(), qe(), "verified")).toEqual({ result: "sender_changed", binding_id: null });
  });

  it("refuses malformed observations without writing", async () => {
    const p = sender.phone_number;
    for (const [service, campaign, status, context] of [
      ["MG123", qe(), "verified", "evidence"],
      [mg(), "QE123", "verified", "evidence"],
      [mg(), null, "verified", "evidence"],
      [mg(), qe(), "none", "evidence"],
      [mg(), qe(), "VERIFIED", "evidence"],
      [mg(), qe(), "verified", "whenever"],
    ] as const) {
      expect(await record(s.studioId, sender.id, p, service, campaign, status, context), `${service} ${campaign} ${status} ${context}`).toEqual({ result: "invalid_input", binding_id: null });
    }
    expect((await adminQuery("select count(*)::int as n from public.studio_sms_sender_campaign_bindings where sender_id = $1", [sender.id])).rows[0].n).toBe(0);
    // `none` without a campaign is a valid observation (the service has none).
    expect(await record(s.studioId, sender.id, p, sender.messaging_service_sid, null, "none")).toMatchObject({ result: "recorded" });
  });
});

describe("privileges", () => {
  it("no client role reads the table or calls the writer; the snapshot is service_role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(role, (q) => q("select 1 from public.studio_sms_sender_campaign_bindings limit 1"))).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, (q) => q(`select public.record_studio_sms_campaign_binding(gen_random_uuid(), gen_random_uuid(), '+12125550101', '${mg()}', null, 'none', 'evidence', null)`)),
      ).rejects.toThrow(/permission denied/);
      await expect(asRole(role, (q) => q("select public.get_live_studio_sms_sender_registration_state(gen_random_uuid())"))).rejects.toThrow(/permission denied/);
    }
    // service_role calls the functions but cannot read the table directly.
    await expect(asRole("service_role", (q) => q("select 1 from public.studio_sms_sender_campaign_bindings limit 1"))).rejects.toThrow(/permission denied/);
    await expect(asRole("service_role", (q) => q("select public.get_live_studio_sms_sender_registration_state(gen_random_uuid())"))).resolves.toBeDefined();
  });
});

describe("G4b: support's campaign check records through 0229, end to end", () => {
  it("the fake reports the service's verified campaign; the check records it; the send-path verdict is ok", async () => {
    const s = await seedStudio("cb-check");
    const number = await freshNumber("416");
    const service = mg();
    const campaign = qe();
    const provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [number]: `PN${hex(16)}` },
      accountServices: [
        {
          sid: service,
          numbers: [number],
          inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`,
          statusUrl: `${ORIGIN}/api/twilio/message-status`,
          usA2pList: { compliance: [{ sid: campaign, campaign_status: "VERIFIED" }] },
        },
      ],
    });
    expect(
      await controls.runSenderAdoption(
        { admin, provider, appOrigin: ORIGIN, testDestination: "+14165553199" },
        { studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: number, messagingServiceSid: service },
      ),
    ).toMatchObject({ ok: true, result: "adopted" });
    const sender = await liveSender(s.studioId);
    expect(await verdictFor(s.studioId)).toEqual({ ok: false, reason: "missing" });

    expect(
      await runCampaignCheck({ admin, reader: provider }, { studioId: s.studioId, expectedSenderId: sender.id, expectedPhone: number, context: "cutover" }),
    ).toEqual({ result: "recorded", status: "verified", campaignSid: campaign });
    expect(await verdictFor(s.studioId)).toEqual({ ok: true });
    expect(provider.calls.campaignRead).toBe(1);
    expect(provider.calls.purchase).toBe(0);
  });
});
