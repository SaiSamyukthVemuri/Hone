import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #269. Visual treatment-area picker V1: the region-grouped AreaPicker (chips
// over AREA_REGIONS) is framed in the charting form as a "Chart part" card with
// a live "Area being charted" preview. Reuse-only (session_blocks
// primary_area / side / custom_area_detail) — NO migration, NO new dependency,
// NO image storage / upload / drawing / canvas / sketch / OCR / AI, and NO
// copied Jane assets. Source-grep, no DB/network.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PICKER = read("components/area-picker.tsx");
const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const CONSTANTS = read("lib/constants.ts");

describe("visual area picker renders grouped body-area chips", () => {
  it("AreaPicker maps the AREA_REGIONS catalog into grouped chip buttons", () => {
    expect(PICKER).toMatch(/AREA_REGIONS/);
    expect(PICKER).toMatch(/AREA_REGIONS\.map/);
    expect(PICKER).toMatch(/group\.areas\.map/);
    expect(PICKER).toMatch(/aria-pressed/); // selected state on chips
  });

  it("AREA_REGIONS provides region-grouped areas + an Other option", () => {
    expect(CONSTANTS).toMatch(/AREA_REGIONS/);
    expect(CONSTANTS).toMatch(/OTHER_AREA/);
    expect(CONSTANTS).toMatch(/region:/);
    expect(CONSTANTS).toMatch(/areas:/);
  });
});

// Migration 0128 (Willow multi-area): the single-area "Chart part" card was
// replaced by the multi-area editor, which itself reuses the region-grouped
// AreaPicker to ADD areas. The picker component + AREA_REGIONS catalog are
// unchanged (asserted above).
const EDITOR = read("components/multi-area-editor.tsx");

describe("charting form uses the multi-area editor over the shared AreaPicker", () => {
  it("renders the MultiAreaEditor bound to the structured areas set", () => {
    expect(FORM).toMatch(/<MultiAreaEditor/);
    expect(FORM).toMatch(/value=\{draft\.areas\}/);
  });

  it("the multi-area editor uses the AreaPicker to add areas + the areas-treated copy", () => {
    expect(EDITOR).toMatch(/Areas treated with these settings/);
    expect(EDITOR).toMatch(/<AreaPicker/);
  });

  it("stores the structured area model (session_block_areas, migration 0128)", () => {
    expect(FORM).toMatch(/BlockArea/);
    expect(FORM).toMatch(/draft\.areas/);
  });
});

describe("no image storage / upload / drawing / OCR / Jane assets", () => {
  for (const [label, src] of [
    ["area-picker", PICKER],
    ["block-setup-form", FORM],
  ] as const) {
    it(`${label} adds no upload/canvas/sketch/OCR/AI primitive`, () => {
      expect(src).not.toMatch(/type="file"/);
      expect(src).not.toMatch(/FileReader|multipart\/form-data/);
      expect(src).not.toMatch(/<canvas|getContext\(|toDataURL/);
      expect(src).not.toMatch(/tesseract|createWorker|\bOCR\b/i);
    });
    it(`${label} references no Jane CDN/thumbnail asset URL`, () => {
      expect(src).not.toMatch(/jane\.app/i);
      expect(src).not.toMatch(/\/thumbs\//i);
    });
  }
});
