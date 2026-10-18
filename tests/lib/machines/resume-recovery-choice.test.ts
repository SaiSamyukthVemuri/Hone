import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  RESUME_CHOICE_NEW,
  RESUME_CHOICE_PROMPT,
  RESUME_CHOICE_RESUME,
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
    expect(FORM).toMatch(/resumedNeedsSettings\n/);
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

describe("5 · a SETTLED close clears the key", () => {
  it("clears on every settled state and retains only while unsettled", () => {
    // `resumeOwnsKey` is true for `checking`, `absent` and `unknown`, and
    // false for `idle` and `saved` - so a settled close still abandons, which
    // is what 4305701038 required.
    const close =
      /if \(([^)]*)\) syncAreaOperationParam\(null\);\s*\n\s*onCancel\(\);/.exec(
        FORM,
      );
    expect(close, "the form's exit path was not found").toBeTruthy();
    expect(close![1]).toContain("!isEdit");
    expect(close![1]).toContain("!resumeOwnsKey");
  });

  it("and the ownership rule is defined ONCE, with both paths deferring to it", () => {
    // THE GAP THAT CAUSED THIS FINDING. The constant's own comment claimed
    // both paths deferred to it; the draft-change rule did and the exit rule
    // kept its own narrower test. One rule, one definition.
    expect(FORM).toMatch(
      /const resumeOwnsKey = resume\.state !== "idle" && resume\.state !== "saved";/,
    );
    const uses = FORM.match(/resumeOwnsKey/g) ?? [];
    expect(
      uses.length,
      "a path stopped deferring to the single ownership rule",
    ).toBeGreaterThanOrEqual(3);
  });
});
