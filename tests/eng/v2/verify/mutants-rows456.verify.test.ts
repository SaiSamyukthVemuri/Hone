/* eslint-disable @typescript-eslint/no-explicit-any -- mutants wrap untyped functions under test */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
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
import { clone } from "./support/deep";
import {
  CODEX_ID,
  REVIEW_ROWS,
  ROLLUP_ROWS,
  checkReview,
  checkRollup,
  evaluateReview,
  evaluateRollup,
  type Impl456,
} from "./support/rows456";

// ===========================================================================
// INDEPENDENT VERIFIER — mutation detection for rows 4-6, through the REAL
// functions. Each mutant wraps the builder's code with one intentionally UNSAFE
// change. It is caught when a row the real implementation satisfies breaks, and
// every mutant names the rows that must catch it.
// ===========================================================================

const REAL: Impl456 = { parsePrKey, parseReviewEvidence, bindReviews, parseRollup, bindExternal, policy: REVIEW_POLICY };
const TOKEN = /(\*\*Reviewed commit:\*\* `)([^`]*)(`)/g;

/** apply f to every review and comment body of an evidence record (a clone; records are frozen) */
const editBodies = (evidence: any, f: (body: string) => string) => {
  const ev = clone(evidence);
  for (const x of [...(ev?.reviews ?? []), ...(ev?.comments ?? [])]) if (typeof x.body === "string") x.body = f(x.body);
  return ev;
};
const wrapBind = (f: (args: any) => any): Partial<Impl456> => ({ bindReviews: (args: any) => REAL.bindReviews(f(args)) });

type Mutant = { name: string; impl: Partial<Impl456>; mustCatch: string[] };

const MUTANTS: Mutant[] = [
  {
    name: "a marker accepted twice",
    impl: wrapBind((a) => ({
      ...a,
      evidence: editBodies(a.evidence, (b) => {
        let n = 0;
        return b.replace(TOKEN, (m) => (n++ === 0 ? m : ""));
      }),
    })),
    mustCatch: ["RV-B-two-markers", "RV-B-two-different-markers", "RV-A-two-markers"],
  },
  {
    name: "a 7-hex marker accepted",
    impl: wrapBind((a) => ({
      ...a,
      evidence: editBodies(a.evidence, (b) =>
        b.replace(TOKEN, (m, p, x, s) => (/^[0-9a-f]{7}$/.test(x) && a.key.headSha.startsWith(x) ? `${p}${a.key.headSha.slice(0, 10)}${s}` : m)),
      ),
    })),
    mustCatch: ["RV-B-7hex", "RV-A-7hex"],
  },
  {
    name: "an upper-case marker accepted",
    impl: wrapBind((a) => ({ ...a, evidence: editBodies(a.evidence, (b) => b.replace(TOKEN, (_m, p, x, s) => `${p}${x.toLowerCase()}${s}`)) })),
    mustCatch: ["RV-B-upper", "RV-A-upper"],
  },
  {
    name: "channel B not anchored at the start of the body",
    impl: wrapBind((a) => {
      const ev = clone(a.evidence);
      for (const c of ev.comments ?? []) {
        const i = typeof c.body === "string" ? c.body.indexOf(a.policy.cleanPrefix) : -1;
        if (i > 0) c.body = c.body.slice(i);
      }
      return { ...a, evidence: ev };
    }),
    mustCatch: ["RV-B-leading-space", "RV-B-quoted", "RV-B-mid"],
  },
  {
    name: "commit_id ignored for channel A",
    impl: wrapBind((a) => {
      const ev = clone(a.evidence);
      for (const r of ev.reviews ?? []) r.commitOid = a.key.headSha;
      return { ...a, evidence: ev };
    }),
    mustCatch: ["RV-A-commit-other", "RV-A-commit-null"],
  },
  {
    name: "every Codex comment counted as a clean verdict (summary comments included)",
    impl: wrapBind((a) => {
      const ev = clone(a.evidence);
      for (const c of ev.comments ?? [])
        if (c.author?.id === CODEX_ID && !c.body.startsWith(a.policy.cleanPrefix)) c.body = `${a.policy.cleanPrefix} ${c.body}`;
      return { ...a, evidence: ev };
    }),
    mustCatch: ["RV-real-776", "RV-real-809-at-head"],
  },
  {
    name: "trust folded into 05A: artifacts from non-Codex actors dropped",
    impl: {
      bindReviews: (a: any) => {
        const r = REAL.bindReviews(a);
        if (!r?.ok) return r;
        return { ok: true, value: { ...r.value, reviews: r.value.reviews.filter((x: any) => x.actor?.id === CODEX_ID && x.actor?.type === "Bot") } };
      },
    },
    mustCatch: ["RV-B-human-author", "RV-real-809-at-head"],
  },
  {
    name: "the thread opener taken from the LAST comment",
    impl: {
      parseReviewEvidence: (raw: any, p: any) => {
        const r = clone(raw);
        for (const t of r?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) t.comments.nodes.reverse();
        return REAL.parseReviewEvidence(r, p);
      },
    },
    mustCatch: ["RV-real-800-at-head", "RV-real-809-at-head"],
  },
  {
    name: "an incomplete review connection accepted",
    impl: {
      parseReviewEvidence: (raw: any, p: any) => {
        const r = clone(raw);
        const fix = (c: any) => {
          if (c?.pageInfo) c.pageInfo.hasNextPage = false;
          if (Array.isArray(c?.nodes)) c.totalCount = c.nodes.length;
        };
        const pr = r?.data?.repository?.pullRequest;
        if (pr) {
          [pr.reviews, pr.comments, pr.reviewThreads].forEach(fix);
          for (const t of pr.reviewThreads?.nodes ?? []) fix(t.comments);
        }
        return REAL.parseReviewEvidence(r, p);
      },
    },
    mustCatch: ["RV-reviews-hasNext", "RV-comments-count-mismatch", "RV-thread-comments-hasNext"],
  },
  {
    name: "the PR number echo ignored",
    impl: {
      parseReviewEvidence: (raw: any, p: any) => {
        const r = clone(raw);
        if (r?.data?.repository?.pullRequest && p?.expectedNumber) r.data.repository.pullRequest.number = p.expectedNumber;
        return REAL.parseReviewEvidence(r, p);
      },
    },
    mustCatch: ["RV-number-echo-mismatch"],
  },
  {
    name: "GitHub Actions check runs counted as external",
    impl: {
      bindExternal: (rec: any) =>
        REAL.bindExternal({ ...rec, contexts: rec.contexts.map((c: any) => (c.appSlug === "github-actions" ? { ...c, appSlug: "actions-counted" } : c)) }),
    },
    mustCatch: ["EX-real-810", "EX-real-800", "EX-actions-excluded-whatever-state"],
  },
  {
    name: "a CheckRun with no app treated as GitHub Actions",
    impl: {
      bindExternal: (rec: any) =>
        REAL.bindExternal({ ...rec, contexts: rec.contexts.map((c: any) => (c.kind === "CheckRun" && c.appSlug === null ? { ...c, appSlug: "github-actions" } : c)) }),
    },
    mustCatch: ["EX-null-app", "EX-malformed-wins-null-app-first", "EX-malformed-wins-null-app-last"],
  },
  {
    name: "unrecognized_context_state winning over malformed",
    impl: {
      bindExternal: (rec: any) => {
        const without = REAL.bindExternal({ ...rec, contexts: rec.contexts.filter((c: any) => !(c.kind === "CheckRun" && c.appSlug === null)) });
        return !without?.ok && without?.reason === "unrecognized_context_state" ? without : REAL.bindExternal(rec);
      },
    },
    mustCatch: ["EX-malformed-wins-null-app-first", "EX-malformed-wins-null-app-last"],
  },
  {
    name: "an incomplete contexts connection accepted",
    impl: {
      parseRollup: (raw: any, p: any) => {
        const r = clone(raw);
        const c = r?.data?.repository?.object?.statusCheckRollup?.contexts;
        if (c) {
          c.pageInfo.hasNextPage = false;
          c.totalCount = c.nodes.length;
        }
        return REAL.parseRollup(r, p);
      },
    },
    mustCatch: ["EX-hasNext", "EX-total-over-100", "EX-total-mismatch"],
  },
  {
    name: "the commit oid echo ignored",
    impl: {
      parseRollup: (raw: any, p: any) => {
        const r = clone(raw);
        if (r?.data?.repository?.object && typeof p?.headSha === "string") r.data.repository.object.oid = p.headSha;
        return REAL.parseRollup(r, p);
      },
    },
    mustCatch: ["EX-oid-echo-mismatch"],
  },
];

describe("mutation detection D: rows 4-6, real functions wrapped by unsafe mutants", () => {
  const reviewPasses = REVIEW_ROWS.filter((row) => checkReview(row, evaluateReview(row, REAL)) === "");
  const rollupPasses = ROLLUP_ROWS.filter((row) => checkRollup(row, evaluateRollup(row, REAL)) === "");

  it("baseline: the rows the real implementation satisfies (the rest are reported by the row files)", () => {
    expect(reviewPasses.length + rollupPasses.length).toBeGreaterThan(0);
  });

  for (const m of MUTANTS) {
    it(`detects the UNSAFE mutant: ${m.name}`, () => {
      const impl = { ...REAL, ...m.impl } as Impl456;
      const caught = [
        ...reviewPasses.filter((row) => checkReview(row, evaluateReview(row, impl)) !== "").map((r) => r.id),
        ...rollupPasses.filter((row) => checkRollup(row, evaluateRollup(row, impl)) !== "").map((r) => r.id),
      ];
      expect(caught.length, "no row the real implementation satisfies breaks under this mutant").toBeGreaterThan(0);
      const satisfied = new Set([...reviewPasses, ...rollupPasses].map((r) => r.id));
      const named = m.mustCatch.filter((id) => satisfied.has(id));
      expect(named.length, `none of the named rows ${m.mustCatch.join(", ")} is satisfied by the real implementation`).toBeGreaterThan(0);
      for (const id of named) expect(caught, `row ${id} should catch it`).toContain(id);
    });
  }
});
