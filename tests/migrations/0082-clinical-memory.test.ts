import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Migration 0082 (applied, frozen) CHECK-constrains the reaction vocabulary.
// This pins the live TypeScript enum to the values the database accepts.

const MIGRATION = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/0082_clinical_memory.sql"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}
const SQL = codeOnly(MIGRATION);

describe("0082: reaction vocabulary", () => {
  it("reaction vocabulary matches lib/sessions/clinical-response.ts", () => {
    const lib = readFileSync(
      path.resolve(__dirname, "../../lib/sessions/clinical-response.ts"),
      "utf8",
    );
    // Charting unification added REACTION_CHIP_LABELS / NOTABLE_REACTION_LABELS to
    // this module, so a whole-file scan for quoted snake_case tokens now also picks
    // up NOTABLE_REACTION_LABELS' members. Scope the extraction to the canonical
    // REACTION_TYPES enum array — the SINGLE source the 0082 CHECK mirrors — so we
    // still verify exactly those 7 values map into the migration's constraint.
    const enumBlock = lib.slice(
      lib.indexOf("export const REACTION_TYPES = ["),
      lib.indexOf("] as const;"),
    );
    const libValues = [...enumBlock.matchAll(/^\s+"([a-z_]+)",$/gm)].map(
      (m) => m[1],
    );
    for (const v of libValues) {
      expect(SQL).toContain(`'${v}'`);
    }
    // The migration enum is UNCHANGED: still exactly these 7 canonical values.
    expect(libValues).toEqual([
      "none",
      "mild_redness",
      "moderate_redness",
      "swelling",
      "sensitivity",
      "irritation",
      "other",
    ]);
    expect(libValues.length).toBe(7);
  });
});
