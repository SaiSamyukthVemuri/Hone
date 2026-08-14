import { describe, expect, it } from "vitest";
import {
  deriveIntakeReviewFlags,
  MODALITY_WORDING,
  type IntakeModality,
  type IntakeReviewFlag,
} from "@/lib/intake/review-flags";

// PR #267. Modality/category badges derived from Chloe's clinic reference
// chart, attached to the existing PR #266 flags. Badges are surfaced for
// review only, never a treatment decision. These tests pin the chart mapping,
// that unmapped rows are NOT invented, that free text is never parsed, and that
// only the allowed wording reaches the badges.

const FORBIDDEN =
  /\bsafe\b|\bunsafe\b|\bcleared\b|\bapproved\b|do not treat|diagnos|clinically verified|recommended treatment/i;

function flagFor(
  responses: Record<string, unknown>,
  id: string,
): IntakeReviewFlag | undefined {
  return deriveIntakeReviewFlags(responses).find((f) => f.id === id);
}
function badges(responses: Record<string, unknown>, id: string): IntakeModality[] {
  return flagFor(responses, id)?.badges ?? [];
}

describe("modality badges: chart-mapped conditions", () => {
  it("heart problem / pacemaker → continuous/galvanic + medical authorization", () => {
    expect(badges({ medical_conditions: ["heart"] }, "medical_conditions:heart")).toEqual([
      "authorization",
      "galvanic",
    ]);
    expect(
      badges({ medical_conditions: ["pacemaker"] }, "medical_conditions:pacemaker"),
    ).toEqual(["authorization", "galvanic"]);
  });

  it("pregnancy → continuous/galvanic + medical authorization", () => {
    expect(
      badges({ medical_conditions: ["pregnancy"] }, "medical_conditions:pregnancy"),
    ).toEqual(["authorization", "galvanic"]);
  });

  it("controlled epilepsy → continuous/galvanic + medical authorization", () => {
    expect(
      badges({ medical_conditions: ["epilepsy"] }, "medical_conditions:epilepsy"),
    ).toEqual(["authorization", "galvanic"]);
  });

  it("cancer → continuous/galvanic + medical authorization (chemo/radiotherapy not invented)", () => {
    expect(badges({ medical_conditions: ["cancer"] }, "medical_conditions:cancer")).toEqual([
      "authorization",
      "galvanic",
    ]);
  });

  it("hepatitis / HIV / blood-borne → thermolysis + continuous/galvanic", () => {
    expect(
      badges({ medical_conditions: ["blood_borne"] }, "medical_conditions:blood_borne"),
    ).toEqual(["thermolysis", "galvanic"]);
  });

  it("diabetes (generic field, type unknown) → conservative union of all diabetes rows", () => {
    expect(
      badges({ medical_conditions: ["diabetes"] }, "medical_conditions:diabetes"),
    ).toEqual(["authorization", "thermolysis", "galvanic", "precaution"]);
  });

  it("blood thinners → prolonged-bleeding row: medical authorization + precaution", () => {
    expect(
      badges({ medications_list: ["blood_thinners"] }, "medications_list:blood_thinners"),
    ).toEqual(["authorization", "precaution"]);
  });
});

describe("modality badges: unmapped rows are NOT invented", () => {
  it("metal implants has no chart modality badges (generic review fallback only)", () => {
    // The chart's only implant row is the specific 'retinal implant'; the
    // intake field is generic 'metal implants' → no chart mapping.
    expect(
      badges({ medical_conditions: ["metal_implants"] }, "medical_conditions:metal_implants"),
    ).toEqual(["review"]);
  });

  it("recent surgery (no chart row) → generic review fallback only", () => {
    expect(
      badges({ medical_conditions: ["recent_surgery"] }, "medical_conditions:recent_surgery"),
    ).toEqual(["review"]);
  });

  it("a precaution-level non-chart condition → precaution fallback only", () => {
    expect(badges({ medical_conditions: ["thyroid"] }, "medical_conditions:thyroid")).toEqual([
      "precaution",
    ]);
  });

  it("a non-chart review medication → review fallback only (no thermolysis/galvanic invented)", () => {
    const b = badges({ medications_list: ["accutane"] }, "medications_list:accutane");
    expect(b).toEqual(["review"]);
    expect(b).not.toContain("thermolysis");
    expect(b).not.toContain("galvanic");
  });
});

describe("modality badges: free text is never parsed", () => {
  it("a prescription named only in free-text notes produces no flag/badges", () => {
    expect(
      deriveIntakeReviewFlags({
        taking_prescriptions: "yes",
        taking_prescriptions_notes: "warfarin (a blood thinner)",
      }),
    ).toEqual([]);
  });

  it("no structured mapped answers → no flags", () => {
    expect(
      deriveIntakeReviewFlags({ medical_conditions: ["__none__"], medications_list: ["__none__"] }),
    ).toEqual([]);
  });
});

describe("modality badges: wording safety", () => {
  it("MODALITY_WORDING uses only the allowed chart phrases", () => {
    expect(MODALITY_WORDING.thermolysis).toBe("Review before thermolysis");
    expect(MODALITY_WORDING.galvanic).toBe("Review before continuous/galvanic current");
    expect(MODALITY_WORDING.authorization).toBe("Medical authorization may be required");
    expect(MODALITY_WORDING.precaution).toBe("Precaution noted");
    expect(MODALITY_WORDING.authorization_depends).toBe(
      "Authorization depends on practitioner review",
    );
  });

  it("no forbidden clinical-decision wording in any badge wording", () => {
    for (const w of Object.values(MODALITY_WORDING)) {
      expect(w).not.toMatch(FORBIDDEN);
      expect(w).not.toMatch(/contraindicat/i);
    }
  });

  it("every derived badge resolves to an allowed wording string, for a kitchen-sink intake", () => {
    const flags = deriveIntakeReviewFlags({
      medical_conditions: [
        "heart",
        "pacemaker",
        "pregnancy",
        "epilepsy",
        "cancer",
        "blood_borne",
        "diabetes",
        "metal_implants",
        "thyroid",
      ],
      medications_list: ["blood_thinners", "accutane"],
      active_cold_sore: "yes",
    });
    const allowed = new Set(Object.values(MODALITY_WORDING));
    for (const f of flags) {
      expect(f.badges.length).toBeGreaterThan(0);
      for (const b of f.badges) {
        expect(allowed.has(MODALITY_WORDING[b])).toBe(true);
        expect(MODALITY_WORDING[b]).not.toMatch(FORBIDDEN);
      }
    }
  });
});
