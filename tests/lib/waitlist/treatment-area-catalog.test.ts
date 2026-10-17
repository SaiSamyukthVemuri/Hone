import { describe, expect, it } from "vitest";
import { AREAS, AREA_REGIONS, OTHER_AREA } from "@/lib/constants";
import {
  TREATMENT_AREA_IDS,
  TREATMENT_AREA_LABEL,
  TREATMENT_AREA_REGIONS,
  TREATMENT_AREA_SELECTION_MAX,
  canonicalProspectAreaLabels,
  canonicalRegionNames,
  isTreatmentAreaId,
  parseTreatmentAreaIds,
  summariseTreatmentAreas,
  treatmentAreaLabel,
} from "@/lib/waitlist/treatment-area-catalog";

// WAIT-04A — THE CATALOG IS THE ONLY DOOR.
//
// The product rule is that a waitlist prospect's treatment areas come from
// Hone's structured catalog and from nowhere else: no "Other", no free text, no
// fallback limb. That rule is only worth stating if an arbitrary string
// genuinely cannot reach the submission model, so most of this file is negative
// controls — and each one is paired with a positive assertion, because a guard
// that rejects EVERYTHING would pass every negative test in isolation.

describe("the catalog mirrors lib/constants and drops exactly one member", () => {
  it("holds AREAS minus 'Other', as a set", () => {
    const labels = TREATMENT_AREA_IDS.map((id) => TREATMENT_AREA_LABEL[id]);
    // Re-derived FROM the canonical source, not re-typed: adding an area to
    // lib/constants.ts without adding it here reds this test.
    expect([...labels].sort()).toEqual([...canonicalProspectAreaLabels()].sort());
  });

  it("drops 'Other' and NOTHING else", () => {
    const labels = new Set(TREATMENT_AREA_IDS.map((id) => TREATMENT_AREA_LABEL[id]));
    const dropped = AREAS.filter((label) => !labels.has(label));
    expect(dropped).toEqual([OTHER_AREA]);
  });

  it("keeps 'Full face', which AREA_REGIONS omits", () => {
    // NON-VACUITY for the grouping choice: the catalog is AREAS-derived, not
    // AREA_REGIONS-derived, so the composite a prospect may legitimately want
    // survives.
    const groupedInConstants = AREA_REGIONS.flatMap((g) => g.areas);
    expect(groupedInConstants).not.toContain("Full face");
    expect(TREATMENT_AREA_LABEL.full_face).toBe("Full face");
  });

  it("has unique ids and unique labels", () => {
    expect(new Set(TREATMENT_AREA_IDS).size).toBe(TREATMENT_AREA_IDS.length);
    const labels = TREATMENT_AREA_IDS.map((id) => TREATMENT_AREA_LABEL[id]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("the region grouping partitions the catalog exactly", () => {
  it("names every id once, and no id twice", () => {
    const grouped = TREATMENT_AREA_REGIONS.flatMap((g) => g.areaIds);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...TREATMENT_AREA_IDS].sort());
  });

  it("reuses the region NAMES from lib/constants, in order", () => {
    expect(TREATMENT_AREA_REGIONS.map((g) => g.region)).toEqual([
      ...canonicalRegionNames(),
    ]);
  });
});

describe("NEGATIVE CONTROL — an arbitrary string is not a treatment area", () => {
  // Every one of these is a plausible way a wrong value arrives: a forged post,
  // a stale client, a copy-paste of a LABEL, a case slip, a prototype probe.
  const rejected = [
    "",
    " ",
    "elbow",
    "Upper lip", // the LABEL, not the id — ids are the wire format
    "Full face",
    "Other", // the one member deliberately removed
    "other",
    "OTHER",
    "upper lip", // space, not underscore
    "UPPER_LIP", // wrong case
    " chin ", // untrimmed
    "chin;drop table",
    "<script>alert(1)</script>",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
  ];

  for (const value of rejected) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      expect(isTreatmentAreaId(value)).toBe(false);
      expect(parseTreatmentAreaIds([value])).toEqual({
        ok: false,
        code: "unknown_area",
      });
    });
  }

  it("refuses non-string members", () => {
    for (const value of [null, undefined, 1, true, {}, [], { id: "chin" }]) {
      expect(isTreatmentAreaId(value)).toBe(false);
    }
  });

  it("NON-VACUITY — every real id passes the same guard", () => {
    for (const id of TREATMENT_AREA_IDS) {
      expect(isTreatmentAreaId(id)).toBe(true);
      expect(parseTreatmentAreaIds([id])).toEqual({ ok: true, value: [id] });
    }
  });

  it("a prototype key cannot borrow a label from Object.prototype", () => {
    // TREATMENT_AREA_LABEL is an object literal, so a raw lookup of
    // "__proto__"/"toString" would return something truthy. The guard is what
    // stops that value ever reaching the lookup.
    expect(isTreatmentAreaId("toString")).toBe(false);
    // And the typed accessor only ever sees ids that passed the guard.
    expect(treatmentAreaLabel("chin")).toBe("Chin");
  });
});

describe("NEGATIVE CONTROL — one bad entry refuses the WHOLE selection", () => {
  it("does not silently filter the unknown entry away", () => {
    const mixed = parseTreatmentAreaIds(["chin", "elbow", "neck"]);
    // The dangerous alternative is `{ ok: true, value: ["chin","neck"] }` — a
    // confirmed join for a DIFFERENT set of areas than the one submitted, with
    // nothing on either side saying so.
    expect(mixed.ok).toBe(false);
    expect(mixed).toEqual({ ok: false, code: "unknown_area" });
  });

  it("refuses even when the unknown entry is last", () => {
    expect(parseTreatmentAreaIds(["chin", "neck", "Other"]).ok).toBe(false);
  });

  it("NON-VACUITY — the same call without the bad entry succeeds", () => {
    expect(parseTreatmentAreaIds(["chin", "neck"])).toEqual({
      ok: true,
      value: ["chin", "neck"],
    });
  });
});

describe("selection shape", () => {
  it("refuses a non-array", () => {
    for (const value of [null, undefined, "chin", 3, { 0: "chin" }]) {
      expect(parseTreatmentAreaIds(value)).toEqual({ ok: false, code: "not_an_array" });
    }
  });

  it("refuses an empty selection", () => {
    expect(parseTreatmentAreaIds([])).toEqual({ ok: false, code: "empty_selection" });
  });

  it("refuses more entries than the catalog holds", () => {
    const tooMany = Array.from({ length: TREATMENT_AREA_SELECTION_MAX + 1 }, () => "chin");
    expect(parseTreatmentAreaIds(tooMany)).toEqual({ ok: false, code: "too_many" });
  });

  it("collapses duplicates rather than refusing them", () => {
    // A double-click is unambiguous; refusing it would be hostile.
    expect(parseTreatmentAreaIds(["chin", "chin", "neck"])).toEqual({
      ok: true,
      value: ["chin", "neck"],
    });
  });

  it("orders by the CATALOG, not by click order", () => {
    const clicked = parseTreatmentAreaIds(["feet", "chin", "back"]);
    expect(clicked).toEqual({ ok: true, value: ["chin", "back", "feet"] });
    // Two equivalent selections are therefore equal arrays.
    expect(parseTreatmentAreaIds(["back", "feet", "chin"])).toEqual(clicked);
  });
});

describe("summary rendering", () => {
  it("reads in catalog order regardless of selection order", () => {
    expect(summariseTreatmentAreas(["feet", "chin"])).toBe("Chin, Feet");
    expect(summariseTreatmentAreas(["chin", "feet"])).toBe("Chin, Feet");
  });

  it("is empty for an empty selection", () => {
    expect(summariseTreatmentAreas([])).toBe("");
  });
});
