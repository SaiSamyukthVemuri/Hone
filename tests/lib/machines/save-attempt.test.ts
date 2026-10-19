import { readFileSync } from "node:fs";
import nodePath from "node:path";

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


// ---------------------------------------------------------------------------
// A REFUSED RETRY CANNOT ANSWER AN EARLIER ATTEMPT'S QUESTION
// (Codex, #860 4308887493)
//
// THE STATE NOBODY HAD ENUMERATED. Every existing `refused` case above starts
// from `initialSaveState()`, where clearing `unresolved` is a no-op - so the
// whole unresolved-then-refused path had NO coverage, and the defect lived in
// the gap rather than behind a wrong assertion.
//
// THE DEFECT is the edge of round 6's own ruling. Round 6 made a PRE-WRITE
// refusal definitive, which was right: nothing was written, so freezing her
// out of a form she could neither save nor dismiss was wrong. But `refused`
// hardcoded `unresolved: false`, applying that reasoning to the one state
// where something ambiguous ALREADY existed. A refusal proves only that THIS
// attempt wrote nothing; it says nothing about an earlier attempt whose answer
// was lost.
//
// THE COST, which is why this is the class we care most about: clearing the
// flag re-enabled editing, `afterDraftChanged` then dropped the retained key,
// and a later save once access recovered minted a FRESH key and appended a
// SECOND IMMUTABLE CAPTURE of settings recorded once. It cannot be edited or
// withdrawn.
// ---------------------------------------------------------------------------
describe("an unresolved attempt survives a refused retry", () => {
  /** The first attempt's answer was lost: unresolved, holding k1. */
  const lost = attempt(initialSaveState(), { kind: "unknown" });

  it("the starting state really is unresolved and holding its key", () => {
    // ANTI-VACUITY: if this were not unresolved, every case below would be
    // asserting the ordinary refusal path and would pass under the defect.
    expect(lost.unresolved).toBe(true);
    expect(lost.key).toBe("k1");
  });

  it("STAYS unresolved when the retry is refused before the RPC", () => {
    const refusedRetry = attempt(lost, {
      kind: "refused",
      error: "Your access to this studio has changed, so nothing was saved.",
    });
    expect(
      refusedRetry.unresolved,
      "a refusal answered a question it cannot answer: whether the ORIGINAL committed",
    ).toBe(true);
  });

  it("and KEEPS the key across that refusal", () => {
    const refusedRetry = attempt(lost, { kind: "refused", error: "nope" });
    expect(refusedRetry.key).toBe("k1");
    // THE STEP THAT MADE IT A DUPLICATE: with `unresolved` cleared, an edit
    // dropped the key, so the next save minted a fresh one.
    expect(
      afterDraftChanged(refusedRetry).key,
      "an edit dropped the retained key, so the next save appends a second capture",
    ).toBe("k1");
    expect(keyForSave(afterDraftChanged(refusedRetry), mint("FRESH"))).toBe("k1");
  });

  it("and the draft stays HELD, so she cannot edit her way into a duplicate", () => {
    const refusedRetry = attempt(lost, { kind: "refused", error: "nope" });
    expect(canEditDraft(refusedRetry, false)).toBe(false);
  });

  it("but the refusal's MESSAGE is still surfaced", () => {
    // Held is not silent. Keeping the freeze must not cost her the reason.
    const refusedRetry = attempt(lost, {
      kind: "refused",
      error: "Choose which studio you are working in before saving.",
    });
    expect(refusedRetry.message).toMatch(/Choose which studio/);
  });

  it("and Save is still offered, because the retry is the way out", () => {
    const refusedRetry = attempt(lost, { kind: "refused", error: "nope" });
    expect(canSubmit(refusedRetry)).toBe(true);
  });

  it("ACCESS RESTORED: the retry under the SAME key is absorbed as ONE capture", () => {
    // The whole point of holding the key. The server answers the ORIGINAL's
    // outcome - `reused: true` - and that is the authoritative response which
    // may clear the doubt.
    const refusedRetry = attempt(lost, { kind: "refused", error: "nope" });
    const absorbed = attempt(refusedRetry, {
      kind: "saved",
      groups: 1,
      readings: 3,
      reused: true,
    });
    expect(absorbed.unresolved).toBe(false);
    expect(absorbed.recorded).toBe(true);
    expect(absorbed.key).toBeNull();
    expect(
      absorbed.captures,
      "the absorbed retry counted a SECOND capture for one save",
    ).toBe(1);
    expect(absorbed.message).toBe(REUSED_NOTE);
  });

  it("CONTROL: a FRESH draft refused is still DEFINITIVE, exactly as round 6 made it", () => {
    // Without this, the fix reads as "never unfreeze", which would restore the
    // deadlock round 6 removed: a form she can neither save nor dismiss after
    // a refusal that wrote nothing and had nothing ambiguous before it.
    const refused = attempt(initialSaveState(), {
      kind: "refused",
      error: "Nothing to save.",
    });
    expect(refused.unresolved).toBe(false);
    expect(canEditDraft(refused, false)).toBe(true);
    expect(afterDraftChanged(refused).key).toBeNull();
  });
});

describe("THE LAW: `unresolved` is monotonic except under `saved`", () => {
  // STATED AS A LAW over the whole outcome union rather than as three
  // examples, because the defect was a MISSING case and a per-branch test
  // cannot report one that nobody thought of. Adding a fourth outcome kind
  // without deciding its answer here shows up as an unlisted kind.
  const OUTCOMES = [
    { label: "refused", outcome: { kind: "refused" as const, error: "x" }, clears: false },
    { label: "unknown", outcome: { kind: "unknown" as const }, clears: false },
    {
      label: "saved",
      outcome: { kind: "saved" as const, groups: 1, readings: 1, reused: false },
      clears: true,
    },
  ];

  it("covers every kind the union admits", () => {
    // A `SaveOutcome["kind"]` added later must appear here or this reds.
    const kinds: Array<"saved" | "refused" | "unknown"> = [
      "saved",
      "refused",
      "unknown",
    ];
    expect(OUTCOMES.map((o) => o.label).sort()).toEqual([...kinds].sort());
  });

  it("no outcome but `saved` may take unresolved TRUE to false", () => {
    const lost = attempt(initialSaveState(), { kind: "unknown" });
    expect(lost.unresolved).toBe(true);
    for (const { label, outcome, clears } of OUTCOMES) {
      const next = attempt(lost, outcome);
      expect(
        next.unresolved,
        `${label} ${clears ? "failed to clear" : "CLEARED"} an earlier attempt's doubt`,
      ).toBe(!clears);
    }
  });

  it("and none of them INVENTS doubt from a settled state", () => {
    // The other direction, so the law is not satisfied by always answering
    // true: a refusal on a fresh draft must stay definitive.
    const fresh = initialSaveState();
    expect(attempt(fresh, { kind: "refused", error: "x" }).unresolved).toBe(false);
    expect(
      attempt(fresh, { kind: "saved", groups: 1, readings: 1, reused: false })
        .unresolved,
    ).toBe(false);
    // `unknown` is the one that legitimately SETS it.
    expect(attempt(fresh, { kind: "unknown" }).unresolved).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// THE CREATE PATH HAS THE SAME LAW, AND ALREADY OBEYED IT
//
// Codex's finding was against the REVISION state machine above. ops01 asked
// whether the initial-save path shares the rule - it does - and the answer
// here is that it was ALREADY correct, which is why no production line changed
// for it. That is worth a guard rather than a claim: "already correct" with
// nothing holding it is one edit away from being the same defect, and this is
// the class where the cost is an immutable duplicate.
//
// The create path keeps its doubt in `saveUnresolved` on the form rather than
// in a `SaveState`, so the law reads as: the refusal branch may SET it and may
// never CLEAR it; only the success path clears it.
// ---------------------------------------------------------------------------
describe("the create path's `saveUnresolved` is monotonic too", () => {
  const FORM =
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx";
  // LINE COMMENTS BEFORE BLOCK COMMENTS: this file discusses `unresolved` at
  // length in prose, and a guard reading raw text is tripped by the
  // explanation rather than by the code.
  const code = readFileSync(nodePath.resolve(__dirname, "../../..", FORM), "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * The CREATE call's refusal branch, sliced deterministically.
   *
   * ANCHORED ON THE CREATE CALL, and the first spelling of this guard was not:
   * it took the FIRST `if (!res.ok) {` in the file, which belongs to the EDIT
   * path. The mis-slice then passed its own anti-vacuity check, because the
   * edit branch also contains `setError(res.error)` and is the same sort of
   * length - so the guard was pointed at the wrong branch and said so only
   * when a positive assertion happened to fail.
   *
   * Two exact delimiters, never a `{0,N}` proximity window: a window matches
   * by nearness and has reached past the thing it was scoping three times in
   * this lane.
   */
  const call = code.indexOf("createTreatmentAreaWithEntryAction({");
  const from = call === -1 ? -1 : code.indexOf("if (!res.ok) {", call);
  const branch = from === -1 ? "" : code.slice(from, code.indexOf("return;", from));

  /** The EDIT call's branch, kept only to prove the two are not confused. */
  const editCall = code.indexOf("updateTreatmentAreaWithEntryAction({");
  const editFrom =
    editCall === -1 ? -1 : code.indexOf("if (!res.ok) {", editCall);

  it("ANTI-VACUITY: the slice is the CREATE branch, and not the edit one", () => {
    expect(call, "the create call was not found").toBeGreaterThan(-1);
    expect(from, "the create refusal branch was not found").toBeGreaterThan(-1);
    expect(editFrom, "the edit call's branch was not found").toBeGreaterThan(-1);
    // THE CHECK THE FIRST VERSION LACKED: the two branches must be different
    // slices, and the create one must come after the create call.
    expect(
      from,
      "the slice landed on the edit path's branch, which is the mistake this guard made once",
    ).not.toBe(editFrom);
    expect(from).toBeGreaterThan(call);
    expect(branch).toMatch(/setError\(res\.error\)/);
    expect(branch).toMatch(/unresolved/);
    expect(branch.length).toBeGreaterThan(20);
    expect(branch.length).toBeLessThan(400);
  });

  it("the refusal branch SETS the flag, guarded by the result's own field", () => {
    expect(branch).toMatch(/res\.unresolved\)\s*setSaveUnresolved\(true\)/);
  });

  it("and NEVER clears it", () => {
    expect(
      branch,
      "a refusal clears the initial save's doubt, so an edit drops the retry key and the next save duplicates the area",
    ).not.toMatch(/setSaveUnresolved\(false\)/);
  });

  it("only the SUCCESS path clears it, and exactly once", () => {
    // One clearing site, outside the refusal branch. A second is not wrong in
    // itself, but it means this guard is no longer looking at all of them - so
    // it fails loudly rather than silently narrowing.
    const clears = code.match(/setSaveUnresolved\(false\)/g) ?? [];
    expect(clears).toHaveLength(1);
    const at = code.indexOf("setSaveUnresolved(false)");
    expect(
      at,
      "the clearing call moved INTO the refusal branch",
    ).toBeGreaterThan(code.indexOf("return;", from));
    expect(code.slice(at - 200, at)).toMatch(/setPendingSaveKey\(null\)/);
  });

  it("and an edit cannot drop the key while the flag stands", () => {
    // The step that turned a cleared flag into a duplicate AREA, which is the
    // create path's equivalent of the capture duplicate above.
    //
    // THE GATE IS PINNED, NOT THE WHOLE CONDITION. This test travels with the
    // branch it is merged into, and #922 adds a second conjunct
    // (`!resumeOwnsKey`) that does not exist here - so an exact match would
    // have been correct on one branch and red on the other for no behavioural
    // reason. What matters is that the key drop is gated on `!saveUnresolved`
    // at all; further conjuncts only narrow it, which is the safe direction.
    expect(code).toMatch(
      /if \(!saveUnresolved[^)]*\) setPendingSaveKey\(null\)/,
    );
  });
});
