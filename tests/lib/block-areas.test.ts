import { describe, it, expect } from "vitest";
import {
  resolveBlockAreas,
  deriveLegacyProjection,
  formatAreaLabel,
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
  it("formats per-area laterality labels", () => {
    expect(formatAreaLabel({ area: "cheek", laterality: "left" })).toBe("Left cheek");
    expect(formatAreaLabel({ area: "sideburn", laterality: "right" })).toBe("Right sideburn");
    expect(formatAreaLabel({ area: "cheeks", laterality: "bilateral" })).toBe("Both sides · cheeks");
    expect(formatAreaLabel({ area: "Chin", laterality: "not_applicable" })).toBe("Chin");
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
