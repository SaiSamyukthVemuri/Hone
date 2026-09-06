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

/** The account already owns Willow's number, already in Willow's service. */
function ownedAndAssociated() {
  return {
    preOwnedNumbers: {
      [WILLOW_NUMBER]: { phoneNumberSid: WILLOW_PN_SID, messagingServiceSid: WILLOW_MG_SID },
    },
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
    inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
    statusCallbackUrl: "https://hone.care/api/twilio/message-status",
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
          preOwnedNumbers: {
            [WILLOW_NUMBER]: { phoneNumberSid: WILLOW_PN_SID, messagingServiceSid: OTHER_MG_SID },
          },
        },
      },
      { name: "membership unknown", script: { ...ownedAndAssociated(), membershipUnknown: true } },
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
      preOwnedNumbers: {
        "+14165550999": { phoneNumberSid: WILLOW_PN_SID, messagingServiceSid: WILLOW_MG_SID },
      },
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

describe("4. an unexpected Messaging Service association is REFUSED, never changed", () => {
  it("a number sitting in a DIFFERENT service is refused rather than moved", async () => {
    // Twilio allows one service per number, so "attach" is really "move".
    // Moving it would silently break whatever the other service serves.
    provider = new FakeSmsProvisioningProvider({
      preOwnedNumbers: {
        [WILLOW_NUMBER]: { phoneNumberSid: WILLOW_PN_SID, messagingServiceSid: OTHER_MG_SID },
      },
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, reason: "number_not_in_named_service" });
    expect(provider.calls.attach).toBe(0);
    expect(provider.calls.createService).toBe(0);
  });

  it("an UNREADABLE membership answer refuses — it never reads as 'not a member'", async () => {
    // This is the whole reason membership is three-state. Collapsing unknown
    // into "no" is what would license the move above.
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      membershipUnknown: true,
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, reason: "service_membership_unknown" });
    expect(provider.calls.attach).toBe(0);
    expect(store.live(STUDIO_A)!.status).toBe("error");
  });

  it("nothing is configured before ownership and association are proven", async () => {
    provider = new FakeSmsProvisioningProvider({ preOwnedNumbers: {} });
    await adopt();
    expect(provider.calls.inboundWebhook).toBe(0);
    expect(provider.calls.statusCallback).toBe(0);
    expect(provider.calls.testSend).toBe(0);
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
    // ownedLookup + inbound + status + test, each fenced by construction.
    expect(store.fenceCalls.length).toBeGreaterThanOrEqual(4);
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

  it("a webhook configuration failure also never reaches ACTIVE", async () => {
    provider = new FakeSmsProvisioningProvider({
      ...ownedAndAssociated(),
      webhookFails: "provider_rejected",
    });
    const outcome = await adopt();
    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    expect(provider.calls.testSend).toBe(0);
    expect(store.live(STUDIO_A)!.status).not.toBe("active");
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
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/message-status",
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
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/message-status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });
    expect(provider.calls.ownedLookup).toBe(0);
  });
});
