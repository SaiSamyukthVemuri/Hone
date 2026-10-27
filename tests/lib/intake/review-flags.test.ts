import { describe, expect, it } from "vitest";
import {
  deriveIntakeReviewFlags,
  LEVEL_WORDING,
  type IntakeReviewFlag,
} from "@/lib/intake/review-flags";

// PR #266. Pure derivation of practitioner-only intake review flags from a
// single intake's `responses` map. No I/O. Hone surfaces intake answers for
// review only — these tests pin which existing answers surface, the allowed
// wording, and that NO forbidden clinical-decision language ever appears in
// the derived output.

const FORBIDDEN =
  /\bsafe\b|\bunsafe\b|\bcleared\b|\bapproved\b|do not treat|contraindicat|diagnos|clinically verified|recommended treatment/i;

function texts(flags: IntakeReviewFlag[]): string {
  return flags.map((f) => `${f.wording} ${f.category} ${f.basis}`).join("\n");
}

describe("deriveIntakeReviewFlags — empty / legacy", () => {
  it("returns [] for null/undefined/empty/non-object and never throws", () => {
    expect(deriveIntakeReviewFlags(null)).toEqual([]);
    expect(deriveIntakeReviewFlags(undefined)).toEqual([]);
    expect(deriveIntakeReviewFlags({})).toEqual([]);
    expect(deriveIntakeReviewFlags({ unrelated: "x" })).toEqual([]);
  });

  it("returns [] when nothing reviewable is selected (incl. the NONE sentinel)", () => {
    expect(
      deriveIntakeReviewFlags({
        medical_conditions: ["__none__"],
        medications_list: ["__none__"],
        scarring_tendency: "never",
        active_cold_sore: "no",
        recent_sun: "no",
      }),
    ).toEqual([]);
  });
});

describe("deriveIntakeReviewFlags — mapping + levels", () => {
  it("maps a high-stakes condition to 'Medical authorization may be required'", () => {
    const flags = deriveIntakeReviewFlags({ medical_conditions: ["pacemaker"] });
    expect(flags).toHaveLength(1);
    expect(flags[0].level).toBe("authorization");
    expect(flags[0].wording).toBe("Medical authorization may be required");
    expect(flags[0].id).toBe("medical_conditions:pacemaker");
    expect(flags[0].basis).toMatch(/^Based on intake response: /);
    expect(flags[0].basis).toMatch(/Pacemaker or implanted defibrillator/);
  });

  it("maps Accutane to 'Review before treatment'", () => {
    const flags = deriveIntakeReviewFlags({ medications_list: ["accutane"] });
    expect(flags).toHaveLength(1);
    expect(flags[0].level).toBe("review");
    expect(flags[0].wording).toBe("Review before treatment");
  });

  it("maps a chronic condition to 'Precaution noted'", () => {
    const flags = deriveIntakeReviewFlags({ medical_conditions: ["diabetes"] });
    expect(flags).toHaveLength(1);
    expect(flags[0].level).toBe("precaution");
    expect(flags[0].wording).toBe("Precaution noted");
  });

  it("derives single_select and yes_no signals", () => {
    expect(
      deriveIntakeReviewFlags({ scarring_tendency: "easily" })[0].level,
    ).toBe("review");
    expect(deriveIntakeReviewFlags({ scarring_tendency: "never" })).toEqual([]);
    expect(deriveIntakeReviewFlags({ active_cold_sore: "yes" })[0].level).toBe(
      "review",
    );
    expect(deriveIntakeReviewFlags({ active_cold_sore: "no" })).toEqual([]);
    expect(
      deriveIntakeReviewFlags({ recent_self_tanner: "yes" })[0].level,
    ).toBe("precaution");
  });

  it("orders authorization → review → precaution regardless of input order", () => {
    const flags = deriveIntakeReviewFlags({
      medical_conditions: ["diabetes", "pacemaker", "recent_surgery"],
    });
    expect(flags.map((f) => f.level)).toEqual([
      "authorization",
      "review",
      "precaution",
    ]);
  });

  it("derives one flag per matched option across questions", () => {
    const flags = deriveIntakeReviewFlags({
      medical_conditions: ["pregnancy", "thyroid"],
      medications_list: ["blood_thinners", "accutane"],
      current_skin_issues: "yes",
    });
    const ids = flags.map((f) => f.id);
    expect(ids).toContain("medical_conditions:pregnancy");
    expect(ids).toContain("medical_conditions:thyroid");
    expect(ids).toContain("medications_list:blood_thinners");
    expect(ids).toContain("medications_list:accutane");
    expect(ids).toContain("current_skin_issues:yes");
    expect(flags).toHaveLength(5);
  });
});

describe("deriveIntakeReviewFlags — wording safety", () => {
  it("uses only the allowed level wording", () => {
    expect(Object.values(LEVEL_WORDING)).toEqual([
      "Medical authorization may be required",
      "Review before treatment",
      "Precaution noted",
    ]);
  });

  it("never emits forbidden clinical-decision language for a kitchen-sink intake", () => {
    const flags = deriveIntakeReviewFlags({
      medical_conditions: [
        "pacemaker",
        "heart",
        "pregnancy",
        "cancer",
        "metal_implants",
        "recent_surgery",
        "epilepsy",
        "diabetes",
        "thyroid",
        "pcos",
        "lupus_autoimmune",
        "blood_borne",
        "skin_condition",
        "other",
      ],
      medications_list: [
        "accutane",
        "blood_thinners",
        "topical_retinoid",
        "steroids",
        "immunosuppressants",
        "acne_meds",
        "antibiotics",
        "hormone_therapy",
      ],
      scarring_tendency: "easily",
      active_cold_sore: "yes",
      recent_sun: "yes",
      skin_sensitizing_products: "yes",
      current_skin_issues: "yes",
      recent_self_tanner: "yes",
      cold_sore_tendency: "yes",
    });
    expect(flags.length).toBeGreaterThan(20);
    expect(texts(flags)).not.toMatch(FORBIDDEN);
    for (const f of flags) {
      expect(f.basis).toMatch(/^Based on intake response: /);
    }
  });
});

describe("0246 issued evidence labels with unchanged current clinical guidance", () => {
  it("uses issued question and option text after current labels change, without changing severity or badges", async () => {
    const { ISSUED_QUESTIONNAIRE, questionnaireForRow } = await import("@/lib/intake/questionnaire");
    const { getQuestionByKey } = await import("@/lib/intake/questions");
    const q = getQuestionByKey("medical_conditions")!;
    const option = q.options!.find(o => o.value === "pacemaker")!;
    const before = { question: q.label, option: option.label };
    const responses = { medical_conditions: ["pacemaker"] };
    const issued = questionnaireForRow(structuredClone(ISSUED_QUESTIONNAIRE));
    const original = deriveIntakeReviewFlags(responses, issued.steps);
    try {
      q.label = "Different current question"; option.label = "Different current option";
      expect(deriveIntakeReviewFlags(responses, issued.steps)).toEqual(original);
      expect(original[0].basis).toContain(before.question);
      expect(original[0].basis).toContain(before.option);
      expect(deriveIntakeReviewFlags(responses)[0].basis).toContain("Different current question");
      // Missing provenance does not hide a clinical alert or invent old words.
      const unknown = deriveIntakeReviewFlags(responses, []);
      expect(unknown[0].id).toBe(original[0].id);
      expect(unknown[0].badges).toEqual(original[0].badges);
      expect(unknown[0].basis).toContain("medical_conditions, pacemaker");
    } finally { q.label = before.question; option.label = before.option; }
  });
});
