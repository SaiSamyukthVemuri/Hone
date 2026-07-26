import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Emergency chip-loading fix — source pins for the write + display wiring across
// the electrolysis charting surfaces (the parts a mocked-action test can't cheaply
// exercise). The behavior is proven by the pure-function tests
// (observation-chips-loading) + DB persistence + browser E2E.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("addElectrolysisEntryAction persists + verifies structured chips", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
  it("parses the chip payload via the strict contract (malformed → invalid_input, no insert)", () => {
    expect(src).toMatch(/parseSubmittedChips\(formData\.get\("observation_chips"\)\)/);
    expect(src).toMatch(/code: "invalid_input"/);
  });
  it("writes observation_chips into the entry insert (was previously omitted)", () => {
    expect(src).toMatch(/observation_chips: observationChips/);
  });
  it("verifies via a SEPARATE read by the inserted id, scoped to the session", () => {
    expect(src).toMatch(/\.eq\("id", entryId\)/);
    expect(src).toMatch(/\.eq\("session_id", sessionId\)/);
    expect(src).toMatch(/verifyStoredChips\(/);
  });
  it("a persisted-but-unverified write returns the entryId (no rollback pretense)", () => {
    expect(src).toMatch(/code: "unverified", entryId/);
  });
});

describe("SimplifiedEntryForm uses STRUCTURED chips, not legacy append-to-comments", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx");
  it("toggles structured chips (selectable + deselectable) instead of appendComment", () => {
    expect(src).toMatch(/toggleFindingChip\(draft\.observationChips/);
    expect(src).toMatch(/isChipSelected\(draft\.observationChips/);
    expect(src).toMatch(/aria-pressed=\{selected\}/);
    expect(src).not.toMatch(/appendComment/); // legacy behavior removed
  });
  it("sends observation_chips as JSON, separate from the free-text notes", () => {
    expect(src).toMatch(/fd\.set\("observation_chips", JSON\.stringify\(draft\.observationChips\)\)/);
  });
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
  it("renders each chip as a toggle that reflects selection (aria-pressed) + persists on save", () => {
    expect(src).toMatch(/isChipSelected\(draft\.observationChips/);
    expect(src).toMatch(/toggleFindingChip\(draft\.observationChips/);
    expect(src).toMatch(/aria-pressed=\{selected\}/);
    // The block save action already persists observation_chips (updateTreatmentAreaWithEntryAction).
    expect(src).toMatch(/observationChips: draft\.observationChips/);
  });
});

describe("entry-row renders chips from structured OR legacy comments (display fix)", () => {
  const src = read("components/entry-row.tsx");
  it("resolves display chips via resolveDisplayChips (hydrates legacy rows)", () => {
    expect(src).toMatch(/resolveDisplayChips\(entry\.observation_chips, entry\.comments\)/);
    expect(src).toMatch(/ObservationChips chips=\{display\.chips\}/);
    // The note shows the chip-stripped free-text, never the raw comment for legacy rows.
    expect(src).toMatch(/\{display\.note\}/);
  });
});
