import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #279 (Chloe real-charting feedback). The charting UI is not DOM-rendered in
// this suite (node env), so these are source/wiring pins that prove each fix is
// in place and persisted. Behavioral DB proof for the new columns is in
// tests/db/charting-numbing-probe-lot.db.test.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const SUGG = read("lib/record-keeping/probe-lot-suggestion.ts");
const ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const VIEW = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
);
const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const RK = read("lib/record-keeping/queries.ts");

describe("item 1: numbing control + persistence", () => {
  it("renders the three numbing choices and updates numbingStatus", () => {
    expect(FORM).toMatch(/NUMBING_OPTIONS\.map/);
    expect(FORM).toMatch(/update\("numbingStatus", opt\.value\)/);
  });
  it("the action validates + writes numbing_status", () => {
    expect(ACTIONS).toMatch(/numbingStatus/);
    expect(ACTIONS).toMatch(/numbing_status: numbing/);
    expect(ACTIONS).toMatch(/isNumbingStatus/);
  });
  it("the saved record shows the numbing line", () => {
    expect(VIEW).toMatch(/numbingStatusLabel\(block\.numbing_status\)/);
  });
});

describe("item 2: underarms does not flood the whole Arms zone", () => {
  it("uses a subtle 'contains the selected area' state, not a full flood", () => {
    const COMPONENT = read("components/body-map-area-picker.tsx");
    expect(COMPONENT).toMatch(/contains the selected area/);
    expect(COMPONENT).toMatch(/containsSelection/);
    // the dominant emerald-200 flood is gone (subtle emerald-50 instead)
    expect(COMPONENT).not.toMatch(/fill-emerald-200/);
  });
});

describe("item 3: probe-lot auto-populate + explicit confirm (Feature A)", () => {
  it("(0155) suggestions carry the last-confirmed inventory item id per probe; never auto-confirms", () => {
    expect(RK).toMatch(/getProbeLotSuggestions/);
    expect(PAGE).toMatch(/getProbeLotSuggestions/);
    expect(FORM).toMatch(/probeLotSuggestions/);
    // The suggestions query surfaces the linked inventory item id for auto-fill.
    expect(RK).toMatch(/probe_inventory_item_id/);
    // Truthful inventory-backed copy.
    expect(FORM).toMatch(/Auto-filled from your last confirmed inventory lot/);
    expect(FORM).toMatch(/Only active inventory lot for this probe/);
    expect(FORM).toMatch(/Confirm lot\/batch/);
    // Old copy is gone.
    expect(FORM).not.toMatch(/Suggested from records/);
    expect(FORM).not.toMatch(/Suggested from last probe lot/);
  });
  it("(0155) auto-fills the last-confirmed / sole-active inventory lot, always unconfirmed", () => {
    // The reactive effect resolves inventory (ACTIVE, matching probe_key) and
    // writes the linked id + lot number unconfirmed; it never runs once the
    // practitioner has edited manually.
    expect(FORM).toMatch(
      /resolveInventoryAutofill\(\s*probeLotInventory,\s*draft\.probeKey,/,
    );
    // The auto-fill rule lives in the shared pure module.
    expect(SUGG).toMatch(/suggestions\.byKey\[probeKey\]/); // still exposes byKey
    expect(FORM).toMatch(/if \(lotEditedManually\) return;/);
    expect(FORM).toMatch(
      /probeInventoryItemId: autofill\.option\.id,\s*\n\s*probeLotNumber: autofill\.option\.lotNumber,\s*\n\s*probeLotConfirmed: false/,
    );
  });
  it("typing the lot un-confirms it + marks a manual edit (probe switch won't clobber)", () => {
    expect(FORM).toMatch(/probeLotConfirmed: false/);
    expect(FORM).toMatch(/setLotEditedManually\(value\.trim\(\) !== ""\)/);
    expect(FORM).toMatch(/update\("probeLotConfirmed", !draft\.probeLotConfirmed\)/);
  });
  it("the query is studio-scoped, same-probe, and excludes null/blank/deleted", () => {
    expect(RK).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(RK).toMatch(/\.not\("probe_key", "is", null\)/);
    expect(RK).toMatch(/\.not\("probe_lot_number", "is", null\)/);
    expect(RK).toMatch(/\.is\("deleted_at", null\)/);
    // Prefer confirmed, then newest.
    expect(RK).toMatch(/\.order\("probe_lot_confirmed", \{ ascending: false \}\)/);
    expect(RK).toMatch(/\.order\("created_at", \{ ascending: false \}\)/);
  });
  it("the action only stores confirmed=true when a lot is present", () => {
    expect(ACTIONS).toMatch(/probe_lot_confirmed:\s*\n?\s*Boolean\(input\.probeLotConfirmed\)/);
  });
});

describe("item 4: energy level lives under Treatment readings (no duplicate)", () => {
  it("has exactly one energy input, after the Treatment readings heading", () => {
    const occurrences = (FORM.match(/Energy level \(EL\)/g) ?? []).length;
    expect(occurrences).toBe(1);
    const readingsAt = FORM.indexOf(
      '<span className="text-sm font-medium">Treatment readings</span>',
    );
    const energyAt = FORM.indexOf("Energy level (EL)");
    expect(readingsAt).toBeGreaterThan(-1);
    expect(energyAt).toBeGreaterThan(readingsAt);
  });
});

describe("item 5: OmniBlend reading layout", () => {
  it("is OmniBlend-specific and reorders galvanic before thermolysis", () => {
    expect(FORM).toMatch(/const isOmniblend = draft\.apilusModality === "Omniblend"/);
    expect(FORM).toMatch(/isOmniblend \? \(\s*<>\s*\{galvSection\}\s*\{thermoSection\}/);
  });
  it("hides thermolysis duration and galvanic intensity for OmniBlend", () => {
    // both fields are guarded by !isOmniblend
    expect((FORM.match(/\{!isOmniblend && \(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(FORM).toMatch(/!isOmniblend && \([\s\S]*Thermolysis duration/);
    expect(FORM).toMatch(/!isOmniblend && \([\s\S]*Galvanic intensity/);
  });
  it("does not change other modalities (no apilus_modality gating beyond OmniBlend)", () => {
    const matches = FORM.match(/draft\.apilusModality === "[A-Za-z]+"/g) ?? [];
    expect(matches).toEqual(['draft.apilusModality === "Omniblend"']);
  });
  it("switching to OmniBlend clears any typed thermolysis-duration / galvanic-intensity (no hidden persisted reading)", () => {
    expect(FORM).toMatch(
      /next === "Omniblend"\s*\?\s*\{ thermolysisDurationSeconds: "", galvanicIntensityPercent: "" \}/,
    );
  });
});

describe("item 6: tolerance is label-based, storage unchanged", () => {
  it("renders TOLERANCE_OPTIONS labels, not a raw 1-5 grid", () => {
    expect(FORM).toMatch(/TOLERANCE_OPTIONS\.map/);
    expect(FORM).not.toMatch(/\["1", "2", "3", "4", "5"\]\.map/);
  });
  it("still stores the numeric tolerance_rating", () => {
    expect(FORM).toMatch(/toleranceRating: draft\.toleranceRating/);
  });
});

describe("item 7: observation chips toggle (structural, migration 0108)", () => {
  it("chips are structured toggles on observationChips (superseding the text/token approach)", () => {
    // Migration 0108: chips are explicit structured state, not re-derived from
    // the free-text `comments` string — so a selected chip can never silently
    // drop. See tests/app/sessions/observation-chips-structured.test.ts.
    expect(FORM).toMatch(/toggleChip\(draft\.observationChips, c\)/);
    expect(FORM).toMatch(/isChipSelected\(draft\.observationChips, c\)/);
    expect(FORM).not.toMatch(/appendComment\(/);
    expect(FORM).not.toMatch(/toggleComment\(|isCommentSelected\(/);
  });
  it("reaction chips are single-select toggles (No visible reaction handled)", () => {
    expect(FORM).toMatch(/draft\.reactionType === r \? "" : r/);
  });
});
