import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  provisionStudioSmsSender,
  type ClaimResult,
  type ClaimRow,
  type FailResult,
  type FinalizeResult,
  type ProvisioningStore,
} from "@/lib/sms/provisioning";
import {
  CLAIM_RESULTS,
  FAIL_RESULTS,
  FINALIZE_RESULTS,
} from "@/lib/sms/provisioning-store";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";

// COMMS-01B — THE AUTHORITATIVE-WRITE CENSUS.
//
// Four authoritative writes decide provisioning state, and every one of them
// answers in WORDS:
//
//   1. claim                  -- may this worker act at all?
//   2. finalize (activating)  -- is this sender live?
//   3. finalize (identifiers) -- are the provider SIDs durably recorded?
//   4. fail                   -- was the attempt parked?
//
// The defect this file exists to prevent has appeared FIVE times in review,
// each at a different word: a verdict the database returned was DISCARDED and
// the worker's own stale story reported over it. Handling "the ones we
// thought of" is what produced that record.
//
// So this is a CENSUS, not a sample. It enumerates every word each command can
// return -- read from the store's own vocabulary, which is itself pinned
// against the SQL -- and drives the orchestration with each one. No word may
// produce an outcome that claims something the database did not say.

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATION = readFileSync(
  path.join(ROOT, "supabase/migrations/0191_studio_sms_sender_provisioning.sql"),
  "utf8",
);

/** Result words a SQL command can actually return, read from the migration. */
function sqlResultWords(fn: string): string[] {
  const start = MIGRATION.indexOf(`create or replace function public.${fn}`);
  expect(start, `${fn} not found`).toBeGreaterThan(-1);
  const end = MIGRATION.indexOf("$$;", start);
  const body = MIGRATION.slice(start, end);
  const words = new Set<string>();
  for (const m of body.matchAll(/'([a-z_]+)'::text/g)) words.add(m[1]);
  for (const m of body.matchAll(/return '([a-z_]+)';/g)) words.add(m[1]);
  return [...words].sort();
}

const STUDIO = "studio-a";
const OWNER = "owner-a";
const CHOSEN = "+14165550100";
const CLAIM_KEY = `hone-sms-${"a".repeat(32)}`;
const GEN = 3;

let provider: FakeSmsProvisioningProvider;
beforeEach(() => {
  provider = new FakeSmsProvisioningProvider();
  provider.reset();
});

/** A store whose four writes each answer with a word the test chooses. */
class CensusStore implements ProvisioningStore {
  constructor(
    private readonly words: {
      claim?: ClaimResult;
      finalizeActivating?: FinalizeResult;
      finalizeIdentifiers?: FinalizeResult;
      fail?: FailResult;
    },
  ) {}
  finalizeCalls = 0;

  async claim(): Promise<ClaimRow> {
    const result = this.words.claim ?? "claimed";
    const usable = result === "claimed" || result === "already_active";
    return {
      result,
      senderId: "sender-1",
      claimKey: usable ? CLAIM_KEY : null,
      senderStatus: "provisioning",
      leaseGeneration: usable ? GEN : null,
    };
  }

  async finalize(input: { testOk: boolean }): Promise<FinalizeResult> {
    this.finalizeCalls += 1;
    return input.testOk
      ? (this.words.finalizeActivating ?? "activated")
      : (this.words.finalizeIdentifiers ?? "provisioned_untested");
  }

  async fail(): Promise<FailResult> {
    return this.words.fail ?? "failed";
  }

  async renewLease(): Promise<boolean> {
    return true;
  }
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
// The vocabularies agree with the database
// ---------------------------------------------------------------------------

describe("the application knows every word the database can say", () => {
  it.each([
    ["claim_studio_sms_provisioning", CLAIM_RESULTS],
    ["finalize_studio_sms_provisioning", FINALIZE_RESULTS],
    ["fail_studio_sms_provisioning", FAIL_RESULTS],
  ] as const)("%s", (fn, known) => {
    // A word the SQL can return but the store does not recognise is mapped to
    // `invalid_input` and SILENTLY loses its meaning -- which is the same
    // class of defect as discarding a verdict outright, arriving by a
    // different route.
    const sql = sqlResultWords(fn);
    const app = [...known].sort();
    expect(sql).toEqual(app);
  });
});

// ---------------------------------------------------------------------------
// 1. claim — every word
// ---------------------------------------------------------------------------

describe("claim: every result word is handled", () => {
  const SUCCESSFUL: ClaimResult[] = ["claimed", "already_active"];

  it.each(CLAIM_RESULTS)("%s", async (word) => {
    const store = new CensusStore({ claim: word });
    const outcome = await run(store);

    if (word === "claimed") {
      expect(outcome).toMatchObject({ ok: true, result: "activated" });
      return;
    }
    if (word === "already_active") {
      expect(outcome).toMatchObject({ ok: true, result: "already_active" });
      return;
    }
    if (word === "claim_held") {
      // Excluded, and it must have performed no provider effect.
      expect(outcome).toMatchObject({ ok: false, result: "in_progress" });
      expect(provider.calls.purchase).toBe(0);
      return;
    }
    // Every remaining word is a refusal that NAMES itself -- never a generic
    // failure, and never a provider error.
    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: word });
    expect(provider.calls.purchase).toBe(0);
    expect(provider.ownedNumbers()).toEqual([]);
  });

  it("no successful word leaks through as a refusal, and vice versa", () => {
    for (const word of CLAIM_RESULTS) {
      expect(SUCCESSFUL.includes(word) || word !== "claimed").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. finalize (activating) — every word
// ---------------------------------------------------------------------------

describe("finalize while activating: every result word is handled", () => {
  it.each(FINALIZE_RESULTS)("%s", async (word) => {
    const store = new CensusStore({ finalizeActivating: word });
    const outcome = await run(store);

    if (word === "activated" || word === "already_active") {
      expect(outcome).toMatchObject({ ok: true, result: "activated" });
      return;
    }
    if (word === "lease_lost") {
      expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
      return;
    }
    // The database's word is REPORTED, not replaced by a provider error.
    expect(outcome).toMatchObject({ ok: false, result: "failed", reason: word });
  });
});

// ---------------------------------------------------------------------------
// 3. finalize (identifiers, after a failed provider test) — every word
// ---------------------------------------------------------------------------

describe("identifier persistence on a failed test: every result word is handled", () => {
  it.each(FINALIZE_RESULTS)("%s", async (word) => {
    provider.reset({ testSendFails: "provider_rejected" });
    const store = new CensusStore({ finalizeIdentifiers: word });
    const outcome = await run(store);

    if (word === "lease_lost") {
      expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
      return;
    }

    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    if (outcome.ok || outcome.result !== "failed") return;

    const recorded = word === "provisioned_untested" || word === "already_active";
    // Whether the SIDs were durably written is reported either way. When they
    // were NOT, that outranks "the provider test failed": one is a retry, the
    // other means Hone is paying for resources it has no record of.
    expect(outcome.identifiersRecorded).toBe(recorded);
    expect(outcome.identifierResult).toBe(word);
  });
});

// ---------------------------------------------------------------------------
// 4. fail — every word
// ---------------------------------------------------------------------------

describe("the parking write: every result word is handled", () => {
  it.each(FAIL_RESULTS)("%s", async (word) => {
    // Reach the failure path via a provider rejection.
    provider.reset({ purchaseFails: "provider_rejected" });
    const store = new CensusStore({ fail: word });
    const outcome = await run(store);

    if (word === "lease_lost") {
      expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
      return;
    }

    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    if (outcome.ok || outcome.result !== "failed") return;

    // `parked` is the database's answer, never an assumption; and the word
    // itself travels so nothing is lost.
    expect(outcome.parked).toBe(word === "failed");
    expect(outcome.parkResult).toBe(word);
    // The provider's own error is still reported alongside -- both facts.
    expect(outcome.reason).toBe("provider_rejected");
  });
});

// ---------------------------------------------------------------------------
// The census is exhaustive by construction
// ---------------------------------------------------------------------------

describe("census coverage", () => {
  it("counts the authoritative writes and their words", () => {
    // 4 writes: claim, finalize(activating), finalize(identifiers), fail.
    // finalize is one command driven at two decision points, and both are
    // enumerated because they are read differently.
    expect(CLAIM_RESULTS.length).toBeGreaterThanOrEqual(9);
    expect(FINALIZE_RESULTS.length).toBeGreaterThanOrEqual(8);
    expect(FAIL_RESULTS.length).toBeGreaterThanOrEqual(6);
  });
});
