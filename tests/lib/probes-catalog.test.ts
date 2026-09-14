import { describe, expect, it } from "vitest";
import {
  PROBE_OPTIONS,
  findProbeOptionByKey,
  isValidProbeOptionKey,
  getMaterialsForBrand,
  getProbeOptionsFor,
  type ProbeMaterial,
  type ProbeOption,
} from "@/lib/probes";

// ===========================================================================
// CHLOE-PROBE-01 — Ballet F2 Regular joins F2 Short.
//
// The Ballet catalog is a SHAPE LIST fanned across three materials, so one
// shape entry becomes three options. These tests pin that fan-out and, more
// importantly, pin the keys — `probe_key` is stored on `session_blocks`, and
// a key that stops being generated is a row that stops resolving.
// ===========================================================================

/**
 * Every key the catalog generated at production `f73ba414`, before F2 Regular
 * was added.
 *
 * This is a LOCK, not a mirror. Any of these may already sit in
 * `session_blocks.probe_key`, so the catalog must keep producing all of them.
 * Regenerate this list ONLY when deliberately retiring a probe — if a change
 * to `slug()`, `buildKey()`, or a brand spec silently reshapes a key, that is
 * the bug this array exists to catch, and the fix is the code, not the list.
 */
const KEYS_AT_F73BA414: ReadonlyArray<string> = [
  "sterex-stainless-steel-two-piece-f2-short",
  "sterex-stainless-steel-two-piece-f3-regular",
  "sterex-stainless-steel-two-piece-f3-short",
  "sterex-stainless-steel-two-piece-f4-regular",
  "sterex-stainless-steel-two-piece-f4-short",
  "sterex-stainless-steel-two-piece-f5-regular",
  "sterex-stainless-steel-two-piece-f5-short",
  "sterex-stainless-steel-two-piece-f6-regular",
  "sterex-stainless-steel-two-piece-f6-short",
  "sterex-gold-two-piece-f2-short",
  "sterex-gold-two-piece-f3-regular",
  "sterex-gold-two-piece-f3-short",
  "sterex-gold-two-piece-f4-regular",
  "sterex-gold-two-piece-f4-short",
  "sterex-gold-two-piece-f5-regular",
  "sterex-gold-two-piece-f5-short",
  "sterex-insulated-two-piece-f2-short",
  "sterex-insulated-two-piece-f3-regular",
  "sterex-insulated-two-piece-f3-short",
  "sterex-insulated-two-piece-f4-regular",
  "sterex-insulated-two-piece-f4-short",
  "sterex-insulated-two-piece-f5-regular",
  "sterex-insulated-two-piece-f5-short",
  "sterex-stainless-steel-one-piece-f2-na",
  "sterex-stainless-steel-one-piece-f3-na",
  "sterex-stainless-steel-one-piece-f4-na",
  "sterex-stainless-steel-one-piece-f5-na",
  "ballet-stainless-steel-one-piece-f2-short",
  "ballet-stainless-steel-one-piece-f3-regular",
  "ballet-stainless-steel-one-piece-k3-regular",
  "ballet-stainless-steel-one-piece-f4-regular",
  "ballet-stainless-steel-one-piece-k4-regular",
  "ballet-stainless-steel-one-piece-f5-regular",
  "ballet-stainless-steel-one-piece-k5-regular",
  "ballet-stainless-steel-one-piece-f6-regular",
  "ballet-stainless-steel-one-piece-k6-regular",
  "ballet-gold-one-piece-f2-short",
  "ballet-gold-one-piece-f3-regular",
  "ballet-gold-one-piece-k3-regular",
  "ballet-gold-one-piece-f4-regular",
  "ballet-gold-one-piece-k4-regular",
  "ballet-gold-one-piece-f5-regular",
  "ballet-gold-one-piece-k5-regular",
  "ballet-gold-one-piece-f6-regular",
  "ballet-gold-one-piece-k6-regular",
  "ballet-insulated-one-piece-f2-short",
  "ballet-insulated-one-piece-f3-regular",
  "ballet-insulated-one-piece-k3-regular",
  "ballet-insulated-one-piece-f4-regular",
  "ballet-insulated-one-piece-k4-regular",
  "ballet-insulated-one-piece-f5-regular",
  "ballet-insulated-one-piece-k5-regular",
  "ballet-insulated-one-piece-f6-regular",
  "ballet-insulated-one-piece-k6-regular",
  "pro-tec-isogard-two-piece-f1-na",
  "pro-tec-isogard-two-piece-f2-na",
  "pro-tec-isogard-two-piece-f3-na",
  "pro-tec-isogard-two-piece-f4-na",
  "pro-tec-isogard-two-piece-f5-na",
  "pro-tec-isogard-two-piece-k1-na",
  "pro-tec-isogard-two-piece-k2-na",
  "pro-tec-isogard-two-piece-k3-na",
  "pro-tec-isogard-two-piece-k4-na",
  "pro-tec-isogard-two-piece-k5-na",
  "pro-tec-isoblend-two-piece-f1-na",
  "pro-tec-isoblend-two-piece-f2-na",
  "pro-tec-isoblend-two-piece-f3-na",
  "pro-tec-isoblend-two-piece-f4-na",
  "pro-tec-isoblend-two-piece-f5-na",
  "pro-tec-isoblend-two-piece-k1-na",
  "pro-tec-isoblend-two-piece-k2-na",
  "pro-tec-isoblend-two-piece-k3-na",
  "pro-tec-isoblend-two-piece-k4-na",
  "pro-tec-isoblend-two-piece-k5-na",
  "pro-tec-stainless-steel-two-piece-f1-na",
  "pro-tec-stainless-steel-two-piece-f2-na",
  "pro-tec-stainless-steel-two-piece-f3-na",
  "pro-tec-stainless-steel-two-piece-f4-na",
  "pro-tec-stainless-steel-two-piece-f5-na",
  "pro-tec-stainless-steel-two-piece-k1-na",
  "pro-tec-stainless-steel-two-piece-k2-na",
  "pro-tec-stainless-steel-two-piece-k3-na",
  "pro-tec-stainless-steel-two-piece-k4-na",
  "pro-tec-stainless-steel-two-piece-k5-na",
];

const BALLET_MATERIALS_EXPECTED: ReadonlyArray<ProbeMaterial> = [
  "Stainless steel",
  "Gold",
  "Insulated",
];

function ballet(): ReadonlyArray<ProbeOption> {
  return PROBE_OPTIONS.filter((o) => o.brand === "Ballet");
}

describe("the pre-existing catalog is preserved byte-for-byte", () => {
  it("still generates EVERY key that existed at f73ba414", () => {
    const now = new Set(PROBE_OPTIONS.map((o) => o.key));
    const dropped = KEYS_AT_F73BA414.filter((k) => !now.has(k));
    // Named, not just counted: a dropped key is a stored row that no longer
    // resolves, and the reader needs to know WHICH probe broke.
    expect(dropped).toEqual([]);
  });

  it("resolves every pre-existing key back to a live option", () => {
    for (const key of KEYS_AT_F73BA414) {
      expect(isValidProbeOptionKey(key), key).toBe(true);
      expect(findProbeOptionByKey(key)?.key, key).toBe(key);
    }
  });

  it("adds exactly three options and removes none", () => {
    expect(KEYS_AT_F73BA414.length).toBe(84);
    expect(PROBE_OPTIONS.length).toBe(KEYS_AT_F73BA414.length + 3);
  });
});

describe("Ballet F2 exists in BOTH lengths", () => {
  it("keeps F2 Short in all three Ballet materials", () => {
    const short = ballet().filter((o) => o.size === "2" && o.length === "Short");
    expect(short.map((o) => o.material)).toEqual(BALLET_MATERIALS_EXPECTED);
    expect(short.every((o) => o.shank === "F")).toBe(true);
  });

  it("adds F2 Regular in all three Ballet materials", () => {
    const regular = ballet().filter(
      (o) => o.size === "2" && o.length === "Regular",
    );
    expect(regular.map((o) => o.material)).toEqual(BALLET_MATERIALS_EXPECTED);
    expect(regular.every((o) => o.shank === "F")).toBe(true);
    expect(regular.every((o) => o.pieceType === "One-piece")).toBe(true);
  });

  it("generates the exact stable keys for F2 Regular", () => {
    expect(
      ballet()
        .filter((o) => o.size === "2" && o.length === "Regular")
        .map((o) => o.key),
    ).toEqual([
      "ballet-stainless-steel-one-piece-f2-regular",
      "ballet-gold-one-piece-f2-regular",
      "ballet-insulated-one-piece-f2-regular",
    ]);
  });

  it("carries the display labels the picker renders", () => {
    expect(
      ballet()
        .filter((o) => o.size === "2" && o.length === "Regular")
        .map((o) => o.displayLabel),
    ).toEqual([
      "Ballet \u00b7 Stainless steel \u00b7 One-piece \u00b7 F2 Regular",
      "Ballet \u00b7 Gold \u00b7 One-piece \u00b7 F2 Regular",
      "Ballet \u00b7 Insulated \u00b7 One-piece \u00b7 F2 Regular",
    ]);
    expect(
      ballet().find((o) => o.key === "ballet-gold-one-piece-f2-short")
        ?.displayLabel,
    ).toBe("Ballet \u00b7 Gold \u00b7 One-piece \u00b7 F2 Short");
  });

  it("distinguishes the two ONLY by length, never by key collision", () => {
    const shortKey = "ballet-gold-one-piece-f2-short";
    const regularKey = "ballet-gold-one-piece-f2-regular";
    expect(shortKey).not.toBe(regularKey);
    const s = findProbeOptionByKey(shortKey)!;
    const r = findProbeOptionByKey(regularKey)!;
    expect([s.brand, s.material, s.pieceType, s.shank, s.size]).toEqual([
      r.brand,
      r.material,
      r.pieceType,
      r.shank,
      r.size,
    ]);
    expect(s.length).toBe("Short");
    expect(r.length).toBe("Regular");
  });
});

describe("the grouping helpers expose both lengths", () => {
  it("still lists the three Ballet materials, in order", () => {
    expect(getMaterialsForBrand("Ballet")).toEqual(BALLET_MATERIALS_EXPECTED);
  });

  it("offers both F2 lengths in every Ballet material the picker can reach", () => {
    for (const material of getMaterialsForBrand("Ballet")) {
      const labels = getProbeOptionsFor("Ballet", material).map((o) => o.label);
      expect(labels, material).toContain("F2 Short");
      expect(labels, material).toContain("F2 Regular");
    }
  });

  it("grows each Ballet material by exactly one option", () => {
    for (const material of getMaterialsForBrand("Ballet")) {
      // 9 shapes before, 10 now.
      expect(getProbeOptionsFor("Ballet", material).length, material).toBe(10);
    }
  });
});

describe("the catalog stays internally sound", () => {
  it("has no duplicate keys", () => {
    const keys = PROBE_OPTIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps every key resolvable through the public lookup", () => {
    for (const o of PROBE_OPTIONS) {
      expect(findProbeOptionByKey(o.key), o.key).toBe(o);
    }
  });

  // SCOPE FENCE. This change was F2 Regular and nothing else; these are the
  // adjacent probes that were explicitly deferred, and a later edit that
  // quietly enables one should fail here rather than ship unnoticed.
  it("does NOT introduce Ballet K2", () => {
    expect(ballet().filter((o) => o.shank === "K" && o.size === "2")).toEqual([]);
  });

  it("does NOT introduce Ballet size 12", () => {
    expect(ballet().filter((o) => o.size === "12")).toEqual([]);
  });

  it("leaves Sterex and Pro-Tec option counts untouched", () => {
    const at = (brand: ProbeOption["brand"]) =>
      KEYS_AT_F73BA414.filter((k) => k.startsWith(`${brand.toLowerCase()}-`))
        .length;
    for (const brand of ["Sterex", "Pro-Tec"] as const) {
      const slugged = brand.toLowerCase();
      expect(
        PROBE_OPTIONS.filter((o) => o.key.startsWith(`${slugged}-`)).length,
        brand,
      ).toBe(at(brand));
    }
  });
});
