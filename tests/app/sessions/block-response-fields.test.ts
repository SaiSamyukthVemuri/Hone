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

  it("CREATE validates the response before the insert and writes the columns", () => {
    const createBody = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function createTreatmentAreaWithEntryAction"),
      ACTIONS_CODE.indexOf("export type UpdateAreaWithEntryInput"),
    );
    const checkIdx = createBody.indexOf("normalizeClinicalResponse(input)");
    const insertIdx = createBody.indexOf('.insert({');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(checkIdx);
    expect(createBody).toMatch(/\.\.\.responseCheck\.columns,/);
  });

  it("EDIT validates the response before the update and writes the columns", () => {
    const updateBody = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function updateTreatmentAreaWithEntryAction"),
    );
    const checkIdx = updateBody.indexOf("normalizeClinicalResponse(input)");
    const updateIdx = updateBody.indexOf(".update({");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(checkIdx);
    expect(updateBody).toMatch(/\.\.\.responseCheck\.columns,/);
  });

  it("both input types accept the optional response fields", () => {
    // Three declarations: ClinicalResponseInput (the validator's own
    // type) plus CreateAreaWithEntryInput and UpdateAreaWithEntryInput.
    const hits = ACTIONS.match(/toleranceRating\?: number \| null;/g) ?? [];
    expect(hits.length).toBe(3);
  });
});

describe("block form: optional capture, round-trip on edit", () => {
  it("renders the Client response section with calm copy", () => {
    expect(FORM).toMatch(/Client response/);
    expect(FORM).toMatch(/How did the client tolerate this area\?/);
    expect(FORM).toMatch(/Skin\/client response/);
    expect(FORM).toMatch(/Caution for next session/);
    expect(FORM).toMatch(/Anything to watch next time\?/);
  });

  it("tolerance is a 1-5 tap control, never required", () => {
    expect(FORM).toMatch(/\["1", "2", "3", "4", "5"\]\.map/);
    expect(FORM).toMatch(/1 = struggled, 5 = very comfortable/);
    const responseSection = FORM.slice(FORM.indexOf("Client response"));
    expect(responseSection).not.toMatch(/required/);
  });

  it("reaction dropdown is built from the shared REACTION_TYPES vocabulary", () => {
    expect(FORM).toMatch(/REACTION_TYPES\.map\(\(r\) => \(/);
    expect(FORM).toMatch(
      /from "@\/lib\/sessions\/clinical-response"/,
    );
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
    expect(VIEW).toMatch(
      /\{\(block\.tolerance_rating != null \|\|\s*\n?\s*block\.reaction_type \|\|\s*\n?\s*block\.reaction_notes\) && \(/,
    );
    expect(VIEW).toMatch(
      /\{\(block\.caution_for_next_session \|\| block\.caution_note\) && \(/,
    );
  });

  it("caution renders with its note when present", () => {
    expect(VIEW).toMatch(/Caution for next session/);
  });
});
