/* eslint-disable @typescript-eslint/no-explicit-any -- the verifier edits raw, untyped GraphQL answers on purpose */
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
import {
  CLEAN_COMMENT_809,
  CODEX_ID,
  CODEX_REVIEW_809,
  H809,
  H810,
  OLD_CLEAN_COMMENT_809,
  OPERATOR_ID,
  checkReview,
  checkRollup,
  evaluateReview,
  evaluateRollup,
  reviewAnswer,
  rollupAnswer,
  type Impl456,
  type ReviewRow,
  type RollupRow,
} from "./support/rows456";

// ===========================================================================
// INDEPENDENT VERIFIER — adversarial pass on rows 4-6 (SPEC-05A §4, ARCH-01 §17-§21,
// §24, §41, EXT-CONTEXT-01). 05A computes qualifiesAtHead and carries identities;
// trust (who is Codex, who may resolve) is 05B's. Each sequence asserts what the spec
// MANDATES; the verdict says whether that is safe, and which layer owns the gap.
// GitHub facts used (docs, read 2026-10-07): anyone with write access can EDIT and
// DELETE other users' comments on pull requests; an edit keeps the original author.
// ===========================================================================

const IMPL: Impl456 = { parsePrKey, parseReviewEvidence, bindReviews, parseRollup, bindExternal, policy: REVIEW_POLICY };
const BOT = `Bot:${CODEX_ID}`;

interface Seq {
  id: string;
  verdict: "NO HOLE" | "SPEC AMBIGUITY" | "CONFIRMED HOLE";
  layer: string;
  sequence: string;
  row: ReviewRow | RollupRow;
}

const edit809 = (f: (pr: any) => void) => () => {
  const raw = reviewAnswer(809);
  f(raw.data.repository.pullRequest);
  return raw;
};
const base809 = [
  `${CODEX_REVIEW_809}|PR_REVIEW|COMMENTED|${BOT}|false`,
  `5446958797|PR_REVIEW|COMMENTED|User:${OPERATOR_ID}|false`,
  `${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|true`,
];

const SEQUENCES: Seq[] = [
  {
    id: "R4-EDIT-forged-clean-verdict",
    verdict: "SPEC AMBIGUITY",
    layer: "05A (the §4.1 query carries no edit evidence; 05B never sees bodies)",
    sequence:
      "A writer edits Codex's OLD clean comment 6044636744 (it reviewed b54e438284) so its marker reads the current head 9dbbdb8087. GitHub keeps Codex as the author. 05A then emits a channel-B CLEAN artifact from Codex's numeric id with qualifiesAtHead true, so 05B would see TRUSTED_REVIEW_AT_HEAD for a head Codex never reviewed. No SHA-prefix collision is needed. This is writer-class — the threat model ARCH-01 §41 accepts for V1 — but it is far cheaper than the recorded 10-hex residual and is recorded nowhere (SPEC §6, ARCH-01 §41). Channel A is immune: commit_id cannot be edited.",
    row: {
      id: "R4-EDIT",
      title: "an edited old Codex clean comment qualifies at the new head",
      source: "real #809 answer; synthetic edit (as a writer could make it)",
      clause: "SPEC §4.2 channel B and marker rule",
      number: 809,
      headSha: H809,
      raw: edit809((pr) => {
        const c = pr.comments.nodes.find((x: any) => x.databaseId === OLD_CLEAN_COMMENT_809);
        c.body = c.body.replace("`b54e438284`", "`9dbbdb8087`");
      }),
      expect: { artifacts: [...base809, `${OLD_CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|true`].sort() },
    },
  },
  {
    id: "R4-EDIT-channel-A-immune",
    verdict: "NO HOLE",
    layer: "05A",
    sequence: "The same edit on Codex's findings REVIEW 5446917669 cannot move its commit_id, so it still does not qualify at 9dbbdb80.",
    row: {
      id: "R4-EDIT-A",
      title: "an edited old Codex review does not qualify: its commit is immutable",
      source: "real #809 answer; synthetic edit",
      clause: "SPEC §4.2 channel A (commitOid AND marker)",
      number: 809,
      headSha: H809,
      raw: edit809((pr) => {
        const r = pr.reviews.nodes.find((x: any) => x.databaseId === CODEX_REVIEW_809);
        r.body = r.body.replace("`b54e438284`", "`9dbbdb8087`");
      }),
      expect: {
        artifacts: [...base809, `${OLD_CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|false`].sort(),
      },
    },
  },
  {
    id: "R5-DELETE-opener",
    verdict: "SPEC AMBIGUITY",
    layer: "05A opener derivation (SPEC §4.1) and 05B FINDINGS_OPEN (ARCH-01 §19)",
    sequence:
      "A writer who is NOT an allowlisted resolver deletes Codex's thread-opening review comment. If GitHub keeps the thread with its human reply (behaviour unverified), the opener becomes the reply's author; if it keeps no comment, the opener is null. Either way 05B no longer sees a Codex-opened thread, so FINDINGS_OPEN cannot fire — the human-resolver allowlist (only 26781116 may clear a Codex finding) is bypassed by deletion instead of resolution. Writer-class and unrecorded. A first remaining comment that is a reply (GraphQL replyTo) would reveal it, but §4.1 does not request replyTo.",
    row: {
      id: "R5-DELETE",
      title: "a thread whose Codex opening comment was deleted is opened by the human reply",
      source: "real #809 thread; synthetic deletion",
      clause: "SPEC §4.1 opener = author of the thread's first comment",
      number: 809,
      headSha: H809,
      raw: edit809((pr) => {
        const t = pr.reviewThreads.nodes[0];
        t.isResolved = false;
        t.resolvedBy = null;
        t.comments.nodes.shift();
        t.comments.totalCount = 1;
      }),
      expect: {
        artifacts: [...base809, `${OLD_CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|false`].sort(),
        threads: [`User:${OPERATOR_ID}|false|null|true`],
      },
    },
  },
  {
    id: "R4-HUMAN-CLEAN",
    verdict: "NO HOLE",
    layer: "05B (must require actor id 199175422 and type Bot)",
    sequence:
      "Anyone posts a comment that begins with the clean prefix and names the current head. 05A emits it as channel B with the poster's identity (qualifiesAtHead true): correct, because trust is 05B's. 05B's TRUSTED_REVIEW_AT_HEAD must check the actor; a 05B that checked only qualifiesAtHead would be a hole.",
    row: {
      id: "R4-HUMAN",
      title: "a human's clean-looking comment is an artifact carrying the human's identity",
      source: "real #809 answer; synthetic author",
      clause: "SPEC §4.2 last bullet",
      number: 809,
      headSha: H809,
      raw: edit809((pr) => {
        pr.comments.nodes.find((x: any) => x.databaseId === CLEAN_COMMENT_809).author = { __typename: "User", login: "mallory", databaseId: 999 };
      }),
      expect: {
        artifacts: [
          `${CODEX_REVIEW_809}|PR_REVIEW|COMMENTED|${BOT}|false`,
          `5446958797|PR_REVIEW|COMMENTED|User:${OPERATOR_ID}|false`,
          `${OLD_CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|false`,
          `${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|User:999|true`,
        ].sort(),
      },
    },
  },
  {
    id: "R4-10HEX-prefix",
    verdict: "NO HOLE",
    layer: "accepted writer-class residual (ARCH-01 §41)",
    sequence:
      "A later head that shares the first 10 hex of 9dbbdb808748… makes the old clean comment qualify. Only 40 bits bind channel B, by recorded V1 decision.",
    row: {
      id: "R4-10HEX",
      title: "a different head with the same 10-hex prefix: the clean comment qualifies",
      source: "real #809 answer; synthetic key",
      clause: "SPEC §4.2 'a 10-hex V1 binding (ARCH-01 §41)'",
      number: 809,
      headSha: `9dbbdb8087${"0".repeat(30)}`,
      raw: () => reviewAnswer(809),
      expect: {
        artifacts: [
          `${CODEX_REVIEW_809}|PR_REVIEW|COMMENTED|${BOT}|false`,
          `5446958797|PR_REVIEW|COMMENTED|User:${OPERATOR_ID}|false`,
          `${OLD_CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|false`,
          `${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|true`,
        ].sort(),
      },
    },
  },
  {
    id: "R4-DISMISSED",
    verdict: "NO HOLE",
    layer: "05B (ARCH-01 §17 A: DISMISSED and PENDING never count; §18 needs CHANGES_REQUESTED)",
    sequence:
      "A Codex CHANGES_REQUESTED review at head is dismissed: GitHub sets its state to DISMISSED. 05A still emits it with qualifiesAtHead true and verdict DISMISSED; 05B must not count it as review-present nor as a forced finding.",
    row: {
      id: "R4-DISMISSED",
      title: "a dismissed Codex review at head qualifies, carrying verdict DISMISSED",
      source: "real #809 review; synthetic state, commit and marker",
      clause: "SPEC §4.2 channel A",
      number: 809,
      headSha: H809,
      raw: edit809((pr) => {
        const r = pr.reviews.nodes.find((x: any) => x.databaseId === CODEX_REVIEW_809);
        r.state = "DISMISSED";
        r.commit = { oid: H809 };
        r.body = r.body.replace("`b54e438284`", "`9dbbdb8087`");
      }),
      expect: {
        artifacts: [
          `${CODEX_REVIEW_809}|PR_REVIEW|DISMISSED|${BOT}|true`,
          `5446958797|PR_REVIEW|COMMENTED|User:${OPERATOR_ID}|false`,
          `${OLD_CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|false`,
          `${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|${BOT}|true`,
        ].sort(),
      },
    },
  },
  {
    id: "R6-OTHER-ACTIONS-WORKFLOW",
    verdict: "NO HOLE",
    layer: "policy (EXT-CONTEXT-01 §4 + V1 CI reads only ci.yml): a residual to record, not a 05A defect",
    sequence:
      "A second PR-triggered GitHub Actions workflow (none exists today: ci.yml is the only one; nightly.yml is schedule-only) fails at H. Its check runs carry slug github-actions, so EXT-CONTEXT-01 excludes them, and V1 CI binds only workflow 289443461. Nothing would block. Today nothing can produce it.",
    row: {
      id: "R6-OTHER-ACTIONS",
      title: "a failing check run from another Actions workflow is excluded",
      source: "real #810 rollup; synthetic node",
      clause: "EXT-CONTEXT-01 §4",
      headSha: H810,
      raw: () => {
        const raw = rollupAnswer(810);
        const c = raw.data.repository.object.statusCheckRollup.contexts;
        c.nodes.push({ __typename: "CheckRun", name: "security scan", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { app: { slug: "github-actions" } } });
        c.totalCount += 1;
        return raw;
      },
      expect: { external: ["Vercel Preview Comments=success", "Vercel=success"].sort() },
    },
  },
  {
    id: "R6-STATUS-SPOOF",
    verdict: "NO HOLE",
    layer: "05B (negative-only: success is inert)",
    sequence: "A writer posts a StatusContext SUCCESS for any name. External success never grants (EXT-CONTEXT-01 §8); a posted FAILURE only blocks.",
    row: {
      id: "R6-SPOOF",
      title: "a writer-posted SUCCESS status is just one more inert success fact",
      source: "real #810 rollup; synthetic node",
      clause: "EXT-CONTEXT-01 §5, §8",
      headSha: H810,
      raw: () => {
        const raw = rollupAnswer(810);
        const c = raw.data.repository.object.statusCheckRollup.contexts;
        c.nodes.push({ __typename: "StatusContext", context: "ci/all-green", state: "SUCCESS" });
        c.totalCount += 1;
        return raw;
      },
      expect: { external: ["Vercel Preview Comments=success", "Vercel=success", "ci/all-green=success"].sort() },
    },
  },
];

describe("adversarial: rows 4-6 sequences (verdicts: SPEC AMBIGUITY = unrecorded residual, NO HOLE = safe or owned by 05B)", () => {
  for (const s of SEQUENCES) {
    it(`${s.id} [${s.verdict}; ${s.layer}]`, () => {
      const why =
        "number" in s.row ? checkReview(s.row, evaluateReview(s.row, IMPL)) : checkRollup(s.row as RollupRow, evaluateRollup(s.row as RollupRow, IMPL));
      expect(why, `${why}\nsequence: ${s.sequence}`).toBe("");
    });
  }
});
