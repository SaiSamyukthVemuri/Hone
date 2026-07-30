import { describe, expect, it } from "vitest";
import {
  CUSTOM_AREA_MAX,
  areaAlreadySelected,
  canCommitCustomArea,
  commitAreaToSet,
  normalizeCustomArea,
} from "@/lib/sessions/area-input";
import type { BlockArea } from "@/lib/sessions/block-areas";

// Custom treatment-area commit contract (Chloe charting hotfix).
//
// THE DEFECT THIS PINS. The multi-area settings-block editor treated every
// AreaPicker onChange as a committed area, and the picker's free-text input
// fired onChange on every keystroke — so typing "Glabella" appended EIGHT selected
// rows ("G", "Gl", "Gla", "Glab", "Glabe", "Glabel", "Glabell", "Glabella") and all eight were persisted
// as session_block_areas rows. These tests pin the pure half of the fix: a
// keystroke is never a commit, and one commit adds at most one row.

const rows = (...areas: string[]): BlockArea[] =>
  areas.map((area) => ({ area, laterality: "not_applicable" }));

describe("normalizeCustomArea", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeCustomArea("  Glabella  ")).toBe("Glabella");
    expect(normalizeCustomArea("\tGlabella\n")).toBe("Glabella");
  });

  it("collapses accidental repeated spaces inside the value", () => {
    expect(normalizeCustomArea("upper  lip")).toBe("upper lip");
    expect(normalizeCustomArea("left   outer   thigh")).toBe("left outer thigh");
  });

  it("returns an empty string for blank / whitespace-only input", () => {
    expect(normalizeCustomArea("")).toBe("");
    expect(normalizeCustomArea("   ")).toBe("");
    expect(normalizeCustomArea("\t \n")).toBe("");
    expect(normalizeCustomArea(null)).toBe("");
    expect(normalizeCustomArea(undefined)).toBe("");
  });

  it("caps at the server-side maximum and never leaves a trailing space", () => {
    const long = `${"a".repeat(CUSTOM_AREA_MAX - 1)} bbbb`;
    const out = normalizeCustomArea(long);
    expect(out.length).toBeLessThanOrEqual(CUSTOM_AREA_MAX);
    expect(out).toBe("a".repeat(CUSTOM_AREA_MAX - 1));
    expect(out.endsWith(" ")).toBe(false);
  });

  it("keeps the practitioner's casing verbatim (no canonicalization here)", () => {
    expect(normalizeCustomArea("glabella")).toBe("glabella");
    expect(normalizeCustomArea("GLABELLA")).toBe("GLABELLA");
  });
});

describe("canCommitCustomArea", () => {
  it("is false for every prefix that is only whitespace", () => {
    expect(canCommitCustomArea("")).toBe(false);
    expect(canCommitCustomArea(" ")).toBe(false);
    expect(canCommitCustomArea("   ")).toBe(false);
  });

  it("is true as soon as there is real text", () => {
    expect(canCommitCustomArea("G")).toBe(true);
    expect(canCommitCustomArea(" Glabella ")).toBe(true);
  });
});

describe("areaAlreadySelected", () => {
  it("matches case-insensitively", () => {
    expect(areaAlreadySelected(rows("Glabella"), "glabella")).toBe(true);
    expect(areaAlreadySelected(rows("glabella"), "GLABELLA")).toBe(true);
  });

  it("matches after normalization (surrounding + repeated whitespace)", () => {
    expect(areaAlreadySelected(rows("upper lip"), "  upper   lip ")).toBe(true);
  });

  it("does not match a different area", () => {
    expect(areaAlreadySelected(rows("Glabella"), "Chin")).toBe(false);
  });

  it("never reports a blank value as selected", () => {
    expect(areaAlreadySelected(rows("Glabella"), "   ")).toBe(false);
  });
});

describe("commitAreaToSet — one submission adds exactly one row", () => {
  it("appends exactly one row with the default N/A laterality", () => {
    const result = commitAreaToSet([], "Glabella");
    expect(result.status).toBe("added");
    expect(result.value).toEqual([{ area: "Glabella", laterality: "not_applicable" }]);
  });

  it("appends (never replaces) prior selections, preserving order", () => {
    const result = commitAreaToSet(rows("Cheeks", "Sideburns"), "Glabella");
    expect(result.value.map((a) => a.area)).toEqual(["Cheeks", "Sideburns", "Glabella"]);
  });

  it("REGRESSION: no keystroke prefix of a typed area can ever be committed blank-first", () => {
    // The defect signature: committing each prefix of "Glabella" in turn used to
    // leave one row per keystroke. The commit rule itself is now the only way in, and each
    // prefix is a distinct area — which is exactly why the COMPONENT must never
    // call it per keystroke. This test documents the arithmetic that made the
    // defect visible in production.
    const prefixes = ["G", "Gl", "Gla", "Glab", "Glabe", "Glabel", "Glabell", "Glabella"];
    let set: ReadonlyArray<BlockArea> = [];
    for (const p of prefixes) set = commitAreaToSet(set, p).value;
    expect(set).toHaveLength(prefixes.length);
    // ...and committing ONLY the final value leaves exactly one row.
    expect(commitAreaToSet([], "Glabella").value).toHaveLength(1);
  });

  it("refuses a blank / whitespace-only commit and returns the set unchanged", () => {
    const start = rows("Cheeks");
    for (const blank of ["", " ", "   ", "\t", null, undefined]) {
      const result = commitAreaToSet(start, blank);
      expect(result.status).toBe("blank");
      expect(result.value).toEqual(start);
    }
  });

  it("is case-insensitively idempotent: Glabella then glabella stays one row", () => {
    const first = commitAreaToSet([], "Glabella");
    expect(first.status).toBe("added");
    const second = commitAreaToSet(first.value, "glabella");
    expect(second.status).toBe("duplicate");
    expect(second.value).toEqual(first.value);
    expect(second.value).toHaveLength(1);
  });

  it("repeated commits of the same text never duplicate (repeated Enter)", () => {
    let set: ReadonlyArray<BlockArea> = [];
    for (let i = 0; i < 5; i += 1) set = commitAreaToSet(set, "Glabella").value;
    expect(set).toHaveLength(1);
  });

  it("dedupes against a canonical chip already added, ignoring casing", () => {
    const result = commitAreaToSet(rows("Chin"), "chin");
    expect(result.status).toBe("duplicate");
    expect(result.value).toHaveLength(1);
  });

  it("trims and collapses before storing", () => {
    const result = commitAreaToSet([], "  midline   glabella  ");
    expect(result.status).toBe("added");
    expect(result.value[0].area).toBe("midline glabella");
  });

  it("respects an explicit laterality when one is supplied", () => {
    const result = commitAreaToSet([], "Glabella", "left");
    expect(result.value[0]).toEqual({ area: "Glabella", laterality: "left" });
  });

  it("never mutates the input array", () => {
    const start = rows("Cheeks");
    const snapshot = JSON.parse(JSON.stringify(start));
    commitAreaToSet(start, "Glabella");
    expect(start).toEqual(snapshot);
  });

  it("caps a commit at the server-side maximum so the action can never reject it", () => {
    const result = commitAreaToSet([], "z".repeat(CUSTOM_AREA_MAX + 40));
    expect(result.status).toBe("added");
    expect(result.value[0].area).toHaveLength(CUSTOM_AREA_MAX);
  });
});
