import { beforeEach, describe, expect, it } from "vitest";
import {
  provisionStudioSmsSender,
  type ClaimRow,
  type FailResult,
  type FinalizeResult,
  type ProvisioningStore,
} from "@/lib/sms/provisioning";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";
import {
  BILLABLE_OR_MUTATING_EFFECTS,
  FENCED_PROVIDER_OPERATIONS,
} from "@/lib/sms/provider/fenced";

// COMMS-01B — THE STALL / TAKEOVER MATRIX.
//
// THE INVARIANT, STATED ONCE AND CHECKED AT EVERY POINT:
//
//   Once lease generation G is displaced, G may execute ZERO provider
//   mutations and ZERO authoritative final-state writes.
//
// A stall can occur between ANY two awaits, so proving the invariant at one
// point proves nothing about the others. That is not a hypothetical: three
// consecutive reviews each found the same defect at a DIFFERENT await, because
// each fix was applied where the last one was found. This file walks the
// takeover across the whole sequence instead.
//
// INJECTION IS DETERMINISTIC, NOT TIMED. The fence answers true for the first
// k checks and false afterwards, so "k allowed checks" IS "another worker took
// the attempt over immediately before operation k+1". No sleeps, no clocks, no
// flakes, and the same rows run identically on every machine.
//
// Every row requires the same three numbers, plus one positive control:
//
//   OLD_PROVIDER_EFFECTS_AFTER_TAKEOVER     = 0
//   OLD_AUTHORITATIVE_WRITES_AFTER_TAKEOVER = 0
//   OLD_RESULT                              = lease_lost
//   ...and the CURRENT worker can still reconcile and finish.

const STUDIO = "studio-a";
const OWNER = "owner-a";
const CHOSEN = "+14165550100";
const CLAIM_KEY = `hone-sms-${"a".repeat(32)}`;

/** The displaced worker's generation, and the one that superseded it. */
const STALE = 7;
const LIVE = 8;

type WriteRecord = { call: "finalize" | "fail"; generation: number; result: string };

class TakeoverStore implements ProvisioningStore {
  writes: WriteRecord[] = [];
  fenceChecks = 0;

  /**
   * @param allowChecks how many fence checks succeed before the takeover lands.
   * @param generation  the generation this worker was handed at claim time.
   */
  constructor(
    private readonly allowChecks: number,
    private readonly generation: number = STALE,
  ) {}

  async claim(): Promise<ClaimRow> {
    return {
      result: "claimed",
      senderId: "sender-1",
      claimKey: CLAIM_KEY,
      senderStatus: "provisioning",
      leaseGeneration: this.generation,
    };
  }

  /** The database is the authority: a stale generation is refused, always. */
  async finalize(input: { leaseGeneration: number }): Promise<FinalizeResult> {
    const result: FinalizeResult =
      input.leaseGeneration === LIVE ? "activated" : "lease_lost";
    this.writes.push({ call: "finalize", generation: input.leaseGeneration, result });
    return result;
  }

  async fail(input: { leaseGeneration: number }): Promise<FailResult> {
    const result: FailResult =
      input.leaseGeneration === LIVE ? "failed" : "lease_lost";
    this.writes.push({ call: "fail", generation: input.leaseGeneration, result });
    return result;
  }

  async renewLease(): Promise<boolean> {
    this.fenceChecks += 1;
    return this.fenceChecks <= this.allowChecks;
  }

  /** Authoritative writes that actually LANDED. Must be empty for a stale worker. */
  landedWrites(): WriteRecord[] {
    return this.writes.filter((w) => w.result !== "lease_lost");
  }
}

let provider: FakeSmsProvisioningProvider;

beforeEach(() => {
  provider = new FakeSmsProvisioningProvider();
  provider.reset();
});

/** Externally-mutating calls the fake actually executed. */
function providerEffects(p: FakeSmsProvisioningProvider): number {
  return (
    p.calls.purchase +
    p.calls.createService +
    p.calls.attach +
    p.calls.inboundWebhook +
    p.calls.statusCallback +
    p.calls.testSend
  );
}

function run(store: ProvisioningStore) {
  return provisionStudioSmsSender({
    store,
    provider,
    studioId: STUDIO,
    actorUserId: OWNER,
    country: "CA",
    areaCode: "416",
    phoneNumber: CHOSEN,
    inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
    statusCallbackUrl: "https://hone.care/api/twilio/status",
    testDestination: "+14165559999",
    serviceLabel: "Studio A",
    testBody: "Hone provisioning test.",
  });
}

// ---------------------------------------------------------------------------
// The named takeover points
// ---------------------------------------------------------------------------
//
// The fenced sequence a fresh attempt performs, in order:
//
//   1 lookupResourcesByClaim   (reconcile)
//   2 isNumberAvailable        (exact availability)
//   3 purchaseNumber           (BILLABLE)
//   4 createMessagingService
//   5 attachNumberToService
//   6 configureInboundWebhook
//   7 configureStatusCallback
//   8 sendProvisioningTest
//   then the authoritative write.
//
// "after X" and "before Y" are the same instant when X and Y are adjacent, and
// both names are kept: the point is to state the requested enumeration in the
// requester's words, not to pretend there are more distinct moments than the
// sequence has.

/**
 * The fenced operations a PURCHASE attempt actually performs, in order. The
 * matrix below stalls at each one.
 */
const PURCHASE_PATH_OPERATIONS = [
  "lookupResourcesByClaim",
  "isNumberAvailable",
  "purchaseNumber",
  "createMessagingService",
  "attachNumberToService",
  "configureInboundWebhook",
  "configureStatusCallback",
  "sendProvisioningTest",
] as const;

/**
 * Fenced operations that belong to a DIFFERENT orchestration. Each one must be
 * covered by that path's own takeover proof -- naming it here is a declaration
 * that it is, not an exemption from being tested.
 */
const ADOPTION_PATH_ONLY_OPERATIONS = ["lookupOwnedNumber"] as const;

const POINTS: Array<{ name: string; allow: number; effectsExpected: number }> = [
  { name: "before reconcile", allow: 0, effectsExpected: 0 },
  { name: "before exact number availability", allow: 1, effectsExpected: 0 },
  { name: "before purchase", allow: 2, effectsExpected: 0 },
  { name: "after purchase / before service create", allow: 3, effectsExpected: 1 },
  { name: "after service create / before attach", allow: 4, effectsExpected: 2 },
  { name: "after attach / before inbound webhook", allow: 5, effectsExpected: 3 },
  { name: "before status callback", allow: 6, effectsExpected: 4 },
  { name: "before provider test", allow: 7, effectsExpected: 5 },
  { name: "after provider test / before finalize", allow: 8, effectsExpected: 6 },
];

describe("takeover matrix: a displaced generation has ZERO authority", () => {
  it.each(POINTS)("takeover $name", async ({ allow, effectsExpected }) => {
    const store = new TakeoverStore(allow);
    const outcome = await run(store);

    // OLD_RESULT = lease_lost
    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });

    // OLD_PROVIDER_EFFECTS_AFTER_TAKEOVER = 0.
    // Exactly the effects BEFORE the takeover ran; not one after it.
    expect(providerEffects(provider)).toBe(effectsExpected);

    // OLD_AUTHORITATIVE_WRITES_AFTER_TAKEOVER = 0.
    expect(store.landedWrites()).toEqual([]);
  });

  it("takeover on the FINALIZE FAILURE path: the write is refused and reported as displacement", async () => {
    // Every provider operation succeeds, the provisioning TEST fails, and the
    // takeover has already landed. The worker must not narrate its test
    // failure over the newer generation's truth.
    provider.reset({ testSendFails: "provider_rejected" });
    const store = new TakeoverStore(Number.MAX_SAFE_INTEGER); // fence never turns
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    expect(outcome).not.toMatchObject({ reason: "provider_rejected" });
    expect(store.landedWrites()).toEqual([]);
    // It DID attempt the write -- and the database refused it. That is the
    // second layer, independent of the fence.
    expect(store.writes.length).toBeGreaterThan(0);
    expect(store.writes.every((w) => w.generation === STALE)).toBe(true);
  });

  it("ADOPTED RESOURCES: a worker that stalled AFTER buying is fenced too", async () => {
    // It never re-enters the purchase branch, which is exactly how this path
    // stayed unfenced through the first repair.
    await provider.purchaseNumber({ claimKey: CLAIM_KEY, phoneNumber: CHOSEN });
    const boughtBefore = provider.calls.purchase;
    const ownedBefore = provider.ownedNumbers();

    const store = new TakeoverStore(0);
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    expect(provider.calls.purchase).toBe(boughtBefore);
    expect(provider.calls.createService).toBe(0);
    expect(provider.calls.attach).toBe(0);
    expect(provider.calls.testSend).toBe(0);
    expect(provider.ownedNumbers()).toEqual(ownedBefore);
    expect(store.landedWrites()).toEqual([]);
  });

  it("a stale worker never narrates a provider answer over the database's verdict", async () => {
    provider.reset({ unavailableNumbers: [CHOSEN] });
    const store = new TakeoverStore(Number.MAX_SAFE_INTEGER);
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    expect(outcome).not.toMatchObject({ reason: "number_no_longer_available" });
  });
});

// ---------------------------------------------------------------------------
// The positive control: the CURRENT worker must still be able to finish
// ---------------------------------------------------------------------------

describe("the current worker reconciles and finishes", () => {
  it("provisions to ACTIVE when it holds the live generation", async () => {
    const store = new TakeoverStore(Number.MAX_SAFE_INTEGER, LIVE);
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: true, result: "activated", adopted: false });
    expect(provider.calls.purchase).toBe(1);
    expect(store.landedWrites().map((w) => w.result)).toEqual(["activated"]);
  });

  it("ADOPTS what a displaced predecessor bought, and buys nothing more", async () => {
    // The whole point of reusing the claim key across a takeover: the number
    // the crashed worker paid for is found, not paid for twice.
    await provider.purchaseNumber({ claimKey: CLAIM_KEY, phoneNumber: CHOSEN });
    const store = new TakeoverStore(Number.MAX_SAFE_INTEGER, LIVE);

    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: true, result: "activated", adopted: true });
    expect(provider.calls.purchase).toBe(1); // the predecessor's, not a second
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
    expect(store.landedWrites().map((w) => w.result)).toEqual(["activated"]);
  });

  it("a fence that fails CLOSED never lets an unprovable worker spend", async () => {
    // assertLease returning false because the database is unreachable is
    // indistinguishable from displacement, and must be treated the same way.
    const store = new TakeoverStore(0, LIVE);
    const outcome = await run(store);
    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    expect(providerEffects(provider)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The parking write's own verdict is reported, never assumed
// ---------------------------------------------------------------------------

describe("a failure write that did not land is not reported as parked", () => {
  /** A store whose `fail()` refuses for a reason that is NOT displacement. */
  class UnparkableStore extends TakeoverStore {
    constructor(private readonly verdict: FailResult) {
      super(Number.MAX_SAFE_INTEGER, LIVE);
    }
    async fail(): Promise<FailResult> {
      return this.verdict;
    }
  }

  it.each(["invalid_input", "not_provisioning", "claim_not_found"] as const)(
    "fail() -> %s is surfaced, not swallowed",
    async (verdict) => {
      // The provider fails, so the attempt tries to park -- and the parking
      // write itself is refused for a reason unrelated to displacement.
      provider.reset({ purchaseFails: "provider_rejected" });
      const store = new UnparkableStore(verdict);
      const outcome = await run(store);

      expect(outcome).toMatchObject({ ok: false, result: "failed" });
      if (outcome.ok || outcome.result !== "failed") return;

      // The row was NOT moved to `error`. Saying otherwise would invite a
      // retry into a door still held shut by the live lease.
      expect(outcome.parked).toBe(false);
      expect(outcome.parkResult).toBe(verdict);
      // The provider's own error is still reported -- both facts travel.
      expect(outcome.reason).toBe("provider_rejected");
    },
  );

  it("a write that DID land reports parked: true", async () => {
    provider.reset({ purchaseFails: "provider_rejected" });
    const store = new TakeoverStore(Number.MAX_SAFE_INTEGER, LIVE);
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    if (outcome.ok || outcome.result !== "failed") return;
    expect(outcome.parked).toBe(true);
    expect(outcome.parkResult).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// The identifier write's verdict on a failed provider test
// ---------------------------------------------------------------------------

describe("identifier persistence outranks an ordinary test failure", () => {
  /** Identifier write answers `verdict`; the parking write then succeeds. */
  class IdentifierVerdictStore extends TakeoverStore {
    constructor(private readonly verdict: FinalizeResult) {
      super(Number.MAX_SAFE_INTEGER, LIVE);
    }
    async finalize(): Promise<FinalizeResult> {
      this.writes.push({ call: "finalize", generation: LIVE, result: this.verdict });
      return this.verdict;
    }
  }

  it.each(["conflict", "not_provisioning", "claim_not_found", "invalid_input"] as const)(
    "identifier finalize -> %s is reported, not disguised as a parked test failure",
    async (verdict) => {
      // The SIDs exist at the provider and Hone has NOT written them down.
      // That outranks "the test failed": one is recoverable by retrying, the
      // other means we are paying for resources we have no record of.
      provider.reset({ testSendFails: "provider_rejected" });
      const store = new IdentifierVerdictStore(verdict);
      const outcome = await run(store);

      expect(outcome).toMatchObject({ ok: false, result: "failed" });
      if (outcome.ok || outcome.result !== "failed") return;

      expect(outcome.identifiersRecorded).toBe(false);
      expect(outcome.identifierResult).toBe(verdict);
      // A successful parking write must not disguise it.
      expect(outcome.parked).toBe(true);
    },
  );

  it("identifier finalize -> lease_lost is displacement, not a test failure", async () => {
    provider.reset({ testSendFails: "provider_rejected" });
    const store = new IdentifierVerdictStore("lease_lost");
    const outcome = await run(store);
    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
  });

  it("identifier finalize -> provisioned_untested records them, and the test failure stands", async () => {
    provider.reset({ testSendFails: "provider_rejected" });
    const store = new IdentifierVerdictStore("provisioned_untested");
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    if (outcome.ok || outcome.result !== "failed") return;
    expect(outcome.identifiersRecorded).toBe(true);
    expect(outcome.reason).toBe("provider_rejected");
  });
});

// ---------------------------------------------------------------------------
// Coverage cannot quietly fall behind
// ---------------------------------------------------------------------------

describe("the matrix stays exhaustive", () => {
  it("has a row for every fenced operation", () => {
    // One takeover point per fenced operation, plus the finalize window. If an
    // operation is added to the port and fenced, this fails until the matrix
    // grows a row for it.
    // WILLOW ADOPTION widened the port. `lookupOwnedNumber` is fenced, but it
    // is unreachable from provisionStudioSmsSender -- it exists only on the
    // adoption path -- so this matrix cannot have a row for it. The invariant
    // is not "one row per fenced operation"; it is "every fenced operation is
    // covered by SOME takeover matrix", and the partition below keeps that
    // total. A new operation on the PURCHASE path still fails here.
    expect(POINTS).toHaveLength(PURCHASE_PATH_OPERATIONS.length + 1);
  });

  it("counts effects, not operations: reads are fenced but cost nothing", () => {
    expect(BILLABLE_OR_MUTATING_EFFECTS).toHaveLength(6);
    expect(PURCHASE_PATH_OPERATIONS).toHaveLength(8);
    // TOTALITY. Every fenced operation belongs to exactly one path. A new one
    // that is added to neither list fails here, so it cannot ship untested.
    const partitioned = new Set<string>([
      ...PURCHASE_PATH_OPERATIONS,
      ...ADOPTION_PATH_ONLY_OPERATIONS,
    ]);
    expect(
      FENCED_PROVIDER_OPERATIONS.filter((op) => !partitioned.has(op)),
      "a fenced operation belongs to no takeover matrix",
    ).toEqual([]);
    expect(partitioned.size).toBe(FENCED_PROVIDER_OPERATIONS.length);

    // The last row lets all 8 purchase-path operations through, so all 6 effects ran.
    expect(POINTS[POINTS.length - 1].effectsExpected).toBe(
      BILLABLE_OR_MUTATING_EFFECTS.length,
    );
  });
});
