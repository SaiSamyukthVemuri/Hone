import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INTAKE_STEPS } from "@/lib/intake/questions";
import { REVIEW_ANSWER_COPY } from "@/lib/intake/review-answers";

// Structural pins for how the practitioner review grid presents an answer.
//
// CONVENTION NOTE, same as tests/app/clients/intake-review-ui-state.test.ts:
// the unit lane runs `environment: "node"` and this repo ships no jsdom / React
// Testing Library, so the grid's structure is pinned here by source assertion.
// The projection's LOGIC is proven properly, as pure functions, in
// tests/lib/intake/diabetes-thyroid-conditionals.test.ts §5.
//
// What these pins protect is the wiring between the two — specifically that the
// grid cannot quietly go back to printing whatever is in the jsonb. The failure
// mode is invisible to a logic test: reviewAnswerState can be perfectly correct
// while the page ignores it.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PAGE = read("app/(app)/clients/[id]/intake/page.tsx");
const PAGE_CODE = codeOnly(PAGE);

describe("the review grid asks the projection, not the raw response map", () => {
  it("computes a state for every question it renders", () => {
    expect(PAGE_CODE).toMatch(/reviewAnswerState\(q, responses, intake\.status\)/);
  });

  it("renders the stored answer ONLY in the answered state", () => {
    // The load-bearing shape: renderResponse is reached through a conditional
    // on `state === "answered"`. If that guard is dropped, a stale child value
    // — one whose parent the client unselected — is printed as their answer.
    expect(PAGE_CODE).toMatch(
      /state === "answered"[\s\S]{0,200}renderResponse\(/,
    );
  });

  it("never falls back to rendering the value for a non-answered state", () => {
    // Between the state check and the closing of that branch there must be no
    // second renderResponse call taking the stored value.
    const grid = PAGE_CODE.slice(
      PAGE_CODE.indexOf("reviewAnswerState(q, responses, intake.status)"),
      PAGE_CODE.indexOf("</dl>"),
    );
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.match(/renderResponse\(/g) ?? []).toHaveLength(1);
  });

  it("uses the shared copy constants rather than inventing strings", () => {
    expect(PAGE_CODE).toMatch(/REVIEW_ANSWER_COPY\[state\]/);
    // And the one remaining literal path — a present-but-empty value inside
    // renderResponse — goes through the same constant.
    expect(PAGE_CODE).toMatch(/REVIEW_ANSWER_COPY\.unanswered/);
  });

  it("hard-codes none of the three state strings as prose in the page", () => {
    // A second, drifting copy of "Not collected on this intake" is exactly how
    // two surfaces end up describing the same record differently.
    for (const copy of Object.values(REVIEW_ANSWER_COPY)) {
      expect(PAGE_CODE, `page inlines "${copy}"`).not.toContain(`>${copy}<`);
    }
  });

  it("still renders a row for every question, including the new ones", () => {
    // The reviewer sees the whole form. Hiding non-applicable questions would
    // make an intake with diabetes and one without look structurally different
    // and invite "did they answer this?" ambiguity.
    expect(PAGE_CODE).toMatch(/s\.questions\.map\(\(q\)/);
    const medical = INTAKE_STEPS.find((s) => s.id === 3)!;
    for (const key of ["diabetes_type", "thyroid_type"]) {
      expect(medical.questions.map((q) => q.key)).toContain(key);
    }
  });

  it("adds no form control to the review surface", () => {
    // The review page is server-rendered prose. This is the same contract
    // tests/source-guards/assisted-intake-guards.test.ts pins for the
    // acknowledgement cards; restated here because this change touched the grid.
    expect(PAGE).not.toContain("intake-question-field");
    const grid = PAGE_CODE.slice(
      PAGE_CODE.indexOf("reviewAnswerState(q, responses, intake.status)"),
      PAGE_CODE.indexOf("</dl>"),
    );
    expect(grid).not.toMatch(/<input|<textarea|<select/);
  });
});

describe("the review flags do not read the new subtype", () => {
  const FLAGS = read("lib/intake/review-flags.ts");

  it("keeps the conservative diabetes union rather than narrowing by type", () => {
    // Narrowing which modalities are surfaced based on the client's diabetes
    // type would be a clinical judgement nobody has approved, and every
    // historical intake has no type to narrow by.
    expect(codeOnly(FLAGS)).not.toContain("diabetes_type");
    expect(codeOnly(FLAGS)).not.toContain("thyroid_type");
    expect(FLAGS).toMatch(
      /"medical_conditions:diabetes":\s*\[\s*"thermolysis",\s*"galvanic",\s*"authorization",\s*"precaution",\s*\]/,
    );
  });
});
