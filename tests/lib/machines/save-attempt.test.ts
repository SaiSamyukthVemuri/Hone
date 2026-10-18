import { describe, expect, it } from "vitest";

import {
  REFUSED_NOTE,
  REUSED_NOTE,
  SAVED_NOTE,
  UNKNOWN_NOTE,
  afterDraftChanged,
  afterOutcome,
  afterRecordAnother,
  canEditDraft,
  canSubmit,
  initialSaveState,
  keyForSave,
  type SaveState,
} from "@/lib/machines/save-attempt";

// ===========================================================================
// The lifecycle of ONE SAVE of machine settings.
//
// WHY THIS FILE EXISTS AT ALL. This repository has no jsdom and no
// testing-library, so logic that lives inside a component is provable only by
// mounting a browser - and three defects in this exact code path were found by
// review rather than by a test, for precisely that reason: a save loop with no
// try/catch that left the form pending for ever and lost the groups that had
// already committed; an unknown transport outcome treated as a failure; and a
// group set that allowed a retry to duplicate an immutable capture. So the
// rules are a pure module and the component only holds the state.
//
// WHAT IS BEING PROVED is the lifetime of the retry key, because both ways of
// getting it wrong are silent and clinical:
//
//   * a key regenerated per attempt makes idempotency useless - every retry
//     looks like a new save, and a lost response becomes a duplicated capture;
//   * a key that never changes makes a deliberate second capture impossible -
//     she re-reads the machine, enters the same numbers, and the save is
//     absorbed as a retry.
// ===========================================================================

const mint = (name: string) => () => name;

/** The state after one attempt, with the key that attempt used. */
function attempt(
  state: SaveState,
  outcome: Parameters<typeof afterOutcome>[2],
  key = keyForSave(state, mint("k1")),
): SaveState {
  return afterOutcome(state, key, outcome);
}

describe("a fresh save", () => {
  it("has no key until one is needed", () => {
    expect(initialSaveState().key).toBeNull();
  });

  it("mints one at the first attempt", () => {
    expect(keyForSave(initialSaveState(), mint("minted"))).toBe("minted");
  });

  it("can be submitted and edited", () => {
    const s = initialSaveState();
    expect(canSubmit(s)).toBe(true);
    expect(canEditDraft(s, false)).toBe(true);
  });

  it("but NOT while its own request is in flight", () => {
    // THE SIXTH CONTROL (Codex, #860 4305022472/4305022475). The payload is
    // snapshotted at submit, so the request's own duration is part of the
    // freeze: a success would discard an edit made during it silently, and a
    // LOST response would retry the retained key against a payload that no
    // longer matches its digest.
    expect(canEditDraft(initialSaveState(), true)).toBe(false);
  });
});

describe("a save that is ACKNOWLEDGED", () => {
  const saved = attempt(initialSaveState(), {
    kind: "saved",
    groups: 2,
    readings: 6,
    reused: false,
  });

  it("closes the save, so the next one mints a new key", () => {
    // THE HALF THAT MAKES A DELIBERATE SECOND CAPTURE POSSIBLE. If the key
    // survived a success, re-reading the machine and entering the same numbers
    // would be absorbed by the database as a retry and silently discarded.
    expect(saved.key).toBeNull();
    expect(keyForSave(saved, mint("k2"))).toBe("k2");
  });

  it("counts the captures the DATABASE reported, not the groups sent", () => {
    expect(saved.captures).toBe(2);
  });

  it("says so", () => {
    expect(saved.message).toBe(SAVED_NOTE);
    expect(saved.recorded).toBe(true);
    expect(saved.unresolved).toBe(false);
  });

  it("does NOT hold the surrounding form, which protects a KEY it no longer has", () => {
    // THE DISTINCTION (Codex, #860 4305364945). `canEditDraft` is false for an
    // acknowledged save, which is right for the entry's own fields. The host's
    // machine picker, mode picker and Cancel are frozen for a different
    // reason — each can discard this save's RETRY KEY — so they must be free
    // once there is no key at risk. Reporting `canEditDraft` upward left them
    // disabled after every successful capture.
    expect(canEditDraft(saved, false), "the entry's own fields").toBe(false);
    // What the host is told, as the entry computes it.
    const transportHold = false || saved.unresolved;
    expect(transportHold, "an acknowledged save held the host's controls").toBe(
      false,
    );
  });

  it("refuses another save of the same draft", () => {
    // Recording it again is a second capture of settings entered once, which
    // is indistinguishable in the record from a genuine mid-treatment change.
    // She records a change explicitly instead.
    expect(canSubmit(saved)).toBe(false);
    expect(canEditDraft(saved, false)).toBe(false);
  });
});

describe("a save REFUSED by the command", () => {
  const refused = attempt(initialSaveState(), {
    kind: "refused",
    error: "Channel 2 is claimed by more than one settings group.",
  });

  it("reports the command's own sentence, not a generic one", () => {
    expect(refused.message).toMatch(/Channel 2 is claimed/);
  });

  it("records nothing", () => {
    expect(refused.recorded).toBe(false);
    expect(refused.captures).toBe(0);
  });

  it("keeps the key, so an unchanged retry is the same save", () => {
    expect(refused.key).toBe("k1");
    expect(keyForSave(refused, mint("DIFFERENT"))).toBe("k1");
  });

  it("lets her fix it: a draft change drops the key and the message", () => {
    // A CHANGED DRAFT IS A DIFFERENT SAVE. Without this, she corrects the
    // value that was refused and the database absorbs the corrected save as a
    // retry of the one it refused - so the correction is never recorded.
    const edited = afterDraftChanged(refused);
    expect(edited.key).toBeNull();
    expect(edited.message).toBeNull();
    expect(keyForSave(edited, mint("k2"))).toBe("k2");
  });

  it("falls back to a sentence when the command gave none", () => {
    expect(attempt(initialSaveState(), { kind: "refused" }).message).toBe(
      REFUSED_NOTE,
    );
  });
});

describe("a save whose outcome is UNKNOWN", () => {
  // The transport failed, so the server's answer is lost - NOT negative. The
  // write may well have committed.
  const unknown = attempt(initialSaveState(), { kind: "unknown" });

  it("is never reported as recorded", () => {
    expect(unknown.recorded).toBe(false);
    expect(unknown.captures).toBe(0);
    expect(unknown.message).not.toBe(SAVED_NOTE);
  });

  it("is never reported as failed either", () => {
    expect(unknown.message).toBe(UNKNOWN_NOTE);
    expect(unknown.message).toMatch(/not\s+known/i);
    expect(unknown.unresolved).toBe(true);
  });

  it("KEEPS the key, which is what makes the retry safe", () => {
    // The whole mechanism. If the retry minted a new key the database would
    // see a second, unrelated save and append a second immutable capture of
    // settings entered once.
    expect(unknown.key).toBe("k1");
    expect(keyForSave(unknown, mint("NEW"))).toBe("k1");
  });

  it("OFFERS the retry rather than sending her to reload the chart", () => {
    // This is the behaviour change the retry key bought. The previous answer
    // was "reload this chart to see what actually committed before entering it
    // again", because a blind retry would have duplicated the capture.
    expect(canSubmit(unknown)).toBe(true);
    expect(unknown.message).toMatch(/again/i);
  });

  it("holds the draft, because editing it would mint a new key", () => {
    // The one case where editing is unsafe: if the unresolved attempt DID
    // commit, a changed draft becomes a second save and records twice.
    expect(canEditDraft(unknown, false)).toBe(false);
    expect(afterDraftChanged(unknown)).toBe(unknown);
  });

  it("settles when the retry succeeds, reporting that nothing was duplicated", () => {
    const settled = afterOutcome(unknown, unknown.key!, {
      kind: "saved",
      groups: 2,
      readings: 5,
      reused: true,
    });
    expect(settled.recorded).toBe(true);
    expect(settled.unresolved).toBe(false);
    expect(settled.message).toBe(REUSED_NOTE);
    expect(settled.message).toMatch(/nothing was recorded twice/i);
    // COUNTED, even though this call wrote nothing: the captures exist,
    // written by the attempt whose answer never arrived, and they have never
    // been counted here.
    expect(settled.captures).toBe(2);
    expect(settled.key).toBeNull();
  });

  it("settles when the retry writes for the first time", () => {
    const settled = afterOutcome(unknown, unknown.key!, {
      kind: "saved",
      groups: 1,
      readings: 3,
      reused: false,
    });
    expect(settled.message).toBe(SAVED_NOTE);
    expect(settled.captures).toBe(1);
  });
});

describe("recording a deliberate SECOND capture", () => {
  const saved = attempt(initialSaveState(), {
    kind: "saved",
    groups: 1,
    readings: 3,
    reused: false,
  });
  const again = afterRecordAnother(saved);

  it("starts a new save with no key", () => {
    expect(again.key).toBeNull();
    expect(again.recorded).toBe(false);
    expect(again.message).toBeNull();
    expect(canSubmit(again)).toBe(true);
    expect(canEditDraft(again, false)).toBe(true);
  });

  it("and is held again the moment the NEXT request is in flight", () => {
    // The freeze is not a one-shot: a fresh save re-enters the window.
    expect(canEditDraft(again, true)).toBe(false);
  });

  it("KEEPS the capture count, which belongs to the treatment", () => {
    // Resetting it would make the second capture announce itself as the
    // first: "Settings saved to this treatment" instead of "2 captures
    // saved". The count is what this mount has recorded, not what the current
    // draft has.
    expect(again.captures).toBe(1);
  });

  it("mints a DIFFERENT key, so the new capture is not absorbed", () => {
    const key = keyForSave(again, mint("k2"));
    expect(key).toBe("k2");
    expect(key).not.toBe("k1");
  });
});

describe("the key's identity rules, stated as a pair", () => {
  // Both halves, together, because each one alone is a defect.
  it("a retry of the SAME save reuses the key", () => {
    const refused = attempt(initialSaveState(), { kind: "refused" });
    expect(keyForSave(refused, mint("x"))).toBe(
      keyForSave(refused, mint("y")),
    );
  });

  it("a DIFFERENT save gets a different key", () => {
    const refused = attempt(initialSaveState(), { kind: "refused" });
    const edited = afterDraftChanged(refused);
    expect(keyForSave(edited, mint("k2"))).not.toBe(refused.key);
  });
});

describe("afterDraftChanged leaves an untouched state alone", () => {
  it("returns the same object when there is nothing to clear", () => {
    // Identity matters: this runs on every keystroke, and returning a new
    // object each time would re-render the form for nothing.
    const fresh = initialSaveState();
    expect(afterDraftChanged(fresh)).toBe(fresh);
  });
});
