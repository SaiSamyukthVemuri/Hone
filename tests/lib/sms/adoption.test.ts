import { beforeEach, describe, expect, it } from "vitest";
import { adoptExistingStudioSmsSender } from "@/lib/sms/adoption";
import { provisionStudioSmsSender } from "@/lib/sms/provisioning";
import { PROVIDER_ERROR_CODES } from "@/lib/sms/provider/types";
import {
  FakeSmsProvisioningProvider,
  type FakeProviderScript,
} from "@/lib/sms/provider/fake-provider";
import {
  InMemoryProvisioningStore,
  type Membership,
} from "./helpers/in-memory-provisioning-store";

// WILLOW ADOPTION — establishing 0191's lifecycle over an ALREADY-OWNED sender.
//
// The property under test is that "adopt" is a DIFFERENT PROVIDER OPERATION
// from "purchase", not a flag on it. It must reach the same end state — a row
// that is `active` only on a real provider test — while never buying, never
// creating a Messaging Service, and never moving a number between services.
//
// The most valuable assertion in this file is a NEGATIVE one: purchase count
// stays at zero. Everything else could be right and that could still be wrong,
// and the failure would cost real money on a real account.
//
// No real Twilio call is reachable: the fake is used directly here, and in
// production resolveProvisioningProvider() returns it unless
// HONE_SMS_PROVISIONING_LIVE is set, which nothing sets.

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const OWNER_A = "user-owner-a";
const STAFF_A = "user-staff-a";
const OWNER_B = "user-owner-b";

/** Willow's existing inventory. */
const WILLOW_NUMBER = "+14165550100";
const WILLOW_PN_SID = "PN" + "a".repeat(32);
const WILLOW_MG_SID = "MG" + "b".repeat(32);
const OTHER_MG_SID = "MG" + "c".repeat(32);

const MEMBERS: Membership[] = [
  { userId: OWNER_A, studioId: STUDIO_A, role: "owner" },
  { userId: STAFF_A, studioId: STUDIO_A, role: "practitioner" },
  { userId: OWNER_B, studioId: STUDIO_B, role: "owner" },
];

let provider: FakeSmsProvisioningProvider;
let store: InMemoryProvisioningStore;

const INBOUND = "https://hone.care/api/twilio/inbound-sms";
const STATUS = "https://hone.care/api/twilio/message-status";

/**
 * The account owns Willow's number, it is in Willow's service, and that service
 * is ALREADY configured the way Hone requires. This is the only shape adoption
 * may proceed from.
 */
function ownedAndAssociated(): FakeProviderScript {
  return {
    preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
    accountServices: [
      { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: INBOUND, statusUrl: STATUS },
    ],
  };
}

function adopt(over: Partial<Parameters<typeof adoptExistingStudioSmsSender>[0]> = {}) {
  return adoptExistingStudioSmsSender({
    store,
    provider,
    studioId: STUDIO_A,
    actorUserId: OWNER_A,
    country: "CA",
    phoneNumber: WILLOW_NUMBER,
    messagingServiceSid: WILLOW_MG_SID,
    requiredInboundWebhookUrl: INBOUND,
    requiredStatusCallbackUrl: STATUS,
    testDestination: "+14165559999",
    testBody: "Hone adoption test.",
    ...over,
  });
}

beforeEach(() => {
  provider = new FakeSmsProvisioningProvider(ownedAndAssociated());
  store = new InMemoryProvisioningStore(MEMBERS);
});

describe("1 + 8. an already-owned number enters the 0191 lifecycle", () => {
  it("adopts, and the row reaches ACTIVE through the ordinary finalize path", async () => {
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: true, result: "adopted", phoneNumber: WILLOW_NUMBER });

    const row = store.live(STUDIO_A)!;
    expect(row.status).toBe("active");
    // The identifiers are the ones the PROVIDER reported, not invented.
    expect(row.phoneNumberSid).toBe(WILLOW_PN_SID);
    expect(row.messagingServiceSid).toBe(WILLOW_MG_SID);
    expect(row.phoneNumber).toBe(WILLOW_NUMBER);
    // Activation still required a real test result.
    expect(row.lastTestOkAt).not.toBeNull();
  });

  it("uses the SAME claim authority: the number is bound write-once", async () => {
    await adopt();
    expect(store.live(STUDIO_A)!.claimedPhoneNumber).toBe(WILLOW_NUMBER);
  });
});

describe("2. NO PURCHASE — the assertion that protects real money", () => {
  it("purchaseNumber is never called on the happy path", async () => {
    await adopt();
    expect(provider.calls.purchase).toBe(0);
  });

  it("no messaging service is created and no number is attached or moved", async () => {
    await adopt();
    expect(provider.calls.createService).toBe(0);
    expect(provider.calls.attach).toBe(0);
  });

  it("the availability/search path is never entered", async () => {
    // Willow OWNS the number, so it is not "available"; asking would either
    // fail or, worse, invite a purchase of something else.
    await adopt();
    expect(provider.calls.search).toBe(0);
    expect(provider.calls.availability).toBe(0);
  });

  it("purchase stays at zero on EVERY refusal path too", async () => {
    const cases: Array<{ name: string; script: FakeProviderScript }> = [
      { name: "not owned", script: { preOwnedNumbers: {} } },
      {
        name: "wrong service",
        script: {
          preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
          accountServices: [{ sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER] }],
        },
      },
      {
        name: "census unavailable",
        script: { ...ownedAndAssociated(), membershipProbeFails: true },
      },
      {
        name: "webhook mismatch",
        script: {
          preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
          accountServices: [
            { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: "https://someone-else.test/hook", statusUrl: STATUS },
          ],
        },
      },
    ];
    for (const c of cases) {
      provider = new FakeSmsProvisioningProvider(c.script);
      store = new InMemoryProvisioningStore(MEMBERS);
      await adopt();
      expect(provider.calls.purchase, c.name).toBe(0);
      expect(provider.calls.attach, c.name).toBe(0);
    }
  });
});

describe("3. wrong account / wrong resource is refused", () => {
  it("a number this account does not own is refused, never bought", async () => {
    provider = new FakeSmsProvisioningProvider({ preOwnedNumbers: {} });
    const outcome = await adopt();
    expect(outcome).toMatchObject({
      ok: false,
      result: "failed",
      reason: "number_not_owned_by_account",
      retryable: false,
    });
    expect(provider.calls.purchase).toBe(0);
    expect(store.live(STUDIO_A)!.status).toBe("error");
  });

  it("the provider answering about a DIFFERENT number is refused", async () => {
    // Guards against a provider (or a mistaken filter) returning a neighbouring
    // record: adopting it would attach Hone to a number nobody chose.
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { "+14165550999": WILLOW_PN_SID },
      accountServices: [{ sid: WILLOW_MG_SID, numbers: ["+14165550999"] }],
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, reason: "number_not_owned_by_account" });
  });

  it("a non-owner is refused before any provider call", async () => {
    const outcome = await adopt({ actorUserId: STAFF_A });
    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: "not_owner" });
    expect(provider.calls.ownedLookup).toBe(0);
    expect(provider.calls.purchase).toBe(0);
  });

  it("cross-studio is refused before any provider call", async () => {
    const outcome = await adopt({ actorUserId: OWNER_B });
    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: "not_a_member" });
    expect(provider.calls.ownedLookup).toBe(0);
    expect(store.live(STUDIO_A)).toBeUndefined();
  });
});

describe("2 + 4. DECISION 2 — the association census is complete and truthful", () => {
  it("number in ANOTHER service: refused, and the refusal NAMES it (safely)", async () => {
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [] },
        { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER] },
      ],
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({
      ok: false,
      reason: "number_in_other_service",
      discovered: { association: "in_other_service" },
    });
    // Truthful AND safe: recognisable in the console, not a usable identifier.
    const ids = (outcome as { discovered: { safeServiceIds: string[] } }).discovered.safeServiceIds;
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(`MG…${OTHER_MG_SID.slice(-4)}`);
    expect(ids[0]).not.toBe(OTHER_MG_SID);
    // NEVER detached or moved.
    expect(provider.calls.attach).toBe(0);
  });

  it("number in NO service: NOT_ASSOCIATED, still refused, still never attached", async () => {
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [{ sid: WILLOW_MG_SID, numbers: [] }],
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({
      reason: "number_not_in_named_service",
      discovered: { association: "not_associated", safeServiceIds: [] },
    });
    expect(provider.calls.attach).toBe(0);
  });

  it("PAGINATION IS EXHAUSTED before absence is claimed", async () => {
    // The number sits in a service on the THIRD page. A first-page-only walk
    // would report not_associated and invite an attach that moves it.
    const services = [
      { sid: "MG" + "1".repeat(32), numbers: [] },
      { sid: "MG" + "2".repeat(32), numbers: [] },
      { sid: "MG" + "3".repeat(32), numbers: [] },
      { sid: "MG" + "4".repeat(32), numbers: [] },
      { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER] },
    ];
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: services,
      servicePageSize: 2,
    });
    const outcome = await adopt();
    expect(provider.calls.servicePages).toBeGreaterThanOrEqual(3);
    expect(outcome).toMatchObject({ reason: "number_in_other_service" });
  });

  it("a FAILED page is UNAVAILABLE, never false absence", async () => {
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [] },
        { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER] },
      ],
      servicePageSize: 1,
      failServicePage: 2,
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({
      reason: "number_association_unavailable",
      discovered: { association: "unavailable" },
      // Retryable: a later attempt may read the page this one could not.
      retryable: true,
    });
    // The decisive assertion: it did NOT say not_associated.
    expect((outcome as { reason: string }).reason).not.toBe("number_not_in_named_service");
    expect(provider.calls.attach).toBe(0);
  });

  it("an unreadable membership probe is UNAVAILABLE too", async () => {
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      membershipProbeFails: true,
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ reason: "number_association_unavailable" });
    expect(store.live(STUDIO_A)!.status).toBe("error");
  });

  it("contradictory associations FAIL CLOSED as ambiguous", async () => {
    // Two services claiming one number. Choosing the expected one would let
    // adoption proceed exactly when the provider cannot say where it is.
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER] },
        { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER] },
      ],
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({
      reason: "number_association_ambiguous",
      discovered: { association: "ambiguous" },
    });
    const ids = (outcome as { discovered: { safeServiceIds: string[] } }).discovered.safeServiceIds;
    expect(ids).toHaveLength(2);
    expect(ids.every((i) => i.includes("…"))).toBe(true);
    expect(provider.calls.attach).toBe(0);
    expect(provider.calls.testSend).toBe(0);
  });
});

describe("1. DECISION 1 — adoption inspects configuration and NEVER writes it", () => {
  it("an INCOMPATIBLE webhook yields provider_configuration_required", async () => {
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: "https://someone-else.test/hook", statusUrl: STATUS },
      ],
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({
      ok: false,
      result: "failed",
      reason: "provider_configuration_required",
      retryable: false,
      configurationMismatch: ["inbound_webhook"],
    });
  });

  it("both mismatches are reported, and no URL is echoed back", async () => {
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [{ sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null }],
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({
      reason: "provider_configuration_required",
      configurationMismatch: ["inbound_webhook", "status_callback"],
    });
    expect(JSON.stringify(outcome)).not.toContain("someone-else.test");
  });

  it("an incompatible webhook causes ZERO provider writes", async () => {
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [{ sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: "https://x.test/h", statusUrl: STATUS }],
    });
    await adopt();
    expect(provider.calls.inboundWebhook).toBe(0);
    expect(provider.calls.statusCallback).toBe(0);
    expect(provider.calls.attach).toBe(0);
    expect(provider.calls.purchase).toBe(0);
    expect(provider.calls.createService).toBe(0);
    // A mismatch is NOT a test failure: no message was sent either.
    expect(provider.calls.testSend).toBe(0);
  });

  it("a mismatch never creates ACTIVE state", async () => {
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [{ sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null }],
    });
    await adopt();
    const row = store.live(STUDIO_A)!;
    expect(row.status).not.toBe("active");
    expect(row.lastTestOkAt).toBeNull();
  });

  it("a COMPATIBLE service is adopted WITHOUT any configuration write", async () => {
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: true, result: "adopted" });
    expect(provider.calls.inboundWebhook).toBe(0);
    expect(provider.calls.statusCallback).toBe(0);
  });

  it("an unreadable configuration refuses rather than assuming compatibility", async () => {
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      serviceConfigFails: "provider_unavailable",
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    expect(provider.calls.testSend).toBe(0);
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
  });
});

describe("5. retry is idempotent", () => {
  it("adopting twice yields already_active and buys nothing", async () => {
    const first = await adopt();
    expect(first).toMatchObject({ result: "adopted" });

    const second = await adopt();
    expect(second).toMatchObject({ ok: true, result: "already_active" });
    expect(provider.calls.purchase).toBe(0);
    expect(store.rows).toHaveLength(1);
  });

  it("a retry after a parked failure reuses the claim and converges", async () => {
    // First attempt: the test message fails, so the attempt parks in `error`
    // with its identifiers recorded and its claim key intact.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      testSendFails: "provider_timeout",
    });
    const first = await adopt();
    expect(first).toMatchObject({ ok: false, result: "failed" });
    const parked = store.live(STUDIO_A)!;
    expect(parked.status).toBe("error");
    expect(parked.phoneNumberSid).toBe(WILLOW_PN_SID);
    expect(parked.lastTestOkAt).toBeNull();

    // The retry recovers on the SAME row and the SAME claim key.
    provider.script = ownedAndAssociated();
    const key = parked.claimKey;
    const second = await adopt();
    expect(second).toMatchObject({ ok: true, result: "adopted" });
    expect(store.live(STUDIO_A)!.claimKey).toBe(key);
    expect(store.rows).toHaveLength(1);
    expect(provider.calls.purchase).toBe(0);
  });

  it("a retry carrying a DIFFERENT number is refused by the write-once binding", async () => {
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      testSendFails: "provider_timeout",
    });
    await adopt();
    const outcome = await adopt({ phoneNumber: "+14165550222" });
    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: "number_mismatch" });
  });
});

describe("6. a competing or stale claim cannot take over", () => {
  it("a live claim EXCLUDES a second adoption, which performs no provider effect", async () => {
    // Hold the claim without finishing: the test send hangs the attempt in
    // `provisioning` behind a live lease.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      testSendFails: "provider_timeout",
    });
    const store2 = new InMemoryProvisioningStore(MEMBERS);
    store = store2;
    // Claim directly so the row stays `provisioning` with a live lease.
    await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: null,
      phoneNumber: WILLOW_NUMBER,
    });

    const fresh = new FakeSmsProvisioningProvider(ownedAndAssociated());
    provider = fresh;
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "in_progress" });
    expect(fresh.calls.ownedLookup).toBe(0);
    expect(fresh.calls.purchase).toBe(0);
  });

  it("a DISPLACED adopter performs no further provider effect and reports lease_lost", async () => {
    // Stall the adopter at its test send, let the lease expire, take the
    // attempt over, then let the old one resume.
    let takenOver = false;
    const stalling = new FakeSmsProvisioningProvider(ownedAndAssociated());
    const original = stalling.sendProvisioningTest.bind(stalling);
    stalling.sendProvisioningTest = async (input) => {
      if (!takenOver) {
        takenOver = true;
        store.now += store.leaseMs + 1;
        // A newer generation takes the attempt over.
        await store.claim({
          studioId: STUDIO_A,
          actorUserId: OWNER_A,
          country: "CA",
          areaCode: null,
          phoneNumber: WILLOW_NUMBER,
        });
      }
      return original(input);
    };
    provider = stalling;

    const outcome = await adopt();
    expect(outcome).toMatchObject({ result: "lease_lost" });
    // The displaced worker never activated anything.
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
    expect(stalling.calls.purchase).toBe(0);
  });

  it("displaced AT THE OWNERSHIP READ: the adoption-only fence point", async () => {
    // takeover-matrix.test.ts declares lookupOwnedNumber "adoption-path only"
    // and requires this path to prove it. A displaced worker must stop at the
    // read itself, before it can configure or send anything.
    const stalling = new FakeSmsProvisioningProvider(ownedAndAssociated());
    const originalLookup = stalling.lookupOwnedNumber.bind(stalling);
    let firstCall = true;
    stalling.lookupOwnedNumber = async (input) => {
      if (firstCall) {
        firstCall = false;
        store.now += store.leaseMs + 1;
        await store.claim({
          studioId: STUDIO_A,
          actorUserId: OWNER_A,
          country: "CA",
          areaCode: null,
          phoneNumber: WILLOW_NUMBER,
        });
      }
      return originalLookup(input);
    };
    provider = stalling;

    const outcome = await adopt();
    expect(outcome).toMatchObject({ result: "lease_lost" });
    // Nothing downstream of the read was reached.
    expect(stalling.calls.inboundWebhook).toBe(0);
    expect(stalling.calls.statusCallback).toBe(0);
    expect(stalling.calls.testSend).toBe(0);
    expect(stalling.calls.purchase).toBe(0);
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
  });

  it("every provider call runs through the fence", async () => {
    await adopt();
    // Adoption performs exactly THREE fenced provider operations now that it
    // configures nothing: the ownership census, the configuration read, and the
    // provisioning test. Asserting the exact number means a fourth appearing --
    // a configuration write sneaking back in -- fails here.
    expect(store.fenceCalls).toHaveLength(3);
    expect(store.fenceCalls.every((c) => c.phoneNumber === WILLOW_NUMBER)).toBe(true);
    expect(store.fenceCalls.every((c) => c.granted)).toBe(true);
  });
});

describe("7. a provider-test failure NEVER produces ACTIVE", () => {
  it("a failed test parks the identifiers without activating", async () => {
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      testSendFails: "provider_rejected",
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });

    const row = store.live(STUDIO_A)!;
    expect(row.status).not.toBe("active");
    expect(row.lastTestOkAt).toBeNull();
    // The resources are real and must be remembered, or Hone pays for a number
    // it has no record of.
    expect(row.phoneNumberSid).toBe(WILLOW_PN_SID);
  });

  it("adoption has no path that finalizes with testOk true after a failed test", async () => {
    for (const code of ["provider_timeout", "provider_rejected", "provider_unavailable"] as const) {
      provider = new FakeSmsProvisioningProvider({ ...ownedAndAssociated(), testSendFails: code });
      store = new InMemoryProvisioningStore(MEMBERS);
      await adopt();
      expect(store.live(STUDIO_A)!.status, code).not.toBe("active");
    }
  });

});

describe("10. ordinary purchase-new behaviour is unchanged", () => {
  it("the purchase path still buys exactly one number and activates", async () => {
    const outcome = await provisionStudioSmsSender({
      store,
      provider,
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
      phoneNumber: "+14165550777",
      inboundWebhookUrl: INBOUND,
      statusCallbackUrl: STATUS,
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });
    expect(outcome).toMatchObject({ ok: true, result: "activated" });
    expect(provider.calls.purchase).toBe(1);
    expect(store.live(STUDIO_A)!.status).toBe("active");
  });

  it("the purchase path never calls the adoption read", async () => {
    // The two paths are genuinely separate: neither leaks into the other.
    await provisionStudioSmsSender({
      store,
      provider,
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
      phoneNumber: "+14165550777",
      inboundWebhookUrl: INBOUND,
      statusCallbackUrl: STATUS,
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });
    expect(provider.calls.ownedLookup).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CODEX P2 — a lost finalize response must not become a false failure.
// ---------------------------------------------------------------------------
//
// createProvisioningStore.finalize maps BOTH a transport error and an
// unrecognised payload to `invalid_input`, and neither of those says anything
// about whether the transaction committed. So the realistic bad case is:
// finalize COMMITS the sender to `active`, the response is lost, the store
// reports `invalid_input`, adoption goes to park the attempt -- and the park
// discovers the row is already live.
//
// The purchase path already answers this: its failWith returns
// `{ ok: true, result: "already_active" }` when the store says so. Adoption
// omitted that branch, so it reported FAILED over a sender the database had
// just activated.

describe("CODEX P2 — activation that commits with a lost response", () => {
  it("1. finalize succeeds normally -> adopted", async () => {
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: true, result: "adopted" });
    expect(store.live(STUDIO_A)!.status).toBe("active");
  });

  it("2. finalize COMMITS but the response is lost -> success, not failure", async () => {
    store.loseFinalizeResponse = true;
    const outcome = await adopt();

    // The database is the authority, and it says this sender is live.
    expect(store.live(STUDIO_A)!.status).toBe("active");
    expect(outcome).toMatchObject({ ok: true, result: "already_active" });
    // The established identity is returned through the existing result shape.
    expect((outcome as { senderId: string }).senderId).toBe(store.live(STUDIO_A)!.id);
  });

  it("3. finalize genuinely fails and the park lands -> stays failed", async () => {
    // Success must be justified by the STORE saying already_active, never by
    // finalize having merely returned invalid_input.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      testSendFails: "provider_rejected",
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    expect(store.live(STUDIO_A)!.status).toBe("error");
  });

  it("3b. finalize returns invalid_input but NOTHING committed -> stays failed", async () => {
    // THE DISCRIMINATING CASE, and the one an earlier version of this suite
    // missed. `invalid_input` is returned both when the write committed and its
    // answer was lost, and when the write never landed at all — the two are
    // indistinguishable from the answer alone. So success must be justified by
    // the STORE saying `already_active`, never by the reason code. A mutation
    // that returned success on `finalize_failed` passed every other test here.
    store.failFinalizeWithoutCommitting = true;
    const outcome = await adopt();
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
    expect(outcome).toMatchObject({ ok: false, result: "failed", reason: "finalize_failed" });
  });

  it("4. fail() answers lease_lost -> stays lease_lost", async () => {
    // Displacement still outranks everything; the new branch must not swallow it.
    store.loseFinalizeResponse = true;
    store.fail = async () => "lease_lost";
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
  });

  it("5. no duplicate provider test on the recovery path", async () => {
    store.loseFinalizeResponse = true;
    await adopt();
    expect(provider.calls.testSend).toBe(1);
  });

  it("6 + 7. recovery performs no purchase and no configuration mutation", async () => {
    store.loseFinalizeResponse = true;
    await adopt();
    expect(provider.calls.purchase).toBe(0);
    expect(provider.calls.createService).toBe(0);
    expect(provider.calls.attach).toBe(0);
    expect(provider.calls.inboundWebhook).toBe(0);
    expect(provider.calls.statusCallback).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CODEX P2-1 — one canonical phone number for the whole operation.
// ---------------------------------------------------------------------------
//
// 0191's claim does `nullif(btrim(coalesce(p_phone_number,'')),'')` and stores
// the TRIMMED value in `claimed_phone_number`. `renew_studio_sms_lease` then
// compares `s.claimed_phone_number = p_phone_number` with NO trim. So a caller
// that claims with a raw value and keeps carrying that raw value fails its own
// fence on the very first provider call -- and reports `lease_lost`, which says
// "another worker took over" about a whitespace mismatch.

describe("CODEX P2-1 — the canonical number is derived once", () => {
  const PADDED = `  ${WILLOW_NUMBER}  `;

  it("1. a canonical E.164 works", async () => {
    expect(await adopt()).toMatchObject({ ok: true, result: "adopted" });
  });

  it("2. the SAME number with surrounding whitespace behaves identically", async () => {
    const outcome = await adopt({ phoneNumber: PADDED });
    expect(outcome).toMatchObject({ ok: true, result: "adopted" });
    expect(store.live(STUDIO_A)!.status).toBe("active");
  });

  it("3. claim and lease agree on ONE value", async () => {
    await adopt({ phoneNumber: PADDED });
    const row = store.live(STUDIO_A)!;
    expect(row.claimedPhoneNumber).toBe(WILLOW_NUMBER);
    // Every fence call must carry exactly what the claim stored, or the fence
    // is comparing two different strings.
    expect(store.fenceCalls.length).toBeGreaterThan(0);
    expect(store.fenceCalls.every((c) => c.phoneNumber === WILLOW_NUMBER)).toBe(true);
  });

  it("4. the provider lookup receives the canonical value", async () => {
    const seen: string[] = [];
    const inner = provider.lookupOwnedNumber.bind(provider);
    provider.lookupOwnedNumber = async (input) => {
      seen.push(input.phoneNumber);
      return inner(input);
    };
    await adopt({ phoneNumber: PADDED });
    expect(seen).toEqual([WILLOW_NUMBER]);
  });

  it("5. a genuinely invalid number is still refused, never coerced", async () => {
    // Trimming is canonicalization. Turning "4165550100" into "+14165550100"
    // would be INVENTING a number the operator did not choose.
    for (const bad of ["4165550100", "+1 416 555 0100", "not-a-number", "  ", "+0123456789"]) {
      store = new InMemoryProvisioningStore(MEMBERS);
      provider = new FakeSmsProvisioningProvider(ownedAndAssociated());
      const outcome = await adopt({ phoneNumber: bad });
      expect(outcome.ok, bad).toBe(false);
      expect(provider.calls.purchase, bad).toBe(0);
    }
  });

  it("6. the finalized row records the canonical value", async () => {
    await adopt({ phoneNumber: PADDED });
    expect(store.live(STUDIO_A)!.phoneNumber).toBe(WILLOW_NUMBER);
  });
});

// ---------------------------------------------------------------------------
// CODEX P2-2 — a service entry we cannot read makes the census UNAVAILABLE.
// ---------------------------------------------------------------------------
//
// The page walker parsed each entry and SKIPPED the ones it could not read,
// then reported the census complete. But the skipped service could be the one
// holding the number, so "complete" was a claim the evidence did not support --
// and the verdict became `not_associated`, which is exactly the reading that
// licenses attaching a number out of a service that already has it.
//
// This is the same rule already applied one level up, to pages. It simply was
// not applied to the entries inside a page.

describe("CODEX P2-2 — malformed service entries fail the census closed", () => {
  const withEntries = (services: unknown[]): FakeProviderScript => ({
    preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
    accountServices: services as FakeProviderScript["accountServices"],
  });

  it("1. an all-valid page still works", async () => {
    expect(await adopt()).toMatchObject({ ok: true, result: "adopted" });
  });

  it("2. an entry that is not an object -> UNAVAILABLE", async () => {
    provider = new FakeSmsProvisioningProvider(
      withEntries([{ sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER] }, null]),
    );
    expect(await adopt()).toMatchObject({ reason: "number_association_unavailable" });
  });

  it("3. a missing SID -> UNAVAILABLE", async () => {
    provider = new FakeSmsProvisioningProvider(
      withEntries([{ sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER] }, { sid: null, numbers: [] }]),
    );
    expect(await adopt()).toMatchObject({ reason: "number_association_unavailable" });
  });

  it("4. a malformed SID -> UNAVAILABLE", async () => {
    provider = new FakeSmsProvisioningProvider(
      withEntries([{ sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER] }, { sid: "MG-not-a-sid", numbers: [] }]),
    );
    expect(await adopt()).toMatchObject({ reason: "number_association_unavailable" });
  });

  it("5. a mixed valid + malformed page -> UNAVAILABLE, not a partial verdict", async () => {
    provider = new FakeSmsProvisioningProvider(
      withEntries([
        { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER] },
        { sid: "garbage", numbers: [] },
        { sid: OTHER_MG_SID, numbers: [] },
      ]),
    );
    const outcome = await adopt();
    expect(outcome).toMatchObject({ reason: "number_association_unavailable" });
    // NOT adopted, even though the expected service was among the readable ones.
    expect(outcome.ok).toBe(false);
  });

  it("6. THE DEFECT: a malformed entry can never yield NOT_ASSOCIATED", async () => {
    // The malformed entry is the one holding the number. Skipping it and
    // reporting "not associated" is the reading that would license an attach.
    provider = new FakeSmsProvisioningProvider(
      withEntries([
        { sid: WILLOW_MG_SID, numbers: [] },
        { sid: "MG-malformed-holder", numbers: [WILLOW_NUMBER] },
      ]),
    );
    const outcome = await adopt();
    expect((outcome as { reason: string }).reason).not.toBe("number_not_in_named_service");
    expect(outcome).toMatchObject({ reason: "number_association_unavailable" });
  });

  it("7. a malformed entry never lets adoption proceed", async () => {
    provider = new FakeSmsProvisioningProvider(
      withEntries([{ sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER] }, { sid: "bad", numbers: [] }]),
    );
    await adopt();
    expect(provider.calls.testSend).toBe(0);
    expect(provider.calls.serviceConfigRead).toBe(0);
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
  });
});

// ---------------------------------------------------------------------------
// CODEX P2-A — activation evidence must name the adopted number.
// ---------------------------------------------------------------------------
//
// sendProvisioningTest posts to a MESSAGING SERVICE, and a service is a POOL.
// On a freshly purchased sender the pool holds exactly one number, so "the
// service can send" and "this number can send" are the same statement. On an
// ADOPTED service they are not: the studio's existing service may hold several
// senders, Twilio picks one, and a successful send proves only that SOME sender
// worked. Finalizing the selected number on that evidence activates a number
// nothing ever tested.

describe("CODEX P2-A — activation evidence is about THIS number", () => {
  // SUPERSEDED CONTRACT, KEPT HONEST. This suite originally proved the sender by
  // reading it back off the create response. That inference was timing-sensitive
  // and was replaced by naming the sender on the send itself, so the assertions
  // below now state what the NEW contract makes true. They are not deleted:
  // the property under test — a number only reaches ACTIVE if IT sent — is the
  // same one, and it is worth keeping a suite that would notice if the newer
  // mechanism stopped delivering it.

  it("1. a single-sender service: the adopted number is the sender -> adopted", async () => {
    expect(await adopt()).toMatchObject({ ok: true, result: "adopted" });
    expect(store.live(STUDIO_A)!.status).toBe("active");
  });

  it("2. a MULTI-SENDER service cannot substitute another sender", async () => {
    // Under the old contract the pool's choice decided this. Now the send names
    // its sender, so the pool's preference is simply not consulted -- and the
    // adopted number is the one proven.
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        {
          sid: WILLOW_MG_SID,
          numbers: [WILLOW_NUMBER, "+14165550777"],
          inboundUrl: INBOUND,
          statusUrl: STATUS,
        },
      ],
      testSendFrom: "+14165550777",
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: true, result: "adopted" });
    expect(store.live(STUDIO_A)!.phoneNumber).toBe(WILLOW_NUMBER);
  });

  it("3. a number NOT in the service's sender pool is refused by the provider", async () => {
    // The provider is the authority on its own pool. This is the case the old
    // inference could never see: it would have read back whatever the service
    // chose and been satisfied.
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: INBOUND, statusUrl: STATUS },
      ],
      rejectExplicitFrom: true,
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
  });

  it("4. a CONTRADICTORY reported sender still fails closed", async () => {
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      reportContradictorySender: "+14165550888",
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
  });

  it("5. an UNPOPULATED reported sender is no longer a failure", async () => {
    // The inversion, and the whole reason for the change: with only a service
    // sid, `from` can be absent for a send that is perfectly fine. Failing on it
    // rejected healthy adoptions.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      testSendFromMissing: true,
    });
    expect(await adopt()).toMatchObject({ ok: true, result: "adopted" });
  });

  it("6. the verification causes NO second provider test", async () => {
    await adopt();
    expect(provider.calls.testSend).toBe(1);
  });

  it("6b. a contradiction sends one test and records identifiers, unproven", async () => {
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      reportContradictorySender: "+14165550888",
    });
    await adopt();
    expect(provider.calls.testSend).toBe(1);
    expect(store.live(STUDIO_A)!.phoneNumberSid).toBe(WILLOW_PN_SID);
    expect(store.live(STUDIO_A)!.lastTestOkAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CODEX P2-B — every adoption refusal maps into 0191's vocabulary.
// ---------------------------------------------------------------------------
//
// ProvisioningStore.fail persists `errorCode` as `last_error_code`, and 0191
// constrains only its SHAPE (^[a-z][a-z0-9_]{2,63}$) -- which an adoption-only
// string satisfies. So an unmapped refusal does not fail loudly; it persists
// quietly as a code no other part of Hone understands.

describe("CODEX P2-B — no adoption-only string reaches last_error_code", () => {
  const VALID: string[] = [
    ...PROVIDER_ERROR_CODES,
    "finalize_failed",
    "finalize_conflict",
    "lease_lost",
  ];

  const REFUSALS: Array<[string, FakeProviderScript]> = [
    ["number_not_owned_by_account", { preOwnedNumbers: {} }],
    [
      "number_in_other_service",
      {
        preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
        accountServices: [
          { sid: WILLOW_MG_SID, numbers: [] },
          { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER] },
        ],
      },
    ],
    [
      "number_not_in_named_service",
      {
        preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
        accountServices: [{ sid: WILLOW_MG_SID, numbers: [] }],
      },
    ],
    [
      "number_association_ambiguous",
      {
        preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
        accountServices: [
          { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER] },
          { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER] },
        ],
      },
    ],
    ["number_association_unavailable", { ...ownedAndAssociated(), membershipProbeFails: true }],
    [
      "provider_configuration_required",
      {
        preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
        accountServices: [
          { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null },
        ],
      },
    ],
  ];

  for (const [reason, script] of REFUSALS) {
    it(`${reason} persists a VALID store error code`, async () => {
      provider = new FakeSmsProvisioningProvider(script);
      store = new InMemoryProvisioningStore(MEMBERS);
      const outcome = await adopt();

      // The caller still receives the RICH adoption reason.
      expect((outcome as { reason?: string }).reason).toBe(reason);

      // But what persists must be vocabulary 0191 understands.
      const persisted = store.live(STUDIO_A)?.lastErrorCode;
      expect(persisted, `${reason} persisted "${persisted}"`).not.toBeNull();
      expect(VALID, `${reason} persisted "${persisted}"`).toContain(persisted);
    });
  }
});

// ---------------------------------------------------------------------------
// CODEX P2 — bind the test message to the adopted sender.
// ---------------------------------------------------------------------------
//
// Reading the sender back off the create response is timing-sensitive: with
// only a MessagingServiceSid, Twilio may not have completed sender selection
// when it answers, so `from` can be absent for a send that is perfectly fine.
// Proof that depends on a field that may not be populated yet is not proof.
//
// Ownership and exact service association are ALREADY established before this
// point, so the test can simply ask for the sender it means: MessagingServiceSid
// plus an explicit From. Twilio accepts both together when the From is in that
// service's sender pool, and rejects the message otherwise — which turns the
// proof into the provider's own acknowledgement instead of our inference.

describe("CODEX P2 — the provisioning test names its sender", () => {
  function recordSends() {
    const seen: Array<{ messagingServiceSid: string; fromPhoneNumber?: string }> = [];
    const inner = provider.sendProvisioningTest.bind(provider);
    provider.sendProvisioningTest = async (input) => {
      seen.push({
        messagingServiceSid: input.messagingServiceSid,
        fromPhoneNumber: input.fromPhoneNumber,
      });
      return inner(input);
    };
    return seen;
  }

  it("1. sends BOTH the expected service and the exact canonical From", async () => {
    const seen = recordSends();
    expect(await adopt()).toMatchObject({ ok: true, result: "adopted" });
    expect(seen).toEqual([
      { messagingServiceSid: WILLOW_MG_SID, fromPhoneNumber: WILLOW_NUMBER },
    ]);
  });

  it("2. a whitespace-padded input still sends the CANONICAL From", async () => {
    const seen = recordSends();
    await adopt({ phoneNumber: `  ${WILLOW_NUMBER}  ` });
    expect(seen[0].fromPhoneNumber).toBe(WILLOW_NUMBER);
  });

  it("3. another pool member can never satisfy the adopted-number test", async () => {
    // The service holds two senders. With an explicit From there is nothing for
    // the pool to choose, so the other member cannot stand in.
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        {
          sid: WILLOW_MG_SID,
          numbers: [WILLOW_NUMBER, "+14165550777"],
          inboundUrl: INBOUND,
          statusUrl: STATUS,
        },
      ],
      // The pool WOULD have picked the other one.
      testSendFrom: "+14165550777",
    });
    const seen = recordSends();
    const outcome = await adopt();
    expect(seen[0].fromPhoneNumber).toBe(WILLOW_NUMBER);
    expect(outcome).toMatchObject({ ok: true, result: "adopted" });
    expect(store.live(STUDIO_A)!.phoneNumber).toBe(WILLOW_NUMBER);
  });

  it("4. the provider rejecting the requested From fails closed", async () => {
    // Twilio refuses a From that is not in the service's sender pool.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      rejectExplicitFrom: true,
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
    expect(store.live(STUDIO_A)!.lastTestOkAt).toBeNull();
  });

  it("5. an invalid adopted number never reaches the provider test", async () => {
    for (const bad of ["4165550100", "  ", "not-a-number"]) {
      provider = new FakeSmsProvisioningProvider(ownedAndAssociated());
      store = new InMemoryProvisioningStore(MEMBERS);
      const outcome = await adopt({ phoneNumber: bad });
      expect(outcome.ok, bad).toBe(false);
      expect(provider.calls.testSend, bad).toBe(0);
    }
  });

  it("6. exactly one provisioning test message is sent", async () => {
    await adopt();
    expect(provider.calls.testSend).toBe(1);
  });

  it("7. an unpopulated response sender is NOT a failure any more", async () => {
    // This is the timing sensitivity the change removes: with an explicit From,
    // a create response that has not yet filled in `from` is still a successful
    // send of the sender we named.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      testSendFromMissing: true,
    });
    expect(await adopt()).toMatchObject({ ok: true, result: "adopted" });
  });

  it("8. a CONTRADICTORY reported sender still fails closed", async () => {
    // Null means "not known yet". A populated value that disagrees with the
    // From we asked for is a real contradiction, not a timing artifact.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      reportContradictorySender: "+14165550888",
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
  });
});
