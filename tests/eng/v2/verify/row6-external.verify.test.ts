/* eslint-disable @typescript-eslint/no-explicit-any -- the verifier feeds raw, untyped GraphQL answers on purpose */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseReviewEvidence } from "../../../../scripts/eng/v2/adapter/internal/github/parse-review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REVIEW_POLICY, bindReviews } from "../../../../scripts/eng/v2/adapter/internal/bind/review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseRollup } from "../../../../scripts/eng/v2/adapter/internal/github/parse-rollup.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindExternal } from "../../../../scripts/eng/v2/adapter/internal/bind/external.mjs";
import { canon, clone, deepFreeze, isDeepFrozen, noThrow, permuteKeys } from "./support/deep";
import { exactFieldMutations, purityViolations } from "./support/parser-props";
import { rng } from "./support/prng";
import { H810, ROLLUP_ROWS, checkRollup, evaluateRollup, externalSummary, rollupAnswer, type Impl456 } from "./support/rows456";
import { budgetGuard } from "./support/budgets";

// ===========================================================================
// INDEPENDENT VERIFIER — ENG-LOOP V1 05A row 6: external contexts.
// Oracle: SPEC-05A §0, §4.3, §4.4 (203ed1f4); EXT-CONTEXT-01 §3-§9 (closed tables,
// the GitHub Actions discriminator, malformed over unrecognized, order-free multiset);
// CAP-01 §17 C8-C11.
// ===========================================================================

const IMPL: Impl456 = { parsePrKey, parseReviewEvidence, bindReviews, parseRollup, bindExternal, policy: REVIEW_POLICY };
const failsWith = (r: any, reasons: string[], label = "") => {
  expect(r?.ok, `${label} should fail closed`).toBe(false);
  expect(reasons, `${label}: got ${JSON.stringify(r?.reason)}`).toContain(r?.reason);
  expect(isUnknownReason(r?.reason)).toBe(true);
};

describe("row 6 verify: external-context table (real rollups and synthetic edits)", () => {
  for (const row of ROLLUP_ROWS) {
    it(`${row.id}: ${row.title} — ${row.source} [${row.clause}]`, () => {
      const why = checkRollup(row, evaluateRollup(row, IMPL));
      expect(why, why).toBe("");
    });
  }
});

describe("row 6 verify: parseRollup properties (§0, §4.3)", () => {
  it("canonical order: the same contexts in any order give the identical record", () => {
    const r = rng(0x6e1);
    for (const [n, head] of [
      [810, H810],
      [776, "7d25459de1fe63a7fd4ed3348ecb11ab35ab6338"],
    ] as const) {
      const want = canon(parseRollup(rollupAnswer(n), { headSha: head }));
      for (let k = 0; k < 8; k++) {
        const raw = rollupAnswer(n);
        const c = raw.data.repository.object.statusCheckRollup.contexts;
        c.nodes = r.shuffle(c.nodes);
        expect(canon(parseRollup(permuteKeys(raw, r), { headSha: head })), `#${n} shuffle ${k}`).toBe(want);
      }
    }
  });

  it("GraphQL exact fields at every level of a real answer: a missing or an extra field is malformed", () => {
    const muts = exactFieldMutations(rollupAnswer(810));
    expect(muts.length).toBeGreaterThan(30);
    for (const m of muts) {
      const out = noThrow(() => parseRollup(m.raw, { headSha: H810 }));
      expect(out.threw, `${m.label}: threw`).toBe(false);
      const envelope = ["repository", "object"].includes(m.deletedKey ?? "");
      failsWith((out as any).value, envelope ? ["malformed", "read_failed"] : ["malformed"], m.label);
    }
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseRollup, rollupAnswer(810), { headSha: H810 })).toEqual([]);
  });

  it("exotic input is malformed and never throws (§0)", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("get"); }, ownKeys: () => { throw new Error("keys"); } });
    for (const [label, raw, params] of [
      ["proxy", hostile, { headSha: H810 }],
      ["null options", rollupAnswer(810), null],
      ["a number", 7, { headSha: H810 }],
    ] as const) {
      const out = noThrow(() => parseRollup(raw, params));
      expect(out.threw, label).toBe(false);
      failsWith((out as any).value, ["malformed"], label);
    }
  });
});

describe("row 6 verify: bindExternal properties (§4.4; EXT-CONTEXT-01 §8)", () => {
  it("a permutation of the same contexts normalizes to the same multiset (EXT-CONTEXT-01 fixture 19)", () => {
    const r = rng(0x6e2);
    const rec = parseRollup(rollupAnswer(776), { headSha: "7d25459de1fe63a7fd4ed3348ecb11ab35ab6338" }).record;
    const want = externalSummary(bindExternal(rec).value);
    for (let k = 0; k < 10; k++) {
      const shuffled = { ...clone(rec), contexts: r.shuffle(clone(rec).contexts) };
      expect(externalSummary(bindExternal(shuffled).value)).toEqual(want);
    }
  });

  it("never throws, and an input outside the §4.3 record shape fails closed", () => {
    for (const [label, input] of [
      ["null", null],
      ["undefined", undefined],
      ["no contexts", {}],
      ["contexts not an array", { contexts: "x" }],
      ["an unknown kind", { contexts: [{ kind: "Commit" }] }],
    ] as const) {
      const out = noThrow(() => bindExternal(input));
      expect(out.threw, label).toBe(false);
      const v = (out as any).value;
      expect(v?.ok, label).toBe(false);
      expect(isUnknownReason(v?.reason), `${label}: ${v?.reason}`).toBe(true);
    }
  });

  it("is pure over a deep-frozen record and returns a deeply frozen value", () => {
    const rec = parseRollup(rollupAnswer(810), { headSha: H810 }).record;
    const a = bindExternal(rec);
    const b = bindExternal(deepFreeze(clone(rec)));
    expect(canon(b)).toBe(canon(a));
    expect(isDeepFrozen(a.value)).toBe(true);
  });
});

budgetGuard("row6-external.verify.test.ts");
