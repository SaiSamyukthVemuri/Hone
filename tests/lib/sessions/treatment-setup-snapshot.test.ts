import { describe, expect, it } from "vitest";
import {
  buildTreatmentSetupDraftPatch,
  firstLiveEntry,
  type SetupSourceBlock,
  type SetupSourceEntry,
} from "@/lib/sessions/treatment-setup-snapshot";

const block = (over: Partial<SetupSourceBlock> = {}): SetupSourceBlock => ({
  mode: "thermo",
  apilus_modality: "OmniBlend",
  energy_level: 42,
  minutes_performed: 15,
  machine_frequency: "13.56 MHz",
  probe_key: "ballet-f3",
  ...over,
});

const entry = (over: Partial<SetupSourceEntry> = {}): SetupSourceEntry => ({
  created_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  mode: "thermo",
  thermolysis_intensity_percent: 30,
  thermolysis_duration_seconds: 0.12,
  galvanic_ma: 0.5,
  galvanic_duration_seconds: 8,
  units_of_lye: 25,
  pulse_count: 3,
  pulse_delay_seconds: 0.4,
  ...over,
});

describe("firstLiveEntry — canonical earliest non-deleted", () => {
  it("returns the earliest non-deleted entry by created_at", () => {
    const e = firstLiveEntry([
      entry({ created_at: "2026-01-03T00:00:00Z", thermolysis_intensity_percent: 99 }),
      entry({ created_at: "2026-01-01T00:00:00Z", thermolysis_intensity_percent: 11 }),
      entry({ created_at: "2026-01-02T00:00:00Z", thermolysis_intensity_percent: 55 }),
    ]);
    expect(e?.thermolysis_intensity_percent).toBe(11);
  });
  it("skips soft-deleted entries", () => {
    const e = firstLiveEntry([
      entry({ created_at: "2026-01-01T00:00:00Z", deleted_at: "2026-02-01T00:00:00Z", thermolysis_intensity_percent: 11 }),
      entry({ created_at: "2026-01-02T00:00:00Z", thermolysis_intensity_percent: 55 }),
    ]);
    expect(e?.thermolysis_intensity_percent).toBe(55);
  });
  it("returns null when there is no live entry", () => {
    expect(firstLiveEntry([])).toBeNull();
    expect(firstLiveEntry(null)).toBeNull();
    expect(firstLiveEntry([entry({ deleted_at: "2026-02-01T00:00:00Z" })])).toBeNull();
  });
});

describe("thermolysis source", () => {
  const p = buildTreatmentSetupDraftPatch(block({ mode: "thermo" }), entry({ mode: "thermo" }));
  it("copies block setup + thermolysis readings + pulse + probe + freq + minutes", () => {
    expect(p.mode).toBe("thermo");
    expect(p.apilusModality).toBe("OmniBlend");
    expect(p.energyLevel).toBe("42");
    expect(p.machineFrequency).toBe("13.56 MHz");
    expect(p.probeKey).toBe("ballet-f3");
    expect(p.minutes).toBe("15");
    expect(p.thermolysisIntensityPercent).toBe("30");
    expect(p.thermolysisDurationSeconds).toBe("0.12");
    expect(p.pulseCount).toBe("3");
    expect(p.pulseDelay).toBe("0.4");
  });
  it("clears galvanic + units of lye (invalid for thermolysis)", () => {
    expect(p.galvanicMa).toBe("");
    expect(p.galvanicDurationSeconds).toBe("");
    expect(p.unitsOfLye).toBe("");
  });
});

describe("galvanic source", () => {
  const p = buildTreatmentSetupDraftPatch(block({ mode: "galv" }), entry({ mode: "galv" }));
  it("copies mA, galvanic duration, units of lye, pulse (reusable galvanic setup)", () => {
    expect(p.mode).toBe("galv");
    expect(p.galvanicMa).toBe("0.5");
    expect(p.galvanicDurationSeconds).toBe("8");
    expect(p.unitsOfLye).toBe("25");
    expect(p.pulseCount).toBe("3");
  });
  it("NEVER copies galvanic intensity — retired reading, not in the patch at all", () => {
    // Even from a source whose row still carries a legacy value, the patch has no
    // galvanicIntensityPercent key, so copy-settings can never resurrect it into a
    // new draft. (A richer source row is allowed; it's simply ignored.)
    const withLegacy = buildTreatmentSetupDraftPatch(
      block({ mode: "galv" }),
      { ...entry({ mode: "galv" }), galvanic_intensity_percent: 42 } as never,
    );
    expect(Object.keys(withLegacy)).not.toContain("galvanicIntensityPercent");
    expect("galvanicIntensityPercent" in p).toBe(false);
  });
  it("clears thermolysis readings AND apilus modality + energy (galvanic carries neither)", () => {
    expect(p.thermolysisIntensityPercent).toBe("");
    expect(p.thermolysisDurationSeconds).toBe("");
    expect(p.apilusModality).toBe("");
    expect(p.energyLevel).toBe("");
  });
});

describe("blend source", () => {
  const p = buildTreatmentSetupDraftPatch(block({ mode: "blend" }), entry({ mode: "blend" }));
  it("copies BOTH reading groups + apilus/energy", () => {
    expect(p.mode).toBe("blend");
    expect(p.thermolysisIntensityPercent).toBe("30");
    expect(p.galvanicMa).toBe("0.5");
    expect(p.unitsOfLye).toBe("25");
    expect(p.apilusModality).toBe("OmniBlend");
    expect(p.energyLevel).toBe("42");
  });
});

describe("single-pulse setup must not carry pulse delay", () => {
  it("clears pulseDelay when pulse_count is 1", () => {
    const p = buildTreatmentSetupDraftPatch(block(), entry({ pulse_count: 1, pulse_delay_seconds: 0.4 }));
    expect(p.pulseCount).toBe("1");
    expect(p.pulseDelay).toBe("");
  });
  it("keeps pulseDelay for multi-pulse", () => {
    const p = buildTreatmentSetupDraftPatch(block(), entry({ pulse_count: 2, pulse_delay_seconds: 0.4 }));
    expect(p.pulseDelay).toBe("0.4");
  });
});

describe("outcome fields are structurally absent from the patch", () => {
  it("the patch object contains only reusable setup keys — no outcome keys", () => {
    const p = buildTreatmentSetupDraftPatch(block(), entry());
    const keys = Object.keys(p);
    for (const forbidden of [
      // Retired reading: never a copyable setup key.
      "galvanicIntensityPercent",
      "hairsTreated",
      "comments",
      "observationChips",
      "toleranceRating",
      "reactionType",
      "reactionNotes",
      "cautionForNextSession",
      "cautionNote",
      "numbingStatus",
      "probeLotNumber",
      "probeLotConfirmed",
      "primaryArea",
      "side",
      "areas",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
