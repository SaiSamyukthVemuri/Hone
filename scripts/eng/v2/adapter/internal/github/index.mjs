// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: the narrow readers (CAP-01 §4, with README difference 7).
//
// `createReaders({ request, policy })` returns a frozen object of readers. Each
// reader takes typed scalars only, refuses anything else before making a
// request, makes exactly ONE request with a fixed GraphQL document or a fixed
// REST route template, and returns its strict parser's closed result for the
// request it made. Branch and ref values come from fixed policy or from a
// coherent key, never from a caller-supplied string beyond those, and each
// answer must echo them. Nothing here pages, retries or throws.
// ---------------------------------------------------------------------------

import { PR_KEY_QUERY, parsePrKey } from "../../../contract/pr-key.mjs";
import { canonicalJson, fail, isNonEmptyString, isPosInt, isSha40 } from "../../../contract/strict.mjs";
import {
  PR_CONTEXT_QUERY,
  parseActivity,
  parseBranchRules,
  parseCompare,
  parseHeadBranchPrs,
  parsePrContext,
} from "./parse-base.mjs";
import { parseFileBlob } from "./parse-blob.mjs";
import { parseRunJobs, parseWorkflowRuns } from "./parse-ci.mjs";
import { REVIEW_EVIDENCE_QUERY, parseReviewEvidence } from "./parse-review.mjs";
import { ROLLUP_QUERY, parseRollup } from "./parse-rollup.mjs";

/** The fixed policy V1 reads against. */
export const POLICY = Object.freeze({
  owner: "SaiSamyukthVemuri",
  name: "Hone",
  repoId: 1240764106,
  productionRef: "claude/build-hone-saas-hOex7",
  workflowId: 289443461,
});

/** The only files `readFileBlob` may be asked for: the CI definitions the shepherd executes or pins against. */
export const BLOB_PATHS = Object.freeze([".github/workflows/ci.yml", "scripts/classify-changes.mjs"]);

export const ACTIVITY_TYPES = Object.freeze(["force_push", "branch_deletion", "branch_creation"]);

// A branch or ref that is safe to place in a route: no query, fragment, space or traversal.
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const isSafeRef = (v) => isNonEmptyString(v) && SAFE_REF.test(v) && !v.split("/").includes("..");

const refused = (what) => Object.freeze({ ok: false, reason: "malformed", detail: `refused before any request: ${what}` });

export function createReaders({ request, policy = POLICY }) {
  // V1 reads one repository under one fixed policy (SPEC-05A §5.1): readers are never built for another owner,
  // repository, production ref or workflow, so no caller can point the history or CI reads elsewhere.
  if (canonicalJson(policy) !== canonicalJson(POLICY)) throw new Error("the reader policy is not V1's fixed policy");
  const { owner, name, productionRef, workflowId } = policy;
  if (!isSafeRef(productionRef) || !isPosInt(workflowId)) throw new Error("the reader policy is invalid");
  const repoPath = `repos/${owner}/${name}`;
  const ref = `refs/heads/${productionRef}`;

  const rest = (label, route) => request({ label, rest: `${repoPath}/${route}` });
  const graphql = (label, query, variables) => request({ label, graphql: query, variables: { owner, name, ...variables } });
  /** Hand the parser the answer to the request that was made, or pass the transport's failure through. */
  const via = (res, parse) => (res && res.ok === true ? parse(res.body) : res && res.ok === false ? res : fail("read_failed", "no transport result"));

  return Object.freeze({
    readPrKey: (n) =>
      isPosInt(n) ? via(graphql("pr-key", PR_KEY_QUERY, { n }), (b) => parsePrKey(b, { expectedNumber: n })) : refused("PR number"),

    readCompare: (baseSha, headSha) =>
      isSha40(baseSha) && isSha40(headSha)
        ? via(rest("compare", `compare/${baseSha}...${headSha}`), (b) => parseCompare(b, { baseSha }))
        : refused("compare SHAs"),

    readPrContext: (n, headSha) =>
      isPosInt(n) && isSha40(headSha)
        ? via(graphql("pr-context", PR_CONTEXT_QUERY, { n, h: headSha }), (b) => parsePrContext(b, { expectedNumber: n }))
        : refused("PR context parameters"),

    readHeadBranchPrs: (headRef) =>
      isNonEmptyString(headRef)
        ? via(
            rest("head-branch-prs", `pulls?head=${encodeURIComponent(`${owner}:${headRef}`)}&state=all&per_page=100`),
            (b) => parseHeadBranchPrs(b, { headRef }),
          )
        : refused("head branch"),

    readBranchRules: () => via(rest("branch-rules", `rules/branches/${productionRef}`), (b) => parseBranchRules(b)),

    readActivity: (activityType) =>
      ACTIVITY_TYPES.includes(activityType)
        ? via(
            rest(
              `activity-${activityType}`,
              `activity?ref=${encodeURIComponent(ref)}&activity_type=${activityType}&time_period=year&per_page=100`,
            ),
            (b) => parseActivity(b, { activityType, ref }),
          )
        : refused("activity type"),

    readCandidateRuns: (headSha) =>
      isSha40(headSha)
        ? via(
            rest("candidate-runs", `actions/workflows/${workflowId}/runs?head_sha=${headSha}&event=pull_request&per_page=100`),
            (b) => parseWorkflowRuns(b),
          )
        : refused("head SHA"),

    readRunJobs: (runId) =>
      isPosInt(runId)
        ? via(rest("run-jobs", `actions/runs/${runId}/jobs?filter=latest&per_page=100`), (b) => parseRunJobs(b, { runId }))
        : refused("run id"),

    readReviewEvidence: (n) =>
      isPosInt(n)
        ? via(graphql("review-evidence", REVIEW_EVIDENCE_QUERY, { n }), (b) => parseReviewEvidence(b, { expectedNumber: n }))
        : refused("PR number"),

    readCommitRollup: (headSha) =>
      isSha40(headSha)
        ? via(graphql("commit-rollup", ROLLUP_QUERY, { h: headSha }), (b) => parseRollup(b, { headSha }))
        : refused("head SHA"),

    readFileBlob: (filePath, sha) =>
      BLOB_PATHS.includes(filePath) && isSha40(sha)
        ? via(rest("file-blob", `contents/${filePath}?ref=${sha}`), (b) => parseFileBlob(b, { path: filePath }))
        : refused("file path or commit"),
  });
}
