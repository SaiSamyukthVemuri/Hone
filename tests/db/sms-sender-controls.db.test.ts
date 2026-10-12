import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, closePool, seedMember, seedStudio } from "./helpers/harness";
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

const deps = (provider: FakeSmsProvisioningProvider) => ({ admin, provider, appOrigin: ORIGIN, testDestination: "+14165550199" });
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
    expect(readiness.map((r) => `${r.destination}:${r.state}`)).toEqual(["CA:active", "US:requires_information"]);

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
    const NUMBER = "+14165550177";
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
      studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: "+14165550178", messagingServiceSid: "MG" + "f".repeat(32),
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
    const provider = controls.senderControlsFakeProvider(ORIGIN);
    const { CA } = controls.DEMO_ADOPTION_INVENTORY.numbers;
    const out = await controls.runSenderAdoption(deps(provider), {
      studioId: s.studioId, actorUserId: s.userId, country: "CA", phoneNumber: CA.phoneNumber,
      messagingServiceSid: controls.DEMO_ADOPTION_INVENTORY.messagingServiceSid,
    });
    expect(out).toMatchObject({ ok: true, result: "adopted", phoneNumber: CA.phoneNumber });
    expect(provider.calls.purchase).toBe(0);
    expect(await liveSenders(s.studioId)).toEqual([{ status: "active", phone_number: CA.phoneNumber, country: "CA" }]);
  });

  it("the demo numbers are never offered for purchase, and another studio can still provision", async () => {
    const s = await seedStudio("ctl-demo-provision");
    const provider = controls.senderControlsFakeProvider(ORIGIN);
    const found = await controls.runSenderSearch({ provider }, { country: "US", areaCode: "212" });
    const numbers = found.ok ? found.candidates.map((c) => c.phoneNumber) : [];
    expect(numbers).not.toContain(controls.DEMO_ADOPTION_INVENTORY.numbers.US.phoneNumber);
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
