import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Emergency chip-loading fix — source pins for the write + display wiring across
// the electrolysis charting surfaces (the parts a mocked-action test can't cheaply
// exercise). The behavior is proven by the pure-function tests
// (observation-chips-loading) + DB persistence + browser E2E.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("addElectrolysisEntryAction persists structured chips", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
  it("parses the observation_chips form field and normalizes it", () => {
    expect(src).toMatch(/formData\.get\("observation_chips"\)/);
    expect(src).toMatch(/normalizeChips\(parsedChips\)/);
  });
  it("writes observation_chips into the entry insert (was previously omitted)", () => {
    expect(src).toMatch(/observation_chips: observationChips/);
  });
});

describe("SimplifiedEntryForm uses STRUCTURED chips, not legacy append-to-comments", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx");
  it("toggles structured chips (selectable + deselectable) instead of appendComment", () => {
    expect(src).toMatch(/toggleChip\(draft\.observationChips/);
    expect(src).toMatch(/isChipSelected\(draft\.observationChips/);
    expect(src).toMatch(/aria-pressed=\{selected\}/);
    expect(src).not.toMatch(/appendComment/); // legacy behavior removed
  });
  it("sends observation_chips as JSON, separate from the free-text notes", () => {
    expect(src).toMatch(/fd\.set\("observation_chips", JSON\.stringify\(draft\.observationChips\)\)/);
  });
});

describe("block-setup-form preloads legacy chips as SELECTED controls (Chloe's edit surface)", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
  it("seeds observationChips via the shared resolveDisplayChips contract (structured OR legacy-from-comments)", () => {
    expect(src).toMatch(/resolveDisplayChips\(firstEntry\?\.observation_chips, firstEntry\?\.comments\)/);
    expect(src).toMatch(/observationChips: hydrated\.chips/);
    expect(src).toMatch(/comments: hydrated\.freeText/);
  });
  it("renders each chip as a toggle that reflects selection (aria-pressed) + persists on save", () => {
    expect(src).toMatch(/isChipSelected\(draft\.observationChips/);
    expect(src).toMatch(/toggleChip\(draft\.observationChips/);
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
