import { beforeEach, describe, expect, it } from "vitest";
import { adoptExistingStudioSmsSender } from "@/lib/sms/adoption";
import { provisionStudioSmsSender } from "@/lib/sms/provisioning";
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
    stalling.sendProvisioningTest = async () => {
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
      return original();
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
