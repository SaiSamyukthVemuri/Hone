import { describe, expect, it } from "vitest";
import {
  buildLastSessionSummary,
  type ClinicalSummaryBlock,
} from "@/lib/sessions/clinical-summary";

// PR #190 (clinical memory). Real unit tests for the pure summary
// helper shared by the appointment detail Last session card and the
// new-session Previous session context panel. The contract under
// test: every line is null when its data is absent (old records show
// no empty labels), and present lines condense multi-block sessions
// into compact, decision-ready strings.

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

describe("old records: absent data yields null lines, never empty labels", () => {
  it("a pre-#190 block (all response fields null) produces no response lines", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ primary_area: "Chin", mode: "thermo" })],
      nextSessionNote: null,
    });
    expect(s.toleranceLine).toBeNull();
    expect(s.reactionLine).toBeNull();
    expect(s.cautionFlagged).toBe(false);
    expect(s.cautionLine).toBeNull();
    expect(s.nextSessionNote).toBeNull();
    // But the settings memory still works for old blocks.
    expect(s.areaLine).toBe("Chin");
    expect(s.settingsLine).toBe("Thermolysis");
  });

  it("a session with no blocks at all yields all-null lines", () => {
    const s = buildLastSessionSummary({ blocks: [], nextSessionNote: null });
    expect(s.areaLine).toBeNull();
    expect(s.settingsLine).toBeNull();
    expect(s.probeLine).toBeNull();
    expect(s.toleranceLine).toBeNull();
    expect(s.reactionLine).toBeNull();
    expect(s.cautionFlagged).toBe(false);
    expect(s.cautionLine).toBeNull();
  });

  it("whitespace-only notes collapse to null", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ caution_note: "   ", reaction_notes: " " })],
      nextSessionNote: "  ",
    });
    expect(s.cautionLine).toBeNull();
    expect(s.nextSessionNote).toBeNull();
  });
});

describe("areas, settings, probe", () => {
  it("joins unique area labels with side, in block order", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 2, primary_area: "Chin" }),
        block({ sort_order: 1, primary_area: "Upper lip", side: "left" }),
        block({ sort_order: 3, primary_area: "Chin" }),
      ],
      nextSessionNote: null,
    });
    expect(s.areaLine).toBe("Upper lip (Left), Chin");
  });

  it("settings come from the first block that recorded any", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 1 }),
        block({
          sort_order: 2,
          mode: "blend",
          energy_level: 14,
          minutes_performed: 30,
        }),
      ],
      nextSessionNote: null,
    });
    expect(s.settingsLine).toBe("Blend - EL 14 - 30 min");
  });

  it("probe line is the first non-null probe_label", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 1 }),
        block({ sort_order: 2, probe_label: "Ballet Gold F3" }),
      ],
      nextSessionNote: null,
    });
    expect(s.probeLine).toBe("Ballet Gold F3");
  });

  it("falls back to block_name when no structured area exists (legacy blocks)", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ block_name: "Main" })],
      nextSessionNote: null,
    });
    expect(s.areaLine).toBe("Main");
  });
});

describe("tolerance, reaction, caution", () => {
  it("tolerance reports the WORST rating across blocks", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 1, tolerance_rating: 5 }),
        block({ sort_order: 2, tolerance_rating: 2 }),
      ],
      nextSessionNote: null,
    });
    expect(s.toleranceLine).toBe("2/5 - Difficult");
  });

  it("reaction joins unique non-none labels and carries a short note", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({
          sort_order: 1,
          reaction_type: "mild_redness",
          reaction_notes: "Settled within an hour.",
        }),
        block({ sort_order: 2, reaction_type: "sensitivity" }),
      ],
      nextSessionNote: null,
    });
    expect(s.reactionLine).toBe(
      "Mild redness, Sensitivity. Settled within an hour.",
    );
  });

  it("an explicit all-clear ('none') surfaces; absent values do not", () => {
    const explicit = buildLastSessionSummary({
      blocks: [block({ reaction_type: "none" })],
      nextSessionNote: null,
    });
    expect(explicit.reactionLine).toBe("No visible reaction");
    const absent = buildLastSessionSummary({
      blocks: [block()],
      nextSessionNote: null,
    });
    expect(absent.reactionLine).toBeNull();
  });

  it("long reaction notes are dropped from the compact line", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({
          reaction_type: "swelling",
          reaction_notes: "x".repeat(200),
        }),
      ],
      nextSessionNote: null,
    });
    expect(s.reactionLine).toBe("Swelling");
  });

  it("caution flag is true when ANY block raises it; notes join distinctly", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 1, caution_for_next_session: true, caution_note: "Avoid the scar area." }),
        block({ sort_order: 2 }),
        block({ sort_order: 3, caution_for_next_session: true, caution_note: "Avoid the scar area." }),
      ],
      nextSessionNote: null,
    });
    expect(s.cautionFlagged).toBe(true);
    expect(s.cautionLine).toBe("Avoid the scar area.");
  });

  it("caution flag without a note keeps cautionLine null (caller shows generic copy)", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ caution_for_next_session: true })],
      nextSessionNote: null,
    });
    expect(s.cautionFlagged).toBe(true);
    expect(s.cautionLine).toBeNull();
  });
});

describe("multi-block honesty", () => {
  it("blockCount reports the number of blocks so the UI can label first-area settings", () => {
    const multi = buildLastSessionSummary({
      blocks: [
        block({ sort_order: 1, primary_area: "Upper lip", mode: "thermo" }),
        block({ sort_order: 2, primary_area: "Chin", mode: "blend" }),
        block({ sort_order: 3, primary_area: "Jawline" }),
      ],
      nextSessionNote: null,
    });
    expect(multi.blockCount).toBe(3);
    // The settings line is the first block's; the count lets the UI
    // say "Settings (first area)" instead of implying coverage.
    expect(multi.settingsLine).toBe("Thermolysis");
    const single = buildLastSessionSummary({
      blocks: [block({ primary_area: "Chin" })],
      nextSessionNote: null,
    });
    expect(single.blockCount).toBe(1);
    const none = buildLastSessionSummary({ blocks: [], nextSessionNote: null });
    expect(none.blockCount).toBe(0);
  });
});

describe("next-session note", () => {
  it("passes the previous visit's note through trimmed", () => {
    const s = buildLastSessionSummary({
      blocks: [],
      nextSessionNote: "  Start lower on the upper lip. ",
    });
    expect(s.nextSessionNote).toBe("Start lower on the upper lip.");
  });
});
