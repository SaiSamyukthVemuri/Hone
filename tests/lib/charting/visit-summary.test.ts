import { describe, expect, it } from "vitest";
import { buildVisitSummary } from "@/lib/charting/visit-summary";

const block = (area: string, deleted: string | null = null) => ({ deleted_at: deleted, primary_area: area, side: "center" });
const pass = (zone: string, deleted: string | null = null) => ({ deleted_at: deleted, zone });

const multi = (areas: Array<[string, string]>, deleted: string | null = null) => ({
  deleted_at: deleted,
  primary_area: areas[0]?.[0] ?? null, // the legacy projection keeps ONLY the first area
  side: null,
  structured_areas: areas.map(([area, laterality]) => ({ area, laterality })),
});

describe("electrolysis areas come from the saved child rows (structured_areas), not the legacy first-area field", () => {
  const sum = (blocks: unknown[]) =>
    buildVisitSummary({ modality: "electrolysis", blocks: blocks as never, laserEntries: [], nextSessionNote: null });
  it("a single structured area", () => {
    const s = sum([multi([["Upper lip", "center"]])]);
    expect(s.count).toBe(1);
    expect(s.areas).toHaveLength(1);
    expect(s.areas[0]).toMatch(/Upper lip/);
  });
  it("multiple structured areas in ONE block are all listed, with their lateralities", () => {
    const s = sum([multi([["Upper lip", "center"], ["Chin", "center"], ["Jawline", "left"], ["Jawline", "right"]])]);
    expect(s.count).toBe(1);
    expect(s.areas).toHaveLength(4);
    expect(s.areas.join("|")).toMatch(/Chin/);
    expect(s.areas.join("|")).toMatch(/Jawline/);
    expect(s.areas.filter((a) => /Jawline/.test(a))).toHaveLength(2);
    expect(new Set(s.areas).size).toBe(4); // mixed laterality stays distinguishable
  });
  it("a mix: a multi-area block, a legacy-only block and a deleted block", () => {
    const s = sum([
      multi([["Upper lip", "center"], ["Chin", "center"]]),
      { deleted_at: null, primary_area: "Neck", side: "left" }, // no child rows: the legacy fallback
      multi([["Cheek", "left"]], "2026-11-18T10:00:00Z"),
    ]);
    expect(s.count).toBe(2);
    expect(s.areas).toHaveLength(3);
    expect(s.areas.join("|")).toMatch(/Upper lip/);
    expect(s.areas.join("|")).toMatch(/Chin/);
    expect(s.areas.join("|")).toMatch(/Neck/);
    expect(s.areas.join("|")).not.toMatch(/Cheek/);
  });
  it("a deleted block contributes nothing", () => {
    const s = sum([multi([["Chin", "center"], ["Neck", "center"]], "2026-11-18T10:00:00Z")]);
    expect(s).toMatchObject({ count: 0, areas: [] });
  });
});

describe("the This-visit summary follows the session's modality", () => {
  it("electrolysis: areas and settings blocks from the live blocks only", () => {
    const s = buildVisitSummary({
      modality: "electrolysis",
      blocks: [block("Upper lip"), block("Chin"), block("Neck", "2026-11-18T10:00:00Z")],
      laserEntries: [pass("Legs")],
      nextSessionNote: "  ",
    });
    expect(s.kind).toBe("electrolysis");
    expect(s.count).toBe(2);
    expect(s.areas.join("|")).toMatch(/Upper lip/);
    expect(s.areas.join("|")).toMatch(/Chin/);
    expect(s.areas.join("|")).not.toMatch(/Neck|Legs/);
    expect(s.nextVisitNoteRecorded).toBe(false);
  });
  it("laser: zones and passes from the live laser entries, NOT 'nothing saved' because no blocks load", () => {
    const s = buildVisitSummary({
      modality: "laser",
      blocks: undefined, // blocks are loaded only for electrolysis
      laserEntries: [pass("Legs"), pass("Legs"), pass("Underarms"), pass("Back", "2026-11-18T10:00:00Z")],
      nextSessionNote: "Come back in 6 weeks",
    });
    expect(s).toEqual({ kind: "laser", areas: ["Legs", "Underarms"], count: 3, nextVisitNoteRecorded: true });
  });
  it("laser with no passes saved says so honestly (zero), and electrolysis ignores laser entries", () => {
    expect(buildVisitSummary({ modality: "laser", blocks: null, laserEntries: [], nextSessionNote: null })).toEqual({
      kind: "laser",
      areas: [],
      count: 0,
      nextVisitNoteRecorded: false,
    });
    expect(buildVisitSummary({ modality: "electrolysis", blocks: [], laserEntries: [pass("Legs")], nextSessionNote: null }).count).toBe(0);
  });
  it("an unknown modality is summarised from laser entries, never from absent blocks", () => {
    expect(buildVisitSummary({ modality: "other", blocks: [block("Chin")], laserEntries: [pass("Legs")], nextSessionNote: null }).kind).toBe("laser");
  });
});
