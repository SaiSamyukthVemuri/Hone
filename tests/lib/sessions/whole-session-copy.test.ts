import { describe, expect, it } from "vitest";
import {
  buildCopyDrafts,
  draftToCopyInput,
  type CopySourceBlock,
} from "@/lib/sessions/whole-session-copy";

// Whole-session copy (0157): pure preview + narrow-input logic. Proves the
// preview build is a pure transform (no I/O), that it is mode-gated, and that
// the client only ever hands the server a NARROW draft input (editable areas +
// setup strings), never decomposed probe columns, never minutes, never an
// outcome. All authority/validation lives server-side (see the normalize test).

function sourceBlock(over: Partial<CopySourceBlock> = {}): CopySourceBlock {
  return {
    blockId: "b1",
    primary_area: "Chin",
    side: "left",
    custom_area_detail: null,
    block: {
      mode: "blend",
      apilus_modality: "Omniblend",
      energy_level: 12,
      // minutes_performed is deliberately absent: it left the reusable-setup
      // source contract when minutes were reclassified as an outcome.
      machine_frequency: "13.56 MHz",
      probe_key: "sterex-gold-two-piece-f3-short",
    },
    probe: {
      probe_brand: "Sterex",
      probe_material: "Gold",
      probe_piece_type: "Two-piece",
      probe_shank: "F",
      probe_size_value: 3,
      probe_length: "Short",
      probe_label: "Sterex · Gold · Two-piece · F3 Short",
    },
    firstEntry: {
      created_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      mode: "blend",
      thermolysis_intensity_percent: 40,
      thermolysis_duration_seconds: 3,
      galvanic_ma: 0.1,
      galvanic_duration_seconds: 10,
      units_of_lye: 30,
      pulse_count: 2,
      pulse_delay_seconds: 1,
    },
    areas: [
      { area: "Chin", laterality: "left" },
      { area: "Upper lip", laterality: "bilateral" },
    ],
    ...over,
  };
}

describe("buildCopyDrafts", () => {
  it("maps source blocks to ephemeral draft cards (areas + gated setup)", () => {
    const drafts = buildCopyDrafts([sourceBlock()]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].areas).toEqual([
      { area: "Chin", laterality: "left" },
      { area: "Upper lip", laterality: "bilateral" },
    ]);
    expect(drafts[0].setup.mode).toBe("blend");
    expect(drafts[0].setup.machineFrequency).toBe("13.56 MHz");
  });

  it("skips blocks with no treated area (nothing to copy)", () => {
    const areaLess = sourceBlock({ primary_area: null, areas: [], blockId: "b2" });
    expect(buildCopyDrafts([areaLess])).toHaveLength(0);
  });

  it("galvanic source clears apilus/energy in the draft setup (mode-gated)", () => {
    const galv = sourceBlock({
      block: { ...sourceBlock().block, mode: "galv" },
      firstEntry: { ...sourceBlock().firstEntry!, mode: "galv" },
    });
    const d = buildCopyDrafts([galv])[0];
    expect(d.setup.mode).toBe("galv");
    expect(d.setup.apilusModality).toBe("");
    expect(d.setup.energyLevel).toBe("");
  });

  it("synthesizes a structured area for a legacy block (primary_area + legacy side)", () => {
    const legacy = sourceBlock({ areas: [], primary_area: "Chin", side: "center" });
    const d = buildCopyDrafts([legacy]);
    expect(d).toHaveLength(1);
    // legacy side "center" → laterality "midline".
    expect(d[0].areas).toEqual([{ area: "Chin", laterality: "midline" }]);
  });

  it("skips a block with no valid electrolysis mode (nothing reusable to copy)", () => {
    const modeless = sourceBlock({
      block: { ...sourceBlock().block, mode: null },
      firstEntry: null,
    });
    // No mode anywhere → not copyable → not offered (so it can't poison a batch).
    expect(buildCopyDrafts([modeless])).toHaveLength(0);
  });
});

describe("draftToCopyInput: NARROW client→server payload", () => {
  it("carries editable areas + setup strings only (no probe decomposition, no minutes, no outcome)", () => {
    const input = draftToCopyInput(buildCopyDrafts([sourceBlock()])[0]);
    // Areas preserved.
    expect(input.areas).toEqual([
      { area: "Chin", laterality: "left" },
      { area: "Upper lip", laterality: "bilateral" },
    ]);
    // Setup keys are exactly the editable machine/probe-key fields, NO minutes,
    // NO decomposed probe columns, NO outcome.
    expect(Object.keys(input.setup).sort()).toEqual(
      [
        "apilusModality",
        "energyLevel",
        "galvanicDurationSeconds",
        "galvanicMa",
        "machineFrequency",
        "mode",
        "probeKey",
        "pulseCount",
        "pulseDelay",
        "thermolysisDurationSeconds",
        "thermolysisIntensityPercent",
        "unitsOfLye",
      ].sort(),
    );
    // galvanic_intensity_percent is a RETIRED reading (Phase A): it is never a
    // copyable setup key and must not cross the wire in any form.
    expect(Object.keys(input.setup)).not.toContain("galvanicIntensityPercent");
    expect(JSON.stringify(input)).not.toContain("galvanicIntensity");
    expect(JSON.stringify(input)).not.toContain("galvanic_intensity");
    // Only the probe KEY crosses the wire; decomposition is derived server-side.
    expect(input.setup.probeKey).toBe("sterex-gold-two-piece-f3-short");
    expect(JSON.stringify(input)).not.toContain("probe_brand");
    expect(JSON.stringify(input)).not.toContain("probe_label");
    // minutes never crosses the wire.
    expect(JSON.stringify(input).toLowerCase()).not.toContain("minute");
    expect(JSON.stringify(input)).not.toContain("minutes_performed");
  });

  it("drops blank-area rows from the wire payload", () => {
    const d = buildCopyDrafts([sourceBlock()])[0];
    d.areas = [{ area: "Chin", laterality: "left" }, { area: "  ", laterality: "left" }];
    const input = draftToCopyInput(d);
    expect(input.areas).toEqual([{ area: "Chin", laterality: "left" }]);
  });
});
