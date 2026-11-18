import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Charting unification — SOURCE-CONTRACT guards for the reaction-driven safety
// consumers. These enforce, at the source level, the query + data-handling
// properties the runtime tests can't easily assert: set-based (no N+1) embedded
// reads, studio scoping (no cross-studio leakage), and the shared reaction helper.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

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
