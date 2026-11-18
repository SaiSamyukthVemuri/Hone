import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase A amendment — source contracts for decimal parsing of PicoBlend
// readings and the retired galvanic-intensity reading. Real value round-trip
// is covered by the browser test (picoblend-precision.spec.ts).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const SIMPLE = read(`${BASE}/simplified-entry-form.tsx`);
const FORM = read(`${BASE}/block-setup-form.tsx`);
const ENTRY_ROW = read("components/entry-row.tsx");

describe("PicoBlend precision — the server action keeps decimals", () => {
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
describe("(P1-1) galvanic intensity is retired from every current write surface", () => {
  const ACTIONS = read(`${BASE}/actions.ts`);
  const BLOCK_ACTIONS = read(`${BASE}/block-actions.ts`);

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

  it("server is authoritative: new entries store NULL; updates omit the column (preserve history)", () => {
    // L18 Phase 2: the retirement moved from the application to the database.
    // `write_electrolysis_entry` (migration 0166) has NO parameter for
    // galvanic_intensity_percent: its INSERT hard-codes NULL and its UPDATE
    // omits the column entirely, so a new row cannot carry a value and a
    // historical one cannot be overwritten — server-authoritative in the
    // strongest sense, since there is no longer an application literal to edit.
    const MIGRATION = read("supabase/migrations/0166_session_block_electrolysis_commands.sql");
    expect(MIGRATION).not.toMatch(/p_galvanic_intensity_percent/);
    expect(MIGRATION).toMatch(/galvanic_intensity_percent/); // named in the INSERT column list
    // Strip comments first: both modules still DOCUMENT the retirement in prose,
    // which is the point — what must be absent is any code that writes it.
    const blockCode = BLOCK_ACTIONS.split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(blockCode).not.toMatch(/galvanic_intensity_percent/);
    expect(ACTIONS).not.toMatch(/formData\.get\("galvanic_intensity_percent"\)/);
    expect(ACTIONS).not.toMatch(/p_galvanic_intensity_percent/);
  });
});
