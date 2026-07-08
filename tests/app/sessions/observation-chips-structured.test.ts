import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Structured observation chips (migration 0108). vitest env is "node" (no DOM),
// so the UI/save wiring is verified by source pins. The behavioral guarantees
// (multi-select persists, deselect removes, hydrate is non-destructive) are unit
// tested in tests/lib/observation-chips.test.ts; the DB contract in
// tests/db/observation-chips.db.test.ts.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
const ROW = read("components/entry-row.tsx");
const EXPORT = read("app/(app)/settings/data/actions.ts");

describe("block-setup-form — chips are STRUCTURAL state, not derived from text", () => {
  it("chip buttons read/write observationChips via the structured helpers", () => {
    expect(FORM).toMatch(/isChipSelected\(draft\.observationChips, c\)/);
    expect(FORM).toMatch(/toggleChip\(draft\.observationChips, c\)/);
    // The old string/token approach must be gone from this form.
    expect(FORM).not.toMatch(/isCommentSelected|toggleComment/);
  });
  it("draft carries observationChips separately from the free-text comments box", () => {
    expect(FORM).toMatch(/observationChips: string\[\]/);
    expect(FORM).toMatch(/value=\{draft\.comments\}/); // textarea = free-text only
    expect(FORM).toMatch(/observationChips: draft\.observationChips/); // in save payload
  });
  it("edit-load hydrates legacy chip-in-comments records non-destructively", () => {
    expect(FORM).toMatch(/normalizeChips\(firstEntry\?\.observation_chips\)/);
    expect(FORM).toMatch(/hydrateLegacyChips\(firstEntry\?\.comments\)/);
    expect(FORM).toMatch(/comments: hydrated\.freeText/);
    expect(FORM).toMatch(/observationChips: hydrated\.chips/);
  });
});

describe("block-actions — persists chips structurally + preserves comments", () => {
  it("EntryReadingsInput carries observationChips and normalizedChips writes them", () => {
    expect(ACTIONS).toMatch(/observationChips\?: string\[\] \| null/);
    expect(ACTIONS).toMatch(/function normalizedChips\(r: EntryReadingsInput\): string\[\]/);
    expect(ACTIONS).toMatch(/normalizeChips\(r\.observationChips\)/);
  });
  it("every electrolysis_entries write sets observation_chips ALONGSIDE comments", () => {
    const commentsWrites = ACTIONS.match(/comments: normalizedComments\(readings\),/g) ?? [];
    const chipWrites = ACTIONS.match(/observation_chips: normalizedChips\(readings\),/g) ?? [];
    expect(commentsWrites.length).toBe(3); // 2 inserts + 1 update
    expect(chipWrites.length).toBe(3); // chips written at every site — none missed
  });
  it("chips count toward 'a reading was entered'", () => {
    expect(ACTIONS).toMatch(/Array\.isArray\(r\.observationChips\) && r\.observationChips\.length > 0/);
  });
});

describe("entry-row — chips render as their own pills; legacy rows unaffected", () => {
  it("renders an ObservationChips block driven by normalizeChips", () => {
    expect(ROW).toMatch(/function ObservationChips/);
    expect(ROW).toMatch(/normalizeChips\(entry\.observation_chips\)/);
    expect(ROW).toMatch(/if \(chips\.length === 0\) return null/); // empty → nothing (no double display)
  });
  it("appears in BOTH the readings variant and the full variant", () => {
    expect(ROW.match(/<ObservationChips entry=\{entry\} \/>/g)?.length).toBe(2);
  });
});

describe("data export — record-keeping includes structured chips", () => {
  it("selects, flattens, and columns observation_chips (comments still exported separately)", () => {
    expect(EXPORT).toMatch(/comments, observation_chips, created_at/); // in the SELECT
    expect(EXPORT).toMatch(/observation_chips: Array\.isArray\(e\.observation_chips\)/); // flattened
    expect(EXPORT).toMatch(/"observation_chips",/); // CSV header
    expect(EXPORT).toMatch(/structured observation chips/); // README copy
  });
});
