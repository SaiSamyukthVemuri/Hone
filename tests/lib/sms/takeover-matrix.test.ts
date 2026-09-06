import { beforeEach, describe, expect, it } from "vitest";
import {
  provisionStudioSmsSender,
  type ClaimRow,
  type FailResult,
  type FinalizeResult,
  type ProvisioningStore,
} from "@/lib/sms/provisioning";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";
import { MUTATING_PROVIDER_EFFECTS } from "@/lib/sms/provider/fenced";

// COMMS-01B — THE DETERMINISTIC TAKEOVER MATRIX.
//
// THE INVARIANT, STATED ONCE AND CHECKED EVERYWHERE:
//
//   Once provisioning generation G loses its lease, G has ZERO authority for
//   any later provider mutation or authoritative final-state database write.
//
// A stall can occur between ANY two awaits, so proving the invariant at one
// point proves nothing about the others -- which is exactly how three
// consecutive reviews each found the same defect at a different await. This
// file therefore walks the takeover across EVERY point in the sequence and
// requires the same four numbers at each one:
//
//   UNFENCED_EFFECTS                        = 0
//   OLD_PROVIDER_MUTATIONS_AFTER_TAKEOVER   = 0
//   OLD_AUTHORITATIVE_WRITES_AFTER_TAKEOVER = 0
//   OLD_RESULT                              = lease_lost
//
// The takeover is injected DETERMINISTICALLY, not by timing: the fence answers
// true for the first k-1 checks and false from the k-th onward, which is
// exactly "another worker took the attempt over immediately before effect k".
// No sleeps, no clocks, no flakes.

const STUDIO = "studio-a";
const OWNER = "owner-a";
const CHOSEN = "+14165550100";

type WriteRecord = { call: "finalize" | "fail"; result: string };

/**
 * A store that answers a fixed claim and records every authoritative write.
 * Generation `STALE` is the displaced worker's; the row has moved to `LIVE`.
 */
const STALE = 7;
const LIVE = 8;

class DisplacedWorkerStore implements ProvisioningStore {
  writes: WriteRecord[] = [];
  /** Fence answers true until this many checks have been made, then false. */
  constructor(private readonly allowChecks: number) {}
  fenceChecks = 0;

  async claim(): Promise<ClaimRow> {
    return {
      result: "claimed",
      senderId: "sender-1",
      claimKey: `hone-sms-${"a".repeat(32)}`,
      senderStatus: "provisioning",
      leaseGeneration: STALE,
    };
  }

  async finalize(input: { leaseGeneration: number }): Promise<FinalizeResult> {
    // The database is the authority: a stale generation is refused, always.
    const result: FinalizeResult =
      input.leaseGeneration === LIVE ? "activated" : "lease_lost";
    this.writes.push({ call: "finalize", result });
    return result;
  }

  async fail(input: { leaseGeneration: number }): Promise<FailResult> {
    const result: FailResult =
      input.leaseGeneration === LIVE ? "failed" : "lease_lost";
    this.writes.push({ call: "fail", result });
    return result;
  }

  async assertLease(): Promise<boolean> {
    this.fenceChecks += 1;
    return this.fenceChecks <= this.allowChecks;
  }
}

let provider: FakeSmsProvisioningProvider;

beforeEach(() => {
  provider = new FakeSmsProvisioningProvider();
  provider.reset();
});

/** Every externally-mutating call the fake actually executed. */
function mutatingCalls(p: FakeSmsProvisioningProvider): number {
  return (
    p.calls.purchase +
    p.calls.createService +
    p.calls.attach +
    p.calls.inboundWebhook +
    p.calls.statusCallback +
    p.calls.testSend
  );
}

function run(store: ProvisioningStore, phoneNumber = CHOSEN) {
  return provisionStudioSmsSender({
    store,
    provider,
    studioId: STUDIO,
    actorUserId: OWNER,
    country: "CA",
    areaCode: "416",
    phoneNumber,
    inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
    statusCallbackUrl: "https://hone.care/api/twilio/status",
    testDestination: "+14165559999",
    serviceLabel: "Studio A",
    testBody: "Hone provisioning test.",
  });
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe("takeover matrix: a displaced generation has ZERO authority, everywhere", () => {
  // k = how many fence checks succeed before the takeover lands. k=0 is a
  // worker displaced before it does anything; k=5 is one displaced at the very
  // last effect (the provisioning test send).
  const POINTS = [0, 1, 2, 3, 4, 5] as const;

  it.each(POINTS)(
    "takeover immediately before mutating effect #%i",
    async (allowed) => {
      const store = new DisplacedWorkerStore(allowed);
      const outcome = await run(store);

      // OLD_RESULT = lease_lost
      expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });

      // OLD_PROVIDER_MUTATIONS_AFTER_TAKEOVER = 0.
      // Exactly `allowed` effects ran -- the ones BEFORE the takeover. Not one
      // more executed after the fence turned.
      expect(mutatingCalls(provider)).toBe(allowed);

      // UNFENCED_EFFECTS = 0. Every mutating effect consumed a fence check, so
      // the counts agree; a call that slipped past the wrapper would make the
      // effects outnumber the checks.
      expect(mutatingCalls(provider)).toBeLessThanOrEqual(store.fenceChecks);

      // OLD_AUTHORITATIVE_WRITES_AFTER_TAKEOVER = 0. Any write the stale
      // worker attempted was REFUSED by the database; none landed.
      const landed = store.writes.filter((w) => w.result !== "lease_lost");
      expect(landed).toEqual([]);
    },
  );

  it("a worker displaced before it starts buys nothing at all", async () => {
    const store = new DisplacedWorkerStore(0);
    await run(store);
    expect(provider.ownedNumbers()).toEqual([]);
    expect(provider.calls.purchase).toBe(0);
  });

  it("ADOPTED PATH: a worker that stalled AFTER buying is fenced too", async () => {
    // It never re-enters the purchase branch, which is precisely how this path
    // stayed unfenced through the first fix.
    const claimKey = `hone-sms-${"a".repeat(32)}`;
    await provider.purchaseNumber({ claimKey, phoneNumber: CHOSEN });
    const boughtBefore = provider.calls.purchase;
    const ownedBefore = provider.ownedNumbers();

    const store = new DisplacedWorkerStore(0);
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    // No SECOND purchase, and no service/attach/webhook/test either.
    expect(provider.calls.purchase).toBe(boughtBefore);
    expect(provider.calls.createService).toBe(0);
    expect(provider.calls.attach).toBe(0);
    expect(provider.calls.testSend).toBe(0);
    expect(provider.ownedNumbers()).toEqual(ownedBefore);
    expect(store.writes.filter((w) => w.result !== "lease_lost")).toEqual([]);
  });

  it("FINALIZE WINDOW: displaced after all provider work, the write is still refused", async () => {
    // Every effect succeeds; the takeover lands in the gap before the
    // authoritative write. The database refuses it and the worker must say so.
    const store = new DisplacedWorkerStore(Number.MAX_SAFE_INTEGER);
    // Its generation is stale even though the fence never turned -- exactly
    // the race the fence cannot close.
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    const landed = store.writes.filter((w) => w.result !== "lease_lost");
    expect(landed).toEqual([]);
    // It did do the provider work; what it could not do was record it.
    expect(mutatingCalls(provider)).toBeGreaterThan(0);
  });

  it("a stale worker never narrates a provider error over the database's verdict", async () => {
    // The availability read is unfenced by design (it spends nothing), so a
    // displaced worker can still receive "number gone". It must not REPORT
    // that: a newer generation may be provisioning that very number.
    provider.reset({ unavailableNumbers: [CHOSEN] });
    const store = new DisplacedWorkerStore(Number.MAX_SAFE_INTEGER);
    const outcome = await run(store);

    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    expect(outcome).not.toMatchObject({ reason: "number_no_longer_available" });
  });
});

// ---------------------------------------------------------------------------
// The matrix is exhaustive, and stays exhaustive
// ---------------------------------------------------------------------------

describe("the matrix covers every mutating effect the port declares", () => {
  it("walks one takeover point per mutating effect", () => {
    // If a seventh mutating effect is added to the port, this fails until the
    // matrix grows a row for it -- so coverage cannot quietly fall behind.
    expect(MUTATING_PROVIDER_EFFECTS).toHaveLength(6);
  });

  it("DEFENCE IN DEPTH: even with the fence never turning, no stale write lands", async () => {
    // NOT a mutation control -- the fence simply never fires here, which is
    // the in-flight race it cannot close. What this shows is the SECOND layer:
    // the database refuses the stale generation independently of the wrapper,
    // so the worst case is wasted provider work, never a corrupted row.
    //
    // The real mutation control is external and was performed for this file:
    // removing the fence check from lib/sms/provider/fenced.ts turns 8 of
    // these 12 tests red, with the displaced worker executing all six effects
    // instead of stopping at k.
    const store = new DisplacedWorkerStore(Number.MAX_SAFE_INTEGER);
    await run(store);
    expect(mutatingCalls(provider)).toBeGreaterThan(0);
    expect(store.writes.filter((w) => w.result !== "lease_lost")).toEqual([]);
  });
});
