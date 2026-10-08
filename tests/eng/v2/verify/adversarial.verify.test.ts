import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseActivity, parseBranchRules, parseCompare, parseHeadBranchPrs, parsePrContext } from "../../../../scripts/eng/v2/adapter/internal/github/parse-base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindBase } from "../../../../scripts/eng/v2/adapter/internal/bind/base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseRunJobs, parseWorkflowRuns } from "../../../../scripts/eng/v2/adapter/internal/github/parse-ci.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindCi, requiredJobs } from "../../../../scripts/eng/v2/adapter/internal/bind/ci.mjs";
import { evaluate, type Impl } from "./support/pipeline";
import { ADVERSARIAL, matches, show } from "./support/scenarios";

// ===========================================================================
// INDEPENDENT VERIFIER — adversarial sequences against SPEC-05A §3.4
// "Why this binds the execution context".
//
// Each row is a concrete sequence of GitHub behaviours, encoded as the evidence
// 05A would read. The expectation is what SPEC-05A MANDATES. For a row whose
// verdict is CONFIRMED HOLE, the mandated outcome is UNSAFE: the row passing
// demonstrates that a spec-conformant implementation accepts the sequence, and
// closing the hole must flip that row's expectation.
// ===========================================================================

const IMPL: Impl = {
  parsePrKey,
  parseCompare,
  parsePrContext,
  parseHeadBranchPrs,
  parseBranchRules,
  parseActivity,
  parseWorkflowRuns,
  parseRunJobs,
  bindBase,
  requiredJobs,
  bindCi,
};

describe("adversarial: sequences against the §3.4 binding argument", () => {
  for (const a of ADVERSARIAL) {
    it(`${a.id} [${a.verdict}]: ${a.title}`, () => {
      const e = evaluate(a.world(), IMPL);
      expect(
        matches(e.result, a.expect),
        `spec mandates ${show(a.expect)}; got ${e.result.ok ? `${e.result.outcome} ${JSON.stringify(e.result.runs)}` : `UNKNOWN(${e.result.reason})`} at ${e.stage}\nsequence: ${a.sequence}`,
      ).toBe(true);
    });
  }

  it("every CONFIRMED HOLE row is still accepted (the demonstration), and every CLOSED row is now refused", () => {
    for (const a of ADVERSARIAL.filter((x) => x.verdict === "CONFIRMED HOLE")) {
      const r = evaluate(a.world(), IMPL).result;
      expect(r.ok && r.outcome === "SUCCEEDED", a.id).toBe(true);
    }
    const closed = ADVERSARIAL.filter((x) => x.verdict === "CLOSED");
    expect(closed.map((x) => x.id)).toEqual(expect.arrayContaining(["A1-merge-before-created-at", "A8a-creation-recorded-after-run"]));
    for (const a of closed) {
      const r = evaluate(a.world(), IMPL).result;
      expect(r.ok && r.outcome === "SUCCEEDED", `${a.id} is still accepted`).toBe(false);
    }
  });
});
