import { describe, it, expect } from "vitest";
import {
  resolveDisplayChips,
  normalizeChips,
  hydrateLegacyChips,
  toggleChip,
  isChipSelected,
  chipsEqual,
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

// Gate 5 — mixed legacy + structured data behaviour (the six required row shapes).
describe("mixed legacy/structured rows", () => {
  it("(1) legacy chip tokens ONLY → chips render, empty note", () => {
    expect(resolveDisplayChips([], `${A}, ${B}`)).toEqual({ chips: [A, B], note: "" });
  });
  it("(2) free text ONLY → no chips, note verbatim", () => {
    expect(resolveDisplayChips([], "client anxious about pain")).toEqual({ chips: [], note: "client anxious about pain" });
  });
  it("(3) legacy chip tokens PLUS free text → chips + chip-stripped note", () => {
    expect(resolveDisplayChips([], `${A}, sensitive around lip, ${B}`)).toEqual({
      chips: [A, B],
      note: "sensitive around lip",
    });
  });
  it("(4) structured chips PLUS historical comments → structured takes precedence; comment stays the note; NO double-display", () => {
    // The comment even mentions a chip word; it is NOT re-extracted (structured wins).
    const r = resolveDisplayChips([A], `${B} noted earlier, follow up`);
    expect(r.chips).toEqual([A]); // only the structured chip — B is not double-added
    expect(r.note).toBe(`${B} noted earlier, follow up`); // comment shown as-is
  });
  it("(5) RENAMED/variant legacy value uses an explicit alias (not dropped)", () => {
    // 'hyper-pigmentation' / 'hyper pigmentation' alias -> 'Hyperpigmentation'.
    expect(resolveDisplayChips([], "hyper-pigmentation, mild").chips).toEqual(["Hyperpigmentation"]);
    expect(resolveDisplayChips([], "hyper pigmentation").chips).toEqual(["Hyperpigmentation"]);
    expect(normalizeChips(["hyper-pigmentation"])).toEqual(["Hyperpigmentation"]);
  });
  it("(6) UNKNOWN historical value is never discarded — it stays visible as a note", () => {
    const r = resolveDisplayChips([], `${A}, some bespoke observation the studio typed`);
    expect(r.chips).toEqual([A]);
    expect(r.note).toBe("some bespoke observation the studio typed"); // preserved, not dropped
  });
  it("precedence: any structured value suppresses legacy hydration entirely", () => {
    // Even a comment that is ALL chip tokens is not re-hydrated when structured exists.
    const r = resolveDisplayChips([A], `${B}, ${C}`);
    expect(r.chips).toEqual([A]);
    expect(r.note).toBe(`${B}, ${C}`);
  });
});

describe("chipsEqual (read-back comparison contract)", () => {
  it("detects missing / additional / duplicate / order-insensitive equality", () => {
    expect(chipsEqual([A, B], [B, A])).toBe(true); // order-insensitive
    expect(chipsEqual([A], [A, B])).toBe(false); // missing
    expect(chipsEqual([A, B], [A])).toBe(false); // additional
    expect(chipsEqual([A, "coarse hair"], [A])).toBe(true); // dup normalizes equal
    expect(chipsEqual([], [])).toBe(true); // empty
    expect(chipsEqual([A, "junk"], [A])).toBe(true); // unknown ignored by normalize
  });
});
