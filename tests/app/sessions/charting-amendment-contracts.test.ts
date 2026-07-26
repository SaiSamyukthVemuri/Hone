import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase A amendment — source contracts for the SimplifiedEntryForm parity, the
// PicoBlend precision steps, and the historical galvanic-intensity display
// policy. These would have FAILED at head 324070b (before the amendment). Real
// value round-trip is covered by the browser test (picoblend-precision.spec.ts).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const SIMPLE = read(`${BASE}/simplified-entry-form.tsx`);
const FORM = read(`${BASE}/block-setup-form.tsx`);
const ENTRY_ROW = read("components/entry-row.tsx");

describe("SimplifiedEntryForm parity with BlockSetupForm (Chloe)", () => {
  it("(1) labels the pulse control exactly 'Thermolysis pulse count'", () => {
    expect(SIMPLE).toMatch(/>Thermolysis pulse count</);
    expect(SIMPLE).not.toMatch(/>Pulse count</); // old standalone label gone
  });

  it("(2) the pulse control is structurally INSIDE the thermolysis section", () => {
    // The thermolysis section is gated on thermo/blend; the pulse control appears
    // between the thermolysis readings and the galvanic section.
    const thermoStart = SIMPLE.indexOf('block.mode === "thermo" || block.mode === "blend"');
    const galvStart = SIMPLE.indexOf('block.mode === "galv" || block.mode === "blend"');
    const pulse = SIMPLE.indexOf("Thermolysis pulse count");
    expect(thermoStart).toBeGreaterThan(-1);
    expect(pulse).toBeGreaterThan(thermoStart);
    expect(pulse).toBeLessThan(galvStart);
  });

  it("(3) no standalone `mode !== \"galv\"` pulse section remains", () => {
    expect(SIMPLE).not.toMatch(/block\.mode !== "galv" && \(/);
  });

  it("(4) uses the unified heading + helper, with no separate reaction section", () => {
    expect(SIMPLE).toMatch(/\{OBSERVATIONS_RESPONSE_HEADING\}/);
    expect(SIMPLE).toMatch(/\{OBSERVATIONS_RESPONSE_HELPER\}/);
    expect(SIMPLE).not.toMatch(/TREATMENT_OBSERVATIONS_HEADING|CLIENT_RESPONSE_HEADING/);
    expect(SIMPLE).not.toMatch(/REACTION_TYPES\.map/);
  });

  it("(5) Additional notes is large: rows={8} + min-h-[12rem], resizable, full-width", () => {
    const notes = SIMPLE.slice(SIMPLE.indexOf("ADDITIONAL_NOTES_HEADING"));
    expect(notes).toMatch(/rows=\{8\}/);
    expect(notes).toMatch(/min-h-\[12rem\]/);
    expect(notes).toMatch(/resize-y/);
    expect(notes).toMatch(/w-full/);
  });
});

describe("PicoBlend precision — native input constraints accept the exact values", () => {
  it("(6) galvanic mA uses step='0.01' in BOTH forms (accepts 0.74)", () => {
    expect(FORM).toMatch(/Galvanic mA[\s\S]{0,200}?step="0\.01"/);
    expect(SIMPLE).toMatch(/Galvanic mA[\s\S]{0,200}?step="0\.01"/);
  });
  it("(7) thermolysis duration uses step='0.001' in BOTH forms (accepts 0.733)", () => {
    expect(FORM).toMatch(/Thermolysis duration \(s\)[\s\S]{0,300}?step="0\.001"/);
    expect(SIMPLE).toMatch(/Thermolysis duration \(s\)[\s\S]{0,300}?step="0\.001"/);
  });

  it("(7b) the simplified-form server action parses fractional readings as DECIMALS (not parseInt), so 0.733 / 0.74 never truncate", () => {
    const ACTIONS = read(`${BASE}/actions.ts`);
    // Would fail if reverted to pickInteger (parseInt truncates 0.733 → 0).
    expect(ACTIONS).toMatch(
      /thermolysisDurationSeconds\s*=\s*wantThermo\s*\?\s*nonNegNumber\(formData\.get\("thermolysis_duration_seconds"\)\)/,
    );
    expect(ACTIONS).toMatch(/nonNegNumber\(formData\.get\("galvanic_ma"\)\)/);
    expect(ACTIONS).not.toMatch(/pickInteger\(formData\.get\("thermolysis_duration_seconds"\)/);
  });
});

describe("(9) historical galvanic intensity is not shown as a current galvanic %", () => {
  it("entry-row no longer pushes galvanic_intensity_percent into the Galvanic line", () => {
    expect(ENTRY_ROW).not.toMatch(/galvanicParts\.push\(`\$\{entry\.galvanic_intensity_percent\}%`\)/);
    // (It remains preserved in storage + the raw data export — see rollout runbook.)
  });
  it("neither active form re-introduces a galvanic intensity input", () => {
    expect(FORM).not.toMatch(/<span[^>]*>Galvanic intensity %<\/span>/);
    expect(SIMPLE).not.toMatch(/<span[^>]*>Galvanic intensity %<\/span>/);
  });
});

// Final amendment: galvanic_intensity_percent is a fully RETIRED reading —
// no current UI captures/edits it, the copy path never resurrects it, and the
// server is authoritative (new rows NULL, historical rows preserved by omission).
// The thermolysis duration displays at exact 3-decimal precision. These would
// have FAILED at head 22bbe4a.
describe("(P1-1) galvanic intensity is retired from every current write surface", () => {
  const ACTIONS = read(`${BASE}/actions.ts`);
  const BLOCK_ACTIONS = read(`${BASE}/block-actions.ts`);
  const SNAPSHOT = read("lib/sessions/treatment-setup-snapshot.ts");

  it("(6) no current UI renders, hydrates, or sends the deprecated field", () => {
    // Neither active form references the galvanicIntensityPercent draft identifier
    // at all (no draft field, no hydrate, no payload). (Explanatory comments may
    // still name the retired snake_case column — we assert the CODE plumbing is
    // gone, not that documentation can't mention it.)
    expect(FORM).not.toMatch(/galvanicIntensityPercent/);
    expect(SIMPLE).not.toMatch(/galvanicIntensityPercent/);
    // The simplified form no longer sets the FormData field either.
    expect(SIMPLE).not.toMatch(/fd\.set\("galvanic_intensity_percent"/);
  });

  it("the in-form Copy settings contract never copies galvanic intensity", () => {
    // Not in the reusable field set, the patch type, or the builder.
    expect(SNAPSHOT).not.toMatch(/"galvanic_intensity_percent"/); // ENTRY_SETUP_FIELDS
    expect(SNAPSHOT).not.toMatch(/galvanicIntensityPercent:/); // patch builder key
    expect(SNAPSHOT).toMatch(/galvanic_ma/); // but valid galvanic setup IS copied
    expect(SNAPSHOT).toMatch(/units_of_lye/);
  });

  it("server is authoritative: new entries store NULL; updates omit the column (preserve history)", () => {
    // The shared column helper no longer mode-gates galvanic_intensity_percent
    // (so an UPDATE leaves it untouched); both create inserts force NULL.
    expect(BLOCK_ACTIONS).not.toMatch(/galvanic_intensity_percent:\s*wantGalv/);
    expect(
      (BLOCK_ACTIONS.match(/galvanic_intensity_percent:\s*null/g) ?? []).length,
    ).toBe(2);
    // Add-another-pass insert forces NULL and never reads a forged form field.
    expect(ACTIONS).toMatch(/galvanic_intensity_percent:\s*null/);
    expect(ACTIONS).not.toMatch(/formData\.get\("galvanic_intensity_percent"\)/);
  });
});

describe("(P1-2) thermolysis duration displays at exact 3-decimal precision", () => {
  it("formatSeconds rounds at the 3rd decimal (0.733 stays 0.733, not 0.73)", () => {
    const FMT = read("lib/sessions/format-seconds.ts");
    expect(FMT).toMatch(/Math\.round\(value \* 1000\) \/ 1000/);
    expect(FMT).not.toMatch(/Math\.round\(value \* 100\) \/ 100/);
  });
});
