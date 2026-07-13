import { describe, expect, it } from "vitest";
import {
  buildLastSessionSummary,
  type ClinicalSummaryBlock,
} from "@/lib/sessions/clinical-summary";

// PR #190 introduced this helper; PR #191 reshaped it to PER-AREA
// summaries after Chloe's smoke (a first-area-only line made
// multi-area sessions useless). Contract under test: each treatment
// area gets its own mini-summary; per-area cautions plus the
// session-level next note are lifted into watchLines /
// nextSessionNote for the ONE combined "From last visit, for today"
// box; every line is null/absent when its data is absent so old
// records render without empty labels.

function block(
  overrides: Partial<ClinicalSummaryBlock> = {},
): ClinicalSummaryBlock {
  return {
    sort_order: 1,
    block_name: null,
    primary_area: null,
    side: null,
    custom_area_detail: null,
    mode: null,
    apilus_modality: null,
    energy_level: null,
    minutes_performed: null,
    probe_label: null,
    tolerance_rating: null,
    reaction_type: null,
    reaction_notes: null,
    caution_for_next_session: false,
    caution_note: null,
    ...overrides,
  };
}

describe("old records render without empty labels", () => {
  it("a pre-#190 block yields settings memory but no response lines", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ primary_area: "Chin", mode: "thermo" })],
      nextSessionNote: null,
    });
    expect(s.areas).toHaveLength(1);
    expect(s.areas[0]).toEqual({
      name: "Chin",
      settingsLine: "Thermolysis",
      probeLine: null,
      toleranceLine: null,
      reactionLine: null,
    });
    expect(s.watchLines).toEqual([]);
    expect(s.nextSessionNote).toBeNull();
  });

  it("a session with no blocks yields no areas and no watch lines", () => {
    const s = buildLastSessionSummary({ blocks: [], nextSessionNote: null });
    expect(s.areas).toEqual([]);
    expect(s.watchLines).toEqual([]);
    expect(s.nextSessionNote).toBeNull();
  });

  it("whitespace-only notes collapse to nothing", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ caution_note: "   ", reaction_notes: " " })],
      nextSessionNote: "  ",
    });
    expect(s.watchLines).toEqual([]);
    expect(s.areas[0].reactionLine).toBeNull();
    expect(s.nextSessionNote).toBeNull();
  });
});

describe("per-area summaries (the Chloe fix)", () => {
  it("a two-area session shows BOTH areas, each with its own settings and response", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({
          sort_order: 1,
          primary_area: "Chin",
          mode: "thermo",
          energy_level: 12,
          minutes_performed: 20,
          probe_label: "Ballet Gold F3",
          tolerance_rating: 5,
          reaction_type: "none",
        }),
        block({
          sort_order: 2,
          primary_area: "Upper lip",
          side: "left",
          mode: "blend",
          energy_level: 9,
          tolerance_rating: 3,
          reaction_type: "mild_redness",
          reaction_notes: "Settled quickly.",
        }),
      ],
      nextSessionNote: null,
    });
    expect(s.areas).toHaveLength(2);
    expect(s.areas[0].name).toBe("Chin");
    expect(s.areas[0].settingsLine).toBe("Thermolysis - EL 12 - 20 min");
    expect(s.areas[0].probeLine).toBe("Ballet Gold F3");
    expect(s.areas[0].toleranceLine).toBe("5/5 - Comfortable");
    expect(s.areas[0].reactionLine).toBe("No visible reaction");
    expect(s.areas[1].name).toBe("Left Upper lip");
    expect(s.areas[1].settingsLine).toBe("Blend - EL 9");
    expect(s.areas[1].toleranceLine).toBe("3/5 - Moderate discomfort");
    expect(s.areas[1].reactionLine).toBe("Mild redness. Settled quickly.");
  });

  it("structured multi-area block shows EVERY area + laterality (never just one)", () => {
    // The exact Chloe blocker: one settings block treats Left cheek + Right
    // sideburn. The summary must show BOTH, in order, with laterality — the
    // legacy projection here (primary_area='Cheeks', side=null for mixed) must
    // NOT collapse the record to a single area.
    const s = buildLastSessionSummary({
      blocks: [
        block({
          sort_order: 1,
          primary_area: "Cheeks",
          side: null,
          structured_areas: [
            { area: "Cheeks", laterality: "left" },
            { area: "Sideburns", laterality: "right" },
          ] as unknown as NonNullable<ClinicalSummaryBlock["structured_areas"]>,
          mode: "thermo",
        }),
      ],
      nextSessionNote: null,
    });
    expect(s.areas).toHaveLength(1);
    expect(s.areas[0].name).toBe("Left Cheeks · Right Sideburns");
  });

  it("structured rows OVERRIDE the legacy primary_area", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({
          primary_area: "Legacy-only-value",
          side: "left",
          structured_areas: [
            { area: "Neck", laterality: "not_applicable" },
          ] as unknown as NonNullable<ClinicalSummaryBlock["structured_areas"]>,
        }),
      ],
      nextSessionNote: null,
    });
    expect(s.areas[0].name).toBe("Neck");
  });

  it("legacy block with NO structured rows still renders its single area", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ primary_area: "Upper lip", side: "center" })],
      nextSessionNote: null,
    });
    expect(s.areas[0].name).toBe("Midline Upper lip");
  });

  it("areas keep block order via sort_order", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 2, primary_area: "Chin" }),
        block({ sort_order: 1, primary_area: "Upper lip" }),
      ],
      nextSessionNote: null,
    });
    expect(s.areas.map((a) => a.name)).toEqual(["Upper lip", "Chin"]);
  });

  it("legacy areas fall back to block_name, then 'Treatment area N'", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 1, block_name: "Main" }),
        block({ sort_order: 2 }),
      ],
      nextSessionNote: null,
    });
    expect(s.areas[0].name).toBe("Main");
    expect(s.areas[1].name).toBe("Treatment area 2");
  });

  it("long reaction notes are dropped from the compact line", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ reaction_type: "swelling", reaction_notes: "x".repeat(200) }),
      ],
      nextSessionNote: null,
    });
    expect(s.areas[0].reactionLine).toBe("Swelling");
  });

  it("a reaction note without a coded reaction still surfaces", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ reaction_notes: "Pinpoint scab on one follicle." })],
      nextSessionNote: null,
    });
    expect(s.areas[0].reactionLine).toBe("Pinpoint scab on one follicle.");
  });
});

describe("the combined From last visit box inputs", () => {
  it("each caution becomes one area-prefixed watch line", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({
          sort_order: 1,
          primary_area: "Upper lip",
          caution_for_next_session: true,
          caution_note: "Start lower and check sensitivity.",
        }),
        block({ sort_order: 2, primary_area: "Chin" }),
      ],
      nextSessionNote: "Start with chin first.",
    });
    expect(s.watchLines).toEqual([
      "Upper lip: Start lower and check sensitivity.",
    ]);
    expect(s.nextSessionNote).toBe("Start with chin first.");
  });

  it("a caution flag without a note still produces a watch line", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ primary_area: "Chin", caution_for_next_session: true }),
      ],
      nextSessionNote: null,
    });
    expect(s.watchLines).toEqual(["Chin: flagged to watch."]);
  });

  it("a caution note implies a watch line even without the flag", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ primary_area: "Chin", caution_note: "Avoid the scar." }),
      ],
      nextSessionNote: null,
    });
    expect(s.watchLines).toEqual(["Chin: Avoid the scar."]);
  });

  it("the next-session note passes through trimmed", () => {
    const s = buildLastSessionSummary({
      blocks: [],
      nextSessionNote: "  Start lower on the upper lip. ",
    });
    expect(s.nextSessionNote).toBe("Start lower on the upper lip.");
  });
});
