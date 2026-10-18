import { describe, expect, it } from "vitest";

import {
  recordSetupSubmission,
  type MachineDb,
  type MachineDbError,
} from "@/lib/machines/machine-queries";
import { relayRecordResult } from "@/components/machines/machine-first-setup-connected";
import {
  afterOutcome,
  canEditDraft,
  initialSaveState,
  keyForSave,
  outcomeFromRecordResult,
} from "@/lib/machines/save-attempt";

// ===========================================================================
// MPX-03 — THE LOST RESPONSE, DRIVEN THROUGH THE REAL CHAIN
//
// WHY THIS EXISTS ALONGSIDE THE SOURCE GUARDS. Every guard for this defect
// class so far has been a source scan, and a scan proves the TEXT mentions
// the field — it cannot prove the VALUE arrives. This lane has now lost the
// same kind of value five times at a hop every scan called fine, and the
// fifth (#860 4301771498) was in a file the scan was already reading.
//
// So this feeds one dropped-connection error into the bottom of the chain
// and asserts the practitioner-facing consequence at the top: the draft is
// frozen and the retry key is preserved. Only the TRANSPORT is stubbed —
// the query, the relay hop and the outcome mapping are the real ones, and
// nothing in between is hand-supplied. Delete any one of those hops'
// forwarding and this test fails.
//
// WHAT IT STILL DOES NOT COVER, stated so the evidence is not overread: the
// server action's auth/lineage wrapper (proved separately with mocked
// identity in tests/app/machines) and React's own binding of these values
// into component state, which needs a browser — the mounted Playwright
// proof in e2e/machine-initial-save-retry covers that end.
// ===========================================================================

/** The shape supabase-js returns when the connection drops mid-request. */
const DROPPED_CONNECTION: MachineDbError = {
  message: "TypeError: fetch failed",
  code: "",
};

/** A definitive refusal, for the control: a plpgsql `raise exception`. */
const REAL_REFUSAL: MachineDbError = {
  message: "At least one settings group is required.",
  code: "P0001",
};

function dbReturning(error: MachineDbError): MachineDb {
  return {
    rpc: async () => ({ data: null, error }),
    from: () => {
      throw new Error("not used by this path");
    },
  } as unknown as MachineDb;
}

const INPUT = {
  blockId: "block-1",
  machineId: "dev-1",
  modeKey: "galvanic",
  idempotencyKey: "retry-key-00000001",
  sessionId: "session-1",
  clientId: "client-1",
  groups: [
    {
      groupKey: "g1",
      channels: [1],
      readings: [
        {
          stageKey: null,
          fieldKey: "current",
          value: { kind: "value" as const, value: 120 },
          nativeUnit: "µA",
          decimals: 0,
          observationSource: "practitioner-entered" as const,
        },
      ],
    },
  ],
};

/** The chain, minus the action's auth wrapper: query -> relay -> outcome. */
async function chain(error: MachineDbError) {
  const queried = await recordSetupSubmission(dbReturning(error), INPUT);
  // The server action's own mapping of the query result, which is the hop
  // round 16 added. Reproduced faithfully rather than imported, because the
  // action itself needs an authenticated request.
  const asAction = queried.ok
    ? { ok: true as const }
    : {
        ok: false as const,
        code: queried.unresolved ? "unknown" : "rejected",
        error: queried.error,
      };
  const relayed = relayRecordResult(asAction);
  return outcomeFromRecordResult(relayed, INPUT.groups.length);
}

describe("a dropped connection reaches the practitioner as UNKNOWN", () => {
  it("the whole chain ends in the unknown outcome, not a refusal", async () => {
    expect(await chain(DROPPED_CONNECTION)).toEqual({ kind: "unknown" });
  });

  it("and the draft is FROZEN with the retry key preserved", async () => {
    // The consequence that matters. An unfrozen draft plus a released key is
    // how a committed first attempt becomes a second immutable capture.
    const key = keyForSave(initialSaveState(), () => "retry-key-00000001");
    const state = afterOutcome(initialSaveState(), key, await chain(DROPPED_CONNECTION));

    expect(canEditDraft(state, false), "the draft stayed editable").toBe(false);
    expect(state.unresolved).toBe(true);
    expect(
      state.key,
      "the retry key was released, so the next save would mint a new one",
    ).toBe("retry-key-00000001");
  });

  it("CONTROL: a real database refusal still unfreezes and stays editable", async () => {
    // Without this, the test above would also pass if everything were
    // treated as unknown — which would be its own defect, stranding her on
    // a refusal she could never edit her way out of.
    const outcome = await chain(REAL_REFUSAL);
    expect(outcome.kind).toBe("refused");

    const key = keyForSave(initialSaveState(), () => "retry-key-00000001");
    const state = afterOutcome(initialSaveState(), key, outcome);
    expect(
      canEditDraft(state, false),
      "a refusal must leave her able to fix it",
    ).toBe(true);
    expect(state.unresolved).toBe(false);
  });

  it("but a refusal she has NOT yet received still holds the draft", async () => {
    // The in-flight window does not care which answer is coming: until one
    // arrives, the payload the request carries is the payload that must not
    // move (Codex, #860 4305022472).
    const outcome = await chain(REAL_REFUSAL);
    const key = keyForSave(initialSaveState(), () => "retry-key-00000001");
    const state = afterOutcome(initialSaveState(), key, outcome);
    expect(canEditDraft(state, true)).toBe(false);
  });
});
