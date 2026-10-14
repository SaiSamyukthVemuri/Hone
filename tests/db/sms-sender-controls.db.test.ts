import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, asRole, closePool, seedMember, seedStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";

// ===========================================================================
// SMS-SENDER-CONTROL-01 (#824): FAKE-PROVIDER PROOF of the owner's sender
// controls, against the real 0191 claim/finalize commands. The provider is the
// deterministic fake throughout: nothing is bought and nothing is sent.
//
//   * search returns candidates and writes nothing;
//   * provisioning a chosen number makes the studio's sender ACTIVE with that
//     exact number, and #841/#844's readiness and snapshot see it;
//   * a second request is already_active and buys nothing more;
//   * a non-owner is refused by the DATABASE's claim, with no provider effect;
//   * a provider failure leaves no active sender and spends nothing further;
//   * adopting a number the account already owns, correctly wired, activates
//     it without a purchase.
// ===========================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ORIGIN = "https://hone.care";
const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
let controls: typeof import("@/lib/sms/sender-controls");
let admin: SupabaseClient;

const deps = (provider: FakeSmsProvisioningProvider) => ({ admin, provider, appOrigin: ORIGIN, testDestination: "+14165553199" });
/** A +1 number in `area` that no sender row records, as its number or its claim. */
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

const liveSenders = async (studioId: string) =>
  (await adminQuery("select status, phone_number, country from public.studio_sms_senders where studio_id = $1 and status <> 'released'", [studioId])).rows;

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

describe("search", () => {
  it("returns CA and US candidates in the safe shape and writes nothing", async () => {
    const s = await seedStudio("ctl-search");
    const provider = new FakeSmsProvisioningProvider();
    for (const country of ["CA", "US"]) {
      const out = await controls.runSenderSearch({ provider }, { country, areaCode: null });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.candidates.length).toBeGreaterThan(0);
        expect(Object.keys(out.candidates[0]).sort()).toEqual(["country", "formatted", "locality", "phoneNumber", "region"]);
      }
    }
    expect(await liveSenders(s.studioId)).toEqual([]);
    expect(provider.calls.purchase).toBe(0);
    expect(await controls.runSenderSearch({ provider }, { country: "GB", areaCode: null })).toEqual({ ok: false, reason: "invalid_input" });
  });
});

describe("provision (fake provider)", () => {
  it("the owner's chosen number becomes the studio's ACTIVE sender, visible to readiness and the operator snapshot", async () => {
    const s = await seedStudio("ctl-prov");
    const provider = new FakeSmsProvisioningProvider();
    const search = await controls.runSenderSearch({ provider }, { country: "CA", areaCode: null });
    if (!search.ok) throw new Error("search failed");
    const chosen = search.candidates[0].phoneNumber;

    const out = await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: null, phoneNumber: chosen,
    });
    expect(out).toMatchObject({ ok: true, result: "activated", phoneNumber: chosen });
    expect(await liveSenders(s.studioId)).toEqual([{ status: "active", phone_number: chosen, country: "CA" }]);
    expect(provider.calls.purchase).toBe(1);

    const snapshot = (await adminQuery("select public.get_live_studio_sms_sender_registration_state($1) s", [s.studioId])).rows[0].s;
    expect(snapshot.senders).toEqual([expect.objectContaining({ status: "active", phone_number: chosen })]);

    const { studioSenderReadiness } = await import("@/lib/sms/sender-readiness");
    const row = (await adminQuery("select * from public.studio_sms_senders where studio_id = $1 and status = 'active'", [s.studioId])).rows[0];
    const readiness = studioSenderReadiness({ ok: true, sender: { ...row, provisioned_at: String(row.provisioned_at), last_test_ok_at: String(row.last_test_ok_at), created_at: "", updated_at: "", last_error_at: null, released_at: null } }, { state: "not_recorded" });
    // A long code is not an eligible Canadian A2P route (Codex P2 4253590276); US awaits registration.
    expect(readiness.map((r) => `${r.destination}:${r.state}`)).toEqual(["CA:requires_information", "US:requires_information"]);

    // A second request buys nothing more.
    const again = await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: null, phoneNumber: chosen,
    });
    expect(again).toMatchObject({ ok: true, result: "already_active" });
    expect(provider.calls.purchase).toBe(1);
  });

  it("a non-owner is refused by the database's claim, before any provider effect", async () => {
    const s = await seedStudio("ctl-member");
    const member = await seedMember(s, "ctl-member");
    const provider = new FakeSmsProvisioningProvider();
    const out = await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: member.userId, country: "CA", areaCode: null, phoneNumber: "+14165550123",
    });
    expect(out.ok).toBe(false);
    expect(provider.calls.purchase).toBe(0);
    expect(await liveSenders(s.studioId)).toEqual([]);
  });

  it("an owner of ANOTHER studio is refused for this one", async () => {
    const s = await seedStudio("ctl-target");
    const other = await seedStudio("ctl-other");
    const provider = new FakeSmsProvisioningProvider();
    const out = await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: other.userId, country: "CA", areaCode: null, phoneNumber: "+14165550124",
    });
    expect(out.ok).toBe(false);
    expect(provider.calls.purchase).toBe(0);
  });

  it("a provider failure leaves no active sender", async () => {
    const s = await seedStudio("ctl-fail");
    const provider = new FakeSmsProvisioningProvider({ purchaseFails: "provider_unavailable" });
    const out = await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "US", areaCode: null, phoneNumber: "+12125550142",
    });
    expect(out.ok).toBe(false);
    expect((await liveSenders(s.studioId)).filter((r) => r.status === "active")).toEqual([]);
  });
});

describe("adopt (fake provider)", () => {
  it("a number the account already owns, wired to Hone's URLs, is adopted WITHOUT a purchase", async () => {
    const s = await seedStudio("ctl-adopt");
    const NUMBER = "+14165553177";
    const MG = "MG" + "d".repeat(32);
    const provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [NUMBER]: "PN" + "e".repeat(32) },
      accountServices: [{ sid: MG, numbers: [NUMBER], inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`, statusUrl: `${ORIGIN}/api/twilio/message-status` }],
    });
    const out = await controls.runSenderAdoption(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: NUMBER, messagingServiceSid: MG,
    });
    expect(out).toMatchObject({ ok: true, result: "adopted", phoneNumber: NUMBER });
    expect(provider.calls.purchase).toBe(0);
    expect(await liveSenders(s.studioId)).toEqual([{ status: "active", phone_number: NUMBER, country: "CA" }]);
  });

  it("a number the account does not own is refused, and nothing becomes active", async () => {
    const s = await seedStudio("ctl-adopt-no");
    const provider = new FakeSmsProvisioningProvider({ preOwnedNumbers: {} });
    const out = await controls.runSenderAdoption(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: "+14165553178", messagingServiceSid: "MG" + "f".repeat(32),
    });
    expect(out.ok).toBe(false);
    expect((await liveSenders(s.studioId)).filter((r) => r.status === "active")).toEqual([]);
  });
});

// Codex P2 4250699105: the number must belong to the country chosen, checked
// BEFORE any claim, and the fake's default area code is the country's own.
describe("the number belongs to the country chosen", () => {
  const claims = async (studioId: string) =>
    Number((await adminQuery("select count(*)::int n from public.studio_sms_senders where studio_id = $1", [studioId])).rows[0].n);

  it("United States with no area code: the search offers US numbers and the provisioned sender is a US number", async () => {
    const s = await seedStudio("ctl-us-default");
    const provider = new FakeSmsProvisioningProvider();
    const found = await controls.runSenderSearch({ provider }, { country: "US", areaCode: null });
    expect(found.ok).toBe(true);
    const candidates = found.ok ? found.candidates : [];
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(controls.numberMatchesCountry(c.phoneNumber, "US"), c.phoneNumber).toBe(true);
    const out = await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "US", areaCode: null, phoneNumber: candidates[0].phoneNumber,
    });
    expect(out).toMatchObject({ ok: true, result: "activated" });
    expect(await liveSenders(s.studioId)).toEqual([{ status: "active", phone_number: candidates[0].phoneNumber, country: "US" }]);
  });

  it("a Canadian number submitted as US (or the reverse) is refused before any claim; nothing is written", async () => {
    const s = await seedStudio("ctl-mismatch");
    const provider = new FakeSmsProvisioningProvider();
    for (const [country, phoneNumber, areaCode] of [
      ["US", "+14165550101", null],
      ["CA", "+12125550101", null],
      ["CA", "+14165550101", "212"],
      ["US", "+18885550101", null],
    ] as const) {
      const out = await controls.runSenderProvision(deps(provider), {
        studioId: s.studioId, actorUserId: s.userId, country, areaCode, phoneNumber,
      });
      expect(out, `${country} ${phoneNumber} ${areaCode}`).toEqual({ ok: false, result: "refused", reason: "number_country_mismatch" });
    }
    const adopt = await controls.runSenderAdoption(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "US", phoneNumber: "+14165550142", messagingServiceSid: "MG" + "d0".repeat(16),
    });
    expect(adopt).toEqual({ ok: false, result: "refused", reason: "number_country_mismatch" });
    expect(await claims(s.studioId)).toBe(0);
    expect(provider.calls.purchase).toBe(0);
    expect(await controls.runSenderSearch({ provider }, { country: "US", areaCode: "416" })).toEqual({ ok: false, reason: "area_code_country_mismatch" });
  });
});

// Codex P2 4250699100: the panel's fake account owns something to adopt, and
// adopting never blocks the provisioning path for another studio.
describe("the controls' seeded fake account", () => {
  it("adopts the demo Canadian number through the panel's own fake, without a purchase", async () => {
    const s = await seedStudio("ctl-demo-adopt");
    const provider = controls.senderControlsFakeProvider(ORIGIN, s.studioId);
    const inv = controls.demoAdoptionInventory(s.studioId);
    const { CA } = inv.numbers;
    const out = await controls.runSenderAdoption(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: CA.phoneNumber,
      messagingServiceSid: inv.messagingServiceSid,
    });
    expect(out).toMatchObject({ ok: true, result: "adopted", phoneNumber: CA.phoneNumber });
    expect(provider.calls.purchase).toBe(0);
    expect(await liveSenders(s.studioId)).toEqual([{ status: "active", phone_number: CA.phoneNumber, country: "CA" }]);
  });

  it("the demo numbers are never offered for purchase, and another studio can still provision", async () => {
    const s = await seedStudio("ctl-demo-provision");
    const provider = controls.senderControlsFakeProvider(ORIGIN, s.studioId);
    const found = await controls.runSenderSearch({ provider }, { country: "US", areaCode: "212" });
    const numbers = found.ok ? found.candidates.map((c) => c.phoneNumber) : [];
    expect(numbers).not.toContain(controls.demoAdoptionInventory(s.studioId).numbers.US.phoneNumber);
    // Other tests' separate fakes share this database: pick a number no live sender holds.
    const held = new Set(
      (await adminQuery("select phone_number from public.studio_sms_senders where phone_number is not null")).rows.map((r) => r.phone_number as string),
    );
    const pick = numbers.find((n) => !held.has(n))!;
    const out = await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "US", areaCode: "212", phoneNumber: pick,
    });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, result: "activated" });
  });
});

// Codex P2 4250840773: an adoption that cannot succeed is refused BEFORE the
// claim, so a typo never wedges the studio's setup (0191's claimed number is
// write-once). Three outcomes, each proved against the database.
describe("adoption is checked before the claim: refused, uncertain, failed", () => {
  const MG = "MG" + "b1".repeat(16);
  const NUMBER = "+14165553188";
  const seeded = (over: ConstructorParameters<typeof FakeSmsProvisioningProvider>[0] = {}) =>
    new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [NUMBER]: "PN" + "b2".repeat(16) },
      accountServices: [{ sid: MG, numbers: [NUMBER], inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`, statusUrl: `${ORIGIN}/api/twilio/message-status` }],
      ...over,
    });
  const rows = async (studioId: string) =>
    (await adminQuery("select status, claimed_phone_number from public.studio_sms_senders where studio_id = $1", [studioId])).rows;
  const adopt = (provider: FakeSmsProvisioningProvider, studioId: string, userId: string, phoneNumber = NUMBER, sid = MG) =>
    controls.runSenderAdoption(deps(provider), { studioId, actorUserId: userId, country: "CA", phoneNumber, messagingServiceSid: sid });

  it("REFUSED: a typo in the number or the service, or a service not wired to Hone, writes nothing; the studio can still provision", async () => {
    const s = await seedStudio("ctl-pre-refused");
    const cases: Array<[string, FakeSmsProvisioningProvider, string, string]> = [
      ["number_not_owned_by_account", seeded(), "+14165552189", MG],
      ["number_in_other_service", seeded(), NUMBER, "MG" + "c3".repeat(16)],
      ["service_webhooks_mismatch", seeded({ accountServices: [{ sid: MG, numbers: [NUMBER], inboundUrl: "https://elsewhere.example/sms", statusUrl: null }] }), NUMBER, MG],
    ];
    for (const [reason, provider, phone, sid] of cases) {
      expect(await adopt(provider, s.studioId, s.userId, phone, sid), reason).toEqual({ ok: false, result: "refused", reason, uncertain: false });
      expect(provider.calls.purchase, reason).toBe(0);
    }
    expect(await rows(s.studioId)).toEqual([]);
    // Not wedged: a searched number can still be provisioned for this studio.
    const provider = new FakeSmsProvisioningProvider();
    const found = await controls.runSenderSearch({ provider }, { country: "CA", areaCode: "604" });
    const pick = found.ok ? found.candidates[0].phoneNumber : "";
    expect(await controls.runSenderProvision(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "604", phoneNumber: pick,
    })).toMatchObject({ ok: true, result: "activated" });
  });

  it("UNCERTAIN: the provider cannot answer, or answers incompletely: refused as uncertain, nothing written", async () => {
    const s = await seedStudio("ctl-pre-uncertain");
    for (const provider of [
      seeded({ ownedLookupFails: "provider_timeout" }),
      seeded({ unparseableServicePage: 1 }),
      seeded({ serviceConfigFails: "provider_unavailable" }),
    ]) {
      const out = await adopt(provider, s.studioId, s.userId);
      expect(out).toMatchObject({ ok: false, result: "refused", uncertain: true });
      expect(provider.calls.purchase).toBe(0);
    }
    expect(await rows(s.studioId)).toEqual([]);
  });

  it("FAILED: an adoption that passes the checks but fails AFTER the claim (its proof text) is reported as failed, not active", async () => {
    const s = await seedStudio("ctl-post-failed");
    const provider = seeded({ testSendFails: "provider_unavailable" });
    const out = await adopt(provider, s.studioId, s.userId);
    expect(out).toMatchObject({ ok: false, result: "failed" });
    expect(provider.calls.purchase).toBe(0);
    const r = await rows(s.studioId);
    expect(r.filter((x) => x.status === "active")).toEqual([]);
    // The claim was taken only for a number the account was shown to own.
    expect(r.map((x) => x.claimed_phone_number)).toEqual([NUMBER]);
  });
});

// The ONE webhook base (lib/sms/webhook-base.ts), and the EFFECTIVE inbound
// route (lib/sms/inbound-routing.ts), against the database.
describe("webhook base and effective inbound routing", () => {
  const BASE = "https://hooks.hone.example";
  // Fresh resources per test: a resource another studio already recorded is
  // (correctly) refused before the claim, so tests must not share one.
  let MG = "";
  let NUMBER = "";
  beforeEach(() => {
    const r = () => Math.floor(Math.random() * 16 ** 8).toString(16).padStart(8, "0");
    MG = `MG${r()}${r()}${r()}${r()}`;
    NUMBER = `+1416555${String(2000 + Math.floor(Math.random() * 7999))}`;
  });
  const svc = (over: Record<string, unknown>) => ({
    sid: MG, numbers: [NUMBER], inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`, statusUrl: `${ORIGIN}/api/twilio/message-status`, ...over,
  });
  const fake = (service: Record<string, unknown>, smsUrls: Record<string, string | null | undefined> = {}) =>
    new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [NUMBER]: "PN" + "e5".repeat(16) },
      preOwnedNumberSmsUrls: smsUrls,
      accountServices: [service as never],
    });
  const adopt = (provider: FakeSmsProvisioningProvider, studioId: string, userId: string, env?: Record<string, string>) =>
    controls.runSenderAdoption({ ...deps(provider), env }, { studioId, actorUserId: userId, country: "CA", phoneNumber: NUMBER, messagingServiceSid: MG });
  const claims = async (studioId: string) =>
    Number((await adminQuery("select count(*)::int n from public.studio_sms_senders where studio_id = $1", [studioId])).rows[0].n);

  it("provisioning configures webhooks on TWILIO_WEBHOOK_BASE_URL, not the app origin, when the base is set", async () => {
    const s = await seedStudio("ctl-base-provision");
    const provider = new FakeSmsProvisioningProvider();
    const configured: Array<[string, unknown]> = [];
    // The fake ignores its arguments; the orchestration passes the URLs it configures.
    const inbound = provider.configureInboundWebhook.bind(provider) as unknown as (a: unknown) => Promise<unknown>;
    const status = provider.configureStatusCallback.bind(provider) as unknown as (a: unknown) => Promise<unknown>;
    provider.configureInboundWebhook = (async (arg: unknown) => { configured.push(["inbound", arg]); return inbound(arg); }) as never;
    provider.configureStatusCallback = (async (arg: unknown) => { configured.push(["status", arg]); return status(arg); }) as never;
    const found = await controls.runSenderSearch({ provider }, { country: "CA", areaCode: "905" });
    const out = await controls.runSenderProvision(
      { ...deps(provider), env: { TWILIO_WEBHOOK_BASE_URL: `${BASE}/` } },
      { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "905", phoneNumber: found.ok ? found.candidates[0].phoneNumber : "" },
    );
    expect(out).toMatchObject({ ok: true, result: "activated" });
    const text = JSON.stringify(configured);
    expect(text).toContain(`${BASE}/api/twilio/inbound-sms`);
    expect(text).toContain(`${BASE}/api/twilio/message-status`);
    expect(text).not.toContain(ORIGIN);
  });

  it("adoption requires the BASE: a service wired to the app origin is refused when the base differs, before any claim", async () => {
    const s = await seedStudio("ctl-base-adopt");
    const out = await adopt(fake(svc({})), s.studioId, s.userId, { TWILIO_WEBHOOK_BASE_URL: BASE });
    expect(out).toEqual({ ok: false, result: "refused", reason: "service_webhooks_mismatch", uncertain: false });
    expect(await claims(s.studioId)).toBe(0);
  });

  it("flag ON and the number's own webhook is Hone's: adopted, whatever the service's inbound URL says", async () => {
    const s = await seedStudio("ctl-flag-on-ok");
    const provider = fake(svc({ useInboundWebhookOnNumber: true, inboundUrl: "https://elsewhere.example/sms" }), {
      [NUMBER]: `${ORIGIN}/api/twilio/inbound-sms`,
    });
    expect(await adopt(provider, s.studioId, s.userId)).toMatchObject({ ok: true, result: "adopted" });
  });

  it("flag ON and the number's webhook points elsewhere: refused before the claim, even though the service URL is Hone's", async () => {
    const s = await seedStudio("ctl-flag-on-other");
    const provider = fake(svc({ useInboundWebhookOnNumber: true }), { [NUMBER]: "https://elsewhere.example/sms" });
    expect(await adopt(provider, s.studioId, s.userId)).toEqual({ ok: false, result: "refused", reason: "service_webhooks_mismatch", uncertain: false });
    expect(await claims(s.studioId)).toBe(0);
  });

  it("flag UNREPORTED, or ON with the number's URL unreported: refused as uncertain before the claim (unknown is a blocker)", async () => {
    const s = await seedStudio("ctl-flag-unknown");
    for (const provider of [
      fake(svc({ useInboundWebhookOnNumber: null })),
      fake(svc({ useInboundWebhookOnNumber: true }), { [NUMBER]: undefined }),
    ]) {
      expect(await adopt(provider, s.studioId, s.userId)).toEqual({ ok: false, result: "refused", reason: "inbound_routing_unknown", uncertain: true });
    }
    expect(await claims(s.studioId)).toBe(0);
  });

  it("flag OFF and no service inbound URL (inbound disabled): refused", async () => {
    const s = await seedStudio("ctl-inbound-disabled");
    expect(await adopt(fake(svc({ inboundUrl: null })), s.studioId, s.userId)).toMatchObject({ ok: false, result: "refused", reason: "service_webhooks_mismatch" });
  });
});

// Codex P2 4251747847: every studio has its OWN demo account, and a resource
// already recorded anywhere is refused before the claim.
describe("per-studio demo inventory and the recorded-resource check", () => {
  it("two studios get different demo services, from a line range search never offers", async () => {
    const a = await seedStudio("ctl-inv-a");
    const b = await seedStudio("ctl-inv-b");
    const ia = controls.demoAdoptionInventory(a.studioId);
    const ib = controls.demoAdoptionInventory(b.studioId);
    expect(ia.messagingServiceSid).not.toBe(ib.messagingServiceSid);
    for (const n of [ia.numbers.CA.phoneNumber, ia.numbers.US.phoneNumber]) {
      const line = Number(n.slice(-4));
      expect(line).toBeGreaterThanOrEqual(150);
      expect(line).toBeLessThanOrEqual(199);
    }
    // Both adopt their own demo number.
    for (const s of [a, b]) {
      const inv = controls.demoAdoptionInventory(s.studioId);
      const out = await controls.runSenderAdoption(deps(controls.senderControlsFakeProvider(ORIGIN, s.studioId)), {
        studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: inv.numbers.CA.phoneNumber, messagingServiceSid: inv.messagingServiceSid,
      });
      // Two studios may hash to the same 555-01xx line: the second is then refused BEFORE a claim.
      if (!out.ok) expect(out).toEqual({ ok: false, result: "refused", reason: "resource_already_recorded", uncertain: false });
      else expect(out).toMatchObject({ ok: true, result: "adopted" });
    }
  });

  it("a number or service already recorded for another studio is refused before any claim", async () => {
    const owner = await seedStudio("ctl-rec-owner");
    const other = await seedStudio("ctl-rec-other");
    const r = () => Math.floor(Math.random() * 16 ** 8).toString(16).padStart(8, "0");
    const mg = `MG${r()}${r()}${r()}${r()}`;
    const ca = `+1416555${String(2000 + Math.floor(Math.random() * 7999))}`;
    const us = `+1212555${String(2000 + Math.floor(Math.random() * 7999))}`;
    const provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [ca]: "PN" + r() + r() + r() + r(), [us]: "PN" + r() + r() + r() + r() },
      accountServices: [{ sid: mg, numbers: [ca, us], inboundUrl: `${ORIGIN}/api/twilio/inbound-sms`, statusUrl: `${ORIGIN}/api/twilio/message-status` }],
    });
    expect(await controls.runSenderAdoption(deps(provider), {
      studioId: owner.studioId, actorUserId: owner.userId, country: "CA", phoneNumber: ca, messagingServiceSid: mg,
    })).toMatchObject({ ok: true, result: "adopted" });
    // The SAME account's service, offered to another studio.
    const out = await controls.runSenderAdoption(deps(provider), {
      studioId: other.studioId, actorUserId: other.userId, country: "US", phoneNumber: us, messagingServiceSid: mg,
    });
    expect(out).toEqual({ ok: false, result: "refused", reason: "resource_already_recorded", uncertain: false });
    expect(await liveSenders(other.studioId)).toEqual([]);
  });
});

// Codex P2 4251989009: a definitive pre-purchase failure can be released and
// the owner can choose again; anything that might own a number cannot.
describe("release and choose again", () => {
  const status = async (studioId: string) =>
    (await adminQuery("select status, claimed_phone_number from public.studio_sms_senders where studio_id = $1 order by created_at", [studioId])).rows;

  /** Wedge a studio the way a stale search does: claim a number, then fail it as no longer available. */
  async function wedge(label: string, code = "number_no_longer_available") {
    const s = await seedStudio(label);
    const number = await freshNumber("905");
    const { rows } = await adminQuery(
      "select * from public.claim_studio_sms_provisioning($1, $2, 'CA', null, $3)",
      [s.studioId, s.userId, number],
    );
    await adminQuery("select public.fail_studio_sms_provisioning($1, $2, $3, $4)", [s.studioId, rows[0].claim_key, rows[0].lease_generation, code]);
    return { s, number, claimKey: rows[0].claim_key as string };
  }

  it("STALE SEARCH: the number another studio bought is refused before the claim; nothing is wedged", async () => {
    const a = await seedStudio("ctl-stale-a");
    const b = await seedStudio("ctl-stale-b");
    const provider = new FakeSmsProvisioningProvider();
    const found = await controls.runSenderSearch({ provider }, { country: "CA", areaCode: "613" });
    const pick = found.ok ? found.candidates[0].phoneNumber : "";
    expect(await controls.runSenderProvision(deps(provider), { studioId: a.studioId, actorUserId: a.userId, country: "CA", areaCode: "613", phoneNumber: pick }))
      .toMatchObject({ ok: true, result: "activated" });
    expect(await controls.runSenderProvision(deps(provider), { studioId: b.studioId, actorUserId: b.userId, country: "CA", areaCode: "613", phoneNumber: pick }))
      .toEqual({ ok: false, result: "refused", reason: "resource_already_recorded", uncertain: false });
    expect(await status(b.studioId)).toEqual([]);
  });

  it("RELEASED: a claim parked as number_no_longer_available, which owns nothing, is released and the owner provisions another number", async () => {
    const { s, number } = await wedge("ctl-release-ok");
    const provider = new FakeSmsProvisioningProvider();
    // Before: any other number is refused against the write-once claim.
    expect(await controls.runSenderProvision(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "905", phoneNumber: "+19055550120" }))
      .toMatchObject({ ok: false, result: "refused", reason: "number_mismatch" });
    expect(await controls.runSenderRelease(deps(provider), { studioId: s.studioId, actorUserId: s.userId })).toMatchObject({ ok: true, result: "released" });
    expect(await status(s.studioId)).toEqual([{ status: "released", claimed_phone_number: number }]);
    expect(await controls.runSenderProvision(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "905", phoneNumber: "+19055550121" }))
      .toMatchObject({ ok: true, result: "activated" });
  });

  it("REFUSED: not an owner, nothing live, an active sender, or an ambiguous (timeout) failure; nothing changes", async () => {
    const provider = new FakeSmsProvisioningProvider();
    const { s } = await wedge("ctl-release-member");
    const member = await seedMember(s, "rel-member");
    expect(await controls.runSenderRelease(deps(provider), { studioId: s.studioId, actorUserId: member.userId })).toEqual({ ok: false, result: "refused", reason: "not_owner", uncertain: false });
    const none = await seedStudio("ctl-release-none");
    expect(await controls.runSenderRelease(deps(provider), { studioId: none.studioId, actorUserId: none.userId })).toMatchObject({ ok: false, reason: "no_live_sender" });
    const { s: t } = await wedge("ctl-release-timeout", "provider_timeout");
    expect(await controls.runSenderRelease(deps(provider), { studioId: t.studioId, actorUserId: t.userId })).toEqual({ ok: false, result: "refused", reason: "not_releasable", uncertain: false });
    expect((await status(t.studioId)).map((r) => r.status)).toEqual(["error"]);
  });

  it("REFUSED: the provider holds something under the claim key (a purchase whose answer was lost)", async () => {
    const { s, number, claimKey } = await wedge("ctl-release-owned");
    const provider = new FakeSmsProvisioningProvider();
    // The fake bought it under this key; the database never heard.
    await provider.purchaseNumber({ claimKey, phoneNumber: number });
    expect(await controls.runSenderRelease(deps(provider), { studioId: s.studioId, actorUserId: s.userId })).toEqual({ ok: false, result: "refused", reason: "resources_found", uncertain: false });
    expect((await status(s.studioId)).map((r) => r.status)).toEqual(["error"]);
  });

  it("UNCERTAIN: the provider cannot answer; nothing is released", async () => {
    const { s } = await wedge("ctl-release-uncertain");
    const provider = new FakeSmsProvisioningProvider({ lookupFails: "provider_timeout" });
    expect(await controls.runSenderRelease(deps(provider), { studioId: s.studioId, actorUserId: s.userId })).toEqual({ ok: false, result: "refused", reason: "ownership_unverified", uncertain: true });
    expect((await status(s.studioId)).map((r) => r.status)).toEqual(["error"]);
  });

  it("the release COMMAND re-checks eligibility itself: a timeout-coded claim is refused even with the right sender and key", async () => {
    const { s, claimKey } = await wedge("ctl-release-cmd-timeout", "provider_timeout");
    const sender = (await adminQuery("select id from public.studio_sms_senders where studio_id = $1", [s.studioId])).rows[0].id;
    expect((await adminQuery("select public.release_unpurchased_studio_sms_claim($1, $2, $3, $4, $5) r", [s.studioId, s.userId, sender, claimKey, 1])).rows[0].r).toBe("not_releasable");
    expect((await status(s.studioId)).map((r) => r.status)).toEqual(["error"]);
  });

  it("the release command is compare-and-set, owner-derived and service_role only", async () => {
    const { s, claimKey } = await wedge("ctl-release-cas");
    const sender = (await adminQuery("select id from public.studio_sms_senders where studio_id = $1", [s.studioId])).rows[0].id;
    expect((await adminQuery("select public.release_unpurchased_studio_sms_claim($1, $2, $3, $4, $5) r", [s.studioId, s.userId, sender, "hone-sms-" + "0".repeat(32), 1])).rows[0].r).toBe("sender_changed");
    expect((await adminQuery("select public.release_unpurchased_studio_sms_claim($1, $2, $3, $4, $5) r", [s.studioId, s.userId, "00000000-0000-4000-8000-000000000000", claimKey, 1])).rows[0].r).toBe("sender_changed");
    for (const role of ["anon", "authenticated"] as const) {
      for (const sql of [
        "select public.release_unpurchased_studio_sms_claim($1, $2, $3, $4, $5)",
        "select * from public.get_releasable_studio_sms_claim($1, $2)",
        "select public.studio_sms_resource_recorded($1, $2, null)",
      ]) {
        const params = sql.includes("release_") ? [s.studioId, s.userId, sender, claimKey, 1] : sql.includes("releasable") ? [s.studioId, s.userId] : [s.studioId, "+19055550100"];
        await expect(asRole(role, (q) => q(sql, params)), `${role} ${sql.slice(7, 40)}`).rejects.toMatchObject({ code: "42501" });
      }
    }
  });
});

// Codex P2 4252928388 and 4252928398: released history counts, and the claim on
// a number is an atomic reservation.
describe("resource history and the atomic reservation", () => {
  // A number NO row in this database records (number or claim), so a test is
  // never refused for a collision it did not set up. The suite shares one DB.
  const rand = () => freshNumber("905");

  it("this studio's RELEASED number is refused before a new claim (0191's uniqueness still holds it)", async () => {
    const s = await seedStudio("ctl-hist-released");
    const number = await rand();
    // History: an active sender on that number, later released (superuser, test-only).
    const { rows } = await adminQuery(
      `insert into public.studio_sms_senders
         (studio_id, provider, status, country, claimed_phone_number, phone_number, phone_number_sid, messaging_service_sid,
          provisioning_claim_key, provisioning_claim_at, provisioning_claim_by_practitioner_id, provisioning_lease_generation, provisioned_at, last_test_ok_at)
       values ($1, 'twilio', 'active', 'CA', $2, $2, $3, $4, $5, now(), $6, 1, now(), now()) returning id`,
      [s.studioId, number, "PN" + "f1".repeat(16), "MG" + "f2".repeat(16), "hone-sms-" + "f3".repeat(16), s.practitionerId],
    );
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [rows[0].id]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [rows[0].id]);
    const provider = new FakeSmsProvisioningProvider();
    expect(await controls.runSenderProvision(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "905", phoneNumber: number }))
      .toEqual({ ok: false, result: "refused", reason: "resource_already_recorded", uncertain: false });
    expect(provider.calls.purchase).toBe(0);
    expect((await adminQuery("select count(*)::int n from public.studio_sms_senders where studio_id = $1 and status <> 'released'", [s.studioId])).rows[0].n).toBe(0);
  });

  it("the studio's OWN live attempt is not counted against its retry", async () => {
    const s = await seedStudio("ctl-hist-retry");
    const number = await rand();
    const provider = new FakeSmsProvisioningProvider({ testSendFails: "provider_unavailable" });
    const first = await controls.runSenderProvision(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "905", phoneNumber: number });
    // It failed for the reason this test set up (the proof text), past the
    // claim -- not for a collision.
    expect(first).toMatchObject({ ok: false, result: "failed" });
    // The retry of the SAME number passes the recorded check and reaches the orchestration.
    const retry = await controls.runSenderProvision(deps(new FakeSmsProvisioningProvider()), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "905", phoneNumber: number });
    expect(retry).not.toMatchObject({ reason: "resource_already_recorded" });
  });

  it("ATOMIC: a second studio's claim on a number another studio holds a live claim on is refused by the database itself", async () => {
    const a = await seedStudio("ctl-race-a");
    const b = await seedStudio("ctl-race-b");
    const number = await rand();
    const claim = (s: SeededStudioLike) =>
      adminQuery("select * from public.claim_studio_sms_provisioning($1, $2, 'CA', null, $3)", [s.studioId, s.userId, number]);
    expect((await claim(a)).rows[0].result).toBe("claimed");
    // No pre-check in the way: the claim command alone must refuse, before any provider work.
    expect((await claim(b)).rows[0].result).toBe("not_claimable");
    expect((await adminQuery("select count(*)::int n from public.studio_sms_senders where studio_id = $1", [b.studioId])).rows[0].n).toBe(0);
  });

  it("CONCURRENT: two studios submitting one number at once -> exactly one claim, nothing bought for the other", async () => {
    const a = await seedStudio("ctl-conc-a");
    const b = await seedStudio("ctl-conc-b");
    const number = await rand();
    const pa = new FakeSmsProvisioningProvider();
    const pb = new FakeSmsProvisioningProvider();
    const [ra, rb] = await Promise.all([
      controls.runSenderProvision(deps(pa), { studioId: a.studioId, actorUserId: a.userId, country: "CA", areaCode: "905", phoneNumber: number }),
      controls.runSenderProvision(deps(pb), { studioId: b.studioId, actorUserId: b.userId, country: "CA", areaCode: "905", phoneNumber: number }),
    ]);
    const winners = [ra, rb].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect(pa.calls.purchase + pb.calls.purchase).toBe(1);
    const live = await adminQuery("select count(*)::int n from public.studio_sms_senders where claimed_phone_number = $1 and status <> 'released'", [number]);
    expect(live.rows[0].n).toBe(1);
  });

  it("a finalize_conflict claim is releasable only when the provider holds nothing under its key", async () => {
    const s = await seedStudio("ctl-rel-fc");
    const number = await rand();
    const { rows } = await adminQuery("select * from public.claim_studio_sms_provisioning($1, $2, 'CA', null, $3)", [s.studioId, s.userId, number]);
    await adminQuery("select public.fail_studio_sms_provisioning($1, $2, $3, 'finalize_conflict')", [s.studioId, rows[0].claim_key, rows[0].lease_generation]);
    const holding = new FakeSmsProvisioningProvider();
    await holding.purchaseNumber({ claimKey: rows[0].claim_key, phoneNumber: number });
    expect(await controls.runSenderRelease(deps(holding), { studioId: s.studioId, actorUserId: s.userId })).toMatchObject({ ok: false, reason: "resources_found" });
    expect(await controls.runSenderRelease(deps(new FakeSmsProvisioningProvider()), { studioId: s.studioId, actorUserId: s.userId })).toMatchObject({ ok: true, result: "released" });
  });

  // Codex P2 4266274277: a RETRY between the provider read and the release
  // keeps the sender and key, takes the lease forward, may buy, and can park
  // the row back in a releasable `error`. The provider's "nothing" was about
  // the earlier attempt, so the release must refuse.
  const senderStatuses = async (studioId: string): Promise<string[]> =>
    (await adminQuery("select status from public.studio_sms_senders where studio_id = $1 order by created_at", [studioId])).rows.map((r) => r.status as string);

  it("FENCED: a retry that runs after the provider read and buys is never released by that stale answer", async () => {
    const s = await seedStudio("ctl-rel-fence");
    const number = await rand();
    const first = (await adminQuery("select * from public.claim_studio_sms_provisioning($1, $2, 'CA', null, $3)", [s.studioId, s.userId, number])).rows[0];
    await adminQuery("select public.fail_studio_sms_provisioning($1, $2, $3, 'number_no_longer_available')", [s.studioId, first.claim_key, first.lease_generation]);

    const bought = new FakeSmsProvisioningProvider();
    let retried: { claim_key: string; lease_generation: number } | null = null;
    // The provider answers "nothing" for the claim as it stood -- and, before
    // the release command runs, a retry takes the lease forward, buys, and is
    // parked back in error with a releasable code.
    const racing = new FakeSmsProvisioningProvider();
    const lookup = racing.lookupResourcesByClaim.bind(racing);
    racing.lookupResourcesByClaim = async (claimKey: string) => {
      const answer = await lookup(claimKey);
      retried = (await adminQuery("select * from public.claim_studio_sms_provisioning($1, $2, 'CA', null, $3)", [s.studioId, s.userId, number])).rows[0];
      await bought.purchaseNumber({ claimKey: retried!.claim_key, phoneNumber: number });
      await adminQuery("select public.fail_studio_sms_provisioning($1, $2, $3, 'finalize_conflict')", [s.studioId, retried!.claim_key, retried!.lease_generation]);
      return answer;
    };

    expect(await controls.runSenderRelease(deps(racing), { studioId: s.studioId, actorUserId: s.userId })).toEqual({
      ok: false, result: "refused", reason: "sender_changed", uncertain: false,
    });
    // The retry kept the key and moved the generation; the row is still live.
    expect(retried!.claim_key).toBe(first.claim_key);
    expect(retried!.lease_generation).toBeGreaterThan(first.lease_generation);
    expect(await senderStatuses(s.studioId)).toEqual(["error"]);
    // Asked afresh, the provider reports what the retry bought: still refused.
    expect(await controls.runSenderRelease(deps(bought), { studioId: s.studioId, actorUserId: s.userId })).toMatchObject({ ok: false, reason: "resources_found" });
    expect(await senderStatuses(s.studioId)).toEqual(["error"]);
  });

  it("the release command refuses a stale lease generation even with the right sender and key", async () => {
    const s = await seedStudio("ctl-release-cmd-gen");
    const c = (await adminQuery("select * from public.claim_studio_sms_provisioning($1, $2, 'CA', null, $3)", [s.studioId, s.userId, await rand()])).rows[0];
    await adminQuery("select public.fail_studio_sms_provisioning($1, $2, $3, 'number_no_longer_available')", [s.studioId, c.claim_key, c.lease_generation]);
    const claimKey = c.claim_key as string;
    const { rows } = await adminQuery("select * from public.get_releasable_studio_sms_claim($1, $2)", [s.studioId, s.userId]);
    expect(rows[0]).toMatchObject({ result: "releasable", claim_key: claimKey });
    const gen = rows[0].lease_generation as number;
    expect((await adminQuery("select public.release_unpurchased_studio_sms_claim($1, $2, $3, $4, $5) r", [s.studioId, s.userId, rows[0].sender_id, claimKey, gen + 1])).rows[0].r).toBe("sender_changed");
    expect((await adminQuery("select public.release_unpurchased_studio_sms_claim($1, $2, $3, $4, $5) r", [s.studioId, s.userId, rows[0].sender_id, claimKey, null])).rows[0].r).toBe("invalid_input");
    expect((await adminQuery("select public.release_unpurchased_studio_sms_claim($1, $2, $3, $4, $5) r", [s.studioId, s.userId, rows[0].sender_id, claimKey, gen])).rows[0].r).toBe("released");
  });
});

type SeededStudioLike = { studioId: string; userId: string };

// Codex P2 4253781002: the searched area code is the claim's recorded request,
// and the chosen number must be in it.
describe("searched area-code provenance", () => {
  it("the search returns the area code it used; provisioning records it on the claim", async () => {
    const s = await seedStudio("ctl-area-prov");
    const provider = new FakeSmsProvisioningProvider();
    const found = await controls.runSenderSearch({ provider }, { country: "CA", areaCode: "613" });
    expect(found).toMatchObject({ ok: true, areaCode: "613" });
    const held = new Set(
      (await adminQuery("select phone_number from public.studio_sms_senders where phone_number is not null")).rows.map((r) => r.phone_number as string),
    );
    const pick = found.ok ? found.candidates.map((c) => c.phoneNumber).find((n) => !held.has(n))! : "";
    expect(pick.slice(2, 5)).toBe("613");
    expect(await controls.runSenderProvision(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: found.ok ? found.areaCode : null, phoneNumber: pick }))
      .toMatchObject({ ok: true, result: "activated" });
    const { rows } = await adminQuery("select requested_area_code from public.studio_sms_senders where studio_id = $1", [s.studioId]);
    expect(rows).toEqual([{ requested_area_code: "613" }]);
  });

  it("a number outside the requested area code is refused before any claim", async () => {
    const s = await seedStudio("ctl-area-mismatch");
    const out = await controls.runSenderProvision(deps(new FakeSmsProvisioningProvider()), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "613", phoneNumber: "+14165553101",
    });
    expect(out).toEqual({ ok: false, result: "refused", reason: "area_code_mismatch" });
    expect((await adminQuery("select count(*)::int n from public.studio_sms_senders where studio_id = $1", [s.studioId])).rows[0].n).toBe(0);
  });
});

// Codex decision on #863: ONE strict normalizer. A same-endpoint inbound URL
// with a valid Twilio connection override is adopted; an invalid fragment or
// any change before the # is refused, before the claim.
describe("connection-override fragments on adoption", () => {
  const adoptWith = async (label: string, inboundUrl: string, statusUrl = `${ORIGIN}/api/twilio/message-status`) => {
    const s = await seedStudio(label);
    const number = await freshNumber("416");
    const r = () => Math.floor(Math.random() * 16 ** 8).toString(16).padStart(8, "0");
    const mg = `MG${r()}${r()}${r()}${r()}`;
    const provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [number]: "PN" + r() + r() + r() + r() },
      accountServices: [{ sid: mg, numbers: [number], inboundUrl, statusUrl }],
    });
    return controls.runSenderAdoption(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: number, messagingServiceSid: mg });
  };

  it("#rp=5xx on the same endpoint is adopted (and on the status callback too)", async () => {
    expect(await adoptWith("ctl-frag-ok", `${ORIGIN}/api/twilio/inbound-sms#rp=5xx`)).toMatchObject({ ok: true, result: "adopted" });
    expect(await adoptWith("ctl-frag-status", `${ORIGIN}/api/twilio/inbound-sms#rp=5xx&rc=2`, `${ORIGIN}/api/twilio/message-status#rp=all`)).toMatchObject({ ok: true, result: "adopted" });
  });

  it("an invalid or unknown fragment, or a changed query, is refused before any claim", async () => {
    for (const [label, url] of [
      ["ctl-frag-ct0", `${ORIGIN}/api/twilio/inbound-sms#ct=0`],
      ["ctl-frag-unknown", `${ORIGIN}/api/twilio/inbound-sms#rp=5xx&foo=1`],
      ["ctl-frag-query", `${ORIGIN}/api/twilio/inbound-sms?x=1#rp=5xx`],
      ["ctl-frag-empty", `${ORIGIN}/api/twilio/inbound-sms#`],
    ]) {
      expect(await adoptWith(label, url), label).toEqual({ ok: false, result: "refused", reason: "service_webhooks_mismatch", uncertain: false });
    }
  });
});

// Codex P2 4271461595, 4271749292, 4272070468: an errored setup offers only
// what is honest without its ORIGIN (not stored): 0226's release for the
// definitive pre-purchase codes, and a truthful support line for everything
// else. Every case below would have been offered a "retry" by an earlier
// head, and each is a case where a provisioning retry is wrong or unproven.
describe("errored setups: release or a truthful support line, never a retry that cannot work", () => {
  const live = async (studioId: string) =>
    (await adminQuery("select status, phone_number, claimed_phone_number, last_error_code from public.studio_sms_senders where studio_id = $1 and status <> 'released'", [studioId])).rows[0];

  it("PROVISIONED, stranded after a purchase (nothing recorded): support, and release is correctly refused", async () => {
    const s = await seedStudio("ctl-err-stranded");
    const number = await freshNumber("416");
    const provider = new FakeSmsProvisioningProvider({ attachFails: "provider_unavailable" });
    expect((await controls.runSenderProvision(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "416", phoneNumber: number })).ok).toBe(false);
    const row = await live(s.studioId);
    expect(row).toMatchObject({ status: "error", phone_number: null, last_error_code: "provider_unavailable", claimed_phone_number: number });
    expect(controls.senderRecoveryFor(row.status, row.last_error_code)).toBe("support");
    expect(await controls.runSenderRelease(deps(provider), { studioId: s.studioId, actorUserId: s.userId })).toMatchObject({ ok: false, reason: "not_releasable" });
    expect(provider.calls.purchase).toBe(1);
  });

  it("ADOPTED, test failed (identifiers recorded; Codex 4271749292): support", async () => {
    const s = await seedStudio("ctl-err-adopted");
    const provider = controls.senderControlsFakeProvider(ORIGIN, s.studioId);
    const inventory = (await import("@/lib/sms/sender-controls-demo")).demoAdoptionInventory(s.studioId);
    provider.script = { ...provider.script, testSendFails: "provider_unavailable" };
    expect((await controls.runSenderAdoption(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: inventory.numbers.CA.phoneNumber, messagingServiceSid: inventory.messagingServiceSid,
    })).ok).toBe(false);
    const row = await live(s.studioId);
    expect(row).toMatchObject({ status: "error", phone_number: inventory.numbers.CA.phoneNumber, last_error_code: "provider_unavailable" });
    expect(controls.senderRecoveryFor(row.status, row.last_error_code)).toBe("support");
    expect(provider.calls.purchase).toBe(0);
  });

  it("PROVISIONED, finalized then the test failed: support", async () => {
    const s = await seedStudio("ctl-err-finalized");
    const number = await freshNumber("416");
    const provider = new FakeSmsProvisioningProvider({ testSendFails: "provider_unavailable" });
    expect((await controls.runSenderProvision(deps(provider), { studioId: s.studioId, actorUserId: s.userId, country: "CA", areaCode: "416", phoneNumber: number })).ok).toBe(false);
    const row = await live(s.studioId);
    expect(row).toMatchObject({ status: "error", phone_number: number, last_error_code: "provider_unavailable" });
    expect(controls.senderRecoveryFor(row.status, row.last_error_code)).toBe("support");
  });

  it("a definitive pre-purchase failure: release, and it releases", async () => {
    const s = await seedStudio("ctl-err-release");
    const number = await freshNumber("905");
    const c = (await adminQuery("select * from public.claim_studio_sms_provisioning($1, $2, 'CA', null, $3)", [s.studioId, s.userId, number])).rows[0];
    await adminQuery("select public.fail_studio_sms_provisioning($1, $2, $3, 'number_no_longer_available')", [s.studioId, c.claim_key, c.lease_generation]);
    const row = await live(s.studioId);
    expect(controls.senderRecoveryFor(row.status, row.last_error_code)).toBe("release");
    expect(await controls.runSenderRelease(deps(new FakeSmsProvisioningProvider()), { studioId: s.studioId, actorUserId: s.userId })).toMatchObject({ ok: true, result: "released" });
  });
});
