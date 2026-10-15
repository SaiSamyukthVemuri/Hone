import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// THE INITIAL SAVE'S SERVER PATH: one set of block arguments, two commands.
//
// `create_block_with_initial_setup` (0223) writes the treatment area AND the
// machine settings in ONE transaction, which closes the window where the area
// commits and the settings do not - an area that silently has no machine
// settings while the practitioner believes she entered them.
//
// WHAT THIS FILE IS AND IS NOT. It reads SOURCE, in the same idiom as
// tests/app/sessions/block-response-fields.test.ts, because `block-actions.ts`
// has no database-mocked harness and building one would be a large new mock
// surface for a branch whose risk is structural rather than behavioural. The
// behaviour of the command itself is specified in
// tests/db/machine-setup-submission.db.test.ts and HAS NOT RUN.
//
// So these are claims about SHAPE: that the two paths cannot create different
// blocks, that the unexecuted command is not on the default path, and that
// validation still precedes both writes. None of them is a claim that either
// command works.
// ===========================================================================

const ACTIONS = readFileSync(
  path.join(
    process.cwd(),
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
  ),
  "utf8",
);

/** Comments stripped: prose naming a command must not satisfy a code claim. */
const CODE = ACTIONS.replace(/^\s*(\/\/|\*|\/\*).*$/gm, " ");

const createBody = CODE.slice(
  CODE.indexOf("export async function createTreatmentAreaWithEntryAction"),
  CODE.indexOf("export type UpdateAreaWithEntryInput"),
);

describe("the block arguments are built ONCE for both commands", () => {
  it("finds the create action, so nothing below is vacuous", () => {
    expect(createBody.length).toBeGreaterThan(500);
    expect(createBody).toContain("const blockArgs = {");
  });

  it("has exactly ONE declaration of the block argument bag", () => {
    // Two call sites with their own copies of twenty-six arguments is how the
    // settings path and the no-settings path would silently come to create
    // DIFFERENT blocks. This is the structural reason that cannot happen.
    expect((createBody.match(/const blockArgs = \{/g) ?? []).length).toBe(1);
  });

  it("passes that same bag to BOTH commands", () => {
    expect(createBody).toMatch(/\.\.\.blockArgs,/);
    expect(createBody).toMatch(
      /rpc\("create_block_with_entry", blockArgs\)/,
    );
  });

  it("declares each block parameter exactly once", () => {
    // The anti-drift claim stated as a count rather than by eye: a duplicated
    // `p_energy_level:` would mean a second bag had crept back in.
    for (const p of [
      "p_session_id",
      "p_client_id",
      "p_block",
      "p_energy_level",
      "p_minutes_performed",
      "p_units_of_lye",
    ]) {
      expect(
        (createBody.match(new RegExp(`${p}:`, "g")) ?? []).length,
        `${p} must be set once`,
      ).toBe(1);
    }
  });
});

describe("the UNEXECUTED command is not on the default path", () => {
  it("is taken only when there are settings to record", () => {
    // 0223 is pending and no database has run it. A twenty-six parameter
    // forwarding wrapper is exactly the class where one wrong parameter name
    // fails only at runtime, so routing EVERY treatment-area creation through
    // it would put the whole charting flow behind unexecuted SQL.
    expect(createBody).toMatch(
      /const withSetup\s*=\s*\n?\s*input\.initialSetup != null && input\.initialSetup\.groups\.length > 0;/,
    );
    const branchAt = createBody.indexOf("withSetup");
    const newAt = createBody.indexOf('"create_block_with_initial_setup"');
    const oldAt = createBody.indexOf('"create_block_with_entry"');
    expect(newAt).toBeGreaterThan(branchAt);
    expect(oldAt).toBeGreaterThan(branchAt);
  });

  it("keeps the PROVEN command as the fallback arm", () => {
    // Explicitly: the ternary's else is the old command, so a save with no
    // settings is byte-for-byte the path that has been running.
    expect(createBody).toMatch(
      /:\s*await supabase\.rpc\("create_block_with_entry", blockArgs\);/,
    );
  });

  it("does not make the settings REQUIRED", () => {
    // An area saved with no machine settings is an ordinary state - she sets
    // the area up and charts later - so the input must be optional.
    expect(CODE).toMatch(/initialSetup\?:\s*InitialSetupInput \| null/);
  });
});

describe("validation still precedes the write, on BOTH arms", () => {
  it("normalizes the clinical response before either command", () => {
    const checkIdx = createBody.indexOf("normalizeClinicalResponse(input)");
    expect(checkIdx).toBeGreaterThan(-1);
    for (const cmd of [
      '"create_block_with_entry"',
      '"create_block_with_initial_setup"',
    ]) {
      expect(createBody.indexOf(cmd), `${cmd} must come after validation`).toBeGreaterThan(
        checkIdx,
      );
    }
  });

  it("resolves the probe-lot selection before either command", () => {
    const invIdx = createBody.indexOf("resolveProbeInventorySelection(");
    expect(invIdx).toBeGreaterThan(-1);
    expect(createBody.indexOf('"create_block_with_initial_setup"')).toBeGreaterThan(
      invIdx,
    );
  });
});

describe("the settings payload keeps the rules the other write paths use", () => {
  it("sends the DERIVED rows, never the caller's", () => {
    // A NEGATIVE CONTROL CAUGHT THIS ONE: swapping `setupGroups` back for
    // `input.initialSetup!.groups` left every assertion in this file green,
    // because the per-reading shape is identical either way. The difference
    // is that one set has been through the validator and carries the
    // CONTRACT's unit and precision, and the other carries whatever the
    // browser sent.
    expect(createBody).toMatch(/p_setup_groups: setupGroups\.map\(\(g\) => \(\{/);
    expect(
      createBody,
      "the caller's groups must not be mapped straight to the command",
    ).not.toMatch(/p_setup_groups: input\.initialSetup!\.groups\.map/);
    // And the rows that are mapped came OUT of the validator.
    expect(createBody).toMatch(/readings: checked\.rows,/);
  });

  it("sends a value as a STRING, so a recorded zero survives JSON", () => {
    // Identical to `recordSetupGroup` and `recordSetupSubmission`, because it
    // is the same rule and not a new one: a bare 0 is indistinguishable from
    // absent once JSON-coerced.
    expect(createBody).toMatch(/value: String\(r\.value\.value\)/);
  });

  it("sends an absence as a REASON with no value at all", () => {
    expect(createBody).toMatch(/absence_reason: r\.value\.reason/);
  });

  it("forwards the retry key rather than minting one", () => {
    // The key identifies the SAVE and is minted once at handoff. Minting here
    // would make every attempt a new save and a lost response a duplicate.
    expect(createBody).toMatch(
      /p_setup_idempotency_key: input\.initialSetup!\.idempotencyKey/,
    );
    expect(createBody).not.toMatch(/randomUUID/);
  });

  it("sends the per-group channels and keys unchanged", () => {
    expect(createBody).toMatch(/group_key: g\.groupKey/);
    expect(createBody).toMatch(/channels: g\.channels/);
  });
});

describe("both command result shapes are read, not assumed", () => {
  it("handles the table-returning command AND the jsonb-returning one", () => {
    // `create_block_with_entry` returns a table, so PostgREST gives an array
    // of rows; `create_block_with_initial_setup` returns one jsonb object
    // carrying the settings result too. Assuming either shape would read the
    // block id as undefined on the other path and refuse a save that worked.
    // PINNED ON THE BLOCK-ID EXTRACTION ITSELF, not on the file containing
    // the words. My first spelling asserted only that `Array.isArray` appeared
    // SOMEWHERE in the action - and a negative control proved that vacuous:
    // removing the branch from the block-id read left the suite green, because
    // the settings-result read still mentioned it. The claim is about which
    // value is extracted how.
    expect(createBody).toMatch(
      /const asRow = Array\.isArray\(createdRows\)\s*\n?\s*\?\s*\(createdRows\[0\]/,
    );
    expect(createBody).toMatch(/const createdBlockId = asRow\?\.block_id/);
    // And the settings result is read only from the OBJECT shape, because the
    // table-returning command has none to give.
    expect(createBody).toMatch(
      /const setupResult = Array\.isArray\(createdRows\)\s*\n?\s*\?\s*undefined/,
    );
  });

  it("passes the settings result through WITHOUT interpreting it", () => {
    // The caller needs to tell "recorded nothing" from "recorded, and here is
    // the submission" - including its reused flag. Collapsing that here would
    // throw away the only thing that distinguishes an absorbed retry.
    expect(createBody).toMatch(/setup: setupResult/);
    expect(createBody).not.toMatch(/setupResult\?\.\w+\s*\?\?/);
  });
});
