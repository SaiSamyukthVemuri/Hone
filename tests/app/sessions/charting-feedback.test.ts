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
  it("the saved record shows the numbing line via the shared presenter (0156)", () => {
    // Charting: the numbing status + optional note now render through the shared
    // numbingDisplay() presenter (so the label + note can't drift across surfaces).
    expect(VIEW).toMatch(/numbingDisplay\(\s*block\.numbing_status,\s*block\.numbing_notes/);
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
    // Truthful provenance copy now lives with the resolver that produces it,
    // so the string and its branch cannot drift apart.
    const AUTOFILL = readFileSync(
      join(process.cwd(), "lib/record-keeping/probe-lot-autofill.ts"),
      "utf8",
    );
    expect(AUTOFILL).toMatch(/Auto-filled from your last confirmed inventory lot/);
    expect(AUTOFILL).toMatch(/Only active inventory lot for this probe/);
    // The history fallback that makes auto-fill work for a studio with no
    // probe inventory at all.
    expect(AUTOFILL).toMatch(/Auto-filled from your last charted lot for this probe, not linked to inventory/);
    expect(FORM).toMatch(/probeLotSourceMessage\(lotStatus\)/);
    expect(FORM).toMatch(/Confirm lot\/batch/);
    // Old copy is gone.
    expect(FORM).not.toMatch(/Suggested from records/);
    expect(FORM).not.toMatch(/Suggested from last probe lot/);
  });
  it("auto-fills inventory FIRST, then recorded charting, always unconfirmed", () => {
    // The reactive effect now delegates the whole precedence to one composed
    // resolver. Inventory still wins; the recorded-charting fallback is what
    // makes auto-fill work at all for a studio with no probe inventory, the
    // shape that made this fail on every appointment.
    expect(FORM).toMatch(/resolveProbeLotAutofill\(\{/);
    expect(FORM).not.toMatch(/resolveInventoryAutofill\(/);
    // The auto-fill rule lives in the shared pure module.
    expect(SUGG).toMatch(/suggestions\.byKey\[probeKey\]/); // still exposes byKey
    expect(FORM).toMatch(/if \(draft\.probeKey === lotOwnerProbeKey\) return;/);
    expect(FORM).toMatch(/const patch = probeLotDraftPatch\(result\);/);
    const AUTOFILL = readFileSync(
      join(process.cwd(), "lib/record-keeping/probe-lot-autofill.ts"),
      "utf8",
    );
    // Inventory results link; history results never do.
    expect(AUTOFILL).toMatch(/probeInventoryItemId: result\.option\.id,/);
    expect(AUTOFILL).toMatch(/probeLotNumber: result\.lotNumber,\s*\n\s*probeInventoryItemId: null,/);
    expect(AUTOFILL).not.toMatch(/probeLotConfirmed: true/);
  });
  it("typing the lot un-confirms it + binds the value to the CURRENT probe", () => {
    expect(FORM).toMatch(/probeLotConfirmed: false/);
    // A typed lot belongs to the probe selected when it was typed: it survives
    // re-renders for that probe, and a probe switch drops it (a lot is
    // probe-specific, it must never follow the practitioner to another probe).
    expect(FORM).toMatch(/setLotOwnerProbeKey\(draft\.probeKey\);/);
    expect(FORM).not.toMatch(/lotEditedManually/);
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
  it("galvanic precedes thermolysis for EVERY mode, not only OmniBlend", () => {
    // Machine order (Chloe): she reads the Apilus top-to-bottom, and the
    // galvanic group is above thermolysis on every blend modality, PicoBlend,
    // OmniBlend, MultiBlend, EvoluBlend, SynchroBlend. The old code branched the
    // ORDER on OmniBlend alone; that conditional is gone.
    expect(FORM).toMatch(/const isOmniblend = draft\.apilusModality === "Omniblend"/);
    expect(FORM).toMatch(/\{galvSection\}\s*\n\s*\{thermoSection\}/);
    expect(FORM).not.toMatch(/isOmniblend \? \(\s*<>\s*\{galvSection\}/);
    expect(FORM).not.toMatch(/\{thermoSection\}\s*\n\s*\{galvSection\}/);
  });
  it("hides thermolysis duration for OmniBlend; galvanic intensity is no longer a visible input at all", () => {
    // OmniBlend has no thermolysis duration, still gated behind !isOmniblend.
    expect(FORM).toMatch(/\{!isOmniblend && \(/);
    expect(FORM).toMatch(/!isOmniblend && \([\s\S]{0,400}Thermolysis duration/);
    // Charting correction: the galvanic intensity % INPUT was removed for EVERY
    // mode (not merely hidden for OmniBlend), so there is no rendered
    // "Galvanic intensity %" field/label.
    expect(FORM).not.toMatch(/<span[^>]*>Galvanic intensity %<\/span>/);
    // Final amendment: galvanic intensity is a RETIRED reading, the form no longer
    // hydrates it or sends it in the save payload (no browser round-trip of a
    // clinical value). Historical values are preserved SERVER-SIDE (the update
    // omits the column). So neither the hydrate nor the payload key exists here.
    expect(FORM).not.toMatch(/galvanicIntensityPercent/);
  });
  it("does not change other modalities (no apilus_modality gating beyond OmniBlend)", () => {
    const matches = FORM.match(/draft\.apilusModality === "[A-Za-z]+"/g) ?? [];
    expect(matches).toEqual(['draft.apilusModality === "Omniblend"']);
  });
  it("switching to OmniBlend clears any typed thermolysis-duration (no hidden persisted reading)", () => {
    // Galvanic intensity is retired everywhere, so only thermolysis duration is
    // cleared on the OmniBlend switch (no galvanicIntensityPercent key remains).
    expect(FORM).toMatch(
      /next === "Omniblend"\s*\?\s*\{ thermolysisDurationSeconds: "" \}/,
    );
    expect(FORM).not.toMatch(/galvanicIntensityPercent: ""/);
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
    // the free-text `comments` string, so a selected chip can never silently
    // drop. See tests/app/sessions/observation-chips-structured.test.ts.
    expect(FORM).toMatch(/toggleFindingChip\(draft\.observationChips, c\)/);
    expect(FORM).toMatch(/isChipSelected\(draft\.observationChips, c\)/);
    expect(FORM).not.toMatch(/appendComment\(/);
    expect(FORM).not.toMatch(/toggleComment\(|isCommentSelected\(/);
  });
  it("reaction labels are merged multi-select chips, not a separate single-select row", () => {
    // Charting unification: the reaction is no longer a single-select toggle
    // (`draft.reactionType === r ? "" : r`). Reaction labels are part of the
    // merged multi-select chip vocabulary and toggle exactly like observation
    // chips (via observationChips).
    expect(FORM).not.toMatch(/draft\.reactionType === r \? "" : r/);
    expect(FORM).not.toMatch(/REACTION_TYPES\.map/);
    expect(FORM).toMatch(/MERGED_OBSERVATION_CHIPS\.map/);
    expect(FORM).toMatch(/toggleFindingChip\(draft\.observationChips, c\)/);
    // A legacy reaction_type is preserved ONLY while its label chip stays selected
    // (never invented from chips); otherwise it saves as null.
    expect(FORM).toMatch(
      /isChipSelected\([\s\S]{0,60}reactionTypeLabel\(draft\.reactionType as ReactionType\)/,
    );
    expect(FORM).toMatch(/\? draft\.reactionType\s*\n?\s*: null/);
  });
});
