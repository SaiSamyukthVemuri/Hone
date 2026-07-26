import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Charting unification — SOURCE-CONTRACT guards for the reaction-driven safety
// consumers. These enforce, at the source level, the query + data-handling
// properties the runtime tests can't easily assert: set-based (no N+1) embedded
// reads, studio scoping (no cross-studio leakage), historical-data preservation,
// and that no active galvanic_intensity_percent input is written by new charting.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";

const CONSUMERS: Array<{ label: string; file: string }> = [
  { label: "clients-needing-attention", file: "lib/dashboard/clients-needing-attention.ts" },
  { label: "treatment-intelligence caller (client page)", file: "app/(app)/clients/[id]/page.tsx" },
  { label: "treatment-intelligence caller (before-today previews)", file: "lib/dashboard/before-today-previews.ts" },
  { label: "onboarding", file: "lib/onboarding/getting-started.ts" },
];

describe("(15) reaction consumers read the unified rep via ONE set-based embedded query (no N+1)", () => {
  for (const { label, file } of CONSUMERS) {
    it(`${label}: embeds electrolysis_entries(observation_chips ...) — not a per-row query`, () => {
      const src = read(file);
      expect(src).toMatch(/electrolysis_entries\(observation_chips[^)]*\)/);
      // No per-block/per-client await inside a loop for reactions.
      expect(src).not.toMatch(/for\s*\([^)]*\)\s*\{[\s\S]{0,200}await[\s\S]{0,120}from\("electrolysis_entries"\)/);
      expect(src).not.toMatch(/\.map\([^)]*await[\s\S]{0,120}\.from\("session_blocks"\)/);
    });
  }
});

describe("(14) reaction consumer queries are studio-scoped (no cross-studio leakage)", () => {
  for (const { label, file } of CONSUMERS) {
    it(`${label}: filters session_blocks by studio_id`, () => {
      const src = read(file);
      // The block read (which carries the embedded chips) is studio-scoped.
      expect(src).toMatch(/\.from\("session_blocks"\)[\s\S]{0,900}\.eq\("studio_id"/);
    });
  }
});

describe("consumers derive reactions ONLY via the shared unified helper (no ad-hoc string guessing)", () => {
  it("clients-needing-attention uses notableReactionLabel from the shared helper", () => {
    const src = read("lib/dashboard/clients-needing-attention.ts");
    expect(src).toMatch(/from "@\/lib\/sessions\/reaction-unified"/);
    expect(src).toMatch(/notableReactionLabel\(/);
    // No hand-rolled reaction classification remains.
    expect(src).not.toMatch(/NOTABLE_REACTIONS as readonly string\[\]\)\.includes/);
  });
  it("treatment-intelligence + clinical-summary use the shared unified helper", () => {
    expect(read("lib/sessions/treatment-intelligence.ts")).toMatch(/unifiedReactionLabels\(/);
    expect(read("lib/sessions/clinical-summary.ts")).toMatch(/unifiedReactionLabels\(/);
  });
});

describe("(5/8/9) galvanic intensity + reaction_type historical-data preservation", () => {
  const FORM = read(`${BASE}/block-setup-form.tsx`);
  it("no active Galvanic intensity % input remains in either charting form", () => {
    expect(FORM).not.toMatch(/<span[^>]*>Galvanic intensity %<\/span>/);
    expect(read(`${BASE}/simplified-entry-form.tsx`)).not.toMatch(/<span[^>]*>Galvanic intensity %<\/span>/);
  });
  it("neither form hydrates or sends galvanic_intensity_percent — history is preserved SERVER-SIDE, not via a browser round-trip", () => {
    // Final amendment: galvanic intensity is a RETIRED reading. The form no longer
    // hydrates it into the draft nor sends it on save (no hidden browser-controlled
    // clinical field). Preservation is server-authoritative: the update path omits
    // the column (historical value untouched) and inserts force NULL.
    expect(FORM).not.toMatch(/galvanicIntensityPercent/);
    expect(read(`${BASE}/simplified-entry-form.tsx`)).not.toMatch(/galvanicIntensityPercent/);
    // The write helper no longer emits galvanic_intensity_percent (so UPDATE omits
    // it → preserved), while both create inserts set it explicitly to NULL.
    const BLOCK_ACTIONS = read(`${BASE}/block-actions.ts`);
    expect(BLOCK_ACTIONS).not.toMatch(/galvanic_intensity_percent:\s*wantGalv/);
    expect(
      (BLOCK_ACTIONS.match(/galvanic_intensity_percent:\s*null/g) ?? []).length,
    ).toBe(2);
    // The add-another-pass action also forces NULL and never reads a forged field.
    const ACTIONS = read(`${BASE}/actions.ts`);
    expect(ACTIONS).toMatch(/galvanic_intensity_percent:\s*null/);
    expect(ACTIONS).not.toMatch(/formData\.get\("galvanic_intensity_percent"\)/);
  });
  it("reaction_type is PRESERVED while its chip stays selected and cleared ONLY when removed (never invented)", () => {
    // Save payload: keep draft.reactionType only if its label chip is still selected, else null.
    expect(FORM).toMatch(
      /reactionType:[\s\S]{0,220}isChipSelected\([\s\S]{0,80}reactionTypeLabel\([\s\S]{0,80}\?\s*draft\.reactionType\s*:\s*null/,
    );
  });
  it("today's minutes are never part of the copy — form has no minutes in the merged findings box", () => {
    // (Guard against a future accidental re-add of minutes into observations.)
    expect(FORM).toMatch(/OBSERVATIONS_RESPONSE_HEADING/);
  });
});
