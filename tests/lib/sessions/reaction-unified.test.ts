import { describe, expect, it } from "vitest";
import {
  reactionLabelsFromChips,
  unifiedReactionLabels,
  effectiveReactionLabel,
  notableReactionLabel,
  hasAnyReaction,
} from "@/lib/sessions/reaction-unified";
import { toggleFindingChip, hydrateLegacyChips } from "@/lib/observation-chips";
import { buildClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";
import { buildTreatmentIntelligence } from "@/lib/sessions/treatment-intelligence";
import {
  buildLastSessionSummary,
  type ClinicalSummaryBlock,
} from "@/lib/sessions/clinical-summary";

// Charting UNIFICATION — patient-safety regression coverage. Reactions come from
// the union of legacy session_blocks.reaction_type AND canonical reaction chips
// in electrolysis_entries.observation_chips. These prove every reaction-driven
// surface reads the unified representation, with severity + "no visible reaction"
// semantics preserved and no reaction guessed from ordinary observation chips.

describe("unified reaction helpers", () => {
  it("classifies reactions ONLY by the canonical reaction labels, never ordinary observation chips", () => {
    // "Redness (erythema)" / "Sensitive skin" are OBSERVATION chips, not reactions.
    expect(reactionLabelsFromChips(["Coarse hair", "Redness (erythema)", "Sensitive skin"])).toEqual([]);
    expect(reactionLabelsFromChips(["Swelling", "Coarse hair"])).toEqual(["Swelling"]);
  });

  it("(1) historical reaction_type is a reaction signal", () => {
    expect(notableReactionLabel("swelling", [])).toBe("Swelling");
    expect(hasAnyReaction("mild_redness", [])).toBe(true);
  });

  it("(2) a reaction captured only in observation_chips is a reaction signal", () => {
    expect(notableReactionLabel(null, [["Irritation"]])).toBe("Irritation");
    expect(hasAnyReaction(null, [["Mild redness"]])).toBe(true);
  });

  it("(3) the same reaction in both fields is deduplicated", () => {
    expect(unifiedReactionLabels("swelling", [["Swelling", "Coarse hair"]])).toEqual(["Swelling"]);
  });

  it("(4) ordinary observation chips never create a reaction signal", () => {
    expect(notableReactionLabel(null, [["Coarse hair", "Ingrown hair"]])).toBeNull();
    expect(hasAnyReaction(null, [["Coarse hair"]])).toBe(false);
  });

  it("(5) 'No visible reaction' is never notable and never suppresses a real reaction", () => {
    expect(notableReactionLabel("none", [])).toBeNull();
    expect(notableReactionLabel(null, [["No visible reaction"]])).toBeNull();
    // none + a real reaction → the real reaction still surfaces.
    expect(notableReactionLabel(null, [["No visible reaction", "Swelling"]])).toBe("Swelling");
    // effective label doesn't get stuck on "No visible reaction" alone.
    expect(unifiedReactionLabels(null, [["No visible reaction", "Swelling"]])).toEqual([
      "No visible reaction",
      "Swelling",
    ]);
  });

  it("(6) multiple reaction chips retain ALL of them", () => {
    expect(unifiedReactionLabels(null, [["Mild redness", "Swelling", "Coarse hair"]])).toEqual([
      "Mild redness",
      "Swelling",
    ]);
  });

  it("(7) attention picks the HIGHEST-severity notable by the explicit enum order (not wording)", () => {
    // enum order: mild_redness < moderate_redness < swelling < sensitivity < irritation
    expect(notableReactionLabel(null, [["Moderate redness", "Irritation"]])).toBe("Irritation");
    expect(notableReactionLabel("moderate_redness", [["Swelling"]])).toBe("Swelling");
    // mild_redness is NOT notable.
    expect(notableReactionLabel("mild_redness", [])).toBeNull();
  });

  it("effectiveReactionLabel prefers legacy reaction_type, else the first reaction chip", () => {
    expect(effectiveReactionLabel("mild_redness", [["Swelling"]])).toBe("Mild redness");
    expect(effectiveReactionLabel(null, [["Swelling", "Irritation"]])).toBe("Swelling");
  });
});

describe("toggleFindingChip — prevents contradictory reaction combinations", () => {
  it("selecting 'No visible reaction' removes any real reaction chips", () => {
    expect(toggleFindingChip(["Swelling", "Coarse hair"], "No visible reaction")).toEqual([
      "Coarse hair",
      "No visible reaction",
    ]);
  });
  it("selecting a real reaction removes 'No visible reaction'", () => {
    expect(toggleFindingChip(["No visible reaction", "Coarse hair"], "Swelling")).toEqual([
      "Coarse hair",
      "Swelling",
    ]);
  });
  it("multiple REAL reactions may coexist", () => {
    expect(toggleFindingChip(["Mild redness", "Coarse hair"], "Swelling")).toEqual([
      "Mild redness",
      "Coarse hair",
      "Swelling",
    ]);
  });
  it("ordinary observation chips toggle freely and never affect reactions", () => {
    expect(toggleFindingChip(["Swelling"], "Coarse hair")).toEqual(["Swelling", "Coarse hair"]);
  });
  it("deselecting never triggers exclusivity", () => {
    expect(toggleFindingChip(["Swelling", "No visible reaction"], "No visible reaction")).toEqual([
      "Swelling",
    ]);
  });
});

describe("legacy comments hydration NEVER string-guesses a reaction from free text", () => {
  it("an observation token still promotes to a chip", () => {
    expect(hydrateLegacyChips("Coarse hair, tender near jaw").chips).toEqual(["Coarse hair"]);
  });
  it("a free-text token equal to a reaction label stays as free-text, not a coded reaction", () => {
    const r = hydrateLegacyChips("Swelling, tender");
    expect(r.chips).toEqual([]); // "Swelling" NOT promoted to a reaction chip
    expect(r.freeText).toContain("Swelling");
  });
});

// ---- Consumer builders read the unified representation ----------------------
const SESSION = {
  id: "s1",
  client_id: "c1",
  client_name: "A",
  started_at: "2026-06-01T10:00:00Z",
  next_session_note: null,
};

describe("Clients needing attention — unified", () => {
  function block(over: Partial<Parameters<typeof buildClientsNeedingAttention>[1][number]> = {}) {
    return {
      session_id: "s1",
      caution_for_next_session: false,
      caution_note: null,
      reaction_type: null,
      tolerance_rating: null,
      observation_chips_list: [],
      ...over,
    };
  }
  it("(1) historical reaction_type still flags the client", () => {
    const r = buildClientsNeedingAttention([SESSION], [block({ reaction_type: "swelling" })], { limit: 5, scanCapped: false });
    expect(r.clients[0]?.notableReactionLabel).toBe("Swelling");
  });
  it("(2) a reaction only in observation_chips also flags the client", () => {
    const r = buildClientsNeedingAttention([SESSION], [block({ observation_chips_list: [["Irritation"]] })], { limit: 5, scanCapped: false });
    expect(r.clients[0]?.notableReactionLabel).toBe("Irritation");
  });
  it("(4) ordinary observation chips do NOT flag; (5) 'No visible reaction' does NOT flag", () => {
    const r = buildClientsNeedingAttention(
      [SESSION],
      [block({ observation_chips_list: [["Coarse hair", "No visible reaction"]] })],
      { limit: 5, scanCapped: false },
    );
    expect(r.clients[0]?.notableReactionLabel ?? null).toBeNull();
  });
});

describe("Treatment intelligence — unified", () => {
  function block(over = {}) {
    return {
      session_id: "s1",
      primary_area: "Chin",
      block_name: null,
      mode: "blend",
      apilus_modality: null,
      energy_level: null,
      machine_frequency: null,
      probe_label: null,
      minutes_performed: null,
      tolerance_rating: null,
      reaction_type: null,
      observation_chips_list: [],
      caution_for_next_session: false,
      caution_note: null,
      entry_hairs: [],
      ...over,
    };
  }
  it("(10) latest reaction reads the unified representation and retains all", () => {
    const intel = buildTreatmentIntelligence({
      sessionsNewestFirst: [{ id: "s1", started_at: "2026-06-01T10:00:00Z", electrolysis_entries: [], laser_entries: [] }],
      blocks: [block({ observation_chips_list: [["Mild redness", "Swelling"]] })],
    });
    expect(intel.latestReactionLabel).toBe("Mild redness, Swelling");
  });
  it("legacy reaction_type still summarized", () => {
    const intel = buildTreatmentIntelligence({
      sessionsNewestFirst: [{ id: "s1", started_at: "2026-06-01T10:00:00Z", electrolysis_entries: [], laser_entries: [] }],
      blocks: [block({ reaction_type: "swelling" })],
    });
    expect(intel.latestReactionLabel).toBe("Swelling");
    expect(intel.commonReactionLabel).toBe("Swelling");
  });
});

describe("Clinical summary — unified reaction line", () => {
  function block(over: Partial<ClinicalSummaryBlock> = {}): ClinicalSummaryBlock {
    return {
      sort_order: 1,
      block_name: null,
      primary_area: "Chin",
      side: null,
      custom_area_detail: null,
      mode: "blend",
      apilus_modality: null,
      energy_level: null,
      minutes_performed: null,
      probe_label: null,
      tolerance_rating: null,
      reaction_type: null,
      reaction_notes: null,
      caution_for_next_session: false,
      caution_note: null,
      observation_chips_list: [],
      ...over,
    };
  }
  it("(11) reads reactions from observation_chips too, retaining all", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ observation_chips_list: [["Mild redness", "Swelling"]] })],
      nextSessionNote: null,
    });
    expect(s.areas[0]?.reactionLine).toBe("Mild redness, Swelling");
  });
  it("legacy reaction_type still shows", () => {
    const s = buildLastSessionSummary({
      blocks: [block({ reaction_type: "irritation" })],
      nextSessionNote: null,
    });
    expect(s.areas[0]?.reactionLine).toBe("Irritation");
  });
});
