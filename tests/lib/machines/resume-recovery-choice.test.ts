import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  RESUME_CHOICE_NEW,
  RESUME_CHOICE_PROMPT,
  RESUME_CHOICE_RESUME,
  RESUME_RECONSTRUCT_CONFIRM,
  RESUME_RECONSTRUCT_NOTICE,
} from "@/lib/machines/pending-setup";

// ===========================================================================
// AN UNSETTLED EARLIER SAVE IS RECOVERED BY AN EXPLICIT CHOICE
// (Codex, #922 4307515255; scoped by ops01)
// ===========================================================================
//
// THE KNOT THREE FINDINGS TIED. Each was right on its own and the three
// together were not:
//
//   * 4305550889 — a bare save from a reloaded form went UNKEYED and made a
//     second area, so such a save was BLOCKED;
//   * 4305701038 — blocking it meant closing had to DISCARD the key, or every
//     later Add resumed an abandoned operation with no way back to a fresh
//     area short of editing the URL;
//   * 4305501015 / 4307515255 — but "no claim found" is NOT settled: the
//     command takes its advisory lock BEFORE the lookup and writes the claim
//     at the very END, so a read landing mid-commit sees no row for a save
//     that is about to succeed. Discarding the key on that answer threw away
//     the only identity that could absorb the original, and a later Add then
//     duplicated the area once the first transaction committed.
//
// UNTIED BY LETTING THE KEY TRAVEL WITHOUT SETTINGS. 0223 already permits it:
// the settings half of `create_block_with_initial_setup` is nullable, its
// declaration says "Null/empty means 'no settings to record', which is a
// valid save", and the claim is written whenever a key is supplied. So a
// resumed settings-free save proceeds KEYED and is absorbed or refused rather
// than duplicating — which removes the need to discard the key, which removes
// the need to block the save. No migration change.
//
// AND THE KEY IS NEVER USED SILENTLY. A retained key would otherwise absorb a
// save whose values happen to match the abandoned one — suppressing an area
// she meant to create as a SECOND one. Sam's standing requirement is that
// recovery preserve the ability to create an identical second area
// deliberately, so the ambiguity is put to her. #920's implicit suppression
// stays held, and nothing here asks her to change a clinical value.
//
// SOURCE CONTRACTS, and that is a limit worth stating: these pin the wiring,
// not the behaviour. The five outcomes ops01 asked to be proved are listed
// against the mechanism that produces each, and the browser journey is where
// they are exercised end to end.
// ===========================================================================

const read = (rel: string) =>
  readFileSync(nodePath.resolve(__dirname, "../../..", rel), "utf8");

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const MIGRATION = read(
  "supabase/migrations/0223_machine_inventory_and_setup_readings.sql",
);

describe("1 · a RESUMED save that already committed is ABSORBED", () => {
  it("re-uses the RETAINED key rather than minting a fresh one", () => {
    // The key is the whole mechanism: `create_block_with_initial_setup` looks
    // the claim up by (session, key) and returns the original ids.
    //
    // RESUME MEANS RE-ENTER HER SETTINGS, so the key travels the ordinary
    // way - inside the setup payload that `machineSetupForSave` builds from a
    // draft that HAS groups. `adoptResumedKey` is what makes that key the
    // URL's rather than a new one.
    expect(FORM).toMatch(
      /const chooseResume = \(\) => \{\s*\n\s*setResumeChoice\("resume"\);\s*\n\s*adoptResumedKey\(\);/,
    );
    expect(FORM).toMatch(
      /const adoptResumedKey = \(\) => \{\s*\n\s*if \(resumedSaveKey !== null\) setPendingSaveKey\(resumedSaveKey\);/,
    );
    // AND THE SAVE USES THE HELD KEY, not a fresh uuid, whenever one is held.
    expect(FORM).toMatch(
      /const key = pendingSaveKey \?\? crypto\.randomUUID\(\)/,
    );
  });

  it("and the command returns the ORIGINAL ids rather than creating again", () => {
    // Asserted against the migration, so this file cannot drift into pinning
    // a reconciliation the database does not perform.
    expect(MIGRATION).toContain("v_claim.payload_digest <> v_digest");
    expect(MIGRATION).toContain(
      "already used to create a different treatment area",
    );
  });
});

describe("2 · a RESUMED save that never committed creates ONCE", () => {
  it("goes through the claiming command, because it carries settings", () => {
    // A RESUMED SAVE ALWAYS HAS SETTINGS, because the hold requires them - so
    // it takes the same route any settings-bearing save takes, with the
    // retained key instead of a fresh one. One area, one claim.
    expect(ACTIONS).toMatch(
      /const withSetup\s*=\s*\n?\s*input\.initialSetup != null && input\.initialSetup\.groups\.length > 0;/,
    );
  });

  it("and a SETTINGS-FREE resume cannot reach the action at all", () => {
    // THE PATH THAT WAS REMOVED BEFORE IT RAN. It would have created an area
    // with NO machine settings whenever the original never committed -
    // silently discarding what she entered. Banned by name in both files so
    // it cannot return as an apparent simplification.
    // THE DECLARATION, not the word. The action's comment names `withClaim`
    // to say why it was removed, and a ban on the bare word would be tripped
    // by the explanation itself - which is how a guard ends up rewritten to
    // be satisfiable rather than true.
    expect(ACTIONS, "the claim-only arm is back").not.toMatch(
      /const withClaim/,
    );
    expect(
      FORM,
      "the keyed settings-free save is back",
    ).not.toMatch(/groups: \[\],/);
    // THE HOLD IS WHAT STANDS IN ITS PLACE.
    expect(FORM).toMatch(
      /const resumedNeedsSettings =\s*\n?\s*resumeUnsettled && resumeChoice === "resume" && !hasSettingsToSend;/,
    );
    // AND IT IS NOT THE ONLY HOLD ANY MORE (Codex, #922 4307763145). A reload
    // resets the WHOLE draft, so re-entering one machine group is not
    // reconstruction - she also affirms that everything else is back.
    expect(FORM).toMatch(/resumedNeedsSettings \|\|/);
    expect(FORM).toMatch(/resumedUnconfirmed/);
  });
});

describe("3 · a RESUMED save whose reconstruction DIFFERS is refused, and says so", () => {
  it("the command refuses a reused key with a different payload", () => {
    expect(MIGRATION).toContain(
      "already used to create a different treatment area",
    );
    // NOT absorbed: returning the original would discard the values she just
    // entered.
    expect(MIGRATION).toContain("errcode = 'unique_violation'");
  });
});

describe("4 · START NEW creates a SECOND, identical area", () => {
  it("releases the key, so nothing can absorb the new save", () => {
    expect(FORM).toMatch(
      /const chooseStartNew = \(\) => \{\s*\n\s*setResumeChoice\("new"\);\s*\n\s*setPendingSaveKey\(null\);/,
    );
  });

  it("and NOTHING asks her to change a clinical value to get it", () => {
    // SAM'S STANDING REQUIREMENT, asserted on the copy itself. The prompt
    // offers an identity choice; it must not hint that the VALUES are the
    // problem.
    for (const copy of [
      RESUME_CHOICE_PROMPT,
      RESUME_CHOICE_RESUME,
      RESUME_CHOICE_NEW,
    ]) {
      expect(copy.toLowerCase()).not.toMatch(/different|change|alter|adjust/);
    }
    // And it says what is uncertain without claiming either outcome.
    expect(RESUME_CHOICE_PROMPT).toContain("may still be finishing");
    expect(RESUME_CHOICE_PROMPT.toLowerCase()).not.toMatch(/failed|succeeded/);
  });

  it("and the choice is OFFERED, not inferred", () => {
    expect(FORM).toMatch(/data-testid="initial-save-resume-choice-new"/);
    expect(FORM).toMatch(/onClick=\{chooseStartNew\}/);
    // HELD UNTIL SHE ANSWERS: saving first would decide it for her.
    expect(FORM).toMatch(/resumeChoicePending \|\|/);
  });
});

describe("6 · a RESUME saves nothing she did not re-enter", () => {
  // THE DEFECT (Codex, #922 4307763145). A reload resets the ENTIRE draft -
  // treatment area, minutes, entry readings, observations, numbing details and
  // notes - not only the machine setup. The recovery gate treated just
  // `machineDraft.groups` as the lost payload, so Save enabled as soon as ONE
  // machine group was re-entered. If the original never committed, the save
  // then recorded null and default values for every field she had filled in
  // before the reload: a clinical record quietly thinner than the treatment it
  // describes.
  //
  // A CONFIRMATION, NOT A VALIDATION RULE, and that choice is deliberate. A
  // treatment area with blank notes, no observations and no numbing detail is
  // LEGAL - she may genuinely have none - so there is no existing notion of
  // "required" to lean on, and inventing one would be deciding a clinical
  // completeness rule that does not belong in this file. What is wrong is not
  // that the fields are empty; it is that they are empty BY ACCIDENT while she
  // believes she is restoring an earlier save. So the emptiness is made
  // deliberate instead of silent.

  it("SAVE STAYS HELD on a resume with only a machine group re-entered", () => {
    // The exact case the finding describes: settings back, everything else at
    // its post-reload default, and Save must not be reachable.
    expect(FORM).toMatch(
      /const resumedUnconfirmed =\s*\n\s*resumeUnsettled && resumeChoice === "resume" && !resumedReconstructed;/,
    );
    // IN THE DISABLED LIST, which is the only thing that actually holds it.
    const disabled = FORM.slice(
      FORM.indexOf("onClick={submit}"),
      FORM.indexOf('data-testid="save-treatment-area"'),
    );
    expect(
      disabled,
      "the whole-draft hold is not in the save button's disabled list",
    ).toContain("resumedUnconfirmed");
    // AND THE SETTINGS HOLD IS STILL THERE: both apply, because re-entering
    // the settings is necessary and not sufficient.
    expect(disabled).toContain("resumedNeedsSettings");
  });

  it("she is TOLD what was lost, not just blocked", () => {
    // A dead button teaches nothing. The notice names what the reload cleared
    // and says plainly that only what is on screen will be saved.
    expect(FORM).toMatch(/RESUME_RECONSTRUCT_NOTICE/);
    expect(FORM).toMatch(/data-testid="initial-save-resume-reconstruct"/);
    expect(FORM).toMatch(/data-testid="initial-save-resume-reconstructed"/);
    expect(RESUME_RECONSTRUCT_NOTICE).toContain("not just the machine settings");
    expect(RESUME_RECONSTRUCT_NOTICE).toContain("Only what is on screen");
  });

  it("and the copy never asks her to CHANGE a value", () => {
    // Sam's rule, on this path too: recovery may ask her to re-enter, never to
    // alter.
    for (const copy of [RESUME_RECONSTRUCT_NOTICE, RESUME_RECONSTRUCT_CONFIRM]) {
      expect(copy.toLowerCase()).not.toMatch(/different|change|alter|adjust/);
    }
  });

  it("CONTROL: an ordinary create is NOT held by any of this", () => {
    // Without this the fix would also pass if it held every save. An ordinary
    // create never had anything to lose, and "start a new area" is authoring a
    // fresh one and already knows it.
    expect(FORM).toMatch(/resumeUnsettled && resumeChoice === "resume" &&/);
    const unconfirmed = FORM.slice(
      FORM.indexOf("const resumedUnconfirmed ="),
      FORM.indexOf(";", FORM.indexOf("const resumedUnconfirmed =")),
    );
    expect(
      unconfirmed,
      "the hold is not scoped to a chosen RESUME, so it blocks ordinary saves",
    ).toContain('resumeChoice === "resume"');
  });
});

describe("7 · START NEW ends the resumed operation's claim on the key", () => {
  it("ownership stops, not just the key value", () => {
    // THE DEFECT (Codex, #922 4307763147). `chooseStartNew` released the
    // retained key, but the resumed operation still OWNED the slot - so the
    // fresh key minted for the new area inherited that protection and survived
    // Cancel after a definitive error. The next Add then resumed an operation
    // already abandoned, which is 4305701038's trap from the other side.
    expect(FORM).toMatch(/resumeChoice !== "new";/);
  });

  it("CONTROL: ownership still holds while the answer is unsettled and unchosen", () => {
    // Without this, "release on start-new" could be satisfied by releasing
    // always - which is the defect this whole thread began with.
    expect(FORM).toMatch(
      /const resumeOwnsKey =\s*\n\s*resume\.state !== "idle" &&\s*\n\s*resume\.state !== "saved" &&/,
    );
  });
});

describe("5 · a SETTLED close clears only its own key", () => {
  it("clears its owned key on settled close and retains keys while unsettled or editing", () => {
    // `resumeOwnsKey` is true for `checking`, `absent` and `unknown`, and
    // false for `idle` and `saved` - so a settled close still abandons, which
    // is what 4305701038 required.
    // A settled banner may belong to A while the URL now carries B. The
    // exit still obeys the same edit/unsettled exclusions, but must ask the
    // owned-key helper to retire A, never clear B blindly.
    const close =
      /if \(([^)]*)\) \{\s*clearAreaOperationParamIfOwned\(([^;]+)\);\s*\}\s*onCancel\(\);/.exec(
        FORM,
      );
    expect(close, "the form's exit path was not found").toBeTruthy();
    expect(close![1]).toContain("!isEdit");
    expect(close![1]).toContain("!resumeOwnsKey");
    expect(close![2]).toBe('resume.state === "saved" ? resumedSaveKey : pendingSaveKey');
    // Anti-vacuity: the match must actually reach the shared exit and must
    // reject its former unconditional clear, not merely find ownership copy.
    expect(close![0]).toContain("onCancel()");
    expect(close![0]).not.toContain("syncAreaOperationParam(null)");
  });

  it("and the ownership rule is defined ONCE, with both paths deferring to it", () => {
    // THE GAP THAT CAUSED THIS FINDING. The constant's own comment claimed
    // both paths deferred to it; the draft-change rule did and the exit rule
    // kept its own narrower test. One rule, one definition.
    // IT GAINED A THIRD LIMB (Codex, #922 4307763147): ownership also ends
    // once she has STARTED A NEW AREA. Releasing the retained key was not
    // enough - the resumed operation still owned the slot, so the freshly
    // minted key inherited that protection and survived Cancel after a
    // definitive error.
    expect(FORM).toMatch(
      /const resumeOwnsKey =\s*\n\s*resume\.state !== "idle" &&\s*\n\s*resume\.state !== "saved" &&/,
    );
    expect(FORM).toMatch(/resumeChoice !== "new";/);
    const uses = FORM.match(/resumeOwnsKey/g) ?? [];
    expect(
      uses.length,
      "a path stopped deferring to the single ownership rule",
    ).toBeGreaterThanOrEqual(3);
  });
});
