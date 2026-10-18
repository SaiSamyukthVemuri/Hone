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
  it("carries the retained key, so the command can recognise the repeat", () => {
    // The key is the whole mechanism: `create_block_with_initial_setup` looks
    // the claim up by (session, key) and returns the original ids.
    expect(FORM).toMatch(
      /if \(resumeChoice === "resume" && pendingSaveKey !== null\) \{/,
    );
    expect(FORM).toMatch(/idempotencyKey: pendingSaveKey,/);
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
  it("reaches the claiming command on a key alone, not the unkeyed path", () => {
    // THE DEFECT THIS CLOSES. Without `withClaim` a settings-free save took
    // the ordinary create path, carried no key, and made a SECOND area the
    // moment the original transaction committed.
    expect(ACTIONS).toMatch(/const withClaim\s*=/);
    expect(ACTIONS).toMatch(/const withSetup = withSettings \|\| withClaim;/);
  });

  it("and names NO machine, because a settings-free save has none", () => {
    expect(ACTIONS).toMatch(
      /p_studio_machine_id: withSettings\s*\n?\s*\? input\.initialSetup!\.machineId\s*\n?\s*: null,/,
    );
    expect(ACTIONS).toMatch(
      /p_setup_mode_key: withSettings \? input\.initialSetup!\.modeKey : null,/,
    );
    // AND 0223 DECLARES THAT VALID, which is why no migration change was
    // needed. If this comment ever leaves the migration, the claim above is
    // no longer grounded.
    expect(MIGRATION).toContain("Null/empty means \"no settings to record\"");
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
