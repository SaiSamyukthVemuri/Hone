import { describe, expect, it } from "vitest";

import {
  IDENTITY_CHANGED,
  WRONG_BLOCK,
  decideHandoff,
  identityMatches,
  pinToBlock,
  prepareHandoff,
  type PendingSetupIdentity,
  INITIAL_SAVE_UNRESOLVED,
} from "@/lib/machines/pending-setup";
import { UNKNOWN_NOTE } from "@/lib/machines/save-attempt";
import type { GroupSubmission } from "@/lib/machines/setting-groups";
import type { recordSetupSubmissionAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions";

// ===========================================================================
// Carrying a machine draft across the BLOCK-CREATE boundary.
//
// THE FEATURE EXISTS NOW, and this header said otherwise until it did. When
// these cases were written the panel refused to collect a reading it had
// nowhere to put, and the browser journey asserted that two-step flow as the
// truth. `create_block_with_initial_setup` (0223) changed it: the create form
// collects the settings and ONE save writes the area and them together,
// proved by 183 DB tests and a mounted gate-open run on 2026-10-15, with the
// gate-closed twin holding.
//
// What is proved HERE is still the same thing - the RULE the handoff obeys -
// and it is still worth proving separately, because a mounted run exercises
// one path through it while these cases exercise all of them.
//
// WHY THE RULE IS WORTH PROVING BEFORE THE WIRE. Captures are append-only, so
// every way this handoff can be wrong is permanent and unamendable:
//
//   1. an empty draft handed off, allocating a capture of nothing;
//   2. the draft recorded under a machine or mode changed AFTER the numbers
//      were typed, so they are stored meaning something she never read;
//   3. the draft recorded against a DIFFERENT block than the one it was
//      entered for - a double create is enough;
//   4. a retry after a lost answer recorded as a second capture.
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

const mint = (name: string) => () => name;

describe("preparing a handoff", () => {
  it("mints the retry key ONCE, at handoff", () => {
    // Minted here rather than at the call is what makes every attempt to
    // record this draft - including one after a lost answer - carry the same
    // key, so the database recognises the repeat.
    const pending = prepareHandoff(IDENTITY, groups("g1", "g2"), mint("k1"));
    expect(pending?.idempotencyKey).toBe("k1");
    expect(pending?.groups).toHaveLength(2);
    expect(pending?.appliedToBlockId).toBeNull();
  });

  it("declines a draft with NOTHING in it", () => {
    // Failure 1. The command refuses an empty save, but reaching it at all
    // means the create form believed it had something to store.
    expect(prepareHandoff(IDENTITY, [], mint("k1"))).toBeNull();
    const empty: GroupSubmission[] = [{ groupKey: "g1", channels: [1], readings: [] }];
    expect(prepareHandoff(IDENTITY, empty, mint("k1"))).toBeNull();
  });

  it("drops the groups that have nothing, and keeps the ones that do", () => {
    const mixed: GroupSubmission[] = [
      { groupKey: "g1", channels: [1], readings: [] },
      ...groups("g2"),
    ];
    const pending = prepareHandoff(IDENTITY, mixed, mint("k1"));
    expect(pending?.groups.map((g) => g.groupKey)).toEqual(["g2"]);
  });

  it("COPIES the groups, so a later edit of the draft cannot change them", () => {
    // The handoff is a snapshot of what she had entered. If it aliased the
    // live draft, a keystroke after the create began would change what gets
    // recorded - and the key would still say it was the same save.
    const live = groups("g1");
    const pending = prepareHandoff(IDENTITY, live, mint("k1"))!;
    live[0]!.groupKey = "mutated";
    expect(pending.groups[0]!.groupKey).toBe("g1");
  });
});

describe("the identity the readings were typed under", () => {
  it("matches itself", () => {
    const pending = prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!;
    expect(identityMatches(pending, { ...IDENTITY })).toBe(true);
  });

  // EVERY PART, SEPARATELY, because each one changes what the same numbers
  // mean: a different unit, a different registered contract version, a
  // different mode's field set.
  for (const [field, value] of [
    ["deviceId", "dev-2"],
    ["profileId", "fixture:other"],
    ["profileVersion", 3],
    ["modeKey", "blend"],
  ] as const) {
    it(`does NOT match when ${field} changed`, () => {
      const pending = prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!;
      expect(identityMatches(pending, { ...IDENTITY, [field]: value })).toBe(false);
    });
  }
});

describe("deciding what to do once the block exists", () => {
  it("records the draft against the new block", () => {
    const pending = prepareHandoff(IDENTITY, groups("g1", "g2"), mint("k1"))!;
    const out = decideHandoff(pending, "block-1", IDENTITY);
    expect(out.kind).toBe("record");
    if (out.kind !== "record") return;
    expect(out.blockId).toBe("block-1");
    expect(out.machineId).toBe("dev-1");
    expect(out.modeKey).toBe("galvanic");
    expect(out.idempotencyKey).toBe("k1");
    expect(out.groups).toHaveLength(2);
  });

  it("does nothing at all when nothing was entered", () => {
    // Not an error. An area with no machine settings yet is an ordinary thing;
    // the block is simply saved alone.
    expect(decideHandoff(null, "block-1", IDENTITY)).toEqual({ kind: "nothing" });
  });

  it("DISCARDS a draft whose machine changed after it was typed", () => {
    // Failure 2, and the one most likely to happen: she enters values, then
    // notices she picked the wrong room's unit and switches. Recording them
    // anyway stores numbers she never read off that machine, permanently.
    const pending = prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!;
    const out = decideHandoff(pending, "block-1", {
      ...IDENTITY,
      deviceId: "dev-2",
    });
    expect(out).toEqual({ kind: "discard", reason: IDENTITY_CHANGED });
    // It says what to do, in words, because she has to act: read the machine
    // again.
    expect(IDENTITY_CHANGED).toMatch(/again/i);
  });

  it("DISCARDS a draft whose mode changed after it was typed", () => {
    // The sharpest version: two modes can declare the SAME field key, so the
    // value stays plausible while meaning something different. The fixtures in
    // this feature deliberately include that case.
    const pending = prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!;
    expect(
      decideHandoff(pending, "block-1", { ...IDENTITY, modeKey: "blend" }),
    ).toEqual({ kind: "discard", reason: IDENTITY_CHANGED });
  });

  it("allows a RETRY against the same block, with the same key", () => {
    // Failure 4 is handled by the key being stable, not by blocking the
    // retry: if the first attempt committed and its answer was lost, the
    // database returns the original submission.
    const pending = pinToBlock(
      prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!,
      "block-1",
    );
    const out = decideHandoff(pending, "block-1", IDENTITY);
    expect(out.kind).toBe("record");
    if (out.kind !== "record") return;
    expect(out.idempotencyKey).toBe("k1");
  });

  it("DISCARDS it against a DIFFERENT block", () => {
    // Failure 3. A double create is enough to produce a second block id, and
    // these values were entered for the first treatment area.
    const pending = pinToBlock(
      prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!,
      "block-1",
    );
    expect(decideHandoff(pending, "block-2", IDENTITY)).toEqual({
      kind: "discard",
      reason: WRONG_BLOCK,
    });
  });

  it("CONTROL: an UNPINNED draft is recordable against any block", () => {
    // Otherwise "the wrong block is refused" could be true because every
    // block is refused, and the pin would be proving nothing.
    const pending = prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!;
    expect(decideHandoff(pending, "block-2", IDENTITY).kind).toBe("record");
  });

  it("checks the identity BEFORE the block, so the clearer sentence wins", () => {
    // Both wrong at once. The machine changing is the thing she can act on -
    // read it again - whereas "wrong treatment area" would tell her nothing
    // about why her numbers are being refused.
    const pending = pinToBlock(
      prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!,
      "block-1",
    );
    expect(
      decideHandoff(pending, "block-2", { ...IDENTITY, deviceId: "dev-2" }),
    ).toEqual({ kind: "discard", reason: IDENTITY_CHANGED });
  });
});

describe("pinning the draft to its block", () => {
  it("records which block it was handed to", () => {
    const pending = prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!;
    expect(pinToBlock(pending, "block-1").appliedToBlockId).toBe("block-1");
  });

  it("keeps the key and the groups unchanged", () => {
    const pending = prepareHandoff(IDENTITY, groups("g1", "g2"), mint("k1"))!;
    const pinned = pinToBlock(pending, "block-1");
    expect(pinned.idempotencyKey).toBe("k1");
    expect(pinned.groups).toEqual(pending.groups);
  });

  it("returns the SAME object when it is already pinned there", () => {
    // Identity matters: a caller may pin before every attempt, and a new
    // object each time would re-render the form for nothing.
    const pinned = pinToBlock(
      prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!,
      "block-1",
    );
    expect(pinToBlock(pinned, "block-1")).toBe(pinned);
  });

  it("does NOT re-pin to a different block", () => {
    // The pin is fixed once set; `decideHandoff` is what refuses the other
    // block, and this must not quietly undo it.
    const pinned = pinToBlock(
      prepareHandoff(IDENTITY, groups("g1"), mint("k1"))!,
      "block-1",
    );
    expect(pinToBlock(pinned, "block-2").appliedToBlockId).toBe("block-2");
    // Stated as it behaves rather than as I would like it: pinToBlock is a
    // setter and will move the pin. The refusal lives in decideHandoff, which
    // is called FIRST - the ordering is the guarantee, and the test above
    // ("DISCARDS it against a DIFFERENT block") is what holds it.
  });
});

describe("the handoff feeds the EXISTING action with no new server code", () => {
  // A TYPE-LEVEL FORWARDING GUARD, which is the shape of check that would have
  // caught `priorUnitNames` being dropped by the connected wrapper
  // (Codex, 2351742d). If the action's input ever stops accepting what a
  // `record` decision carries, this stops compiling rather than failing in a
  // browser.
  type ActionInput = Parameters<typeof recordSetupSubmissionAction>[0];

  it("produces exactly the action's input shape", () => {
    const pending = prepareHandoff(IDENTITY, groups("g1", "g2"), mint("k1"))!;
    const out = decideHandoff(pending, "block-1", IDENTITY);
    expect(out.kind).toBe("record");
    if (out.kind !== "record") return;
    const input: ActionInput = {
      blockId: out.blockId,
      machineId: out.machineId,
      modeKey: out.modeKey,
      idempotencyKey: out.idempotencyKey,
      groups: out.groups,
    };
    // Asserted at runtime too, so the test is not purely a compile-time
    // artefact that a `skip` could silently remove.
    expect(input.groups).toHaveLength(2);
    expect(input.idempotencyKey).toBe("k1");
  });
});

// ---------------------------------------------------------------------------
// AN UNRESOLVED *INITIAL* SAVE IS NOT RETRYABLE, and this is the one place in
// the feature where the advice after a lost response is "look", not "try
// again".
//
// MEASURED, NOT REASONED. tests/db/machine-initial-save.db.test.ts ran against
// a real database and showed it: the submission command's retry key is unique
// per (BLOCK, key), and the initial save creates a NEW block before using it -
// so a repeat cannot collide, nothing is absorbed, and pressing Save again
// produces a SECOND treatment area carrying a second copy of the settings.
//
// The edit path keeps the opposite advice, correctly, and that asymmetry is
// the point rather than an inconsistency.
// ---------------------------------------------------------------------------
describe("the wording for a lost initial save", () => {
  it("tells her to RETRY, which is the instruction that inverted", () => {
    // THIS ASSERTED THE OPPOSITE, and the old expectation is the reason the
    // claim table exists: "reload this chart" and "do not save again", because
    // a second attempt created a second treatment area. 0223's create claim
    // anchors the retry key to the SESSION, so the repeat is absorbed and the
    // honest instruction is the simple one.
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/press save again/i);
    expect(INITIAL_SAVE_UNRESOLVED, "the old advice must be gone").not.toMatch(
      /do not save again/i,
    );
    expect(INITIAL_SAVE_UNRESOLVED).not.toMatch(/reload this chart/i);
  });

  it("says WHY the retry is safe, in terms of what she will get back", () => {
    // Without the consequence she has no reason to believe the instruction. It
    // used to have to justify a refusal; now it has to justify a retry, and
    // the thing that makes it safe is the key.
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/retry key/i);
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/same area/i);
    // AND IT STILL NAMES THE DUPLICATE SHE IS AVOIDING, because that is what
    // makes "press Save again" credible on a clinical form.
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/second copy/i);
  });

  it("warns against EDITING before the retry, the part that did not change", () => {
    // The key identifies a SAVE, not an attempt. A changed draft is a
    // different save, so retrying after an edit either records the edited
    // version - if the first attempt never arrived - or is refused as a used
    // key if it did. Neither is harmful and both are confusing.
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/without changing anything/i);
  });

  it("does not claim the save failed", () => {
    // The write may well have committed. Saying it failed is as wrong as
    // saying it succeeded.
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/not known/i);
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/may have been/i);
  });

  it("now AGREES with the edit path on the advice, and differs on the noun", () => {
    // THIS TEST EXISTED TO HOLD THE TWO MESSAGES APART, and that was right
    // while the two paths genuinely behaved differently: the edit path's key
    // absorbed a repeat and the create path's could not. Both do now, so
    // asserting they still disagree would be pinning a difference that has
    // become a defect.
    //
    // WHAT IS STILL ASSERTED, because it is still true: they are not the same
    // sentence. One is about settings recorded against an existing treatment,
    // the other about the treatment area itself - and telling her "these
    // settings may not have been recorded" when the whole AREA may be missing
    // would understate what she has to check.
    expect(INITIAL_SAVE_UNRESOLVED).not.toBe(UNKNOWN_NOTE);
    expect(UNKNOWN_NOTE, "the edit path offers the retry").toMatch(
      /press save again/i,
    );
    expect(INITIAL_SAVE_UNRESOLVED, "and so does the create path now").toMatch(
      /press save again/i,
    );
    // THE NOUN IS THE DIFFERENCE: the area, not the settings.
    expect(INITIAL_SAVE_UNRESOLVED).toMatch(/treatment area/i);
    expect(UNKNOWN_NOTE).toMatch(/these settings/i);
    // MY FIRST SPELLING OF THE OLD VERSION OF THIS TEST banned the substring
    // "save again:" - which the message itself contained, in "Do NOT save
    // again:". The substring was common to both; the ADVICE was what differed.
    // Guessing at a phrase instead of comparing the two constants is what made
    // that test wrong, and it is why both constants are still read here rather
    // than one being described.
  });
});
