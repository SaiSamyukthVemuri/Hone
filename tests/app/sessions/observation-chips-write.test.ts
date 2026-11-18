import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Emergency chip-loading fix — source pins for the simplified form's handling of
// an unverified save result and the edit form's legacy seed. Chip behavior is proven by the pure-function tests
// (observation-chips-loading) + DB persistence + browser E2E.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("SimplifiedEntryForm save-result handling", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx");
  it("switches on the discriminated result and BLOCKS blind retry on unverified", () => {
    // ok → reset; unverified → recovery lock (no auto-resubmit → no duplicate entry).
    expect(src).toMatch(/if \(res\.ok\)/);
    expect(src).toMatch(/res\.code === "unverified"/);
    expect(src).toMatch(/setRecovery\(/);
    // The save button is disabled and submit() short-circuits while in recovery.
    expect(src).toMatch(/disabled=\{pending \|\| recovery !== null\}/);
    expect(src).toMatch(/if \(recovery\) return;/);
  });
});

describe("block-setup-form preloads legacy chips as SELECTED controls (Chloe's edit surface)", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
  it("seeds observationChips via the shared resolveDisplayChips contract (structured OR legacy-from-comments), folding a legacy reaction in", () => {
    expect(src).toMatch(/resolveDisplayChips\(firstEntry\?\.observation_chips, firstEntry\?\.comments\)/);
    // Charting unification: the seed folds a legacy reaction_type into the chips
    // (shown as selected), still non-destructively.
    expect(src).toMatch(/observationChips: mergeReactionIntoChips\(hydrated\.chips, block\.reaction_type\)/);
    expect(src).toMatch(/comments: hydrated\.freeText/);
  });
});
