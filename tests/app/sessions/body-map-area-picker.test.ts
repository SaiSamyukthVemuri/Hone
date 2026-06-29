import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_ZONES,
  isCanonicalBodyArea,
  zoneForArea,
} from "@/lib/sessions/body-zones";
import { AREA_REGIONS } from "@/lib/constants";

// PR #270. Built-in body-map treatment-area picker V1: a schematic (inline SVG)
// body with clickable broad zones that reveal the existing canonical area keys
// and set session_blocks.primary_area — reuse-only (NO migration, NO new
// dependency, NO image storage/upload/canvas/drawing/OCR/AI, NO copied Jane
// assets). The shared AreaPicker is unchanged so the treatment-plan editor is
// unaffected. Pure zone-mapping tests + source-grep, no DB/network.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const COMPONENT = read("components/body-map-area-picker.tsx");
const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const AREA_PICKER = read("components/area-picker.tsx");
const PLAN_CARD = read("components/treatment-plans-card.tsx");

describe("BODY_ZONES map onto existing canonical area keys (no invented areas)", () => {
  const canonical = new Set(AREA_REGIONS.flatMap((g) => g.areas));

  it("covers the broad body zones", () => {
    expect(BODY_ZONES.map((z) => z.id)).toEqual([
      "face",
      "neck",
      "torso",
      "arms",
      "legs",
      "intimate",
      "other",
    ]);
  });

  it("every body-map area is a real AREA_REGIONS key", () => {
    for (const z of BODY_ZONES) {
      for (const area of z.areas) {
        expect(isCanonicalBodyArea(area)).toBe(true);
        expect(canonical.has(area)).toBe(true);
      }
    }
  });

  it("the zones collectively cover every canonical area (nothing dropped)", () => {
    const mapped = new Set(BODY_ZONES.flatMap((z) => z.areas));
    for (const area of canonical) {
      expect(mapped.has(area)).toBe(true);
    }
  });

  it("zoneForArea routes canonical, custom, and empty values", () => {
    expect(zoneForArea("Upper lip")).toBe("face");
    expect(zoneForArea("Underarms")).toBe("arms");
    expect(zoneForArea("Bikini")).toBe("intimate");
    expect(zoneForArea("midline glabella")).toBe("other"); // custom free-text
    expect(zoneForArea("")).toBeNull();
    expect(zoneForArea("   ")).toBeNull();
  });
});

describe("body-map component is a schematic picker, not an image/canvas", () => {
  it("renders an inline SVG with clickable zones that set the area", () => {
    expect(COMPONENT).toMatch(/<svg/);
    expect(COMPONENT).toMatch(/BODY_ZONES/);
    expect(COMPONENT).toMatch(/aria-pressed/);
    expect(COMPONENT).toMatch(/onChange\(area\)/); // chip selects an area
  });

  it("adds no image storage / upload / canvas / drawing / OCR / AI", () => {
    expect(COMPONENT).not.toMatch(/type="file"/);
    expect(COMPONENT).not.toMatch(/FileReader|multipart\/form-data/);
    expect(COMPONENT).not.toMatch(/<canvas|getContext\(|toDataURL/);
    expect(COMPONENT).not.toMatch(/tesseract|createWorker|\bOCR\b/i);
    expect(COMPONENT).not.toMatch(/<img|background-image|url\(/);
  });

  it("references no Jane CDN/thumbnail asset URL", () => {
    expect(COMPONENT).not.toMatch(/jane\.app/i);
    expect(COMPONENT).not.toMatch(/\/thumbs\//i);
  });
});

describe("charting form wires the body map above the list picker", () => {
  it("renders BodyMapAreaPicker and keeps the AreaPicker as the list below", () => {
    expect(FORM).toMatch(/<BodyMapAreaPicker/);
    expect(FORM).toMatch(/<AreaPicker/);
    const bodyMapAt = FORM.indexOf("<BodyMapAreaPicker");
    const areaPickerAt = FORM.indexOf("<AreaPicker");
    expect(bodyMapAt).toBeGreaterThan(-1);
    expect(areaPickerAt).toBeGreaterThan(bodyMapAt); // body map first, list below
  });

  it("uses the body-map wording and the shared area-change handler", () => {
    expect(FORM).toMatch(/Body map/);
    expect(FORM).toMatch(/Choose from the body map or use the list below/);
    expect(FORM).toMatch(/onChange=\{onAreaChange\}/);
  });
});

describe("PR #279 (item 2): a sub-area no longer floods the whole zone", () => {
  it("underarms maps to the Arms zone (the source of the confusion)", () => {
    expect(zoneForArea("Underarms")).toBe("arms");
    expect(zoneForArea("Forearms")).toBe("arms");
    expect(zoneForArea("Hands")).toBe("arms");
  });
  it("the broad zone gets a SUBTLE 'contains the selected area' state, not a flood", () => {
    expect(COMPONENT).toMatch(/containsSelection/);
    expect(COMPONENT).toMatch(/contains the selected area/);
    // the previous dominant flood is replaced by a subtle tint
    expect(COMPONENT).not.toMatch(/fill-emerald-200/);
    expect(COMPONENT).toMatch(/fill-emerald-50/);
  });
  it("the exact area is still conveyed precisely by the selected area chip", () => {
    // the area chips set aria-pressed on the exact value
    expect(COMPONENT).toMatch(/const selected = value === area/);
    // the form shows the precise "Area being charted" line
    expect(FORM).toMatch(/Area being charted/);
  });
});

describe("treatment-plan editor is unaffected (body map is charting-only)", () => {
  it("the treatment-plan card does NOT use the charting-only body map", () => {
    expect(PLAN_CARD).not.toMatch(/BodyMapAreaPicker|body-map-area-picker/);
    // it still uses a (multi-)area picker over the same AREA_REGIONS catalog
    expect(PLAN_CARD).toMatch(/MultiAreaPicker|AreaPicker/);
  });

  it("the shared AreaPicker does not import the body map", () => {
    expect(AREA_PICKER).not.toMatch(/body-map-area-picker|BodyMapAreaPicker/);
  });
});
