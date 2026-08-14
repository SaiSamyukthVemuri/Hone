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

// Charting UNIFICATION: patient-safety regression coverage. Reactions come from
// the union of legacy session_blocks.reaction_type AND canonical reaction chips
// in electrolysis_entries.observation_chips. These prove every reaction-driven
// surface reads the unified representation, with severity + "no visible reaction"
// semantics preserved and no reaction guessed from ordinary observation chips.

describe("unified reaction helpers", () => {
  // SUPERSEDED BY Chloe Session 1A. This test previously asserted that
  // "Redness (erythema)" and "Sensitive skin" are ordinary observation chips and
  // yield NO response signal, which was the defect: they sit in the same merged
  // findings box, describe a real skin response, and were invisible to every
  // safety surface. They are now safety-relevant response labels.
  //
  // The half of the guarantee that MUST survive is the other half: a chip that
  // describes hair or follicle morphology is never a clinical response, and
  // nothing is string-guessed.
  it("classifies responses by the EXPLICIT contract, coded labels plus the safety-relevant labels", () => {
    expect(
      reactionLabelsFromChips(["Coarse hair", "Redness (erythema)", "Sensitive skin"]),
    ).toEqual(["Redness (erythema)", "Sensitive skin"]);
    expect(reactionLabelsFromChips(["Swelling", "Coarse hair"])).toEqual(["Swelling"]);
  });

  it("ordinary observation chips are still NEVER a response signal", () => {
    expect(
      reactionLabelsFromChips([
        "Coarse hair",
        "Fine hair",
        "Deep follicles",
        "Curved follicles",
        "Shallow follicles",
        "Dehydrated follicles",
        "Lots of anagen",
        "Lots of catagen",
        "Lots of telogen",
        "Client tolerated well",
        "Hyperpigmentation",
      ]),
    ).toEqual([]);
  });

  it("never substring-matches a clinically distinct label into a response", () => {
    // The laser vocabulary's "Follicular erythema" / "Follicular edema" are
    // DIFFERENT findings. They are not canonical electrolysis chips at all, so
    // normalizeChips drops them, and they must never be folded into
    // "Redness (erythema)" / "Slight swelling (edema)" by a substring test.
    expect(reactionLabelsFromChips(["Follicular erythema"])).toEqual([]);
    expect(reactionLabelsFromChips(["Follicular edema"])).toEqual([]);
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

  // -------------------------------------------------------------------------
  // Chloe Session 1A, SAFETY-RELEVANT RESPONSE LABELS
  // -------------------------------------------------------------------------
  // These three sit in the same merged findings box as the coded reactions and
  // describe a real skin response. Before this contract they were classified as
  // ordinary observations and reached NO safety surface.

  it("A1 each safety-relevant label is a clinical response signal", () => {
    for (const label of [
      "Redness (erythema)",
      "Slight swelling (edema)",
      "Sensitive skin",
    ]) {
      expect(reactionLabelsFromChips([label])).toEqual([label]);
      expect(hasAnyReaction(null, [[label]])).toBe(true);
      expect(unifiedReactionLabels(null, [[label]])).toEqual([label]);
    }
  });

  it("A2 severity follows the EXISTING enum ordering via each label's coded peer", () => {
    // Slight swelling (edema) -> swelling; Sensitive skin -> sensitivity.
    // enum order: ... swelling(3) < sensitivity(4) < irritation(5)
    expect(notableReactionLabel(null, [["Slight swelling (edema)"]])).toBe(
      "Slight swelling (edema)",
    );
    expect(notableReactionLabel(null, [["Sensitive skin"]])).toBe("Sensitive skin");
    // Sensitivity outranks swelling, so the sensitive-skin label wins.
    expect(
      notableReactionLabel(null, [["Slight swelling (edema)", "Sensitive skin"]]),
    ).toBe("Sensitive skin");
    // Irritation still outranks both.
    expect(
      notableReactionLabel(null, [["Sensitive skin", "Irritation"]]),
    ).toBe("Irritation");
  });

  it("A3 Redness (erythema) is a response but NOT notable, it maps to mild_redness", () => {
    // Visible on the response surfaces...
    expect(hasAnyReaction(null, [["Redness (erythema)"]])).toBe(true);
    expect(unifiedReactionLabels(null, [["Redness (erythema)"]])).toEqual([
      "Redness (erythema)",
    ]);
    // ...but it does NOT raise a dashboard alert, exactly as the coded
    // "Mild redness" chip already behaves. Promoting an unqualified redness
    // chip to "moderate" would assert an intensity nobody recorded.
    expect(notableReactionLabel(null, [["Redness (erythema)"]])).toBeNull();
    expect(notableReactionLabel("mild_redness", [])).toBeNull();
  });

  it("A4 legacy spellings resolve through the alias map and classify identically", () => {
    // Stored legacy tokens, pre-relabel.
    expect(reactionLabelsFromChips(["Erythema"])).toEqual(["Redness (erythema)"]);
    expect(reactionLabelsFromChips(["Redness"])).toEqual(["Redness (erythema)"]);
    expect(reactionLabelsFromChips(["Slight edema"])).toEqual([
      "Slight swelling (edema)",
    ]);
    expect(reactionLabelsFromChips(["Slight swelling"])).toEqual([
      "Slight swelling (edema)",
    ]);
    // ...and the alias form is notable exactly like its canonical form.
    expect(notableReactionLabel(null, [["Slight edema"]])).toBe(
      "Slight swelling (edema)",
    );
  });

  it("A5 'No visible reaction' never suppresses a safety-relevant response", () => {
    // Historical contradictory data: legacy block says none, the entry chip
    // records a real response. The real response must win.
    expect(
      notableReactionLabel("none", [["Slight swelling (edema)"]]),
    ).toBe("Slight swelling (edema)");
    expect(effectiveReactionLabel("none", [["Redness (erythema)"]])).toBe(
      "Redness (erythema)",
    );
    expect(
      effectiveReactionLabel(null, [["No visible reaction", "Sensitive skin"]]),
    ).toBe("Sensitive skin");
    // Alone, it is still not a response signal and not an alert.
    expect(effectiveReactionLabel("none", [])).toBe("No visible reaction");
    expect(notableReactionLabel("none", [])).toBeNull();
  });

  it("A6 multiple responses across mixed sources are all retained and deduped", () => {
    expect(
      unifiedReactionLabels("swelling", [
        ["Redness (erythema)", "Coarse hair"],
        ["Sensitive skin", "Swelling"],
      ]),
    ).toEqual(["Swelling", "Redness (erythema)", "Sensitive skin"]);
  });

  it("A7 unknown chip values never become a response", () => {
    expect(reactionLabelsFromChips(["Something nobody defined"])).toEqual([]);
    expect(hasAnyReaction(null, [["Something nobody defined"]])).toBe(false);
    expect(notableReactionLabel(null, [[42, null, { a: 1 }]])).toBeNull();
  });

  it("A8 prose is never guessed into a response; an exact legacy token is not prose", () => {
    // Legacy hydration splits on commas and matches EXACT whole tokens. Prose is
    // never promoted, "client mentioned some redness after" stays free text,
    // and no substring match ever fires.
    const { chips, freeText } = hydrateLegacyChips(
      "Redness (erythema), Coarse hair, client mentioned some redness after",
    );
    // The three safety-relevant labels only ever existed as COMMON_COMMENTS
    // chips written by the old picker, so an exact token IS the practitioner's
    // recorded selection and stays a pill (see the note in hydrateLegacyChips).
    expect(chips).toEqual(["Redness (erythema)", "Coarse hair"]);
    expect(freeText).toBe("client mentioned some redness after");

    // The seven CODED labels had their own column, so a matching comment token
    // is NOT promoted, that would fabricate a coded reaction from prose.
    const coded = hydrateLegacyChips("Swelling, Coarse hair");
    expect(coded.chips).toEqual(["Coarse hair"]);
    expect(coded.freeText).toBe("Swelling");
  });
});

describe("toggleFindingChip: prevents contradictory reaction combinations", () => {
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

describe("Clients needing attention: unified", () => {
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

  // Chloe Session 1A: the whole point of the widened contract: these chips
  // were being recorded and reaching NO safety surface.
  it("D1 a safety-relevant NOTABLE response flags the client", () => {
    for (const label of ["Slight swelling (edema)", "Sensitive skin"]) {
      const r = buildClientsNeedingAttention(
        [SESSION],
        [block({ observation_chips_list: [[label, "Coarse hair"]] })],
        { limit: 5, scanCapped: false },
      );
      expect(r.clients[0]?.notableReactionLabel).toBe(label);
      expect(r.clients[0]?.previewLine).toBe(`Latest recorded reaction: ${label}`);
    }
  });

  it("D2 Redness (erythema) alone does NOT raise a dashboard alert", () => {
    const r = buildClientsNeedingAttention(
      [SESSION],
      [block({ observation_chips_list: [["Redness (erythema)"]] })],
      { limit: 5, scanCapped: false },
    );
    expect(r.totalClients).toBe(0);
  });

  it("D3 a legacy 'none' block never suppresses a safety-relevant response", () => {
    const r = buildClientsNeedingAttention(
      [SESSION],
      [block({ reaction_type: "none", observation_chips_list: [["Sensitive skin"]] })],
      { limit: 5, scanCapped: false },
    );
    expect(r.clients[0]?.notableReactionLabel).toBe("Sensitive skin");
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

describe("Treatment intelligence: unified", () => {
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

  it("D4 safety-relevant responses reach treatment intelligence", () => {
    const intel = buildTreatmentIntelligence({
      sessionsNewestFirst: [{ id: "s1", started_at: "2026-06-01T10:00:00Z", electrolysis_entries: [], laser_entries: [] }],
      blocks: [
        block({
          observation_chips_list: [
            ["Redness (erythema)", "Sensitive skin", "Coarse hair"],
          ],
        }),
      ],
    });
    // Both responses retained, ordinary observation excluded.
    expect(intel.latestReactionLabel).toBe("Redness (erythema), Sensitive skin");
  });
});

describe("Clinical summary: unified reaction line", () => {
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

  // Session B owns lib/sessions/clinical-summary.ts. This PR changes NOTHING in
  // that file, it changes the shared helper the file already calls, so the
  // prior-visit response line picks the three labels up automatically. This test
  // proves that flow-through rather than the file's internals.
  it("D5 the prior-visit response line picks up safety-relevant responses", () => {
    const s = buildLastSessionSummary({
      blocks: [
        block({
          observation_chips_list: [
            ["Slight swelling (edema)", "Lots of anagen"],
          ],
        }),
      ],
      nextSessionNote: null,
    });
    expect(s.areas[0]?.reactionLine).toBe("Slight swelling (edema)");
  });
});
