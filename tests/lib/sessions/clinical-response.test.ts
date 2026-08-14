import { describe, expect, it } from "vitest";
import {
  NUMBING_OPTIONS,
  NUMBING_STATUSES,
  TOLERANCE_OPTIONS,
  isNumbingStatus,
  numbingStatusLabel,
  toleranceLabel,
} from "@/lib/sessions/clinical-response";

// PR #279 (Chloe real-charting feedback): numbing vocabulary + label-based
// tolerance. Stored shapes are unchanged (tolerance_rating stays a 1-5 smallint;
// numbing_status is a small allowlist + NULL), so legacy records map cleanly.

describe("numbing vocabulary (item 1)", () => {
  it("allows exactly none/used (NULL = Not recorded)", () => {
    expect([...NUMBING_STATUSES]).toEqual(["none", "used"]);
    expect(isNumbingStatus("none")).toBe(true);
    expect(isNumbingStatus("used")).toBe(true);
    expect(isNumbingStatus("")).toBe(false);
    expect(isNumbingStatus(null)).toBe(false);
    expect(isNumbingStatus("topical")).toBe(false);
  });
  it("labels are factual, no advice/dosing", () => {
    expect(numbingStatusLabel("none")).toBe("No numbing used");
    expect(numbingStatusLabel("used")).toBe("Numbing used");
  });
  it("offers the three charting choices incl. Not recorded (empty value)", () => {
    expect(NUMBING_OPTIONS.map((o) => o.value)).toEqual(["", "none", "used"]);
    expect(NUMBING_OPTIONS.map((o) => o.label)).toEqual([
      "Not recorded",
      "No numbing used",
      "Numbing used",
    ]);
  });
});

describe("tolerance labels (item 6): labels over raw 1-5, storage unchanged", () => {
  it("offers five labeled options mapped to the stored 1-5 (best -> hardest)", () => {
    expect(TOLERANCE_OPTIONS.map((o) => o.value)).toEqual([5, 4, 3, 2, 1]);
    expect(TOLERANCE_OPTIONS.map((o) => o.label)).toEqual([
      "Comfortable",
      "Mild discomfort",
      "Moderate discomfort",
      "High discomfort",
      "Needed pause / stopped early",
    ]);
  });
  it("maps every legacy numeric value to a clear label (old records readable)", () => {
    expect(toleranceLabel(5)).toBe("Comfortable");
    expect(toleranceLabel(4)).toBe("Mild discomfort");
    expect(toleranceLabel(3)).toBe("Moderate discomfort");
    expect(toleranceLabel(2)).toBe("High discomfort");
    expect(toleranceLabel(1)).toBe("Needed pause / stopped early");
  });
  it("clamps any out-of-range legacy value to an end label (never throws)", () => {
    expect(toleranceLabel(0)).toBe("Needed pause / stopped early");
    expect(toleranceLabel(9)).toBe("Comfortable");
  });
});
