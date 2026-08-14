import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGEMENTS_STEP_ID,
  ANSWER_ERROR_COPY,
  INTAKE_STEPS,
  PRACTITIONER_ENTERABLE_STEPS,
  TOTAL_STEPS,
  isAnswerProvided,
  isConditionalSatisfied,
  isValidIntakeDate,
  isValidIntakeEmail,
  stepById,
  validateVisibleAnswers,
  visibleQuestionsForStep,
  type Question,
} from "@/lib/intake/questions";

// PARITY GUARD for the shared questionnaire authority.
//
// The conditional-visibility predicate and the per-step required / email /
// date-of-birth rules used to live privately inside
// app/intake/[token]/IntakeWizard.tsx. They were lifted into
// lib/intake/questions.ts so the practitioner-assisted editor evaluates the
// questionnaire with the SAME code rather than a lookalike.
//
// The functions below are the ORIGINAL wizard implementations, transcribed
// verbatim from production commit 88d9949 (PR #518 merge). They are the
// reference oracle: every assertion in this file compares the shared exports
// against them over the real INTAKE_STEPS catalogue and a broad set of
// response maps. If anyone edits the shared predicate, or reintroduces a
// private fork that drifts, these go red.

// --- ORIGINAL: IntakeWizard.tsx isVisible (88d9949, lines 250-259) ----------
const EMAIL_RE_ORIGINAL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isVisibleOriginal(
  q: Question,
  responses: Record<string, unknown>,
): boolean {
  if (!q.conditional) return true;
  const parent = responses[q.conditional.whenKey];
  const allowed = q.conditional.whenEquals;
  if (typeof parent === "string") return allowed.includes(parent);
  if (Array.isArray(parent)) {
    return parent.some((v) => typeof v === "string" && allowed.includes(v));
  }
  return false;
}

// --- ORIGINAL: IntakeWizard.tsx validateStep (88d9949, lines 101-134) -------
function validateStepOriginal(
  visibleQuestions: ReadonlyArray<Question>,
  responses: Record<string, unknown>,
  nowMs: number,
): Record<string, string> {
  const stepErrors: Record<string, string> = {};
  for (const q of visibleQuestions) {
    if (!q.required) continue;
    const v = responses[q.key];
    if (q.type === "multi_select") {
      if (!Array.isArray(v) || v.length === 0) {
        stepErrors[q.key] = "Please answer this question to continue.";
      }
      continue;
    }
    if (q.type === "checkbox") {
      if (v !== true) {
        stepErrors[q.key] = "Please confirm to continue.";
      }
      continue;
    }
    if (typeof v !== "string" || v.trim() === "") {
      stepErrors[q.key] = "Please answer this question to continue.";
      continue;
    }
    if (q.key === "email" && !EMAIL_RE_ORIGINAL.test(v.trim())) {
      stepErrors[q.key] = "Enter a valid email address.";
    }
    if (q.type === "date") {
      const d = new Date(v);
      const year = d.getUTCFullYear();
      if (Number.isNaN(d.getTime()) || year < 1900 || d.getTime() > nowMs) {
        stepErrors[q.key] = "Enter a valid date of birth.";
      }
    }
  }
  return stepErrors;
}

// ---------------------------------------------------------------------------
// A deterministic spread of response maps that actually exercises the
// conditionals: every conditional parent is driven to each of its trigger
// values, to a non-trigger value, to an array form, and to absent/wrong types.
// ---------------------------------------------------------------------------
const ALL_QUESTIONS: Question[] = INTAKE_STEPS.flatMap((s) => [...s.questions]);
const CONDITIONALS = ALL_QUESTIONS.filter((q) => q.conditional);

function responseMaps(): Array<Record<string, unknown>> {
  const maps: Array<Record<string, unknown>> = [
    {},
    { legal_name: "", email: "", date_of_birth: "" },
    { legal_name: "Dana", email: "dana@example.com", date_of_birth: "1990-04-02" },
    { email: "not-an-email", date_of_birth: "not-a-date" },
    { email: "a@b.c", date_of_birth: "1899-12-31" },
    { email: "  spaced@example.com  ", date_of_birth: "3000-01-01" },
  ];
  for (const q of CONDITIONALS) {
    const parentKey = q.conditional!.whenKey;
    for (const trigger of q.conditional!.whenEquals) {
      maps.push({ [parentKey]: trigger });
      maps.push({ [parentKey]: [trigger] });
      maps.push({ [parentKey]: [trigger, "__other__"] });
    }
    maps.push({ [parentKey]: "definitely-not-a-trigger" });
    maps.push({ [parentKey]: [] });
    maps.push({ [parentKey]: null });
    maps.push({ [parentKey]: 42 });
    maps.push({ [parentKey]: true });
    maps.push({ [parentKey]: { nested: "object" } });
  }
  // A fully answered map so the "no errors" path is exercised too.
  const complete: Record<string, unknown> = {};
  for (const q of ALL_QUESTIONS) {
    if (q.type === "multi_select") complete[q.key] = [q.options?.[0]?.value ?? "x"];
    else if (q.type === "checkbox") complete[q.key] = true;
    else if (q.type === "date") complete[q.key] = "1990-04-02";
    else if (q.key === "email") complete[q.key] = "dana@example.com";
    else if (q.type === "yes_no") complete[q.key] = "no";
    else if (q.type === "single_select") complete[q.key] = q.options?.[0]?.value ?? "x";
    else complete[q.key] = "answer";
  }
  maps.push(complete);
  return maps;
}

const MAPS = responseMaps();
const NOW = Date.parse("2026-08-07T12:00:00.000Z");

// ---------------------------------------------------------------------------
describe("conditional visibility matches the original wizard predicate", () => {
  it("covers a meaningful number of cases (guards against a vacuous sweep)", () => {
    expect(CONDITIONALS.length).toBeGreaterThanOrEqual(10);
    expect(MAPS.length).toBeGreaterThanOrEqual(50);
  });

  it("agrees for every question against every response map", () => {
    let compared = 0;
    let visibleTrue = 0;
    let visibleFalse = 0;
    for (const map of MAPS) {
      for (const q of ALL_QUESTIONS) {
        const shared = isConditionalSatisfied(map, q.conditional);
        const original = isVisibleOriginal(q, map);
        expect(
          shared,
          `visibility drift for ${q.key} with ${JSON.stringify(map).slice(0, 120)}`,
        ).toBe(original);
        compared += 1;
        if (original) visibleTrue += 1;
        else visibleFalse += 1;
      }
    }
    expect(compared).toBeGreaterThan(1000);
    // Both outcomes must actually occur, or the comparison proves nothing.
    expect(visibleTrue).toBeGreaterThan(0);
    expect(visibleFalse).toBeGreaterThan(0);
  });

  it("visibleQuestionsForStep equals the original filter, step by step", () => {
    for (const map of MAPS) {
      for (const step of INTAKE_STEPS) {
        const shared = visibleQuestionsForStep(step.id, map).map((q) => q.key);
        const original = step.questions
          .filter((q) => isVisibleOriginal(q, map))
          .map((q) => q.key);
        expect(shared).toEqual(original);
      }
    }
  });

  it("returns nothing for an unknown step id", () => {
    expect(visibleQuestionsForStep(999, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("required / email / date validation matches the original wizard", () => {
  it("agrees on the full error map for every step and every response map", () => {
    let withErrors = 0;
    let withoutErrors = 0;
    for (const map of MAPS) {
      for (const step of INTAKE_STEPS) {
        const visible = visibleQuestionsForStep(step.id, map);
        const shared = validateVisibleAnswers(visible, map, NOW);
        const original = validateStepOriginal(visible, map, NOW);
        expect(
          shared,
          `validation drift on step ${step.id} with ${JSON.stringify(map).slice(0, 120)}`,
        ).toEqual(original);
        if (Object.keys(original).length > 0) withErrors += 1;
        else withoutErrors += 1;
      }
    }
    expect(withErrors).toBeGreaterThan(0);
    expect(withoutErrors).toBeGreaterThan(0);
  });

  it("produces each distinct error message at least once", () => {
    const seen = new Set<string>();
    for (const map of MAPS) {
      for (const step of INTAKE_STEPS) {
        const visible = visibleQuestionsForStep(step.id, map);
        for (const msg of Object.values(validateVisibleAnswers(visible, map, NOW))) {
          seen.add(msg);
        }
      }
    }
    expect(seen).toContain(ANSWER_ERROR_COPY.required);
    expect(seen).toContain(ANSWER_ERROR_COPY.confirm);
    expect(seen).toContain(ANSWER_ERROR_COPY.email);
    expect(seen).toContain(ANSWER_ERROR_COPY.date);
  });

  it("email rule: shape only, trimmed", () => {
    expect(isValidIntakeEmail("dana@example.com")).toBe(true);
    expect(isValidIntakeEmail("  dana@example.com ")).toBe(true);
    expect(isValidIntakeEmail("dana@example")).toBe(false);
    expect(isValidIntakeEmail("dana example.com")).toBe(false);
    expect(isValidIntakeEmail("")).toBe(false);
  });

  it("date rule: parseable, year >= 1900, not in the future", () => {
    expect(isValidIntakeDate("1990-04-02", NOW)).toBe(true);
    expect(isValidIntakeDate("1899-12-31", NOW)).toBe(false);
    expect(isValidIntakeDate("3000-01-01", NOW)).toBe(false);
    expect(isValidIntakeDate("nonsense", NOW)).toBe(false);
  });

  it("isAnswerProvided is exported and matches its documented rules", () => {
    const multi = { key: "m", type: "multi_select", label: "" } as Question;
    const check = { key: "c", type: "checkbox", label: "" } as Question;
    const text = { key: "t", type: "short_text", label: "" } as Question;
    expect(isAnswerProvided(multi, ["a"])).toBe(true);
    expect(isAnswerProvided(multi, [])).toBe(false);
    expect(isAnswerProvided(check, true)).toBe(true);
    expect(isAnswerProvided(check, "true")).toBe(false);
    expect(isAnswerProvided(text, " x ")).toBe(true);
    expect(isAnswerProvided(text, "   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the practitioner-enterable / client-owned step split", () => {
  it("the acknowledgements step is the last step", () => {
    expect(ACKNOWLEDGEMENTS_STEP_ID).toBe(INTAKE_STEPS[INTAKE_STEPS.length - 1].id);
    expect(ACKNOWLEDGEMENTS_STEP_ID).toBe(TOTAL_STEPS);
  });

  it("every step except the acknowledgements step is practitioner-enterable", () => {
    expect(PRACTITIONER_ENTERABLE_STEPS.map((s) => s.id)).toEqual(
      INTAKE_STEPS.filter((s) => s.id !== ACKNOWLEDGEMENTS_STEP_ID).map((s) => s.id),
    );
    expect(PRACTITIONER_ENTERABLE_STEPS.length).toBe(INTAKE_STEPS.length - 1);
  });

  it("the acknowledgements step is entirely required checkboxes", () => {
    const step = stepById(ACKNOWLEDGEMENTS_STEP_ID)!;
    expect(step.questions.length).toBeGreaterThan(0);
    for (const q of step.questions) {
      expect(q.type).toBe("checkbox");
      expect(q.required).toBe(true);
    }
  });

  it("no practitioner-enterable step contains a checkbox", () => {
    // If one ever does, it becomes client-owned automatically (proved in
    // entry-provenance.test.ts), this asserts today's shape so the change
    // is noticed rather than silently reducing what a practitioner can enter.
    for (const s of PRACTITIONER_ENTERABLE_STEPS) {
      for (const q of s.questions) {
        expect(q.type).not.toBe("checkbox");
      }
    }
  });
});
