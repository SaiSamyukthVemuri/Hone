import { describe, expect, it } from "vitest";
import {
  normalizeWholeSessionCopy,
  type WholeSessionCopyDraftInput,
} from "@/lib/sessions/whole-session-copy-normalize";

// Canonical server-side normalizer (0157, P1-4). Proves the browser draft is
// validated against canonical charting rules BEFORE any SQL, that probe
// decomposition + primary_area/side are DERIVED server-side (never trusted from
// the browser), that outcomes and minutes never appear, and that forged
// area/laterality/mode/probe/numeric values are rejected (not NULL-coerced).

const VALID_PROBE_KEY = "sterex-gold-two-piece-f3-short";

function draft(over: Partial<WholeSessionCopyDraftInput> = {}): WholeSessionCopyDraftInput {
  return {
    areas: [
      { area: "Chin", laterality: "left" },
      { area: "Upper lip", laterality: "bilateral" },
    ],
    customAreaDetail: null,
    setup: {
      mode: "blend",
      apilusModality: "Omniblend",
      energyLevel: "12",
      probeKey: VALID_PROBE_KEY,
      machineFrequency: "13.56 MHz",
      thermolysisIntensityPercent: "40",
      thermolysisDurationSeconds: "3",
      galvanicMa: "0.1",
      galvanicDurationSeconds: "10",
      galvanicIntensityPercent: "50",
      unitsOfLye: "30",
      pulseCount: "2",
      pulseDelay: "0.5",
    },
    ...over,
  };
}

const OUTCOME_KEYS = [
  "comments", "observation_chips", "hairs_treated", "tolerance_rating",
  "reaction_type", "reaction_notes", "caution_for_next_session", "caution_note",
  "numbing_status", "numbing_notes", "probe_lot_number", "probe_lot_confirmed",
  "probe_inventory_item_id", "probe_lot_id",
];

describe("normalizeWholeSessionCopy — happy path", () => {
  it("derives probe decomposition + primary_area/side server-side; never copies minutes or outcomes", () => {
    const r = normalizeWholeSessionCopy([draft()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [spec] = r.specs;
    // Probe decomposition DERIVED from the key (not the browser).
    expect(spec.block).toMatchObject({
      mode: "blend",
      energy_level: 12,
      machine_frequency: "13.56 MHz",
      probe_key: VALID_PROBE_KEY,
      probe_brand: "Sterex",
      probe_material: "Gold",
      probe_label: "Sterex · Gold · Two-piece · F3 Short",
      primary_area: "Chin", // derived from areas
    });
    // No minutes anywhere; no outcome keys anywhere.
    expect("minutes_performed" in spec.block).toBe(false);
    if (spec.entry) expect("minutes_performed" in spec.entry).toBe(false);
    for (const k of OUTCOME_KEYS) {
      expect(Object.keys(spec.block)).not.toContain(k);
      if (spec.entry) expect(Object.keys(spec.entry)).not.toContain(k);
    }
    // Areas normalized with display_order.
    expect(spec.areas).toEqual([
      { area: "Chin", laterality: "left", display_order: 0 },
      { area: "Upper lip", laterality: "bilateral", display_order: 1 },
    ]);
    // Entry carries setup readings keyed to the primary area.
    expect(spec.entry).toMatchObject({
      area: "Chin",
      mode: "blend",
      thermolysis_intensity_percent: 40,
      galvanic_ma: 0.1,
      units_of_lye: 30,
      pulse_count: 2,
      pulse_delay_seconds: 0.5,
    });
  });

  it("galvanic mode clears apilus modality + energy + thermolysis readings", () => {
    const r = normalizeWholeSessionCopy([
      draft({ setup: { ...draft().setup, mode: "galv", apilusModality: "", energyLevel: "12" } }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.specs[0].block.apilus_modality).toBeNull();
    expect(r.specs[0].block.energy_level).toBeNull();
    expect(r.specs[0].entry?.thermolysis_intensity_percent).toBeNull();
    expect(r.specs[0].entry?.galvanic_ma).toBe(0.1);
  });

  it("thermo mode clears galvanic readings", () => {
    // Omniblend is a blend-only modality; under thermo use a thermo modality.
    const r = normalizeWholeSessionCopy([
      draft({ setup: { ...draft().setup, mode: "thermo", apilusModality: "Picoflash" } }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.specs[0].entry?.galvanic_ma).toBeNull();
    expect(r.specs[0].entry?.units_of_lye).toBeNull();
    expect(r.specs[0].entry?.thermolysis_intensity_percent).toBe(40);
  });

  it("single pulse clears the pulse delay", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, pulseCount: "1", pulseDelay: "0.5" } })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.specs[0].entry?.pulse_delay_seconds).toBeNull();
  });

  it("a blank probe key clears all probe columns", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, probeKey: "" } })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.specs[0].block.probe_key).toBeNull();
    expect(r.specs[0].block.probe_brand).toBeNull();
    expect(r.specs[0].block.probe_label).toBeNull();
  });
});

describe("normalizeWholeSessionCopy — forgery / invalid values are REJECTED (not NULL-coerced)", () => {
  it("rejects an unknown probe key", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, probeKey: "totally-made-up-key" } })]);
    expect(r.ok).toBe(false);
  });
  it("rejects an unknown mode", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, mode: "laser" } })]);
    expect(r.ok).toBe(false);
  });
  it("rejects a non-catalog apilus modality for the mode", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, mode: "thermo", apilusModality: "Omniblend" } })]);
    expect(r.ok).toBe(false); // Omniblend is a blend modality, not thermo
  });
  it("rejects an unknown laterality", () => {
    const r = normalizeWholeSessionCopy([draft({ areas: [{ area: "Chin", laterality: "sideways" }] })]);
    expect(r.ok).toBe(false);
  });
  it("rejects an over-long area", () => {
    const r = normalizeWholeSessionCopy([draft({ areas: [{ area: "x".repeat(61), laterality: "left" }] })]);
    expect(r.ok).toBe(false);
  });
  it("rejects malformed numeric text (not silently NULL)", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, energyLevel: "12abc" } })]);
    expect(r.ok).toBe(false);
  });
  it("rejects an out-of-range percent", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, thermolysisIntensityPercent: "150" } })]);
    expect(r.ok).toBe(false);
  });
  it("rejects an out-of-range pulse delay", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, pulseCount: "3", pulseDelay: "9" } })]);
    expect(r.ok).toBe(false);
  });
  it("rejects a pulse count above the max", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, pulseCount: "99" } })]);
    expect(r.ok).toBe(false);
  });
  it("rejects an area-less draft (cannot create a block)", () => {
    const r = normalizeWholeSessionCopy([draft({ areas: [] })]);
    expect(r.ok).toBe(false);
  });
  it("rejects a custom_area_detail longer than the DB CHECK (60)", () => {
    const r = normalizeWholeSessionCopy([draft({ customAreaDetail: "x".repeat(61) })]);
    expect(r.ok).toBe(false);
  });
  it("rejects an energy level beyond the sane int bound", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, energyLevel: "100001" } })]);
    expect(r.ok).toBe(false);
  });
  it("rejects duplicate (area, laterality) pairs", () => {
    const r = normalizeWholeSessionCopy([
      draft({ areas: [{ area: "Chin", laterality: "left" }, { area: "chin", laterality: "left" }] }),
    ]);
    expect(r.ok).toBe(false);
  });
  it("rejects an empty batch", () => {
    expect(normalizeWholeSessionCopy([]).ok).toBe(false);
  });
  it("rejects an oversized batch (>50)", () => {
    const many = Array.from({ length: 51 }, () => draft());
    expect(normalizeWholeSessionCopy(many).ok).toBe(false);
  });
  it("accepts both canonical machine frequencies and rejects anything else", () => {
    expect(normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, machineFrequency: "13.56 MHz" } })]).ok).toBe(true);
    expect(normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, machineFrequency: "27.12 MHz" } })]).ok).toBe(true);
    // blank clears (allowed)
    const blank = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, machineFrequency: "" } })]);
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.specs[0].block.machine_frequency).toBeNull();
    // invalid / case / forged (padding is trimmed, so only genuinely non-canonical values reject)
    for (const bad of ["13.56", "13.56 mhz", "13.56MHz", "40.68 MHz", "x".repeat(50)]) {
      expect(normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, machineFrequency: bad } })]).ok).toBe(false);
    }
  });

  it("never leaks raw internals in the error message", () => {
    const r = normalizeWholeSessionCopy([draft({ setup: { ...draft().setup, mode: "laser" } })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toMatch(/undefined|null|SQLSTATE|throw|Error:/);
  });
});
