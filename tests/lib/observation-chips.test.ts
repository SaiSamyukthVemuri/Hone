import { describe, expect, it } from "vitest";
import {
  OBSERVATION_CHIPS,
  normalizeChips,
  isChipSelected,
  toggleChip,
  hydrateLegacyChips,
} from "@/lib/observation-chips";

const A = OBSERVATION_CHIPS[0]; // e.g. "Dehydrated follicles"
const B = OBSERVATION_CHIPS[1];
const C = OBSERVATION_CHIPS[2];

describe("normalizeChips: safe read-side contract", () => {
  it("keeps canonical chips, canonicalizes casing, dedups, drops unknown", () => {
    expect(normalizeChips([A, B])).toEqual([A, B]);
    expect(normalizeChips([A.toUpperCase(), A])).toEqual([A]); // dedup + canonical casing
    expect(normalizeChips([A, "not a real chip", B])).toEqual([A, B]);
  });
  it("never throws on null/garbage: yields [] rather than losing the render", () => {
    expect(normalizeChips(null)).toEqual([]);
    expect(normalizeChips(undefined)).toEqual([]);
    expect(normalizeChips("Dehydrated follicles")).toEqual([]); // not an array
    expect(normalizeChips([1, {}, null])).toEqual([]);
    expect(normalizeChips({})).toEqual([]);
  });
});

describe("toggleChip / isChipSelected: explicit structured state", () => {
  it("selecting is idempotent (no duplicates); deselect removes", () => {
    let chips: string[] = [];
    chips = toggleChip(chips, A);
    expect(chips).toEqual([A]);
    chips = toggleChip(chips, A.toLowerCase()); // case-insensitive → removes
    expect(chips).toEqual([]);
  });
  it("selecting MULTIPLE distinct chips keeps them all (no silent loss)", () => {
    let chips: string[] = [];
    for (const c of [A, B, C]) chips = toggleChip(chips, c);
    expect(chips).toEqual([A, B, C]);
    expect(isChipSelected(chips, B)).toBe(true);
  });
  it("unknown chip is a no-op (never corrupts structured state)", () => {
    expect(toggleChip([A], "made up chip")).toEqual([A]);
  });
});

describe("hydrateLegacyChips: non-destructive per-record migration", () => {
  it("splits a legacy comments string into chips + remaining free-text", () => {
    const { chips, freeText } = hydrateLegacyChips(`${A}, ${B}, client was chatty`);
    expect(chips).toEqual([A, B]);
    expect(freeText).toBe("client was chatty");
  });
  it("preserves free-text verbatim (in order) and loses nothing", () => {
    const { chips, freeText } = hydrateLegacyChips(`custom note one, ${A}, custom note two`);
    expect(chips).toEqual([A]);
    expect(freeText).toBe("custom note one, custom note two");
  });
  it("handles pure free-text (no chips) and pure chips (no free-text)", () => {
    expect(hydrateLegacyChips("just a plain note")).toEqual({ chips: [], freeText: "just a plain note" });
    expect(hydrateLegacyChips(`${A}, ${B}`)).toEqual({ chips: [A, B], freeText: "" });
    expect(hydrateLegacyChips(null)).toEqual({ chips: [], freeText: "" });
    expect(hydrateLegacyChips("")).toEqual({ chips: [], freeText: "" });
  });
  it("dedups repeated chip tokens while keeping free-text", () => {
    const { chips, freeText } = hydrateLegacyChips(`${A}, ${A}, note`);
    expect(chips).toEqual([A]);
    expect(freeText).toBe("note");
  });
});
