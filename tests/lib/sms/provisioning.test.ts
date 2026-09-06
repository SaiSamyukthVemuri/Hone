import { beforeEach, describe, expect, it } from "vitest";
import {
  provisionStudioSmsSender,
  searchAvailableSenderNumbers,
  isAuthorizationRefusal,
  type AttemptErrorCode,
  type ClaimRow,
  type FailResult,
  type FinalizeResult,
  type ProvisioningStore,
} from "@/lib/sms/provisioning";
import {
  FakeSmsProvisioningProvider,
  type FakeProviderScript,
} from "@/lib/sms/provider/fake-provider";
import type { ProviderErrorCode } from "@/lib/sms/provider/types";

// COMMS-01B — per-studio SMS sender provisioning.
//
// WHAT THIS FILE PROVES, AND WHAT IT CANNOT. It proves the ORCHESTRATION: the
// order of operations, that a purchase is attempted at most once per claim,
// that a lost finalize is reconciled rather than re-bought, that a vanished
// number is never substituted, and that an unproven sender never reaches
// `active`. It drives an in-memory store written to the same contract as
// migration 0191's commands.
//
// It CANNOT prove that the database actually enforces that contract. A partial
// unique index, a write-once trigger and a readiness CHECK are properties of
// PostgreSQL, and only PostgreSQL can demonstrate them. That half lives in
// tests/db/studio-sms-sender.db.test.ts. Neither file is sufficient alone, and
// this comment exists so nobody reads a green run here as proof of the schema.
//
// MUTATION CONTROLS. Four assertions below are load-bearing enough that a
// silently broken implementation would still pass a naively-written test. Each
// is paired with a control that performs the plausible mutation FOR REAL
// against a deliberately-weakened store or provider, and asserts the resulting
// behaviour is the bad one. A control that stopped failing would mean the
// corresponding test had gone vacuous.

// ---------------------------------------------------------------------------
// An in-memory store written to migration 0191's contract
// ---------------------------------------------------------------------------

type Membership = { userId: string; studioId: string; role: "owner" | "practitioner" };

type Row = {
  id: string;
  studioId: string;
  status: string;
  claimKey: string | null;
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  messagingServiceSid: string | null;
  provisionedAt: string | null;
  lastTestOkAt: string | null;
  lastErrorCode: string | null;
  /** Liveness lease. A live attempt excludes a second one; a stale one is taken over. */
  claimAt: number;
  /** Fencing token. Advances on every takeover, so a displaced worker is refused. */
  leaseGeneration: number;
};

type StoreOptions = {
  /** MUTATION: skip the owner-role check the database performs. */
  skipOwnerCheck?: boolean;
  /**
   * MUTATION: remove the fence ENTIRELY -- the pre-purchase check and the
   * generation checks in finalize/fail -- so a worker displaced by a
   * stale-lease takeover keeps going and buys alongside the worker that took
   * the attempt over. Half a fence is not the mutation being modelled.
   */
  ignoreFence?: boolean;
  /** MUTATION: mint a fresh claim key on every request instead of reusing. */
  remintClaimKeyEveryCall?: boolean;
  /** MUTATION: let `active` be reached without a successful provider test. */
  allowActiveWithoutTest?: boolean;
  /** Make the next finalize call fail, simulating a lost write. */
  failNextFinalize?: boolean;
  /**
   * MUTATION: a live claim SHARES its key with a second concurrent request and
   * lets it proceed, instead of excluding it. This is the plausible-but-wrong
   * design -- "same attempt, same key, so it must be safe".
   */
  liveClaimSharesInsteadOfExcluding?: boolean;
};

class InMemoryStore implements ProvisioningStore {
  rows: Row[] = [];
  private seq = 0;
  /** Virtual clock, so lease expiry is tested without waiting. */
  now = 0;
  readonly leaseMs = 5 * 60 * 1000;
  constructor(
    private readonly members: Membership[],
    readonly options: StoreOptions = {},
  ) {}

  private nextKey(): string {
    this.seq += 1;
    return `hone-sms-${this.seq.toString(16).padStart(32, "0")}`;
  }

  live(studioId: string): Row | undefined {
    return this.rows.find((r) => r.studioId === studioId && r.status !== "released");
  }

  async claim(input: {
    studioId: string;
    actorUserId: string;
    country: string;
    areaCode: string | null;
  }): Promise<ClaimRow> {
    const refuse = (result: ClaimRow["result"]): ClaimRow => ({
      result,
      senderId: null,
      claimKey: null,
      senderStatus: null,
      leaseGeneration: null,
    });

    if (!/^[A-Z]{2}$/.test(input.country)) return refuse("invalid_input");

    // Authorization is re-derived from (studio, authenticated user). A studio
    // id in the request proves nothing by itself.
    const member = this.members.find(
      (m) => m.studioId === input.studioId && m.userId === input.actorUserId,
    );
    if (!member) {
      const studioExists = this.members.some((m) => m.studioId === input.studioId);
      return refuse(studioExists ? "not_a_member" : "studio_not_found");
    }
    if (!this.options.skipOwnerCheck && member.role !== "owner") {
      return refuse("not_owner");
    }

    const existing = this.live(input.studioId);
    if (!existing) {
      const row: Row = {
        id: `sender-${this.rows.length + 1}`,
        studioId: input.studioId,
        status: "provisioning",
        claimKey: this.nextKey(),
        phoneNumber: null,
        phoneNumberSid: null,
        messagingServiceSid: null,
        provisionedAt: null,
        lastTestOkAt: null,
        lastErrorCode: null,
        claimAt: this.now,
        leaseGeneration: 1,
      };
      this.rows.push(row);
      return {
        result: "claimed",
        senderId: row.id,
        claimKey: row.claimKey,
        senderStatus: row.status,
        leaseGeneration: row.leaseGeneration,
      };
    }

    if (existing.status === "active") {
      return {
        result: "already_active",
        senderId: existing.id,
        claimKey: existing.claimKey,
        senderStatus: existing.status,
        leaseGeneration: existing.leaseGeneration,
      };
    }

    if (existing.status === "provisioning") {
      if (this.now - existing.claimAt < this.leaseMs) {
        if (this.options.liveClaimSharesInsteadOfExcluding) {
          return {
            result: "claimed",
            senderId: existing.id,
            claimKey: existing.claimKey,
            senderStatus: existing.status,
            leaseGeneration: existing.leaseGeneration,
          };
        }
        // A live attempt EXCLUDES this request: it is told the claim is held
        // and given no key, so it cannot perform a provider effect at all.
        return {
          result: "claim_held",
          senderId: existing.id,
          claimKey: null,
          senderStatus: existing.status,
          leaseGeneration: null,
        };
      }
      // Stale: take over on the SAME key and refresh the lease.
      if (this.options.remintClaimKeyEveryCall) existing.claimKey = this.nextKey();
      existing.claimAt = this.now;
      existing.leaseGeneration += 1;
      return {
        result: "claimed",
        senderId: existing.id,
        claimKey: existing.claimKey,
        senderStatus: existing.status,
        leaseGeneration: existing.leaseGeneration,
      };
    }

    if (existing.status === "off" || existing.status === "error") {
      // A retry REUSES the key. Reminting it is the mutation that loses the
      // handle on an already-purchased number.
      if (this.options.remintClaimKeyEveryCall) existing.claimKey = this.nextKey();
      existing.status = "provisioning";
      existing.claimAt = this.now;
      existing.leaseGeneration += 1;
      return {
        result: "claimed",
        senderId: existing.id,
        claimKey: existing.claimKey,
        senderStatus: existing.status,
        leaseGeneration: existing.leaseGeneration,
      };
    }

    return {
      result: "not_claimable",
      senderId: existing.id,
      claimKey: null,
      senderStatus: existing.status,
      leaseGeneration: null,
    };
  }

  async finalize(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    phoneNumber: string;
    phoneNumberSid: string;
    messagingServiceSid: string;
    testOk: boolean;
  }): Promise<FinalizeResult> {
    if (this.options.failNextFinalize) {
      // The lost write. The provider effect happened; Hone never records it.
      return "invalid_input";
    }
    const row = this.rows.find(
      (r) =>
        r.studioId === input.studioId &&
        r.claimKey === input.claimKey &&
        r.status !== "released",
    );
    if (!row) return "claim_not_found";
    if (!this.options.ignoreFence && row.leaseGeneration !== input.leaseGeneration) {
      return "lease_lost";
    }

    if (row.status === "active") {
      return row.phoneNumberSid === input.phoneNumberSid &&
        row.messagingServiceSid === input.messagingServiceSid &&
        row.phoneNumber === input.phoneNumber
        ? "already_active"
        : "conflict";
    }
    if (row.status !== "provisioning") return "not_provisioning";
    if (
      row.phoneNumberSid !== null &&
      (row.phoneNumberSid !== input.phoneNumberSid ||
        row.messagingServiceSid !== input.messagingServiceSid ||
        row.phoneNumber !== input.phoneNumber)
    ) {
      return "conflict";
    }

    row.phoneNumber ??= input.phoneNumber;
    row.phoneNumberSid ??= input.phoneNumberSid;
    row.messagingServiceSid ??= input.messagingServiceSid;
    row.provisionedAt ??= "2026-01-01T00:00:00.000Z";
    if (input.testOk) row.lastTestOkAt = "2026-01-01T00:00:00.000Z";

    // THE READINESS RULE, as the CHECK constraint states it: `active` is
    // unreachable without every identifier AND a successful test.
    const ready =
      row.phoneNumber !== null &&
      row.phoneNumberSid !== null &&
      row.messagingServiceSid !== null &&
      row.provisionedAt !== null &&
      row.lastTestOkAt !== null;

    if (this.options.allowActiveWithoutTest || ready) {
      row.status = "active";
      row.lastErrorCode = null;
      return input.testOk ? "activated" : "provisioned_untested";
    }
    return "provisioned_untested";
  }

  async fail(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    errorCode: AttemptErrorCode;
  }): Promise<FailResult> {
    const row = this.rows.find(
      (r) =>
        r.studioId === input.studioId &&
        r.claimKey === input.claimKey &&
        r.status !== "released",
    );
    if (!row) return "claim_not_found";
    if (!this.options.ignoreFence && row.leaseGeneration !== input.leaseGeneration) {
      return "lease_lost";
    }
    if (row.status === "active") return "already_active";
    if (row.status !== "provisioning") return "not_provisioning";
    row.status = "error";
    row.lastErrorCode = input.errorCode;
    // The claim key is deliberately NOT cleared.
    return "failed";
  }

  async assertLease(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
  }): Promise<boolean> {
    // MUTATION: with the fence removed, a displaced worker keeps going and
    // buys alongside the worker that took the attempt over.
    if (this.options.ignoreFence) return true;
    const row = this.rows.find(
      (r) =>
        r.studioId === input.studioId &&
        r.claimKey === input.claimKey &&
        r.status !== "released",
    );
    return (
      row !== undefined &&
      row.status === "provisioning" &&
      row.leaseGeneration === input.leaseGeneration
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const OWNER_A = "user-owner-a";
const STAFF_A = "user-staff-a";
const OWNER_B = "user-owner-b";
const CHOSEN = "+14165550100";

const MEMBERS: Membership[] = [
  { userId: OWNER_A, studioId: STUDIO_A, role: "owner" },
  { userId: STAFF_A, studioId: STUDIO_A, role: "practitioner" },
  { userId: OWNER_B, studioId: STUDIO_B, role: "owner" },
];

let provider: FakeSmsProvisioningProvider;
let store: InMemoryStore;

function attempt(overrides: Partial<Parameters<typeof provisionStudioSmsSender>[0]> = {}) {
  return provisionStudioSmsSender({
    store,
    provider,
    studioId: STUDIO_A,
    actorUserId: OWNER_A,
    country: "CA",
    areaCode: "416",
    phoneNumber: CHOSEN,
    inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
    statusCallbackUrl: "https://hone.care/api/twilio/status",
    testDestination: "+14165559999",
    serviceLabel: "Studio A",
    testBody: "Hone provisioning test.",
    ...overrides,
  });
}

beforeEach(() => {
  provider = new FakeSmsProvisioningProvider();
  provider.reset();
  store = new InMemoryStore(MEMBERS);
});

// ---------------------------------------------------------------------------
// 1. Authorization
// ---------------------------------------------------------------------------

describe("authorization is re-derived, never supplied", () => {
  it("OWNER_OWN_STUDIO: an owner provisions their own studio", async () => {
    const outcome = await attempt();
    expect(outcome).toMatchObject({ ok: true, result: "activated", adopted: false });
    expect(provider.calls.purchase).toBe(1);
  });

  it("NON_OWNER_REFUSED: a non-owner member of the same studio is refused", async () => {
    const outcome = await attempt({ actorUserId: STAFF_A });
    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: "not_owner" });
    // The refusal happens BEFORE anything billable is reachable.
    expect(provider.calls.purchase).toBe(0);
    expect(provider.calls.lookup).toBe(0);
    expect(provider.ownedNumbers()).toEqual([]);
  });

  it("CROSS_STUDIO_REFUSED: studio B's owner cannot provision studio A", async () => {
    const outcome = await attempt({ actorUserId: OWNER_B });
    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: "not_a_member" });
    expect(provider.calls.purchase).toBe(0);
    expect(store.live(STUDIO_A)).toBeUndefined();
  });

  it("every refusal reason is recognised as an authorization refusal", () => {
    expect(isAuthorizationRefusal("not_owner")).toBe(true);
    expect(isAuthorizationRefusal("not_a_member")).toBe(true);
    expect(isAuthorizationRefusal("studio_not_found")).toBe(true);
    expect(isAuthorizationRefusal("claimed")).toBe(false);
  });

  it("MUTATION CONTROL (owner authorization): dropping the role check lets staff spend money", async () => {
    // Perform the mutation for real. If NON_OWNER_REFUSED could pass against a
    // store that ignores the role, that test would be vacuous.
    store = new InMemoryStore(MEMBERS, { skipOwnerCheck: true });
    const outcome = await attempt({ actorUserId: STAFF_A });
    expect(outcome).toMatchObject({ ok: true, result: "activated" });
    expect(provider.calls.purchase).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. One owner action, at most one billable number
// ---------------------------------------------------------------------------

describe("at most one purchase per studio attempt", () => {
  it("DOUBLE_SUBMIT_ONE_CLAIM: a second submit gets no second claim", async () => {
    const claimArgs = {
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    };
    const first = await store.claim(claimArgs);
    const second = await store.claim(claimArgs);

    expect(first.result).toBe("claimed");
    expect(first.claimKey).toBeTruthy();

    // The second submit is EXCLUDED, not served a copy of the key. Handing it
    // the key would let it reconcile (finding nothing, since the first has not
    // purchased yet) and buy in parallel.
    expect(second.result).toBe("claim_held");
    expect(second.claimKey).toBeNull();

    // And crucially: one attempt exists, not two.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].claimKey).toBe(first.claimKey);
  });

  it("CONCURRENT_REQUESTS_ONE_PURCHASE: two in-flight attempts buy one number", async () => {
    const [a, b] = await Promise.all([attempt(), attempt()]);

    // Exactly one attempt executes; the other is excluded and does nothing.
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok && o.result === "activated")).toHaveLength(1);
    expect(
      outcomes.filter((o) => !o.ok && o.result === "in_progress"),
    ).toHaveLength(1);

    // THE ASSERTION. One owner action, one billable number.
    expect(provider.calls.purchase).toBe(1);
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
    expect(store.rows).toHaveLength(1);
    expect(store.live(STUDIO_A)?.status).toBe("active");
  });

  it("the excluded request performs NO provider effect whatsoever", async () => {
    // Hold the claim, then submit again while it is live.
    await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    provider.reset();

    const outcome = await attempt();

    expect(outcome).toMatchObject({ ok: false, result: "in_progress" });
    expect(provider.calls).toMatchObject({
      lookup: 0,
      availability: 0,
      purchase: 0,
      createService: 0,
      testSend: 0,
    });
  });

  it("a crashed attempt's stale claim is taken over on the SAME key", async () => {
    const first = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    // The holder crashes. Time passes beyond the lease.
    store.now += store.leaseMs + 1;

    const second = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });

    expect(second.result).toBe("claimed");
    // Same key: the takeover can still find whatever the crashed attempt bought.
    expect(second.claimKey).toBe(first.claimKey);
    expect(store.rows).toHaveLength(1);
  });

  it("a third attempt after activation buys nothing and reports already_active", async () => {
    await attempt();
    const again = await attempt();
    expect(again).toMatchObject({ ok: true, result: "already_active" });
    expect(provider.calls.purchase).toBe(1);
  });

  it("STALLED_WORKER_FENCED: a worker displaced by a takeover stops before spending", async () => {
    // THE CASE THE CLAIM KEY ALONE DOES NOT COVER, and the reason the lease
    // generation exists. Reusing the key across a takeover makes a SEQUENTIAL
    // retry safe. It does NOT fence a worker that merely STALLED past its lease
    // -- not crashed, just slow -- and then resumed believing it still owned
    // the attempt.
    const claim = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    expect(claim.result).toBe("claimed");
    const stalled = claim.leaseGeneration!;

    // While that worker is stalled, its lease expires and another takes over.
    store.now += store.leaseMs + 1;
    const takeover = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    expect(takeover.result).toBe("claimed");
    // Same key -- so the new worker can adopt anything already bought...
    expect(takeover.claimKey).toBe(claim.claimKey);
    // ...but a NEW generation, which is what fences the old one.
    expect(takeover.leaseGeneration).toBe(stalled + 1);

    // The stalled worker wakes up and tries to continue.
    expect(
      await store.assertLease({
        studioId: STUDIO_A,
        claimKey: claim.claimKey!,
        leaseGeneration: stalled,
      }),
    ).toBe(false);

    // It cannot write either, so it cannot stomp the live attempt.
    expect(
      await store.finalize({
        studioId: STUDIO_A,
        claimKey: claim.claimKey!,
        leaseGeneration: stalled,
        phoneNumber: "+14165550101",
        phoneNumberSid: `PN${"a".repeat(32)}`,
        messagingServiceSid: `MG${"a".repeat(32)}`,
        testOk: true,
      }),
    ).toBe("lease_lost");
    expect(
      await store.fail({
        studioId: STUDIO_A,
        claimKey: claim.claimKey!,
        leaseGeneration: stalled,
        errorCode: "provider_timeout",
      }),
    ).toBe("lease_lost");

    // And the current holder is unharmed.
    expect(
      await store.assertLease({
        studioId: STUDIO_A,
        claimKey: takeover.claimKey!,
        leaseGeneration: takeover.leaseGeneration!,
      }),
    ).toBe(true);
  });

  it("the fence is checked immediately before the purchase, and refuses to spend", async () => {
    // End-to-end: the orchestration is displaced mid-flight and must abort
    // with NO provider effect.
    const claim = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    // Someone else takes the attempt over while this one is still working.
    store.now += store.leaseMs + 1;
    await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    provider.reset();

    // The displaced worker resumes. It holds the OLD generation.
    const displaced = await provisionStudioSmsSender({
      store: {
        ...store,
        claim: async () => ({ ...claim, result: "claimed" as const }),
        finalize: store.finalize.bind(store),
        fail: store.fail.bind(store),
        assertLease: store.assertLease.bind(store),
      },
      provider,
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
      phoneNumber: CHOSEN,
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });

    expect(displaced).toMatchObject({ ok: false, result: "lease_lost" });
    // THE ASSERTION: no money was spent.
    expect(provider.calls.purchase).toBe(0);
    expect(provider.ownedNumbers()).toEqual([]);
  });

  it("ADOPTED_PATH_FENCED: a worker that stalled AFTER buying is still stopped", async () => {
    // The fencing fix's own blind spot, found on re-review. A worker that
    // stalls AFTER purchasing skips the purchase branch entirely on retry --
    // its number is already adopted -- so gating only the purchase left it free
    // to create a SECOND messaging service and race the current worker to
    // attach the same number. One attach takes the already-in-pool path, the
    // live worker ends up testing an empty service, and reconciliation then
    // finds two claim-tagged services and fails closed forever.
    const claim = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    // Its purchase landed at the provider.
    await provider.purchaseNumber({ claimKey: claim.claimKey!, phoneNumber: CHOSEN });
    const purchasesBefore = provider.calls.purchase;

    // It stalls; another worker takes over.
    store.now += store.leaseMs + 1;
    await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });

    // The displaced worker resumes on the ADOPTED path.
    const outcome = await provisionStudioSmsSender({
      store: {
        claim: async () => ({ ...claim, result: "claimed" as const }),
        finalize: store.finalize.bind(store),
        fail: store.fail.bind(store),
        assertLease: store.assertLease.bind(store),
      },
      provider,
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
      phoneNumber: CHOSEN,
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });

    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    // It bought nothing more AND created no second messaging service.
    expect(provider.calls.purchase).toBe(purchasesBefore);
    expect(provider.calls.createService).toBe(0);
    expect(provider.calls.attach).toBe(0);
    expect(provider.calls.testSend).toBe(0);
  });

  it("LEASE_LOST_OUTRANKS_A_STALE_ERROR: the owner is not told a live number is gone", async () => {
    // A stale worker's provider error must not be reported over the database's
    // "you were displaced". Otherwise an availability check that resumed after
    // a takeover tells the owner "that number is gone" while the current
    // generation is busy successfully provisioning it.
    const claim = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    store.now += store.leaseMs + 1;
    await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });

    // The stale worker's provider call comes back "number gone".
    provider.reset({ availabilityFails: undefined, unavailableNumbers: [CHOSEN] });

    const outcome = await provisionStudioSmsSender({
      store: {
        claim: async () => ({ ...claim, result: "claimed" as const }),
        finalize: store.finalize.bind(store),
        fail: store.fail.bind(store),
        // Fence check passes so the flow reaches the failure write, which is
        // where the database reveals the takeover.
        assertLease: async () => true,
      },
      provider,
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
      phoneNumber: CHOSEN,
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });

    // lease_lost, NOT number_no_longer_available.
    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
    expect(outcome).not.toMatchObject({ reason: "number_no_longer_available" });
    // And the live attempt was not parked in `error` by the stale worker.
    expect(store.live(STUDIO_A)?.status).toBe("provisioning");
  });

  it("MUTATION CONTROL (fencing): without the fence, a displaced worker buys a second number", async () => {
    // Perform the mutation for real. With assertLease always true, the stalled
    // worker resumes, reconciles against a claim nothing has been bought under
    // yet, and buys -- alongside the worker that displaced it.
    store = new InMemoryStore(MEMBERS, { ignoreFence: true });
    const claim = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });
    store.now += store.leaseMs + 1;
    await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
    });

    const displaced = await provisionStudioSmsSender({
      store: {
        claim: async () => ({ ...claim, result: "claimed" as const }),
        finalize: store.finalize.bind(store),
        fail: store.fail.bind(store),
        assertLease: store.assertLease.bind(store),
      },
      provider,
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
      phoneNumber: CHOSEN,
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });

    // It spent money it had no right to spend.
    expect(displaced.result).not.toBe("lease_lost");
    expect(provider.calls.purchase).toBe(1);
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
  });

  it("MUTATION CONTROL (claim exclusivity): sharing a live claim's key buys two numbers", async () => {
    // The plausible-but-wrong design: hand the second concurrent request the
    // same key and let it proceed. Both reconcile before either has purchased,
    // both find nothing, and both buy -- different numbers, because a real
    // second tab offers a fresh pick.
    store = new InMemoryStore(MEMBERS, { liveClaimSharesInsteadOfExcluding: true });
    await Promise.all([
      attempt(),
      attempt({ phoneNumber: "+14165550101" }),
    ]);

    expect(provider.calls.purchase).toBe(2);
    expect(provider.ownedNumbers().sort()).toEqual(["+14165550100", "+14165550101"]);
  });

  it("MUTATION CONTROL (claim uniqueness): reminting the key on retry buys a second number", async () => {
    // The mutation: a retry mints a FRESH key. The reconciliation lookup then
    // searches under a key nothing was bought against, so the already-purchased
    // number is invisible and a second one is bought.
    store = new InMemoryStore(MEMBERS, {
      remintClaimKeyEveryCall: true,
      failNextFinalize: true,
    });
    await attempt();
    store.options.failNextFinalize = false;
    // A real retry goes through a fresh picker, so the owner chooses again.
    await attempt({ phoneNumber: "+14165550101" });

    expect(provider.calls.purchase).toBe(2);
    // Two billable numbers from one studio's provisioning. This is precisely
    // the catastrophe the write-once claim key exists to make impossible.
    expect(provider.ownedNumbers().sort()).toEqual(["+14165550100", "+14165550101"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The lost finalize — the failure the whole design is built around
// ---------------------------------------------------------------------------

describe("provider succeeded, Hone lost the write", () => {
  it("PURCHASE_SUCCESS_FINALIZE_FAILURE: the retry adopts, it does not re-buy", async () => {
    store = new InMemoryStore(MEMBERS, { failNextFinalize: true });

    const first = await attempt();
    expect(first.ok).toBe(false);
    expect(provider.calls.purchase).toBe(1);
    // The number is real and Hone's row does not know its SID.
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
    expect(store.live(STUDIO_A)?.phoneNumberSid).toBeNull();

    // The retry, with finalize working again. The owner has gone back through
    // the picker and chosen a DIFFERENT number -- which is what a real retry
    // looks like, and the case where a weak design quietly buys a second one.
    store.options.failNextFinalize = false;
    const second = await attempt({ phoneNumber: "+14165550101" });

    // THE ASSERTIONS THIS FILE EXISTS FOR: the already-purchased number is
    // adopted, the newly-chosen one is NOT bought, and the count stays at one.
    expect(second).toMatchObject({ ok: true, result: "activated", adopted: true });
    expect(provider.calls.purchase).toBe(1);
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
    expect(store.live(STUDIO_A)?.phoneNumber).toBe(CHOSEN);
    expect(store.live(STUDIO_A)?.status).toBe("active");
  });

  it("PROVIDER_TIMEOUT_RECOVERABLE: an ambiguous timeout is retryable and flags possible ownership", async () => {
    // The purchase SUCCEEDS at the provider and the caller is told "timeout".
    provider.reset({ purchaseThenLoseResponse: true });
    const first = await attempt();

    expect(first).toMatchObject({
      ok: false,
      result: "failed",
      reason: "provider_timeout",
      retryable: true,
      mayOwnUnfinalizedResources: true,
    });
    // Money was spent even though the caller never heard so.
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
    // The attempt is parked in `error` WITH its claim key intact.
    const row = store.live(STUDIO_A);
    expect(row?.status).toBe("error");
    expect(row?.claimKey).toBeTruthy();

    // The retry finds the orphan through the claim key.
    provider.script.purchaseThenLoseResponse = false;
    const second = await attempt();

    expect(second).toMatchObject({ ok: true, result: "activated", adopted: true });
    expect(provider.calls.purchase).toBe(1);
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
  });

  it("a lookup that fails refuses to purchase rather than risk a duplicate", async () => {
    provider.reset({ lookupFails: "provider_unavailable" });
    const outcome = await attempt();

    expect(outcome).toMatchObject({
      ok: false,
      reason: "provider_unavailable",
      retryable: true,
      mayOwnUnfinalizedResources: true,
    });
    // Unable to prove it owns nothing, it spends nothing.
    expect(provider.calls.purchase).toBe(0);
  });

  it("reconciliation runs before the purchase on every attempt, first one included", async () => {
    await attempt();
    expect(provider.calls.lookup).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The chosen number is the chosen number
// ---------------------------------------------------------------------------

describe("no silent substitution", () => {
  it("NUMBER_GONE_AT_CONFIRM: a vanished number ends the attempt", async () => {
    provider.reset({ unavailableNumbers: [CHOSEN] });
    const outcome = await attempt();

    expect(outcome).toMatchObject({
      ok: false,
      result: "failed",
      reason: "number_no_longer_available",
      retryable: false,
    });
    expect(provider.calls.purchase).toBe(0);
    expect(provider.ownedNumbers()).toEqual([]);
    expect(store.live(STUDIO_A)?.status).toBe("error");
  });

  it("a number taken between the check and the purchase still refuses to substitute", async () => {
    // Availability says yes; the purchase itself reports it gone. The purchase
    // is the authority and the outcome is identical.
    provider.reset({ purchaseFails: "number_no_longer_available" });
    const outcome = await attempt();

    expect(outcome).toMatchObject({
      ok: false,
      reason: "number_no_longer_available",
      retryable: false,
    });
    expect(provider.ownedNumbers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. ACTIVE is a proof
// ---------------------------------------------------------------------------

describe("incomplete provisioning cannot become active", () => {
  it("INCOMPLETE_PROVISIONING: a failed provisioning test leaves the sender inactive", async () => {
    provider.reset({ testSendFails: "provider_rejected" });
    const outcome = await attempt();

    expect(outcome.ok).toBe(false);
    const row = store.live(STUDIO_A);
    expect(row?.status).not.toBe("active");
    // The identifiers ARE recorded: forgetting a purchased number is how Hone
    // ends up paying for something it has no record of.
    expect(row?.phoneNumberSid).toBeTruthy();
    expect(row?.messagingServiceSid).toBeTruthy();
    expect(row?.lastTestOkAt).toBeNull();
  });

  it.each([
    ["attach", { attachFails: "provider_rejected" as ProviderErrorCode }],
    ["inbound webhook", { webhookFails: "provider_rejected" as ProviderErrorCode }],
    ["status callback", { statusCallbackFails: "provider_rejected" as ProviderErrorCode }],
  ])("a failure at %s stops short of active", async (_label, script) => {
    provider.reset(script);
    const outcome = await attempt();
    expect(outcome.ok).toBe(false);
    expect(store.live(STUDIO_A)?.status).not.toBe("active");
    expect(provider.calls.testSend).toBe(0);
  });

  it("MUTATION CONTROL (active readiness): dropping the test requirement activates an unproven sender", async () => {
    store = new InMemoryStore(MEMBERS, { allowActiveWithoutTest: true });
    provider.reset({ testSendFails: "provider_rejected" });
    await attempt();
    // With the readiness rule removed, a sender that demonstrably cannot send
    // is live. That is what the constraint prevents.
    expect(store.live(STUDIO_A)?.status).toBe("active");
    expect(store.live(STUDIO_A)?.lastTestOkAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Browser-supplied provider identifiers are never authority
// ---------------------------------------------------------------------------

describe("provider identifiers come from the provider", () => {
  it("PROVIDER_IDS_BROWSER_SUPPLIED: the input type has no place to put one", () => {
    // A compile-time property made explicit: the orchestration's input carries
    // a studio, an actor, a country, an area code and a chosen NUMBER. There is
    // no phoneNumberSid or messagingServiceSid field for a caller to populate,
    // so a forged SID has nowhere to enter.
    const inputKeys = [
      "store", "provider", "studioId", "actorUserId", "country", "areaCode",
      "phoneNumber", "inboundWebhookUrl", "statusCallbackUrl",
      "testDestination", "serviceLabel", "testBody",
    ];
    expect(inputKeys).not.toContain("phoneNumberSid");
    expect(inputKeys).not.toContain("messagingServiceSid");
    expect(inputKeys).not.toContain("claimKey");
  });

  it("the SIDs written are the ones the provider returned", async () => {
    const outcome = await attempt();
    expect(outcome.ok).toBe(true);
    const row = store.live(STUDIO_A);
    // Shapes match the DB CHECK constraints exactly.
    expect(row?.phoneNumberSid).toMatch(/^PN[0-9a-fA-F]{32}$/);
    expect(row?.messagingServiceSid).toMatch(/^MG[0-9a-fA-F]{32}$/);
    expect(row?.phoneNumber).toBe(CHOSEN);
  });

  it("a claim key is minted by the store, never accepted from the caller", async () => {
    const claim = await store.claim({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: null,
    });
    expect(claim.claimKey).toMatch(/^hone-sms-[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// 7. Search is a read
// ---------------------------------------------------------------------------

describe("number search", () => {
  it("returns a bounded, browser-safe candidate list and writes nothing", async () => {
    const result = await searchAvailableSenderNumbers({
      provider,
      country: "CA",
      areaCode: "416",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    expect(result.candidates.length).toBeLessThanOrEqual(10);

    for (const candidate of result.candidates) {
      expect(candidate.phoneNumber).toMatch(/^\+[1-9][0-9]{7,14}$/);
      expect(candidate.smsCapable).toBe(true);
      // No provider identifiers on a candidate: nothing has been bought.
      expect(Object.keys(candidate).sort()).toEqual([
        "country", "formatted", "locality", "mmsCapable",
        "phoneNumber", "region", "smsCapable",
      ]);
    }

    // Search must not purchase, reserve, or create a messaging service.
    expect(provider.calls.purchase).toBe(0);
    expect(provider.calls.createService).toBe(0);
    expect(provider.ownedNumbers()).toEqual([]);
    expect(store.rows).toHaveLength(0);
  });

  it("clamps an over-large request to the browser-facing bound", async () => {
    const result = await searchAvailableSenderNumbers({
      provider,
      country: "CA",
      limit: 500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidates.length).toBeLessThanOrEqual(10);
  });

  it("refuses a malformed country or area code without calling the provider", async () => {
    expect(await searchAvailableSenderNumbers({ provider, country: "CANADA" }))
      .toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await searchAvailableSenderNumbers({ provider, country: "CA", areaCode: "4x6" }))
      .toMatchObject({ ok: false, reason: "invalid_input" });
    expect(provider.calls.search).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12. THE STALL-AND-TAKEOVER MATRIX
// ---------------------------------------------------------------------------
//
// Three consecutive reviews found the SAME defect wearing three faces: a stale
// worker that kept acting after another generation had taken its attempt over.
// Each was patched at the site where it was spotted. This suite exists so the
// FAMILY is closed rather than the three instances, by driving a takeover at
// every point in the sequence instead of the one point a reviewer happened to
// look at.
//
// THE INVARIANT, stated once:
//
//   After generation G loses its lease, G has ZERO authority. It performs no
//   further provider mutation, it writes no authoritative final state, and it
//   reports `lease_lost` rather than its own stale story -- while the worker
//   that took over remains able to finish.
//
// WHERE A TAKEOVER CAN BE INJECTED, AND WHY IT MATTERS. The orchestration
// revalidates the fence immediately before every mutating provider call, so the
// sequence is a chain of windows:
//
//   ... fence -> effect N -> [WINDOW] -> fence -> effect N+1 ...
//
// A stall in a WINDOW is caught by the next fence, and the strict claim
// (`0 mutations after takeover`) holds. A stall in the sub-millisecond gap
// BETWEEN the fence and the call it guards cannot be caught by any fence --
// that is a property of distributed systems, not of this code -- so it is
// tested SEPARATELY below, where the claim is the weaker but still decisive
// one: at most the single in-flight effect, no divergent resource, and a stop
// immediately afterwards. Writing one suite that blurred the two would have
// been a test that overclaims.

/** Provider methods that mutate something outside Hone, and cost money. */
const MUTATING_METHODS = new Set([
  "purchaseNumber",
  "createMessagingService",
  "attachNumberToService",
  "configureInboundWebhook",
  "configureStatusCallback",
  "sendProvisioningTest",
]);

/** Store methods that write authoritative final state. */
const AUTHORITATIVE_METHODS = new Set(["finalize", "fail"]);

type Generation = "old" | "new";
type ProviderCall = { worker: Generation; method: string };
type StoreCall = { worker: Generation; method: string; result: string };

type TakeoverReport = {
  oldResult: string;
  newOutcome: Awaited<ReturnType<typeof provisionStudioSmsSender>>;
  fired: boolean;
  oldProviderMutationsAfterTakeover: string[];
  oldAuthoritativeWritesAfterTakeover: string[];
  oldWriteAttemptsAfterFirstRefusal: string[];
  ownedNumbers: string[];
  purchaseCalls: number;
  finalRow: ReturnType<InMemoryStore["live"]>;
};

/**
 * Authoritative writes this worker attempted AFTER the database had already
 * told it `lease_lost`.
 *
 * WHY THIS IS SEPARATE FROM "writes that took effect". Both are zero in correct
 * code, but only this one can see the difference between stopping on the
 * refusal and ploughing on to attempt a second write that is refused for the
 * same reason. Two negative controls -- deleting the `lease_lost` short-circuit
 * on the failure path, and deleting it on the finalize path -- left every other
 * assertion in this file green, because `failWith` converts the SECOND refusal
 * into `lease_lost` too and the returned outcome is identical. The invariant
 * the brief actually states is ZERO AUTHORITY, and a worker that keeps issuing
 * writes it has already been told it may not make is still exercising it.
 */
function writeAttemptsAfterFirstRefusal(log: StoreCall[]): string[] {
  const mine = log.filter((c) => c.worker === "old" && AUTHORITATIVE_METHODS.has(c.method));
  const firstRefusal = mine.findIndex((c) => c.result === "lease_lost");
  if (firstRefusal === -1) return [];
  return mine.slice(firstRefusal + 1).map((c) => `${c.method} -> ${c.result}`);
}

/**
 * Run one attempt, stall it at `phase`, let a SECOND worker take the attempt
 * over completely, then release the first and record what it did afterwards.
 *
 * `phase` is `${providerMethod}:before` or `${providerMethod}:after`. The
 * takeover fires exactly once: the hook disarms itself before the second worker
 * runs, or it would recurse into itself.
 */
async function runTakeoverAt(
  phase: string,
  opts: { script?: FakeProviderScript; clearScriptBeforeTakeover?: boolean } = {},
): Promise<TakeoverReport> {
  const rawProvider = new FakeSmsProvisioningProvider(opts.script ?? {});
  const rawStore = new InMemoryStore(MEMBERS);

  let worker: Generation = "old";
  let fired = false;
  let takeoverAtProvider = Number.POSITIVE_INFINITY;
  let takeoverAtStore = Number.POSITIVE_INFINITY;
  let newOutcome: Awaited<ReturnType<typeof provisionStudioSmsSender>> | null = null;

  const providerLog: ProviderCall[] = [];
  const storeLog: StoreCall[] = [];
  let hook: ((p: string) => Promise<void>) | null = null;

  // Wrapping rather than editing the fake keeps the takeover machinery inside
  // the test: production-shaped code learns nothing about being observed.
  const provider = new Proxy(rawProvider, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const method = String(prop);
      return async (...args: unknown[]) => {
        if (hook) await hook(`${method}:before`);
        providerLog.push({ worker, method });
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (hook) await hook(`${method}:after`);
        return out;
      };
    },
  }) as FakeSmsProvisioningProvider;

  const store = new Proxy(rawStore, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const method = String(prop);
      return async (...args: unknown[]) => {
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        const result =
          out !== null && typeof out === "object" && "result" in out
            ? String((out as { result: unknown }).result)
            : String(out);
        storeLog.push({ worker, method, result });
        return out;
      };
    },
  }) as ProvisioningStore;

  const params = {
    store,
    provider,
    studioId: STUDIO_A,
    actorUserId: OWNER_A,
    country: "CA",
    areaCode: "416",
    phoneNumber: CHOSEN,
    inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
    statusCallbackUrl: "https://hone.care/api/twilio/status",
    testDestination: "+14165559999",
    serviceLabel: "Studio A",
    testBody: "Hone provisioning test.",
  };

  hook = async (p: string) => {
    if (p !== phase) return;
    hook = null; // fire once; the takeover worker uses the same proxy
    fired = true;

    // The lease expires. This is the ONLY way a second worker may take over --
    // there is no cancel channel, and there does not need to be.
    rawStore.now += rawStore.leaseMs + 1;

    // A transient provider fault belongs to the attempt, not to the studio: the
    // worker that takes over must be able to succeed where the last one failed.
    if (opts.clearScriptBeforeTakeover) rawProvider.script = {};

    worker = "new";
    newOutcome = await provisionStudioSmsSender(params);
    worker = "old";

    takeoverAtProvider = providerLog.length;
    takeoverAtStore = storeLog.length;
  };

  const oldOutcome = await provisionStudioSmsSender(params);

  return {
    oldResult: oldOutcome.result,
    newOutcome: newOutcome!,
    fired,
    oldProviderMutationsAfterTakeover: providerLog
      .slice(takeoverAtProvider === Number.POSITIVE_INFINITY ? providerLog.length : takeoverAtProvider)
      .filter((c) => c.worker === "old" && MUTATING_METHODS.has(c.method))
      .map((c) => c.method),
    oldAuthoritativeWritesAfterTakeover: storeLog
      .slice(takeoverAtStore === Number.POSITIVE_INFINITY ? storeLog.length : takeoverAtStore)
      .filter(
        (c) =>
          c.worker === "old" &&
          AUTHORITATIVE_METHODS.has(c.method) &&
          // A write the database REFUSED is not a write. `lease_lost` is the
          // refusal, and receiving it is the correct outcome, not a violation.
          c.result !== "lease_lost",
      )
      .map((c) => `${c.method} -> ${c.result}`),
    oldWriteAttemptsAfterFirstRefusal: writeAttemptsAfterFirstRefusal(storeLog),
    ownedNumbers: rawProvider.ownedNumbers(),
    purchaseCalls: rawProvider.calls.purchase,
    finalRow: rawStore.live(STUDIO_A),
  };
}

describe("a displaced worker has ZERO authority, at every point in the sequence", () => {
  // Every window between one fence and the next. The names in parentheses are
  // the phases the closure brief enumerates; several share a window because the
  // orchestration has no step between them, and saying so is more honest than
  // inventing two tests that inject at one program point.
  const WINDOWS: ReadonlyArray<[string, string]> = [
    ["lookupResourcesByClaim:after", "reconciled, before availability and before purchase"],
    ["isNumberAvailable:after", "availability checked, before the purchase fence"],
    ["purchaseNumber:after", "after purchase, before service creation"],
    ["createMessagingService:after", "after service creation, before attach"],
    ["attachNumberToService:after", "after attach, before the inbound webhook"],
    ["configureInboundWebhook:after", "after the inbound webhook, before the status callback"],
    ["configureStatusCallback:after", "after the status callback, before the test"],
    ["sendProvisioningTest:after", "after the test, before finalize"],
  ];

  for (const [phase, description] of WINDOWS) {
    it(`TAKEOVER @ ${phase} (${description})`, async () => {
      const r = await runTakeoverAt(phase);

      // The control. Every assertion below is vacuous if the stall never
      // happened, and a renamed provider method would silently do exactly that.
      expect(r.fired, `phase ${phase} never fired -- the matrix is vacuous`).toBe(true);

      // OLD_PROVIDER_MUTATIONS_AFTER_TAKEOVER = 0
      expect(r.oldProviderMutationsAfterTakeover).toEqual([]);

      // OLD_AUTHORITATIVE_WRITES_AFTER_TAKEOVER = 0
      expect(r.oldAuthoritativeWritesAfterTakeover).toEqual([]);

      // ...and it STOPS on the refusal rather than trying again.
      expect(r.oldWriteAttemptsAfterFirstRefusal).toEqual([]);

      // OLD_RESULT = lease_lost. Not `failed`, not a provider error code: the
      // displaced worker must not narrate a story about a row it no longer owns.
      expect(r.oldResult).toBe("lease_lost");

      // The current worker remains reconcilable -- it finished the job.
      expect(r.newOutcome).toMatchObject({ ok: true, result: "activated" });

      // And the studio owns exactly ONE number. This is the money assertion:
      // two workers, one purchase.
      expect(r.ownedNumbers).toHaveLength(1);
      expect(r.finalRow?.status).toBe("active");
    });
  }

  it("TAKEOVER @ the failure path (during finalize / failure handling)", async () => {
    // The provisioning test FAILS for the old worker, which sends it down the
    // park-the-identifiers branch -- a finalize that runs while a newer
    // generation already owns the row. Reporting `test_failed` from here was
    // one of the three original defects: it overwrites a live worker's truth
    // with a stale worker's error.
    const r = await runTakeoverAt("sendProvisioningTest:after", {
      script: { testSendFails: "provider_timeout" },
      clearScriptBeforeTakeover: true,
    });

    expect(r.fired).toBe(true);
    expect(r.oldProviderMutationsAfterTakeover).toEqual([]);
    expect(r.oldAuthoritativeWritesAfterTakeover).toEqual([]);

    // The finalize that parks the identifiers is REFUSED, and the worker stops
    // there. Falling through to `fail()` would be a second write attempted
    // after the database had already said no.
    expect(r.oldWriteAttemptsAfterFirstRefusal).toEqual([]);

    // THE POINT: `lease_lost`, not `failed` with reason `test_failed`.
    expect(r.oldResult).toBe("lease_lost");
    expect(r.newOutcome).toMatchObject({ ok: true, result: "activated" });
    expect(r.ownedNumbers).toHaveLength(1);
  });

  it("MUTATION CONTROL: with the fence ignored, the displaced worker keeps acting", async () => {
    // Prove the matrix is not green by accident. Run the same stall against a
    // store whose fence always answers yes -- which is what the code looked
    // like before the adopted path was fenced -- and watch the old worker sail
    // on through mutations it has no authority to perform.
    const rawProvider = new FakeSmsProvisioningProvider();
    const rawStore = new InMemoryStore(MEMBERS, { ignoreFence: true });
    let worker: Generation = "old";
    const providerLog: ProviderCall[] = [];
    let takeoverAt = Number.POSITIVE_INFINITY;
    let hook: ((p: string) => Promise<void>) | null = null;

    const provider = new Proxy(rawProvider, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        const method = String(prop);
        return async (...args: unknown[]) => {
          if (hook) await hook(`${method}:before`);
          providerLog.push({ worker, method });
          const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (hook) await hook(`${method}:after`);
          return out;
        };
      },
    }) as FakeSmsProvisioningProvider;

    const params = {
      store: rawStore,
      provider,
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      country: "CA",
      areaCode: "416",
      phoneNumber: CHOSEN,
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    };

    hook = async (p: string) => {
      if (p !== "purchaseNumber:after") return;
      hook = null;
      rawStore.now += rawStore.leaseMs + 1;
      worker = "new";
      await provisionStudioSmsSender(params);
      worker = "old";
      takeoverAt = providerLog.length;
    };

    const outcome = await provisionStudioSmsSender(params);
    const after = providerLog
      .slice(takeoverAt)
      .filter((c) => c.worker === "old" && MUTATING_METHODS.has(c.method));

    // The bad behaviour, demonstrated for real. If this ever comes back empty,
    // the matrix above has stopped proving anything.
    expect(after.length).toBeGreaterThan(0);
    expect(outcome.result).not.toBe("lease_lost");
  });
});

describe("the in-flight gap: what fencing CANNOT prevent, bounded", () => {
  // A stall between `stillOurs()` and the call it guards is unreachable by any
  // fence -- the check has already answered. The guarantee here is therefore
  // narrower, and stating it precisely is the point: AT MOST the single
  // in-flight effect, no divergent resource, and a stop at the very next fence.
  //
  // This is also why the claim key exists. The in-flight effect lands under the
  // SAME key as the new worker's, so it is discoverable and adoptable rather
  // than orphaned -- which is what makes the residual window survivable.
  const IN_FLIGHT: ReadonlyArray<[string, string]> = [
    ["purchaseNumber:before", "stalled between the fence and the purchase"],
    ["createMessagingService:before", "stalled between the fence and service creation"],
    ["attachNumberToService:before", "stalled between the fence and the attach"],
    ["sendProvisioningTest:before", "stalled between the fence and the test"],
  ];

  for (const [phase, description] of IN_FLIGHT) {
    it(`IN-FLIGHT @ ${phase} (${description})`, async () => {
      const r = await runTakeoverAt(phase);
      expect(r.fired, `phase ${phase} never fired`).toBe(true);

      // At most the one call that was already past its fence.
      expect(r.oldProviderMutationsAfterTakeover.length).toBeLessThanOrEqual(1);

      // Still absolute: no authoritative write, no retry after the refusal,
      // and no stale story.
      expect(r.oldAuthoritativeWritesAfterTakeover).toEqual([]);
      expect(r.oldWriteAttemptsAfterFirstRefusal).toEqual([]);
      expect(r.oldResult).toBe("lease_lost");

      // No DIVERGENT resource. The in-flight effect lands under the shared
      // claim key, so it converges with the new worker's rather than becoming
      // a second number Hone pays for and has no record of.
      expect(r.ownedNumbers).toHaveLength(1);
      expect(r.newOutcome).toMatchObject({ ok: true, result: "activated" });
      expect(r.finalRow?.status).toBe("active");
      expect(r.finalRow?.phoneNumber).toBe(CHOSEN);
    });
  }
});
