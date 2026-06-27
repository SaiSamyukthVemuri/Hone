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

describe("charting form frames the picker as a Treatment area chart part", () => {
  it("renders a 'Chart part' / 'Treatment area' card and uses the AreaPicker", () => {
    expect(FORM).toMatch(/Chart part/);
    expect(FORM).toMatch(/Treatment area/);
    expect(FORM).toMatch(/<AreaPicker/);
    expect(FORM).toMatch(/Choose the area for this chart entry/);
  });

  it("shows a live 'Area being charted' preview with an 'Area not recorded' fallback", () => {
    expect(FORM).toMatch(/Area being charted:/);
    expect(FORM).toMatch(/Area not recorded/);
  });

  it("reuses the existing structured area fields (no new schema)", () => {
    expect(FORM).toMatch(/primaryArea/);
    expect(FORM).toMatch(/customAreaDetail/);
    expect(FORM).toMatch(/SIDE_OPTIONS/);
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
