import { describe, expect, it } from "vitest";

import {
  CREATED_NOT_RECORDED_NOTE,
  createAndRecord,
  outcomeNote,
  type CreateOutcome,
  type RecordOutcome,
} from "@/lib/machines/create-and-record";
import {
  IDENTITY_CHANGED,
  prepareHandoff,
  type PendingSetupIdentity,
} from "@/lib/machines/pending-setup";
import type { GroupSubmission } from "@/lib/machines/setting-groups";
import type { createTreatmentAreaWithEntryAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions";
import type { recordSetupSubmissionAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions";

// ===========================================================================
// CREATE THE TREATMENT AREA, THEN RECORD THE SETTINGS SHE ENTERED.
//
// ONE-STEP CREATE-AND-RECORD DOES NOT EXIST YET, and this file does not
// pretend otherwise. In create mode the block has no row, so the panel refuses
// to collect a reading it cannot store; she saves the area, re-opens it, and
// records. The browser journey spec asserts that two-step flow as today's
// truth. What is proved here is the ORCHESTRATION a one-step version needs -
// the form render and the browser-to-action call are the mount-only half, and
// nothing calls this yet.
//
// THE TWO WRITES ARE NOT ATOMIC WITH EACH OTHER, deliberately: one command
// creates a treatment area, another records a clinical setup, and merging them
// would give the setup command a responsibility it should not have. So the
// interesting state is "AREA CREATED, SETTINGS NOT RECORDED" - which is
// ordinary and honest, and must be reported as neither saved nor failed. Every
// case below exists because getting that wrong is the whole risk.
//
// BOTH CALLS ARE INJECTED, so none of this needs a database. The type-level
// guards at the bottom assert that the REAL actions satisfy the injected
// signatures, which is the check that would have caught `priorUnitNames` dying
// in the connected wrapper (Codex, 2351742d) - a defect every unit test passed
// through.
// ===========================================================================

const IDENTITY: PendingSetupIdentity = {
  deviceId: "dev-1",
  profileId: "fixture:panel",
  profileVersion: 2,
  modeKey: "galvanic",
};

const groups = (...keys: string[]): GroupSubmission[] =>
  keys.map((k, i) => ({
    groupKey: k,
    channels: [i + 1],
    readings: [
      {
        stageKey: null,
        fieldKey: "current",
        value: { kind: "value", value: 120 + i },
        observationSource: "practitioner-entered",
      },
    ],
  }));

const draft = (...keys: string[]) =>
  prepareHandoff(IDENTITY, groups(...keys), () => "save-key-0001")!;

const created: CreateOutcome = { ok: true, block: { id: "block-1" } };

/** A recorder that remembers what it was asked to do. */
function recorder(result: RecordOutcome | (() => never)) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    fn: async (input: Record<string, unknown>) => {
      calls.push(input);
      if (typeof result === "function") result();
      return result as RecordOutcome;
    },
  };
}

describe("nothing was entered", () => {
  it("saves the area and records nothing, which is not a failure", async () => {
    // An area whose machine settings have not been entered is an ordinary
    // thing. The settings command is never called at all.
    const rec = recorder({ ok: true });
    const out = await createAndRecord({
      pending: null,
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: rec.fn,
    });
    expect(out).toEqual({ kind: "created", blockId: "block-1" });
    expect(rec.calls).toHaveLength(0);
    // And it says nothing extra: the area saving is the whole act.
    expect(outcomeNote(out)).toBeNull();
  });
});

describe("the area is created and the settings are recorded", () => {
  it("hands the draft off with its single retry key", async () => {
    const rec = recorder({ ok: true, captures: 2, written: 2, reused: false });
    const out = await createAndRecord({
      pending: draft("g1", "g2"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: rec.fn,
    });
    expect(out.kind).toBe("recorded");
    if (out.kind !== "recorded") return;
    expect(out.blockId).toBe("block-1");
    expect(out.captures).toBe(2);
    expect(out.readings).toBe(2);
    expect(out.reused).toBe(false);

    // ONE CALL, against the block that was just created, with the key minted
    // at handoff - not a new one.
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.blockId).toBe("block-1");
    expect(rec.calls[0]!.idempotencyKey).toBe("save-key-0001");
    expect(rec.calls[0]!.machineId).toBe("dev-1");
    expect(rec.calls[0]!.modeKey).toBe("galvanic");
    expect((rec.calls[0]!.groups as GroupSubmission[]).map((g) => g.groupKey)).toEqual(
      ["g1", "g2"],
    );
  });

  it("counts what the DATABASE recorded, not what was sent", async () => {
    // On a reused submission the call wrote nothing and the counts describe
    // what the ORIGINAL save recorded, which is the only true answer.
    const rec = recorder({ ok: true, captures: 2, written: 5, reused: true });
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: rec.fn,
    });
    expect(out.kind).toBe("recorded");
    if (out.kind !== "recorded") return;
    expect(out.captures).toBe(2);
    expect(out.readings).toBe(5);
    expect(out.reused).toBe(true);
  });

  it("says the retry was ABSORBED, not that a new capture was made", async () => {
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async () => ({ ok: true, captures: 1, written: 3, reused: true }),
    });
    const note = outcomeNote(out);
    expect(note).toMatch(/already recorded/i);
    expect(note).toMatch(/nothing was recorded twice/i);
  });

  it("falls back to the groups sent only when the server gave no tally", async () => {
    const out = await createAndRecord({
      pending: draft("g1", "g2"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async () => ({ ok: true }),
    });
    expect(out.kind === "recorded" && out.captures).toBe(2);
  });
});

describe("the area is created and the record is REFUSED", () => {
  const refusal = { ok: false, error: "Channel 2 is claimed by two groups." };

  it("reports neither saved nor failed, and hands back what a retry needs", async () => {
    // THE STATE THIS MODULE EXISTS FOR. The area really was created, so
    // "could not save" is false; the settings were not, so "saved" is false.
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async () => refusal,
    });
    expect(out.kind).toBe("created-not-recorded");
    if (out.kind !== "created-not-recorded") return;
    expect(out.blockId).toBe("block-1");
    expect(out.error).toMatch(/Channel 2/);
    // An acknowledged refusal: nothing was written, and that is a different
    // fact from a lost answer.
    expect(out.unresolved).toBe(false);
  });

  it("PINS the draft to the block, so a retry cannot land on another one", async () => {
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async () => refusal,
    });
    expect(out.kind === "created-not-recorded" && out.pending.appliedToBlockId).toBe(
      "block-1",
    );
  });

  it("keeps the SAME retry key, so the retry is the same save", async () => {
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async () => refusal,
    });
    expect(out.kind === "created-not-recorded" && out.pending.idempotencyKey).toBe(
      "save-key-0001",
    );
  });

  it("never says SAVED, and says the area is", async () => {
    // Wording is part of the contract: "saved" for a state where the settings
    // were not recorded is the failure this module exists to prevent.
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async () => refusal,
    });
    const note = outcomeNote(out);
    expect(note).toBe(CREATED_NOT_RECORDED_NOTE);
    expect(note).toMatch(/treatment area is saved/i);
    expect(note).toMatch(/not yet recorded/i);
    expect(note).toMatch(/retry key/i);
    expect(note).not.toMatch(/settings are saved/i);
  });
});

describe("the record THREW, so the answer is unknown", () => {
  it("is marked unresolved, which is not the same as refused", async () => {
    // The write may well have committed and the answer was lost on the way
    // back. Saying "not recorded" flatly would be a claim nobody can make.
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(out.kind).toBe("created-not-recorded");
    if (out.kind !== "created-not-recorded") return;
    expect(out.unresolved).toBe(true);
    expect(out.error).toMatch(/socket hang up/);
    // Still retryable under the same key, which is what makes the retry safe.
    expect(out.pending.idempotencyKey).toBe("save-key-0001");
    expect(out.pending.appliedToBlockId).toBe("block-1");
  });
});

describe("the machine or mode changed after the values were typed", () => {
  it("DISCARDS the draft and still saves the area", async () => {
    // She enters values, notices she picked the wrong room's unit, switches,
    // and saves. Recording them anyway would store numbers she never read off
    // that machine, permanently.
    const rec = recorder({ ok: true });
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: { ...IDENTITY, deviceId: "dev-2" },
      createBlock: async () => created,
      recordSetup: rec.fn,
    });
    expect(out).toEqual({
      kind: "created-draft-discarded",
      blockId: "block-1",
      reason: IDENTITY_CHANGED,
    });
    // THE COMMAND WAS NEVER CALLED. A discard that still sent the payload
    // would be a discard in name only.
    expect(rec.calls).toHaveLength(0);
  });

  it("tells her the area is saved AND what to do about the settings", async () => {
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: { ...IDENTITY, modeKey: "blend" },
      createBlock: async () => created,
      recordSetup: async () => ({ ok: true }),
    });
    const note = outcomeNote(out);
    expect(note).toMatch(/treatment area is saved/i);
    // The actionable half, from pending-setup's own sentence: read the machine
    // again.
    expect(note).toMatch(/again/i);
  });
});

describe("the area itself could not be created", () => {
  it("hands nothing off and leaves the draft alone", async () => {
    const rec = recorder({ ok: true });
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => ({ ok: false, error: "Treatment area is required." }),
      recordSetup: rec.fn,
    });
    expect(out).toEqual({
      kind: "not-created",
      error: "Treatment area is required.",
    });
    expect(rec.calls).toHaveLength(0);
    expect(outcomeNote(out)).toBe("Treatment area is required.");
  });

  it("survives the create THROWING", async () => {
    const rec = recorder({ ok: true });
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => {
        throw new Error("connection reset");
      },
      recordSetup: rec.fn,
    });
    expect(out.kind).toBe("not-created");
    expect(out.kind === "not-created" && out.error).toMatch(/connection reset/);
    expect(rec.calls).toHaveLength(0);
  });

  it("has a sentence even when the create gave none", async () => {
    const out = await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => ({ ok: false }),
      recordSetup: async () => ({ ok: true }),
    });
    expect(outcomeNote(out)).toMatch(/could not be saved/i);
  });
});

describe("THE AREA IS NEVER HELD HOSTAGE TO THE SETTINGS", () => {
  it("is created in every case where the create itself succeeded", async () => {
    // Stated as one claim across the whole matrix, because it is the product
    // rule: a machine draft that cannot be recorded is a reason to tell her
    // so, not a reason to lose the treatment area she asked to save.
    const cases: Array<{
      label: string;
      record: () => Promise<RecordOutcome>;
      identity: PendingSetupIdentity;
    }> = [
      { label: "recorded", record: async () => ({ ok: true }), identity: IDENTITY },
      { label: "refused", record: async () => ({ ok: false }), identity: IDENTITY },
      {
        label: "threw",
        record: async () => {
          throw new Error("x");
        },
        identity: IDENTITY,
      },
      {
        label: "discarded",
        record: async () => ({ ok: true }),
        identity: { ...IDENTITY, deviceId: "other" },
      },
    ];
    for (const c of cases) {
      const out = await createAndRecord({
        pending: draft("g1"),
        currentIdentity: c.identity,
        createBlock: async () => created,
        recordSetup: c.record,
      });
      expect(
        out.kind === "not-created",
        `${c.label}: the area must still be created`,
      ).toBe(false);
      expect(
        "blockId" in out ? out.blockId : null,
        `${c.label}: the block id must reach the caller`,
      ).toBe("block-1");
    }
  });
});

describe("the REAL actions satisfy the injected signatures", () => {
  // THE GUARD FOR THE INERT-FEATURE CLASS. `priorUnitNames` existed in the
  // loader, the props and the panel's own forwarding and died in the connected
  // wrapper - a gap every unit test passed through, because each layer was
  // tested against its own fixture. If either action's input or result drifts
  // away from what this orchestrator injects, that stops COMPILING instead of
  // failing in a browser.
  //
  // THE ENFORCER IS `tsc`, NOT THIS TEST RUN, and that distinction is not
  // pedantry - I checked it. Vitest transpiles with esbuild, which STRIPS
  // types without checking them, so dropping `idempotencyKey` from the
  // injected signature left all 19 cases below green while `tsc --noEmit`
  // reported three errors (TS2353 at the call site, TS2741 and TS1360 here).
  // So this guard is real, and it is the typecheck lane that holds it: a
  // pipeline that ran tests without typecheck would not catch the drift.
  // The runtime assertions in each case are what keep the file honest under
  // vitest alone.
  type RealCreate = Awaited<ReturnType<typeof createTreatmentAreaWithEntryAction>>;
  type RealRecord = Awaited<ReturnType<typeof recordSetupSubmissionAction>>;
  type RecordInput = Parameters<typeof recordSetupSubmissionAction>[0];

  it("the create action's success carries a block with an id", () => {
    // Narrowed from the real union, so a rename of `block` or `id` fails here.
    const ok = { ok: true, block: { id: "block-1" } } as Extract<
      RealCreate,
      { ok: true }
    >;
    const asOutcome: CreateOutcome = { ok: true, block: { id: ok.block.id } };
    expect(asOutcome.ok && asOutcome.block.id).toBe("block-1");
  });

  it("the record action's result is usable as a RecordOutcome", () => {
    const real = {
      ok: true,
      submissionId: "sub-1",
      captures: 2,
      written: 4,
      reused: false,
    } as Extract<RealRecord, { ok: true }>;
    const asOutcome: RecordOutcome = {
      ok: real.ok,
      captures: real.captures,
      written: real.written,
      reused: real.reused,
    };
    expect(asOutcome.captures).toBe(2);
  });

  it("what the orchestrator SENDS is the record action's input", async () => {
    // The strongest of the three: the object built inside createAndRecord is
    // assigned to the real action's parameter type, so a new required field on
    // the action breaks this test rather than silently never being sent.
    let sent: RecordInput | null = null;
    await createAndRecord({
      pending: draft("g1"),
      currentIdentity: IDENTITY,
      createBlock: async () => created,
      recordSetup: async (input) => {
        sent = input satisfies RecordInput;
        return { ok: true };
      },
    });
    expect(sent).not.toBeNull();
    expect(sent!.idempotencyKey).toBe("save-key-0001");
  });
});
