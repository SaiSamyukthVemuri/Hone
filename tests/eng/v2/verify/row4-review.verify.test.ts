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
import {
  CLEAN_COMMENT_809,
  CLEAN_PREFIX,
  CODEX_ID,
  H809,
  OPERATOR_ID,
  REVIEW_ROWS,
  artifactSummary,
  checkReview,
  evaluateReview,
  keyAt,
  reviewAnswer,
  type Impl456,
} from "./support/rows456";

// ===========================================================================
// INDEPENDENT VERIFIER — ENG-LOOP V1 05A rows 4-5: trusted review provenance and
// review threads. Oracle: SPEC-05A §0, §4.1, §4.2 (203ed1f4); ARCH-01 §17-§22, §24
// (05A computes qualifiesAtHead and carries identities; trust is 05B's); CAP-01 §17.
// ===========================================================================

const IMPL: Impl456 = { parsePrKey, parseReviewEvidence, bindReviews, parseRollup, bindExternal, policy: REVIEW_POLICY };
const failsWith = (r: any, reasons: string[], label = "") => {
  expect(r?.ok, `${label} should fail closed`).toBe(false);
  expect(reasons, `${label}: got ${JSON.stringify(r?.reason)}`).toContain(r?.reason);
  expect(isUnknownReason(r?.reason)).toBe(true);
};

describe("rows 4-5 verify: the policy values are the spec's", () => {
  it("the Codex bot, the human resolver and the clean prefix equal SPEC §4.2 / ARCH-01 §20, §17b", () => {
    expect(REVIEW_POLICY.codex).toEqual({ id: CODEX_ID, type: "Bot" });
    expect(REVIEW_POLICY.humanResolvers).toEqual([{ id: OPERATOR_ID, type: "User" }]);
    expect(REVIEW_POLICY.cleanPrefix).toBe(CLEAN_PREFIX);
  });
});

describe("rows 4-5 verify: review evidence table (real answers and synthetic edits)", () => {
  for (const row of REVIEW_ROWS) {
    it(`${row.id}: ${row.title} — ${row.source} [${row.clause}]`, () => {
      const why = checkReview(row, evaluateReview(row, IMPL));
      expect(why, why).toBe("");
    });
  }
});

describe("rows 4-5 verify: parseReviewEvidence properties (§0, §4.1)", () => {
  it("logins never enter the record: every author, resolver and opener is exactly { id, type } or null", () => {
    // Bodies are kept verbatim and may mention a user (the real Vercel comment links ?owner=<login>);
    // the rule is about actor identity fields, which must never carry a login.
    for (const n of [800, 809, 776] as const) {
      const r = parseReviewEvidence(reviewAnswer(n), { expectedNumber: n });
      expect(r.ok, `#${n}`).toBe(true);
      const actors = [
        ...r.record.reviews.map((x: any) => x.author),
        ...r.record.comments.map((x: any) => x.author),
        ...r.record.threads.flatMap((t: any) => [t.opener, t.resolver]),
      ];
      for (const a of actors) if (a !== null) expect(Object.keys(a).sort(), `#${n}`).toEqual(["id", "type"]);
      expect(canon(r.record).includes('"login"'), `#${n}: a login key`).toBe(false);
    }
  });

  it("canonical order: reviews, comments and threads in any order give the identical record (SPEC §0, CAP-01 L7)", () => {
    const r = rng(0x4e1);
    for (const n of [800, 809] as const) {
      const want = canon(parseReviewEvidence(reviewAnswer(n), { expectedNumber: n }));
      for (let k = 0; k < 8; k++) {
        const raw = reviewAnswer(n);
        const p = raw.data.repository.pullRequest;
        p.reviews.nodes = r.shuffle(p.reviews.nodes);
        p.comments.nodes = r.shuffle(p.comments.nodes);
        p.reviewThreads.nodes = r.shuffle(p.reviewThreads.nodes);
        expect(canon(parseReviewEvidence(permuteKeys(raw, r), { expectedNumber: n })), `#${n} shuffle ${k}`).toBe(want);
      }
    }
  });

  it("reviews and comments come out sorted by id", () => {
    const rec = parseReviewEvidence(reviewAnswer(800), { expectedNumber: 800 }).record;
    const ids = (xs: any[]) => xs.map((x) => x.id);
    expect(ids(rec.reviews)).toEqual([...ids(rec.reviews)].sort((a, b) => a - b));
    expect(ids(rec.comments)).toEqual([...ids(rec.comments)].sort((a, b) => a - b));
  });

  it("GraphQL exact fields at every level of a real answer: a missing or an extra field is malformed", () => {
    const muts = exactFieldMutations(reviewAnswer(809));
    expect(muts.length).toBeGreaterThan(40);
    for (const m of muts) {
      const out = noThrow(() => parseReviewEvidence(m.raw, { expectedNumber: 809 }));
      expect(out.threw, `${m.label}: threw`).toBe(false);
      // a missing `author` / `resolvedBy` / `commit` key is still a missing field, never a deleted actor
      const envelope = ["repository", "pullRequest"].includes(m.deletedKey ?? "");
      failsWith((out as any).value, envelope ? ["malformed", "read_failed"] : ["malformed"], m.label);
    }
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseReviewEvidence, reviewAnswer(809), { expectedNumber: 809 })).toEqual([]);
  });

  it("exotic input is malformed and never throws (§0)", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("get"); }, ownKeys: () => { throw new Error("keys"); } });
    const getter = Object.defineProperty({}, "data", { enumerable: true, get: () => { throw new Error("getter"); } });
    for (const [label, raw, params] of [
      ["proxy", hostile, { expectedNumber: 809 }],
      ["throwing getter", getter, { expectedNumber: 809 }],
      ["null options", reviewAnswer(809), null],
      ["a string", "x", { expectedNumber: 809 }],
    ] as const) {
      const out = noThrow(() => parseReviewEvidence(raw, params));
      expect(out.threw, label).toBe(false);
      failsWith((out as any).value, ["malformed"], label);
    }
  });
});

describe("rows 4-5 verify: bindReviews properties (§4.2; ARCH-01 §24)", () => {
  const evidence = (n: 800 | 809) => parseReviewEvidence(reviewAnswer(n), { expectedNumber: n }).record;

  it("trust is 05B's: changing the policy's Codex id and resolvers changes nothing 05A emits", () => {
    for (const [n, head] of [
      [809, H809],
      [800, "fe62f51f0fd95fc97d2e21eef71d179e2e701358"],
    ] as const) {
      const key = keyAt(IMPL, n, head);
      const a = bindReviews({ key, evidence: evidence(n), policy: REVIEW_POLICY });
      const b = bindReviews({ key, evidence: evidence(n), policy: { ...REVIEW_POLICY, codex: { id: 1, type: "Bot" }, humanResolvers: [] } });
      expect(a.ok && b.ok, `#${n}`).toBe(true);
      expect(canon(b.value), `#${n}`).toBe(canon(a.value));
    }
  });

  it("the clean prefix is the POLICY's value, never a hard-coded string (ARCH-01 §21)", () => {
    const key = keyAt(IMPL, 809, H809);
    const other = { ...REVIEW_POLICY, cleanPrefix: "Codex says all clear." };
    const v = bindReviews({ key, evidence: evidence(809), policy: other });
    expect(v.ok).toBe(true);
    expect(artifactSummary(v.value).some((s) => s.includes("CLEAN_COMMENT"))).toBe(false);
    const raw = reviewAnswer(809);
    const c = raw.data.repository.pullRequest.comments.nodes.find((x: any) => x.databaseId === CLEAN_COMMENT_809);
    c.body = c.body.replace(CLEAN_PREFIX, "Codex says all clear.");
    const v2 = bindReviews({ key, evidence: parseReviewEvidence(raw, { expectedNumber: 809 }).record, policy: other });
    expect(artifactSummary(v2.value)).toContain(`${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|Bot:${CODEX_ID}|true`);
  });

  it("a missing or invalid policy, key or evidence fails closed and never throws", () => {
    const key = keyAt(IMPL, 809, H809);
    for (const [label, args] of [
      ["null", null],
      ["no policy", { key, evidence: evidence(809) }],
      ["no evidence", { key, policy: REVIEW_POLICY }],
      ["no key", { evidence: evidence(809), policy: REVIEW_POLICY }],
      ["a non-key", { key: { headSha: H809 }, evidence: evidence(809), policy: REVIEW_POLICY }],
      ["evidence of the wrong shape", { key, evidence: { reviews: "x" }, policy: REVIEW_POLICY }],
    ] as const) {
      const out = noThrow(() => bindReviews(args));
      expect(out.threw, label).toBe(false);
      const v = (out as any).value;
      expect(v?.ok, label).toBe(false);
      expect(isUnknownReason(v?.reason), `${label}: ${v?.reason}`).toBe(true);
    }
  });

  it("is pure over deep-frozen arguments and returns a deeply frozen value", () => {
    const key = keyAt(IMPL, 800, "fe62f51f0fd95fc97d2e21eef71d179e2e701358");
    const args = { key, evidence: evidence(800), policy: REVIEW_POLICY };
    const a = bindReviews(args);
    const b = bindReviews(deepFreeze(clone(args)));
    expect(canon(b)).toBe(canon(a));
    expect(isDeepFrozen(a.value)).toBe(true);
  });
});
