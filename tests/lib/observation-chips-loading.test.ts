import { describe, it, expect } from "vitest";
import {
  resolveDisplayChips,
  normalizeChips,
  hydrateLegacyChips,
  toggleChip,
  isChipSelected,
  OBSERVATION_CHIPS,
} from "@/lib/observation-chips";

// Emergency chip-loading fix. Willow's observations were stored in the legacy
// `comments` field (structured observation_chips empty), so the entry-row showed
// no chip pills ("not loading"). resolveDisplayChips is the single display/preload
// contract that renders structured chips OR hydrates legacy chips from comments,
// non-destructively.

const A = "Coarse hair";
const B = "Slight edema";
const C = "Lots of anagen";

describe("regression: the reported chips are canonical + round-trip", () => {
  it("vocabulary contains Coarse hair / Slight edema / Lots of anagen", () => {
    expect(OBSERVATION_CHIPS).toEqual(expect.arrayContaining([A, B, C]));
  });
  it("normalizeChips keeps them and drops unknowns/dupes/casing", () => {
    expect(normalizeChips([A, B, C])).toEqual([A, B, C]);
    expect(normalizeChips(["coarse HAIR", "coarse hair"])).toEqual([A]); // dedup + canonical casing
    expect(normalizeChips([A, "not a chip", 42, null])).toEqual([A]); // unknown/garbage dropped
    expect(normalizeChips(null)).toEqual([]);
    expect(normalizeChips("x")).toEqual([]);
  });
  it("toggle selects then deselects (deselection is possible)", () => {
    let c: string[] = [];
    c = toggleChip(c, A);
    expect(isChipSelected(c, A)).toBe(true);
    c = toggleChip(c, A);
    expect(c).toEqual([]);
  });
});

describe("resolveDisplayChips — structured rows", () => {
  it("shows the structured chips and keeps the full comment as the note", () => {
    const r = resolveDisplayChips([A, B], "tender near jaw");
    expect(r.chips).toEqual([A, B]);
    expect(r.note).toBe("tender near jaw");
  });
});

describe("resolveDisplayChips — LEGACY rows (chips stored in comments)", () => {
  it("hydrates chips from a comma-joined legacy comment; note = chip-stripped free-text", () => {
    const r = resolveDisplayChips([], `${A}, ${B}, ${C}`);
    expect(r.chips).toEqual([A, B, C]);
    expect(r.note).toBe("");
  });
  it("preserves unknown/free-text tokens as the note (nothing dropped)", () => {
    const r = resolveDisplayChips([], `${A}, tender near jaw, ${B}`);
    expect(r.chips).toEqual([A, B]);
    expect(r.note).toBe("tender near jaw");
  });
  it("aliases legacy casing/spacing into the canonical chip", () => {
    const r = resolveDisplayChips([], "  coarse hair ,  SLIGHT EDEMA ");
    expect(r.chips).toEqual([A, B]);
  });
  it("a pure free-text note yields no chips and the note verbatim", () => {
    const r = resolveDisplayChips([], "client anxious, rebooked");
    // 'client anxious' and 'rebooked' are not chips → stay in the note.
    expect(r.chips).toEqual([]);
    expect(r.note).toBe("client anxious, rebooked");
  });
  it("null/empty are safe", () => {
    expect(resolveDisplayChips(null, null)).toEqual({ chips: [], note: "" });
    expect(resolveDisplayChips([], "")).toEqual({ chips: [], note: "" });
  });
  it("matches hydrateLegacyChips (same underlying split) for legacy input", () => {
    const legacy = `${A}, note here`;
    const h = hydrateLegacyChips(legacy);
    const d = resolveDisplayChips([], legacy);
    expect(d.chips).toEqual(h.chips);
    expect(d.note).toBe(h.freeText);
  });
});
