import { describe, it, expect } from "vitest";
import { COMMON_COMMENTS } from "@/lib/constants";
import {
  normalizeChips,
  hydrateLegacyChips,
  verifyStoredChips,
  toggleChip,
  OBSERVATION_CHIP_ALIASES,
} from "@/lib/observation-chips";

// Vocabulary cleanup (Chloe complaint #9): erythema/redness and edema/swelling
// read as redundant. The two jargon-only electrolysis chips now pair plain
// language with the medical term ("Redness (erythema)", "Slight swelling
// (edema)"). This is a canonical LABEL change; legacy stored values must keep
// resolving via aliases with NO backfill and NO row rewrite.

describe("preferred observation labels", () => {
  it("the picker offers the paired labels and no bare jargon duplicate", () => {
    expect(COMMON_COMMENTS).toContain("Redness (erythema)");
    expect(COMMON_COMMENTS).toContain("Slight swelling (edema)");
    // The old jargon-only labels are no longer separate picker options.
    expect(COMMON_COMMENTS).not.toContain("Erythema");
    expect(COMMON_COMMENTS).not.toContain("Slight edema");
    // One option per concept — no duplicate redness/swelling entries.
    const redness = COMMON_COMMENTS.filter((c) => /redness|erythema/i.test(c));
    const swelling = COMMON_COMMENTS.filter((c) => /swelling|edema/i.test(c));
    expect(redness).toHaveLength(1);
    expect(swelling).toHaveLength(1);
  });
});

describe("legacy hydration (no backfill, no data rewrite)", () => {
  it("stored legacy 'Erythema' resolves to the current label", () => {
    expect(normalizeChips(["Erythema"])).toEqual(["Redness (erythema)"]);
  });
  it("stored legacy 'Slight edema' resolves to the current label", () => {
    expect(normalizeChips(["Slight edema"])).toEqual(["Slight swelling (edema)"]);
  });
  it("plain-language spellings ('redness', 'swelling') also resolve", () => {
    expect(normalizeChips(["redness"])).toEqual(["Redness (erythema)"]);
    expect(normalizeChips(["slight swelling"])).toEqual(["Slight swelling (edema)"]);
  });
  it("legacy comments containing the old chip token hydrate + keep free text", () => {
    const { chips, freeText } = hydrateLegacyChips("Erythema, tolerated well overall");
    expect(chips).toEqual(["Redness (erythema)"]);
    expect(freeText).toBe("tolerated well overall");
  });
});

describe("clinical distinctness preserved (no over-merging)", () => {
  it("does NOT merge the laser 'Follicular erythema'/'Follicular edema' concepts", () => {
    // Those are separate laser chips (not in COMMON_COMMENTS); as electrolysis
    // tokens they are unknown and stay free-text rather than collapsing to redness.
    expect(normalizeChips(["Follicular erythema"])).toEqual([]);
    expect(normalizeChips(["Follicular edema"])).toEqual([]);
    const { chips, freeText } = hydrateLegacyChips("Follicular erythema");
    expect(chips).toEqual([]);
    expect(freeText).toBe("Follicular erythema");
  });
  it("aliases are exact-token, never substring-merging distinct terms", () => {
    for (const [k, v] of Object.entries(OBSERVATION_CHIP_ALIASES)) {
      expect(k).toBe(k.toLowerCase());
      expect(COMMON_COMMENTS).toContain(v);
    }
  });
});

describe("strict persisted-row verification still holds", () => {
  it("a new save of the paired label verifies exactly", () => {
    const sel = toggleChip([], "Redness (erythema)");
    expect(sel).toEqual(["Redness (erythema)"]);
    expect(verifyStoredChips(["Redness (erythema)"], sel)).toEqual({ ok: true });
  });
  it("a stored bare-alias value fails strict verify (would not be what we wrote)", () => {
    expect(verifyStoredChips(["Erythema"], ["Redness (erythema)"])).toEqual({
      ok: false,
      reason: "noncanonical",
    });
  });
});
