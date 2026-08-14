import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #162. Chloe's charting feedback: the thermolysis settings
// should match the order on her machine and her charting workflow:
//   Duration -> Intensity -> Pulse count.
//
// Before PR #162 the rendered JSX in block-setup-form.tsx put
// Intensity before Duration inside the thermolysis block. We pin
// the order textually so a future refactor that swaps the inputs
// back is caught by `npm test`.

const FORM_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const SOURCE = readFileSync(FORM_PATH, "utf8");

// Helper: return the source-character offset of the first occurrence
// of a substring inside a sliced range. Throws if not found.
function findOrThrow(haystack: string, needle: string, label: string): number {
  const idx = haystack.indexOf(needle);
  if (idx === -1) throw new Error(`Expected to find '${needle}' (${label})`);
  return idx;
}

describe("thermolysis input order in block-setup-form.tsx", () => {
  // The thermolysis block is rendered inside the (mode === 'thermo' ||
  // mode === 'blend') branch. Isolating it via JSX brace-matching is
  // brittle; instead we slice the source between the thermo branch
  // opener and the next-sibling galv branch opener. That window
  // contains exactly the thermolysis labels we care about and ends
  // before any Galvanic copy can leak in.
  // PR #279 refactor: the thermolysis/galvanic fields are now built as the
  // `thermoSection` / `galvSection` consts before the return (so OmniBlend can
  // reorder them). Slice between the two const definitions to isolate thermo.
  const thermoOpenIdx = SOURCE.indexOf("const thermoSection =");
  const galvOpenIdx = SOURCE.indexOf("const galvSection =");
  if (thermoOpenIdx === -1 || galvOpenIdx === -1) {
    throw new Error(
      "Could not isolate the thermolysis section (thermoSection/galvSection const missing).",
    );
  }
  if (galvOpenIdx <= thermoOpenIdx) {
    throw new Error(
      "Expected galvSection to be defined AFTER thermoSection in source order.",
    );
  }
  const thermoBlock = SOURCE.slice(thermoOpenIdx, galvOpenIdx);

  it("renders the Thermolysis duration label BEFORE the Thermolysis intensity label", () => {
    const durationIdx = findOrThrow(
      thermoBlock,
      "Thermolysis duration",
      "duration label",
    );
    const intensityIdx = findOrThrow(
      thermoBlock,
      "Thermolysis intensity",
      "intensity label",
    );
    expect(durationIdx).toBeLessThan(intensityIdx);
  });

  it("the rendered inputs bind to the unchanged persisted field names", () => {
    // Even after the swap, the input value/onChange must still bind
    // to the same draft keys, which map 1:1 to the canonical column
    // names (thermolysis_duration_seconds /
    // thermolysis_intensity_percent). Pin both so a future rename
    // would be caught here as well.
    expect(thermoBlock).toMatch(/value=\{draft\.thermolysisDurationSeconds\}/);
    expect(thermoBlock).toMatch(/value=\{draft\.thermolysisIntensityPercent\}/);
    expect(thermoBlock).toMatch(
      /update\("thermolysisDurationSeconds",/,
    );
    expect(thermoBlock).toMatch(
      /update\("thermolysisIntensityPercent",/,
    );
  });
});

describe("pulse count renders AFTER the thermolysis readings (Duration -> Intensity -> Pulse count)", () => {
  it("Thermolysis pulse count label appears after the second thermolysis input", () => {
    // The two literal label strings ("Thermolysis duration",
    // "Thermolysis intensity") also appear inside the validation
    // array (label: "Thermolysis duration" / "Thermolysis
    // intensity") earlier in the file. Anchor on the rendered JSX
    // shape ">...Thermolysis duration (s)<" / ">...Thermolysis
    // intensity %<" so the validation-array entries do not move
    // the offsets around.
    const formDurationIdx = SOURCE.indexOf("Thermolysis duration (s)");
    const formIntensityIdx = SOURCE.indexOf("Thermolysis intensity %");
    // Charting correction: the pulse control moved INTO the thermolysis section
    // and is now labeled "Thermolysis pulse count" (it is a thermolysis concept).
    // It still renders after duration + intensity.
    const pulseIdx = SOURCE.indexOf(">Thermolysis pulse count<");
    expect(formDurationIdx).toBeGreaterThan(-1);
    expect(formIntensityIdx).toBeGreaterThan(-1);
    expect(pulseIdx).toBeGreaterThan(-1);
    expect(formDurationIdx).toBeLessThan(formIntensityIdx);
    expect(formIntensityIdx).toBeLessThan(pulseIdx);
    // The old generic "Pulse count" label is gone (renamed to the thermolysis one).
    expect(SOURCE.indexOf(">Pulse count<")).toBe(-1);
  });

  it("Thermolysis pulse count is a thermolysis concept (renders inside the thermolysis section, thermo/blend only)", () => {
    // Charting correction: pulse now lives inside thermoSection, which renders
    // only for thermolysis + blend (`mode === "thermo" || mode === "blend"`); pure
    // galvanic has no pulse. This is the clinical equivalent of the old
    // `mode !== "galv"` gate, but scoped to the thermolysis section.
    const thermoOpenIdx = SOURCE.indexOf("const thermoSection =");
    const galvOpenIdx = SOURCE.indexOf("const galvSection =");
    expect(thermoOpenIdx).toBeGreaterThan(-1);
    expect(galvOpenIdx).toBeGreaterThan(thermoOpenIdx);
    const thermoBlock = SOURCE.slice(thermoOpenIdx, galvOpenIdx);
    // The section is gated on thermo/blend, either via the literal condition or
    // the shared resolveModeSections helper (modeSections.showThermo). After the
    // Phase B refresh the charting form and the whole-session copy card share the
    // SAME mode-gating helper, so both forms can never drift.
    expect(thermoBlock).toMatch(
      /mode === "thermo" \|\| mode === "blend"|modeSections\.showThermo/,
    );
    // ...and that shared helper genuinely means thermo/blend (equivalence proof,
    // so accepting the helper form does NOT weaken the gate).
    const MODE_SECTIONS = readFileSync(
      path.resolve(__dirname, "../../../lib/sessions/mode-sections.ts"),
      "utf8",
    );
    expect(MODE_SECTIONS).toMatch(/showThermo:\s*m === "thermo" \|\| m === "blend"/);
    // The pulse-count control lives inside that section.
    expect(thermoBlock).toMatch(/>Thermolysis pulse count</);
    // It is NOT rendered in the galvanic section (pure galvanic has no pulse).
    const galvBlock = SOURCE.slice(
      galvOpenIdx,
      SOURCE.indexOf("\n  return (", galvOpenIdx),
    );
    expect(galvBlock).not.toMatch(/pulse count/i);
    // The old standalone `mode !== "galv"` pulse gate is gone.
    expect(SOURCE).not.toMatch(/\{mode !== "galv" && \(/);
  });
});

// ---------------------------------------------------------------------------
// Galvanic order is left alone by PR #162. The Galvanic block already
// renders Duration before Intensity (lines 736 vs 750 pre-PR-162), and
// the Galvanic mA + Units of lye fields are galvanic-specific
// concepts not covered by Chloe's "Duration -> Intensity -> Pulse
// count" ask. Pin the existing order so a casual reorder does not
// silently regress it.
// ---------------------------------------------------------------------------

describe("galvanic input order (preserved, not changed by PR #162)", () => {
  // Same slice strategy as the thermo branch above: take the source
  // window between the galv branch opener and the next-sibling
  // "Pulse count" branch opener (`mode !== "galv"`). The comment
  // block PR #162 added INSIDE the thermo branch also mentions the
  // `mode !== "galv"` string, so we ask for the FIRST occurrence
  // strictly after the galv opener.
  const galvOpenIdx = SOURCE.indexOf("const galvSection =");
  if (galvOpenIdx === -1) {
    throw new Error("Could not isolate the galvSection const.");
  }
  // galvSection ends at the component's render return.
  const renderIdx = SOURCE.indexOf("\n  return (", galvOpenIdx);
  if (renderIdx === -1) {
    throw new Error("Could not find the component return after galvSection.");
  }
  const galvBlock = SOURCE.slice(galvOpenIdx, renderIdx);

  it("Galvanic duration (s) appears before Galvanic intensity %", () => {
    const durationIdx = galvBlock.indexOf("Galvanic duration");
    const intensityIdx = galvBlock.indexOf("Galvanic intensity");
    expect(durationIdx).toBeGreaterThan(-1);
    expect(intensityIdx).toBeGreaterThan(-1);
    expect(durationIdx).toBeLessThan(intensityIdx);
  });
});

// ---------------------------------------------------------------------------
// Persisted field names are unchanged. Pinning these alongside the
// render-order change makes it obvious in review that this PR is a
// presentation change only.
// ---------------------------------------------------------------------------

describe("persisted field names are unchanged by PR #162", () => {
  it("block-actions.ts still writes thermolysis_duration_seconds + thermolysis_intensity_percent + pulse_count", () => {
    const actions = readFileSync(
      path.resolve(
        __dirname,
        "../../../app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
      ),
      "utf8",
    );
    expect(actions).toMatch(/thermolysis_duration_seconds/);
    expect(actions).toMatch(/thermolysis_intensity_percent/);
    expect(actions).toMatch(/pulse_count/);
  });
});
