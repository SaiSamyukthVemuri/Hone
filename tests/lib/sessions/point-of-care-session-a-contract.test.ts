import { describe, expect, it } from "vitest";
import {
  buildPointOfCareMemory,
  type PointOfCareBlock,
  type PointOfCareEntry,
} from "@/lib/sessions/point-of-care-memory";
import {
  notableReactionLabel,
  unifiedReactionLabels,
} from "@/lib/sessions/reaction-unified";
import {
  SAFETY_RESPONSE_LABELS,
  isClinicalResponseLabel,
} from "@/lib/sessions/clinical-response";

// SESSION 1A × SESSION 1B INTEGRATION.
//
// Session 1A widened the clinical-response classifier: the three safety-relevant
// chips, "Redness (erythema)", "Slight swelling (edema)", "Sensitive skin",
// carry response meaning even though they have no coded enum member of their
// own, and they rank through a declared coded PEER.
//
// The point-of-care memory card must CONSUME that contract, not re-implement it.
// It has no classifier of its own: buildPointOfCareMemory calls
// unifiedReactionLabels, so a change to 1A's central helper flows straight into
// the card. These tests assert exactly that seam, if the classifier is ever
// narrowed again, or if the memory card grows a second copy of the vocabulary,
// they go red.
//
// The severity/notability RULES themselves are Session 1A's and are tested in
// tests/lib/sessions/reaction-unified.test.ts. What is pinned here is that the
// memory surface reproduces them faithfully.

function entry(over: Partial<PointOfCareEntry> = {}): PointOfCareEntry {
  return {
    created_at: "2026-01-01T10:00:00Z",
    deleted_at: null,
    mode: "blend",
    ...over,
  };
}

function memoryWith(
  chips: string[],
  over: Partial<PointOfCareBlock> = {},
) {
  return buildPointOfCareMemory({
    session: {
      id: "s-prev",
      started_at: "2026-01-01T10:00:00Z",
      modality: "electrolysis",
    },
    blocks: [
      {
        id: "b1",
        sort_order: 1,
        primary_area: "Chin",
        entries: [entry({ observation_chips: chips })],
        ...over,
      },
    ],
  });
}

describe("the three Session 1A safety-response chips reach point-of-care memory", () => {
  it("Redness (erythema) appears in the response line", () => {
    const m = memoryWith(["Redness (erythema)"]);
    expect(m.areas[0].responseLine).toBe("Redness (erythema)");
  });

  it("Redness (erythema) does NOT become notable merely because it is displayed", () => {
    // Visibility and notability are separate decisions. Redness's declared peer
    // is `mild_redness`, which is deliberately not in the attention set, so
    // surfacing it on the memory card must not escalate the client.
    const chips = ["Redness (erythema)"];
    const m = memoryWith(chips);
    expect(m.areas[0].responseLine).toBe("Redness (erythema)");
    expect(notableReactionLabel(null, [chips])).toBeNull();
  });

  it("Slight swelling (edema) appears in the response line", () => {
    const m = memoryWith(["Slight swelling (edema)"]);
    expect(m.areas[0].responseLine).toBe("Slight swelling (edema)");
  });

  it("Sensitive skin appears in the response line", () => {
    const m = memoryWith(["Sensitive skin"]);
    expect(m.areas[0].responseLine).toBe("Sensitive skin");
  });

  it("all three arrive together, in chip order, none collapsed away", () => {
    const m = memoryWith([
      "Redness (erythema)",
      "Slight swelling (edema)",
      "Sensitive skin",
    ]);
    expect(m.areas[0].responseLine).toBe(
      "Redness (erythema), Slight swelling (edema), Sensitive skin",
    );
  });

  it("covers the WHOLE of Session 1A's declared safety-response set", () => {
    // Guards against 1A adding a fourth label that the memory card silently
    // never renders.
    for (const label of SAFETY_RESPONSE_LABELS) {
      const m = memoryWith([label]);
      expect(m.areas[0].responseLine).toBe(label);
    }
  });
});

describe("ordinary morphology chips stay out of the response line", () => {
  it("Coarse hair is not a response", () => {
    expect(isClinicalResponseLabel("Coarse hair")).toBe(false);
    const m = memoryWith(["Coarse hair"]);
    expect(m.areas[0].responseLine).toBeNull();
  });

  it("a mixed chip set keeps only the response members", () => {
    const m = memoryWith([
      "Coarse hair",
      "Deep follicles",
      "Sensitive skin",
      "Lots of anagen",
    ]);
    expect(m.areas[0].responseLine).toBe("Sensitive skin");
  });

  it("never substring-matches a clinically distinct chip", () => {
    // "Follicular erythema" is a laser-list term and must NEVER be folded in by
    // an includes("erythema") style check.
    expect(isClinicalResponseLabel("Follicular erythema")).toBe(false);
    const m = memoryWith(["Follicular erythema"]);
    expect(m.areas[0].responseLine).toBeNull();
  });
});

describe("a legacy 'none' never suppresses a real recorded response", () => {
  it("legacy reaction_type='none' + Sensitive skin chip surfaces the real response", () => {
    const m = memoryWith(["Sensitive skin"], { reaction_type: "none" });
    // Both are retained: the historical coded value AND the real response.
    expect(m.areas[0].responseLine).toContain("Sensitive skin");
    // And the contradictory "No visible reaction" does not stand alone.
    expect(m.areas[0].responseLine).not.toBe("No visible reaction");
  });

  it("the real response is still the NOTABLE one despite the legacy 'none'", () => {
    const chips = ["Sensitive skin"];
    expect(notableReactionLabel("none", [chips])).toBe("Sensitive skin");
  });

  it("legacy 'none' with only ordinary chips stays a plain no-reaction record", () => {
    const m = memoryWith(["Coarse hair"], { reaction_type: "none" });
    expect(m.areas[0].responseLine).toBe("No visible reaction");
    expect(notableReactionLabel("none", [["Coarse hair"]])).toBeNull();
  });
});

describe("the memory card consumes the shared helper, it does not fork it", () => {
  it("the card's response line is exactly unifiedReactionLabels, joined", () => {
    const chips = ["Redness (erythema)", "Coarse hair", "Sensitive skin"];
    const m = memoryWith(chips, { reaction_type: "irritation" });
    expect(m.areas[0].responseLine).toBe(
      unifiedReactionLabels("irritation", [chips]).join(", "),
    );
  });

  it("a widened classifier flows through without touching the memory module", () => {
    // The seam itself: every label 1A declares a response is one the card shows.
    for (const label of SAFETY_RESPONSE_LABELS) {
      expect(isClinicalResponseLabel(label)).toBe(true);
      expect(unifiedReactionLabels(null, [[label]])).toEqual([label]);
      expect(memoryWith([label]).areas[0].responseLine).toBe(label);
    }
  });

  it("soft-deleted passes still contribute nothing, safety chips included", () => {
    const m = buildPointOfCareMemory({
      session: {
        id: "s-prev",
        started_at: "2026-01-01T10:00:00Z",
        modality: "electrolysis",
      },
      blocks: [
        {
          id: "b1",
          sort_order: 1,
          entries: [
            entry({
              deleted_at: "2026-01-02T00:00:00Z",
              observation_chips: ["Sensitive skin"],
            }),
          ],
        },
      ],
    });
    expect(m.areas[0].responseLine).toBeNull();
  });
});
