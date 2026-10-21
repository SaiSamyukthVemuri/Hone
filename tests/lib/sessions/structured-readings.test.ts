import { describe, expect, it } from "vitest";
import { hasStructuredReadings } from "@/lib/sessions/structured-readings";

// The ONE rule both the saved-record view and the HON-46 printout use to
// decide whether an entry's legacy intensity/duration are stale
// (Codex P1 4304983088).

describe("hasStructuredReadings", () => {
  it("is false for a legacy-only entry (generic intensity/duration only)", () => {
    expect(hasStructuredReadings({ mode: "thermo", pulse_count: null })).toBe(false);
    expect(hasStructuredReadings({})).toBe(false);
  });
  it("is true for any galvanic reading", () => {
    expect(hasStructuredReadings({ units_of_lye: 4 })).toBe(true);
    expect(hasStructuredReadings({ galvanic_duration_seconds: 6 })).toBe(true);
    expect(hasStructuredReadings({ galvanic_ma: 0.3 })).toBe(true);
  });
  it("is true for any thermolysis reading", () => {
    expect(hasStructuredReadings({ thermolysis_intensity_percent: 22 })).toBe(true);
    expect(hasStructuredReadings({ thermolysis_duration_seconds: 0.733 })).toBe(true);
  });
  it("counts a pulse count only in a thermo/blend mode, as the saved view does", () => {
    expect(hasStructuredReadings({ mode: "thermo", pulse_count: 3 })).toBe(true);
    expect(hasStructuredReadings({ mode: "blend", pulse_count: 1 })).toBe(true);
    expect(hasStructuredReadings({ mode: "galvanic", pulse_count: 3 })).toBe(false);
  });
  it("counts a thermolysis duration only when it is a finite number (entry-row's formatSeconds gate)", () => {
    expect(hasStructuredReadings({ thermolysis_duration_seconds: Number.NaN })).toBe(false);
  });
});
