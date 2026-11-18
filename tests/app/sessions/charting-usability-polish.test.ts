import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chloe charting-usability polish (no-migration UI PR). Source-guards for the
// unified observations box; the live browser behaviour is proven in
// e2e/charting-usability-polish.spec.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const FORM = read(`${BASE}/block-setup-form.tsx`);

describe("B. one unified observations & skin response box (charting unification)", () => {
  it("(#8) legacy reaction notes are preserved (render-if-present + round-trip)", () => {
    expect(FORM).toMatch(/\{draft\.reactionNotes\.trim\(\) !== "" && \(/);
    expect(FORM).toMatch(/reactionNotes: draft\.reactionNotes\.trim\(\) \|\| null/);
  });

  it("the payload folds reaction into the chips but never invents/loses a reaction_type", () => {
    // observationChips is the single multi-select store sent on save.
    expect(FORM).toMatch(/observationChips: draft\.observationChips/);
    // Charting unification: reaction_type is no longer a blindly round-tripped
    // separate field (`reactionType: draft.reactionType || null`). It is preserved
    // ONLY while its label chip stays selected, else null — never invented from chips.
    expect(FORM).not.toMatch(/reactionType: draft\.reactionType \|\| null/);
    expect(FORM).toMatch(/reactionType:\s*\n?\s*draft\.reactionType &&/);
    expect(FORM).toMatch(/isReactionType\(draft\.reactionType\) &&/);
    expect(FORM).toMatch(
      /isChipSelected\([\s\S]{0,60}reactionTypeLabel\(draft\.reactionType as ReactionType\)/,
    );
    expect(FORM).toMatch(/\? draft\.reactionType\s*\n?\s*: null/);
  });
});
