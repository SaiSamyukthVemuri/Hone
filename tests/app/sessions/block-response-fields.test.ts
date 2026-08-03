import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #190 (clinical memory). Pins the create/edit wiring for the
// structured client-response fields on session blocks: both combined
// actions validate and write the columns, the form captures them
// optionally, edit round-trips stored values, and invalid values are
// rejected server-side before any DB write.

const ROOT = path.resolve(__dirname, "../../..");
const ACTIONS = readFileSync(
  path.join(
    ROOT,
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
  ),
  "utf8",
);
const FORM = readFileSync(
  path.join(
    ROOT,
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
  ),
  "utf8",
);
const VIEW = readFileSync(
  path.join(
    ROOT,
    "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
  ),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const ACTIONS_CODE = codeOnly(ACTIONS);

describe("block actions: response validation and persistence", () => {
  it("validates tolerance via isToleranceRating and rejects bad values", () => {
    expect(ACTIONS_CODE).toMatch(/!isToleranceRating\(rating\)/);
    expect(ACTIONS_CODE).toMatch(
      /Tolerance rating must be a whole number from 1 to 5\./,
    );
  });

  it("validates reaction via isReactionType and rejects unknown values", () => {
    expect(ACTIONS_CODE).toMatch(/!isReactionType\(reaction\)/);
    expect(ACTIONS_CODE).toMatch(/Pick a skin response from the list\./);
  });

  it("a caution note implies the caution flag", () => {
    expect(ACTIONS_CODE).toMatch(
      /Boolean\(input\.cautionForNextSession\) \|\| cautionNote !== null/,
    );
  });

  it("CREATE validates the response before the write and carries the columns", () => {
    // L18 Phase 2: the write is `create_block_with_entry` (migration 0166), not
    // a direct insert. The ordering property is unchanged — validation still
    // precedes the write — so it is asserted against the RPC call site.
    const createBody = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function createTreatmentAreaWithEntryAction"),
      ACTIONS_CODE.indexOf("export type UpdateAreaWithEntryInput"),
    );
    const checkIdx = createBody.indexOf("normalizeClinicalResponse(input)");
    const writeIdx = createBody.indexOf('"create_block_with_entry"');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(checkIdx);
    // The validated columns still reach the write, via the shared block bag.
    expect(createBody).toMatch(/\.\.\.responseCheck\.columns,/);
    expect(createBody).toMatch(/p_block: blockFields/);
  });

  it("EDIT validates the response before writing the columns (via blockFields / the 0129 RPC)", () => {
    const updateBody = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function updateTreatmentAreaWithEntryAction"),
    );
    const checkIdx = updateBody.indexOf("normalizeClinicalResponse(input)");
    // Migration 0129 put the columns in the shared blockFields bag; L18 Phase 2
    // routes that same bag through `update_block_with_entry` (migration 0166)
    // for BOTH the single-area and area-set paths, so there is no longer a
    // direct `.update(blockFields)` branch to assert.
    const colsIdx = updateBody.indexOf("...responseCheck.columns,");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(colsIdx).toBeGreaterThan(checkIdx);
    expect(updateBody).toMatch(/rpc\("update_block_with_entry"/);
    expect(updateBody).toMatch(/p_block: blockFields/);
    expect(updateBody).not.toMatch(/\.update\(blockFields\)/);
  });

  it("both input types accept the optional response fields", () => {
    // Three declarations: ClinicalResponseInput (the validator's own
    // type) plus CreateAreaWithEntryInput and UpdateAreaWithEntryInput.
    const hits = ACTIONS.match(/toleranceRating\?: number \| null;/g) ?? [];
    expect(hits.length).toBe(3);
  });
});

describe("block form: optional capture, round-trip on edit", () => {
  it("renders tolerance + observations; area-level caution UI is gone but data round-trips (PR #199 shape)", () => {
    expect(FORM).toMatch(/Client tolerance/);
    expect(FORM).toMatch(/How did the client tolerate this area\?/);
    // PR #199: no per-area caution checkbox or note input; the saved
    // values still load into the draft and save back unchanged.
    expect(FORM).not.toMatch(/Caution for next session/);
    expect(FORM).not.toMatch(/Anything to watch next time\?/);
    expect(FORM).toMatch(/cautionForNextSession: block\.caution_for_next_session \?\? false/);
    expect(FORM).toMatch(/cautionNote: draft\.cautionNote\.trim\(\) \|\| null/);
  });

  it("tolerance is a label-based control, never required (PR #279)", () => {
    // PR #279: the raw 1-5 grid was replaced by labeled options; storage is
    // still the 1-5 tolerance_rating smallint.
    expect(FORM).toMatch(/TOLERANCE_OPTIONS\.map/);
    expect(FORM).not.toMatch(/\["1", "2", "3", "4", "5"\]\.map/);
    const responseSection = FORM.slice(FORM.indexOf("Client tolerance"));
    expect(responseSection).not.toMatch(/required/);
  });

  it("reaction labels are folded into the merged observation-chip vocabulary from the shared modules", () => {
    // Charting unification: reactions are no longer a separate REACTION_TYPES.map
    // single-select row. The unified box renders MERGED_OBSERVATION_CHIPS, which
    // is the observation presets PLUS the shared reaction labels.
    expect(FORM).not.toMatch(/REACTION_TYPES\.map/);
    expect(FORM).toMatch(/MERGED_OBSERVATION_CHIPS\.map/);
    expect(FORM).toMatch(/from "@\/lib\/observation-chips"/);
    // A legacy reaction_type is still preserved via the shared clinical-response
    // vocabulary (isReactionType / reactionTypeLabel), imported from that module.
    expect(FORM).toMatch(/from "@\/lib\/sessions\/clinical-response"/);
    expect(FORM).toMatch(/isReactionType\(draft\.reactionType\)/);
    expect(FORM).toMatch(/reactionTypeLabel\(draft\.reactionType as ReactionType\)/);
  });

  it("edit mode initializes the draft from the stored block (round-trip)", () => {
    expect(FORM).toMatch(
      /toleranceRating:\s*\n?\s*block\.tolerance_rating != null \? String\(block\.tolerance_rating\) : ""/,
    );
    expect(FORM).toMatch(/reactionType: block\.reaction_type \?\? ""/);
    expect(FORM).toMatch(
      /cautionForNextSession: block\.caution_for_next_session \?\? false/,
    );
  });

  it("both submit paths send the response payload", () => {
    const spreads = FORM.match(/\.\.\.clinicalResponse,/g) ?? [];
    expect(spreads.length).toBe(2);
  });
});

describe("blocks view: old null records render without clutter", () => {
  it("response lines are gated on recorded values", () => {
    // Charting unification: tolerance is its OWN concept, gated on a recorded
    // value (Client tolerance line), and the LEGACY-labeled line (un-migrated
    // reaction_type not already a chip, and/or legacy reaction_notes) returns null
    // when neither is present — old all-null records still render nothing.
    expect(VIEW).toMatch(/\{block\.tolerance_rating != null && \(/);
    expect(VIEW).toMatch(/Client tolerance: /);
    expect(VIEW).toMatch(
      /if \(!legacyReaction && !block\.reaction_notes\) return null;/,
    );
    // legacyReaction is derived from the recorded reaction_type value and only
    // shown when not already a chip (no double-show of a migrated reaction).
    expect(VIEW).toMatch(/isReactionType\(block\.reaction_type\)/);
    expect(VIEW).toMatch(/Legacy skin response: /);
    // The caution line is unchanged: still gated on a recorded caution flag/note.
    expect(VIEW).toMatch(
      /\{\(block\.caution_for_next_session \|\| block\.caution_note\) && \(/,
    );
  });

  it("caution renders with its note when present", () => {
    expect(VIEW).toMatch(/Caution for next session/);
  });
});
