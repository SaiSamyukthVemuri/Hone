import { describe, it, expect } from "vitest";
import {
  resolveDisplayChips,
  normalizeChips,
  hydrateLegacyChips,
  toggleChip,
  isChipSelected,
  verifyStoredChips,
  OBSERVATION_CHIPS,
} from "@/lib/observation-chips";

// Emergency chip-loading fix. Willow's observations were stored in the legacy
// `comments` field (structured observation_chips empty), so the entry-row showed
// no chip pills ("not loading"). resolveDisplayChips is the single display/preload
// contract that renders structured chips OR hydrates legacy chips from comments,
// non-destructively.

const A = "Coarse hair";
const B = "Slight swelling (edema)";
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
  it("(7) CASING variants in legacy comments normalize with no data loss", () => {
    expect(resolveDisplayChips([], "COARSE HAIR, slight EDEMA").chips).toEqual([A, B]);
  });
  it("(8) SPACING variants (extra internal/edge whitespace) normalize", () => {
    expect(resolveDisplayChips([], "  Coarse hair ,   Slight edema  ").chips).toEqual([A, B]);
  });
  it("(9) HYPHENATION/punctuation variant resolves via the explicit alias only", () => {
    expect(resolveDisplayChips([], "hyper-pigmentation").chips).toEqual(["Hyperpigmentation"]);
    // A punctuation variant with NO alias is NOT guessed — it stays as a note.
    expect(resolveDisplayChips([], "coarse-hair").chips).toEqual([]);
    expect(resolveDisplayChips([], "coarse-hair").note).toBe("coarse-hair");
  });
  it("(10) empty string comment → no chips, empty note", () => {
    expect(resolveDisplayChips([], "")).toEqual({ chips: [], note: "" });
  });
  it("(11) null comment → no chips, empty note", () => {
    expect(resolveDisplayChips([], null)).toEqual({ chips: [], note: "" });
  });
  it("(12) empty structured array falls through to legacy hydration", () => {
    expect(resolveDisplayChips([], `${A}`).chips).toEqual([A]);
  });
  it("(13) multiple structured chips all render (order preserved, deduped)", () => {
    expect(resolveDisplayChips([A, B, C], "").chips).toEqual([A, B, C]);
  });
  it("(14) DUPLICATE legacy tokens collapse to one canonical chip", () => {
    expect(resolveDisplayChips([], `${A}, ${A}, ${B}`).chips).toEqual([A, B]);
  });
  it("(15) DUPLICATE structured values collapse to one", () => {
    expect(resolveDisplayChips(["Coarse hair", "coarse hair"], "").chips).toEqual([A]);
  });
  it("(16) MIXED known + unknown legacy tokens: known→chips, unknown→note", () => {
    const r = resolveDisplayChips([], `${A}, mystery thing, ${C}, another note`);
    expect(r.chips).toEqual([A, C]);
    expect(r.note).toBe("mystery thing, another note");
  });
});

// Gate 4 — STRICT persisted-row verification. Unlike a normalize-both-sides
// equality, this inspects the RAW stored array and must NOT let a database
// duplicate / non-canonical / non-array value pass as a verified success.
describe("verifyStoredChips (strict read-back contract)", () => {
  it("exact canonical match → ok", () => {
    expect(verifyStoredChips([A, B], [A, B])).toEqual({ ok: true });
  });
  it("reordered but canonical + unique → ok (order-insensitive)", () => {
    expect(verifyStoredChips([B, A], [A, B])).toEqual({ ok: true });
  });
  it("empty vs empty → ok", () => {
    expect(verifyStoredChips([], [])).toEqual({ ok: true });
  });
  it("stored array MISSING an expected chip → fails", () => {
    expect(verifyStoredChips([A], [A, B])).toEqual({ ok: false, reason: "missing" });
  });
  it("stored array with an UNEXPECTED extra chip → fails", () => {
    expect(verifyStoredChips([A, B], [A])).toEqual({ ok: false, reason: "unexpected" });
  });
  it("stored RAW DUPLICATE → fails (never masked by dedup)", () => {
    // The crux of Gate 4: ["Coarse hair","Coarse hair"] must NOT verify against ["Coarse hair"].
    expect(verifyStoredChips([A, A], [A])).toEqual({ ok: false, reason: "duplicate" });
  });
  it("stored NON-CANONICAL casing/spacing → fails (documented: raw must be exactly canonical)", () => {
    expect(verifyStoredChips(["coarse hair"], [A])).toEqual({ ok: false, reason: "noncanonical" });
    expect(verifyStoredChips(["hyper-pigmentation"], ["Hyperpigmentation"])).toEqual({
      ok: false,
      reason: "noncanonical",
    });
  });
  it("stored UNKNOWN value → fails (not silently treated as success)", () => {
    expect(verifyStoredChips(["totally unknown"], [])).toEqual({ ok: false, reason: "noncanonical" });
  });
  it("stored NON-ARRAY value → fails", () => {
    expect(verifyStoredChips("Coarse hair", [A]).ok).toBe(false);
    expect(verifyStoredChips({ 0: A }, [A]).ok).toBe(false);
    expect(verifyStoredChips(null, []).ok).toBe(false);
  });
  it("stored array with a NON-STRING member → fails", () => {
    expect(verifyStoredChips([A, 42], [A]).ok).toBe(false);
  });
});
