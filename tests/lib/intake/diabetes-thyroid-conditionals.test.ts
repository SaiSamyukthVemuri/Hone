import { describe, expect, it } from "vitest";
import {
  ALL_QUESTION_KEYS,
  CLIENT_OWNED_RESPONSE_KEYS,
  INTAKE_STEPS,
  PRACTITIONER_ENTERABLE_STEPS,
  findInvalidChoiceAnswers,
  findMissingRequiredAnswers,
  getQuestionByKey,
  getOptionLabel,
  isConditionalSatisfied,
  visibleQuestionsForStep,
  type Question,
} from "@/lib/intake/questions";
import {
  REVIEW_ANSWER_COPY,
  reviewAnswerState,
} from "@/lib/intake/review-answers";

// Diabetes / thyroid subtype conditionals.
//
// Chloe asked for the type when a client reports diabetes or a thyroid
// condition. The parent is NOT a yes/no question — it is one option inside the
// `medical_conditions` multi_select — so "affirmative" means "that option is
// selected", and the child follows the same shape the metal-implants and
// recent-surgery follow-ups already use.
//
// The hard part is not showing the field. It is that ~every intake already in
// the database answered "diabetes" without a type, and none of them may become
// invalid, be rewritten, or be shown to a practitioner as though a type were
// known. That is what most of this file is about.

const MEDICAL_STEP_ID = 3;

function q(key: string): Question {
  const found = getQuestionByKey(key);
  expect(found, `question ${key} not found`).toBeDefined();
  return found!;
}

// A minimal responses map. Nothing here is a complete intake; these tests drive
// the pure predicates, which look only at the keys they are asked about.
function withConditions(...values: string[]): Record<string, unknown> {
  return { medical_conditions: values };
}

describe("1. the question definitions", () => {
  it("adds exactly two questions, both on the Medical step", () => {
    const step = INTAKE_STEPS.find((s) => s.id === MEDICAL_STEP_ID);
    expect(step).toBeDefined();
    const keys = step!.questions.map((qq) => qq.key);
    expect(keys).toContain("diabetes_type");
    expect(keys).toContain("thyroid_type");
  });

  it("places each child immediately after the parent it depends on", () => {
    // Not cosmetic: the client answers the parent and the detail appears right
    // there, and the practitioner review grid renders in this same order.
    const step = INTAKE_STEPS.find((s) => s.id === MEDICAL_STEP_ID)!;
    const keys = step.questions.map((qq) => qq.key);
    expect(keys.indexOf("diabetes_type")).toBe(
      keys.indexOf("medical_conditions") + 1,
    );
    expect(keys.indexOf("thyroid_type")).toBe(
      keys.indexOf("diabetes_type") + 1,
    );
  });

  it("uses single-choice controls with the exact canonical values", () => {
    expect(q("diabetes_type").type).toBe("single_select");
    expect(q("diabetes_type").options?.map((o) => o.value)).toEqual([
      "type_1",
      "type_2",
    ]);
    expect(q("diabetes_type").options?.map((o) => o.label)).toEqual([
      "Type 1",
      "Type 2",
    ]);

    expect(q("thyroid_type").type).toBe("single_select");
    expect(q("thyroid_type").options?.map((o) => o.value)).toEqual([
      "hypothyroidism",
      "hyperthyroidism",
    ]);
    expect(q("thyroid_type").options?.map((o) => o.label)).toEqual([
      "Hypothyroidism",
      "Hyperthyroidism",
    ]);
  });

  it("is required, and conditional on its own parent option only", () => {
    expect(q("diabetes_type").required).toBe(true);
    expect(q("diabetes_type").conditional).toEqual({
      whenKey: "medical_conditions",
      whenEquals: ["diabetes"],
    });

    expect(q("thyroid_type").required).toBe(true);
    expect(q("thyroid_type").conditional).toEqual({
      whenKey: "medical_conditions",
      whenEquals: ["thyroid"],
    });
  });

  it("carries self-contained labels, because review renders them alone", () => {
    // The review grid prints a question's label with no parent question above
    // it. A bare "Type" would be meaningless there.
    for (const key of ["diabetes_type", "thyroid_type"]) {
      const label = q(key).label;
      expect(label.length).toBeGreaterThan(10);
      expect(label.toLowerCase()).toMatch(/diabetes|thyroid/);
    }
  });

  it("leaves the parent question and its options untouched", () => {
    // The whole historical-compatibility argument rests on "diabetes" and
    // "thyroid" still meaning exactly what they meant before.
    const parent = q("medical_conditions");
    expect(parent.type).toBe("multi_select");
    const values = parent.options?.map((o) => o.value) ?? [];
    expect(values).toContain("diabetes");
    expect(values).toContain("thyroid");
    expect(getOptionLabel("medical_conditions", "diabetes")).toBe("Diabetes");
    expect(getOptionLabel("medical_conditions", "thyroid")).toBe(
      "Thyroid disorder (hyper or hypothyroid)",
    );
  });

  it("adds no free-text escape hatch", () => {
    // If either question ever gains a `_notes` prompt or becomes a text type,
    // the enum guarantee below stops being a guarantee.
    for (const key of ["diabetes_type", "thyroid_type"]) {
      expect(q(key).followUpNotesPrompt).toBeUndefined();
    }
  });
});

describe("2. visibility follows the affirmative parent answer", () => {
  it("hides both children when neither condition is selected", () => {
    const visible = visibleQuestionsForStep(
      MEDICAL_STEP_ID,
      withConditions("pcos"),
    ).map((qq) => qq.key);
    expect(visible).not.toContain("diabetes_type");
    expect(visible).not.toContain("thyroid_type");
  });

  it("shows the diabetes child — and ONLY it — when diabetes is selected", () => {
    const visible = visibleQuestionsForStep(
      MEDICAL_STEP_ID,
      withConditions("diabetes"),
    ).map((qq) => qq.key);
    expect(visible).toContain("diabetes_type");
    expect(visible).not.toContain("thyroid_type");
  });

  it("shows the thyroid child — and ONLY it — when thyroid is selected", () => {
    const visible = visibleQuestionsForStep(
      MEDICAL_STEP_ID,
      withConditions("thyroid"),
    ).map((qq) => qq.key);
    expect(visible).toContain("thyroid_type");
    expect(visible).not.toContain("diabetes_type");
  });

  it("shows both when both are selected, alongside other conditions", () => {
    const visible = visibleQuestionsForStep(
      MEDICAL_STEP_ID,
      withConditions("pregnancy", "diabetes", "thyroid", "pcos"),
    ).map((qq) => qq.key);
    expect(visible).toContain("diabetes_type");
    expect(visible).toContain("thyroid_type");
  });

  it("hides both for an intake that never answered the parent at all", () => {
    // The historical shape: no medical_conditions key whatsoever.
    for (const key of ["diabetes_type", "thyroid_type"]) {
      expect(isConditionalSatisfied({}, q(key).conditional)).toBe(false);
    }
  });
});

describe("3. required-ness is conditional, server-side", () => {
  it("does not demand a type when the condition is not reported", () => {
    const missing = findMissingRequiredAnswers(withConditions("pcos"));
    expect(missing).not.toContain("diabetes_type");
    expect(missing).not.toContain("thyroid_type");
  });

  it("demands the diabetes type once diabetes is reported", () => {
    const missing = findMissingRequiredAnswers(withConditions("diabetes"));
    expect(missing).toContain("diabetes_type");
    expect(missing).not.toContain("thyroid_type");
  });

  it("demands the thyroid type once a thyroid condition is reported", () => {
    const missing = findMissingRequiredAnswers(withConditions("thyroid"));
    expect(missing).toContain("thyroid_type");
    expect(missing).not.toContain("diabetes_type");
  });

  it("is satisfied by either canonical value", () => {
    for (const value of ["type_1", "type_2"]) {
      const missing = findMissingRequiredAnswers({
        ...withConditions("diabetes"),
        diabetes_type: value,
      });
      expect(missing, `diabetes_type=${value}`).not.toContain("diabetes_type");
    }
    for (const value of ["hypothyroidism", "hyperthyroidism"]) {
      const missing = findMissingRequiredAnswers({
        ...withConditions("thyroid"),
        thyroid_type: value,
      });
      expect(missing, `thyroid_type=${value}`).not.toContain("thyroid_type");
    }
  });

  it("stops demanding the type as soon as the parent is deselected", () => {
    // Yes -> pick a type -> change to No. The stale value is still in the map;
    // it must not be required, and (section 5) it must not be authoritative.
    const missing = findMissingRequiredAnswers({
      medical_conditions: ["pcos"],
      diabetes_type: "type_1",
    });
    expect(missing).not.toContain("diabetes_type");
  });
});

describe("4. only the offered values are accepted", () => {
  it("accepts every canonical value", () => {
    expect(
      findInvalidChoiceAnswers({
        ...withConditions("diabetes", "thyroid"),
        diabetes_type: "type_2",
        thyroid_type: "hyperthyroidism",
      }),
    ).toEqual([]);
  });

  it("rejects free text, near-misses and wrong-question values", () => {
    for (const bad of [
      "gestational",
      "Type 1",
      "type_3",
      "type_1 ",
      "hypothyroidism", // right value, wrong question
      "",
      " ",
    ]) {
      const invalid = findInvalidChoiceAnswers({
        ...withConditions("diabetes"),
        diabetes_type: bad,
      });
      if (bad.trim() === "") {
        // Blank is ABSENCE, which is the required check's job, not this one.
        expect(invalid, `blank ${JSON.stringify(bad)}`).not.toContain(
          "diabetes_type",
        );
      } else {
        expect(invalid, `value ${JSON.stringify(bad)}`).toContain(
          "diabetes_type",
        );
      }
    }
  });

  it("rejects non-string values", () => {
    for (const bad of [1, true, null, ["type_1"], { value: "type_1" }]) {
      const invalid = findInvalidChoiceAnswers({
        ...withConditions("diabetes"),
        diabetes_type: bad,
      });
      if (bad === null) {
        expect(invalid).not.toContain("diabetes_type"); // absent
      } else {
        expect(invalid, `value ${JSON.stringify(bad)}`).toContain(
          "diabetes_type",
        );
      }
    }
  });

  it("ignores a value whose question does not apply", () => {
    // A crafted payload cannot be blocked forever by a stale value it can no
    // longer see — and a hidden question is not being answered.
    expect(
      findInvalidChoiceAnswers({
        medical_conditions: ["pcos"],
        diabetes_type: "nonsense",
      }),
    ).toEqual([]);
  });

  it("leaves a complete, legitimate intake alone", () => {
    // Two-way check: the guard must be capable of returning empty over the real
    // catalogue, or the assertions above prove nothing.
    const complete: Record<string, unknown> = {};
    for (const step of INTAKE_STEPS) {
      for (const qq of step.questions) {
        if (qq.type === "single_select") {
          complete[qq.key] = qq.options?.[0]?.value;
        }
      }
    }
    expect(findInvalidChoiceAnswers(complete)).toEqual([]);
  });
});

describe("5. the practitioner review tells the truth about what is known", () => {
  const answered = {
    ...withConditions("diabetes"),
    diabetes_type: "type_1",
  };

  it("renders a recorded type as the answer", () => {
    expect(reviewAnswerState(q("diabetes_type"), answered, "reviewed")).toBe(
      "answered",
    );
    expect(getOptionLabel("diabetes_type", "type_1")).toBe("Type 1");
  });

  it("marks the child not applicable when the client did not report it", () => {
    const state = reviewAnswerState(
      q("diabetes_type"),
      withConditions("pcos"),
      "reviewed",
    );
    expect(state).toBe("not_applicable");
    expect(REVIEW_ANSWER_COPY[state]).toBe("Not applicable");
  });

  it("does NOT present a stale type as the client's answer", () => {
    // THE regression this projection exists to prevent: the client picked
    // Type 1, then unchecked diabetes. The value is still in the jsonb (the
    // wizard merges, the server spreads — nothing deletes it), and before this
    // the grid would have printed "Type 1" under a client who reports no
    // diabetes at all.
    const stale = {
      medical_conditions: ["pcos"],
      diabetes_type: "type_1",
    };
    expect(reviewAnswerState(q("diabetes_type"), stale, "reviewed")).toBe(
      "not_applicable",
    );
    expect(reviewAnswerState(q("diabetes_type"), stale, "submitted")).toBe(
      "not_applicable",
    );
  });

  it("says 'never collected' — not 'not answered' — for a historical intake", () => {
    // The legacy shape: submitted long before the subtype existed. The client
    // was never asked, so blaming them for an omission would be a lie, and
    // inventing a type would be a worse one.
    const legacy = withConditions("diabetes");
    for (const status of ["submitted", "reviewed"] as const) {
      const state = reviewAnswerState(q("diabetes_type"), legacy, status);
      expect(state, status).toBe("not_collected");
      expect(REVIEW_ANSWER_COPY[state]).toBe("Not collected on this intake");
    }
  });

  it("never names a type for a historical intake", () => {
    const legacy = withConditions("diabetes", "thyroid");
    for (const key of ["diabetes_type", "thyroid_type"]) {
      const state = reviewAnswerState(q(key), legacy, "reviewed");
      const copy = REVIEW_ANSWER_COPY[state as "not_collected"];
      for (const invented of [
        "Type 1",
        "Type 2",
        "Hypothyroidism",
        "Hyperthyroidism",
      ]) {
        expect(copy, `${key} must not imply ${invented}`).not.toContain(
          invented,
        );
      }
    }
  });

  it("says 'not answered' while the client can still answer", () => {
    const state = reviewAnswerState(
      q("diabetes_type"),
      withConditions("diabetes"),
      "in_progress",
    );
    expect(state).toBe("unanswered");
    expect(REVIEW_ANSWER_COPY[state]).toBe("Not answered");
  });

  it("keeps an optional unanswered question out of 'never collected'", () => {
    // `outcome_hoped` is optional, so a terminal intake without it is a client
    // who skipped it — not a form that predates it. Getting this wrong would
    // relabel ordinary skips as history.
    const optional = q("outcome_hoped");
    expect(optional.required).toBeFalsy();
    expect(reviewAnswerState(optional, {}, "reviewed")).toBe("unanswered");
  });

  it("still renders a false checkbox as an answer, not as missing", () => {
    // A client who left a confirmation unticked HAS answered; the grid has
    // always shown "Not confirmed". Treating false as absent would relabel a
    // real answer as never collected.
    const ack = q("ack_accurate");
    expect(reviewAnswerState(ack, { ack_accurate: false }, "reviewed")).toBe(
      "answered",
    );
  });

  it("mutates nothing it reads", () => {
    const before = {
      ...withConditions("diabetes"),
      diabetes_type: "type_1",
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    for (const step of INTAKE_STEPS) {
      for (const qq of step.questions) {
        reviewAnswerState(qq, before, "reviewed");
      }
    }
    expect(before).toEqual(snapshot);
  });
});

describe("6. the practitioner-assisted path reaches these answers", () => {
  it("keeps the Medical step practitioner-enterable", () => {
    expect(PRACTITIONER_ENTERABLE_STEPS.map((s) => s.id)).toContain(
      MEDICAL_STEP_ID,
    );
  });

  it("does NOT make the new answers client-owned", () => {
    // A practitioner sitting with the client may record what the client tells
    // them about their health history — that is the whole point of #525/#527.
    // Only the client's own first-person confirmations are off limits.
    for (const key of [
      "diabetes_type",
      "thyroid_type",
      "diabetes_type_notes",
      "thyroid_type_notes",
    ]) {
      expect(CLIENT_OWNED_RESPONSE_KEYS.has(key), key).toBe(false);
    }
  });

  it("keeps the client-owned boundary exactly where it was", () => {
    // Two-way check on the assertion above: the acknowledgements ARE still
    // client-owned, so "not client-owned" is a real distinction here.
    for (const key of ["ack_accurate", "ack_will_update"]) {
      expect(CLIENT_OWNED_RESPONSE_KEYS.has(key), key).toBe(true);
    }
  });

  it("admits the new keys through the response whitelist", () => {
    for (const key of ["diabetes_type", "thyroid_type"]) {
      expect(ALL_QUESTION_KEYS).toContain(key);
      expect(ALL_QUESTION_KEYS).toContain(`${key}_notes`);
    }
  });
});
