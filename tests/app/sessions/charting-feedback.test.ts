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
  it("suggests the most-recent lot per probe (keyed + label fallback), never auto-confirms", () => {
    // Reliability update: the page passes richer suggestions (byKey + byLabel,
    // each with a confirmed flag); the form auto-populates per selected probe.
    expect(RK).toMatch(/getProbeLotSuggestions/);
    expect(PAGE).toMatch(/getProbeLotSuggestions/);
    expect(FORM).toMatch(/probeLotSuggestions/);
    // Confirmed-aware helper copy.
    expect(FORM).toMatch(
      /Auto-filled from last confirmed probe lot\. Please confirm this lot\/batch is correct\./,
    );
    expect(FORM).toMatch(
      /Suggested from last probe lot\. Please confirm this lot\/batch is correct\./,
    );
    expect(FORM).toMatch(/Confirm lot\/batch/);
    // Old copy is gone.
    expect(FORM).not.toMatch(/Suggested from records/);
    expect(FORM).not.toMatch(/Suggested from last use/);
  });
  it("auto-populates from the keyed-then-label suggestion, always unconfirmed", () => {
    // The reactive effect keys off the resolved suggestion (keyed first, then
    // normalized-label fallback) and writes it unconfirmed; it never runs once
    // the practitioner has edited manually.
    expect(FORM).toMatch(/resolveProbeLotSuggestion\(draft\.probeKey, probeLotSuggestions\)/);
    // The keyed-then-label resolution lives in the shared pure module.
    expect(SUGG).toMatch(/suggestions\.byKey\[probeKey\]/);
    expect(SUGG).toMatch(/suggestions\.byLabel\[normalizeProbeLabel\(opt\.displayLabel\)\]/);
    expect(FORM).toMatch(/if \(lotEditedManually\) return;/);
    expect(FORM).toMatch(
      /probeLotNumber: suggestion,\s*\n?\s*probeLotConfirmed: false/,
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

describe("item 7: observation chips toggle and reflect in the notes", () => {
  it("uses toggleComment/isCommentSelected (not append-only)", () => {
    expect(FORM).toMatch(/toggleComment\(draft\.comments, c\)/);
    expect(FORM).toMatch(/isCommentSelected\(draft\.comments, c\)/);
    expect(FORM).not.toMatch(/appendComment\(/);
  });
  it("reaction chips are single-select toggles (No visible reaction handled)", () => {
    expect(FORM).toMatch(/draft\.reactionType === r \? "" : r/);
  });
});
