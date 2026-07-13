import { describe, it, expect } from "vitest";
import {
  resolveBlockAreas,
  deriveLegacyProjection,
  formatAreaLabel,
  blockAreasLabel,
  legacySideToLaterality,
  lateralityToLegacySide,
  type BlockArea,
} from "@/lib/sessions/block-areas";

describe("read contract: structured rows win, else legacy fallback", () => {
  it("uses structured child rows when present", () => {
    const rows: BlockArea[] = [
      { area: "Cheek", laterality: "left" },
      { area: "Sideburn", laterality: "right" },
    ];
    expect(resolveBlockAreas(rows, { primary_area: "Chin", side: "bilateral" })).toEqual(rows);
  });
  it("falls back to legacy primary_area + side when no child rows", () => {
    expect(resolveBlockAreas([], { primary_area: "Chin", side: "bilateral" })).toEqual([
      { area: "Chin", laterality: "bilateral" },
    ]);
    expect(resolveBlockAreas(null, { primary_area: "Upper lip", side: "center" })).toEqual([
      { area: "Upper lip", laterality: "midline" },
    ]);
  });
  it("returns [] for an area-less block", () => {
    expect(resolveBlockAreas([], { primary_area: null, side: null })).toEqual([]);
  });
});

describe("legacy side <-> laterality mapping", () => {
  it("maps legacy side to laterality", () => {
    expect(legacySideToLaterality("left")).toBe("left");
    expect(legacySideToLaterality("center")).toBe("midline");
    expect(legacySideToLaterality("n/a")).toBe("not_applicable");
    expect(legacySideToLaterality(null)).toBe("not_applicable");
  });
  it("maps laterality back to a legacy side value", () => {
    expect(lateralityToLegacySide("midline")).toBe("center");
    expect(lateralityToLegacySide("not_applicable")).toBe("n/a");
    expect(lateralityToLegacySide("bilateral")).toBe("bilateral");
  });
});

describe("combined labels", () => {
  it("formats per-area laterality labels in the canonical prefix format", () => {
    expect(formatAreaLabel({ area: "cheek", laterality: "left" })).toBe("Left cheek");
    expect(formatAreaLabel({ area: "sideburn", laterality: "right" })).toBe("Right sideburn");
    expect(formatAreaLabel({ area: "cheeks", laterality: "bilateral" })).toBe("Bilateral cheeks");
    expect(formatAreaLabel({ area: "upper lip", laterality: "midline" })).toBe("Midline upper lip");
    expect(formatAreaLabel({ area: "Neck", laterality: "not_applicable" })).toBe("Neck");
  });
});

describe("blockAreasLabel — the single display contract for every surface", () => {
  it("joins multiple structured areas, preserving order and per-area laterality", () => {
    expect(
      blockAreasLabel(
        [
          { area: "cheek", laterality: "left" },
          { area: "sideburn", laterality: "right" },
        ],
        { primary_area: "cheek", side: "left" },
      ),
    ).toBe("Left cheek · Right sideburn");
  });
  it("mixed laterality is NEVER flattened to one side", () => {
    // The legacy projection would have side=null here; the label still shows both.
    expect(
      blockAreasLabel(
        [
          { area: "cheek", laterality: "left" },
          { area: "cheek", laterality: "right" },
        ],
        { primary_area: "cheek", side: null },
      ),
    ).toBe("Left cheek · Right cheek");
  });
  it("structured rows OVERRIDE the legacy projection", () => {
    expect(
      blockAreasLabel([{ area: "chin", laterality: "bilateral" }], {
        primary_area: "IGNORED", // legacy is only a fallback
        side: "left",
      }),
    ).toBe("Bilateral chin");
  });
  it("falls back to legacy primary_area + side when there are no structured rows", () => {
    expect(
      blockAreasLabel(null, { primary_area: "Upper lip", side: "center" }),
    ).toBe("Midline Upper lip");
    expect(blockAreasLabel([], { primary_area: "Neck", side: "n/a" })).toBe("Neck");
  });
  it("keeps an unknown historical area value visible verbatim", () => {
    expect(
      blockAreasLabel(null, { primary_area: "Left temple (custom)", side: null }),
    ).toBe("Left temple (custom)");
  });
  it("returns null when the block records no area at all", () => {
    expect(blockAreasLabel(null, { primary_area: null, side: null })).toBeNull();
    expect(blockAreasLabel([], { primary_area: "  ", side: null })).toBeNull();
  });
});

describe("write-side legacy projection (never misrepresents mixed sides)", () => {
  it("keeps primary_area = first area; side = shared side when all match", () => {
    expect(
      deriveLegacyProjection([
        { area: "Cheek", laterality: "bilateral" },
        { area: "Chin", laterality: "bilateral" },
      ]),
    ).toEqual({ primaryArea: "Cheek", side: "bilateral" });
  });
  it("sets side = null when areas have MIXED laterality (no misleading value)", () => {
    expect(
      deriveLegacyProjection([
        { area: "Cheek", laterality: "left" },
        { area: "Sideburn", laterality: "right" },
      ]),
    ).toEqual({ primaryArea: "Cheek", side: null });
  });
  it("empty → nulls", () => {
    expect(deriveLegacyProjection([])).toEqual({ primaryArea: null, side: null });
  });
});
