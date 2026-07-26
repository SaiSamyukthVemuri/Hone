import { describe, expect, it } from "vitest";
import {
  buildCopyDrafts,
  draftToCopySpec,
  type CopySourceBlock,
} from "@/lib/sessions/whole-session-copy";

// Whole-session copy (0157) — pure preview + commit-spec logic. Proves the copy
// is SETUP-ONLY (no outcome ever reaches the RPC payload) and mode-gated, and
// that building the preview is a pure transform (no I/O).

const OUTCOME_KEYS = [
  "comments",
  "observation_chips",
  "hairs_treated",
  "tolerance_rating",
  "reaction_type",
  "reaction_notes",
  "caution_for_next_session",
  "caution_note",
  "numbing_status",
  "numbing_notes",
  "probe_lot_number",
  "probe_lot_confirmed",
  "probe_inventory_item_id",
  "probe_lot_id",
];

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
      minutes_performed: 20,
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
      galvanic_intensity_percent: 50,
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
    expect(drafts[0].setup.minutes).toBe("20");
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
});

describe("draftToCopySpec — SETUP-ONLY, mode-gated, numbers parsed", () => {
  it("emits ONLY setup keys on block + entry (never an outcome)", () => {
    const spec = draftToCopySpec(buildCopyDrafts([sourceBlock()])[0]);
    for (const k of OUTCOME_KEYS) {
      expect(Object.keys(spec.block)).not.toContain(k);
      if (spec.entry) expect(Object.keys(spec.entry)).not.toContain(k);
    }
    // Block carries the setup + area identity.
    expect(spec.block).toMatchObject({
      mode: "blend",
      energy_level: 12,
      minutes_performed: 20,
      machine_frequency: "13.56 MHz",
      probe_key: "sterex-gold-two-piece-f3-short",
      primary_area: "Chin",
      side: "left",
    });
    // Areas carry display_order.
    expect(spec.areas).toEqual([
      { area: "Chin", laterality: "left", display_order: 0 },
      { area: "Upper lip", laterality: "bilateral", display_order: 1 },
    ]);
    // Entry carries the setup readings (numbers), keyed to the primary area.
    expect(spec.entry).toMatchObject({
      area: "Chin",
      mode: "blend",
      thermolysis_intensity_percent: 40,
      galvanic_ma: 0.1,
      units_of_lye: 30,
      pulse_count: 2,
    });
  });

  it("parses numeric setup fields (strings → numbers, blank → null)", () => {
    const d = buildCopyDrafts([sourceBlock()])[0];
    d.setup.energyLevel = "  14  ";
    d.setup.minutes = "";
    const spec = draftToCopySpec(d);
    expect(spec.block.energy_level).toBe(14);
    expect(spec.block.minutes_performed).toBeNull();
  });

  it("a draft with no area yields a null entry (no orphan reading)", () => {
    const d = buildCopyDrafts([sourceBlock()])[0];
    d.areas = [];
    d.primaryArea = null;
    const spec = draftToCopySpec(d);
    expect(spec.entry).toBeNull();
  });
});
