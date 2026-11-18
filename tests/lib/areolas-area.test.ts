import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AREAS, AREA_REGIONS, OTHER_AREA, PRACTITIONER_ONLY_AREAS } from "@/lib/constants";
import { BODY_ZONES, zoneForArea } from "@/lib/sessions/body-zones";
import { validateTreatmentArea } from "@/lib/sessions/area-validation";
import { isTreatmentAreaId, TREATMENT_AREA_REGIONS } from "@/lib/waitlist/treatment-area-catalog";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("Areolas is a practitioner area", () => {
  it("is in AREAS before Other, in the Torso region, and in the torso body zone", () => {
    expect(AREAS.indexOf("Areolas")).toBe(AREAS.indexOf(OTHER_AREA) - 1);
    expect(AREA_REGIONS.find((g) => g.region === "Torso")!.areas).toContain("Areolas");
    expect(BODY_ZONES.find((z) => z.id === "torso")!.areas).toContain("Areolas");
    expect(zoneForArea("Areolas")).toBe("torso");
  });
  it("validates as a canonical, non-custom area, case-insensitively", () => {
    expect(validateTreatmentArea("areolas", false)).toEqual({ ok: true, value: "Areolas", custom: false });
  });
  it("historical free text is untouched: 'Areola' under Other stays custom, not rewritten", () => {
    expect(validateTreatmentArea("Areola", true)).toEqual({ ok: true, value: "Areola", custom: true });
    expect(validateTreatmentArea("Areola", false).ok).toBe(false);
    expect(zoneForArea("Areola")).toBe("other");
  });
});

describe("the waitlist prospect list is unchanged", () => {
  it("does not offer Areolas and has no id for it", () => {
    expect(PRACTITIONER_ONLY_AREAS).toContain("Areolas");
    expect(isTreatmentAreaId("areolas")).toBe(false);
    expect(TREATMENT_AREA_REGIONS.flatMap((g) => g.areaIds)).not.toContain("areolas");
    const picker = read("components/waitlist/treatment-area-picker.tsx");
    expect(picker).toContain("TREATMENT_AREA_REGIONS");
    expect(picker).not.toContain("@/lib/constants"); // it imports only the frozen prospect catalogue
  });
});

describe("the practitioner pickers draw from the lists that now hold it", () => {
  it("session entry forms use AREAS; area-picker and multi-area-picker use AREA_REGIONS", () => {
    expect(read("app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx")).toMatch(/options=\{AREAS\}/);
    expect(read("components/log-electrolysis-entry-form.tsx")).toMatch(/options=\{AREAS\}/);
    expect(read("components/area-picker.tsx")).toContain("AREA_REGIONS.map");
    expect(read("components/multi-area-picker.tsx")).toContain("AREA_REGIONS.map");
  });
});
