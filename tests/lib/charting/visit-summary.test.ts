import { describe, expect, it } from "vitest";
import { buildVisitSummary } from "@/lib/charting/visit-summary";

const block = (area: string, deleted: string | null = null) => ({ deleted_at: deleted, primary_area: area, side: "center" });
const pass = (zone: string, deleted: string | null = null) => ({ deleted_at: deleted, zone });

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
