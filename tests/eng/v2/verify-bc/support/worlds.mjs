// Realistic GitHub worlds: the recorded #800 bodies (tests/eng/v2/fixtures/) with targeted, realistic edits.
// Each world states the decision SPEC-05B §2-§3 requires for it, derived by hand from the recorded facts:
//   #800 at fe62f51f, production 6cdd830b, behind 0, one completed/success ci.yml run (37673706298) whose two
//   always-required jobs succeeded (docs-only diff), production unprotected (rules []), no force push/deletion,
//   creation 2026-05-16; a Codex PR_REVIEW COMMENTED at fe62f51f with marker `fe62f51f0f`; 12 Codex threads resolved
//   by the operator (26781116, User) and one unresolved Codex thread (4211046602); external: Vercel + Vercel
//   Preview Comments, both success.

import { world800 } from "./fake-gh.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));
const pr = (w) => w["pr-key"].data.repository.pullRequest;
const reviewPr = (w) => w["review-evidence"].data.repository.pullRequest;
const rollupNodes = (w) => w["commit-rollup"].data.repository.object.statusCheckRollup.contexts.nodes;
const OPERATOR = { __typename: "User", login: "SaiSamyukthVemuri", databaseId: 26781116 };
const CODEX_BOT = { __typename: "Bot", login: "chatgpt-codex-connector", databaseId: 199175422 };
export const HEAD = "fe62f51f0fd95fc97d2e21eef71d179e2e701358";
export const PROD_TIP = "6cdd830b0bcc5e3532016bc612bd0298db3533fb";

function fixCount(conn) {
  conn.totalCount = conn.nodes.length;
}

export const edits = {
  ready: (w) => (pr(w).isDraft = false),
  merged: (w) => (pr(w).state = "MERGED"),
  protectedRules: (w) =>
    (w["branch-rules"] = [
      { type: "deletion", ruleset_source_type: "Repository", ruleset_source: "SaiSamyukthVemuri/Hone", ruleset_id: 1 },
      { type: "non_fast_forward", ruleset_source_type: "Repository", ruleset_source: "SaiSamyukthVemuri/Hone", ruleset_id: 1 },
    ]),
  resolveOpenThread: (w, by = OPERATOR) => {
    for (const t of reviewPr(w).reviewThreads.nodes) if (!t.isResolved) Object.assign(t, { isResolved: true, resolvedBy: by });
  },
  resolveOpenThreadByCodex: (w) => edits.resolveOpenThread(w, CODEX_BOT),
  behind: (w, n = 2) => Object.assign(w.compare, { status: "diverged", behind_by: n }),
  runConclusion: (w, conclusion) => Object.assign(w["candidate-runs"].workflow_runs[0], { status: "completed", conclusion }),
  runInProgress: (w) => Object.assign(w["candidate-runs"].workflow_runs[0], { status: "in_progress", conclusion: null }),
  noRuns: (w) => (w["candidate-runs"] = { total_count: 0, workflow_runs: [] }),
  requiredJobFailed: (w) => {
    for (const j of w["run-jobs"].jobs) if (j.name === "browser e2e (local stack)") j.conclusion = "failure";
  },
  vercelState: (w, state) => {
    for (const n of rollupNodes(w)) if (n.__typename === "StatusContext") n.state = state;
  },
  headReviewState: (w, state) => {
    for (const r of reviewPr(w).reviews.nodes) if (r.commit?.oid === HEAD && r.author?.databaseId === 199175422) r.state = state;
  },
  headReviewAuthorType: (w, typename) => {
    for (const r of reviewPr(w).reviews.nodes) if (r.commit?.oid === HEAD && r.author?.databaseId === 199175422) r.author = { ...r.author, __typename: typename };
  },
  dropHeadReview: (w) => {
    const conn = reviewPr(w).reviews;
    conn.nodes = conn.nodes.filter((r) => !(r.commit?.oid === HEAD && r.author?.databaseId === 199175422));
    fixCount(conn);
  },
  addCleanComment: (w, { edited = false, marker = HEAD.slice(0, 10), author = CODEX_BOT } = {}) => {
    const conn = reviewPr(w).comments;
    conn.nodes.push({
      databaseId: 6099999999,
      body: `Codex Review: Didn't find any major issues. Keep them coming!\n\n**Reviewed commit:** \`${marker}\`\n\n<details> <summary>About Codex in GitHub</summary> … </details>`,
      lastEditedAt: edited ? "2026-10-07T21:00:00Z" : null,
      author,
    });
    fixCount(conn);
  },
  /** A string in a GitHub-controlled field that flows into the report (a failing context's name). */
  vercelContextName: (w, name) => {
    for (const n of rollupNodes(w)) if (n.__typename === "StatusContext") n.context = name;
  },
  /** The PR is based on a branch other than production; its base tip is that branch's, not production's. */
  featureBase: (w, sha = "1111111111111111111111111111111111111111") => {
    const p = pr(w);
    p.baseRefName = "feat/other-base";
    p.baseRef.target.oid = sha;
    w.compare.base_commit.sha = sha;
    w.compare.merge_base_commit.sha = sha;
  },
};

export function world(...steps) {
  const w = clone(world800());
  for (const s of steps) {
    if (Array.isArray(s)) edits[s[0]](w, ...s.slice(1));
    else edits[s](w);
  }
  return w;
}

/** Worlds with the decision SPEC-05B requires (hand-derived from the facts above). */
export const WORLDS = [
  { name: "recorded #800 (draft)", steps: [], decision: "DRAFT_HOLD" },
  { name: "ready, production unprotected", steps: ["ready"], decision: "UNKNOWN", reason: "base_history_unverified" },
  { name: "ready, protected, one Codex thread open", steps: ["ready", "protectedRules"], decision: "FINDINGS_OPEN" },
  { name: "ready, protected, thread resolved by the operator", steps: ["ready", "protectedRules", "resolveOpenThread"], decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { name: "thread resolved by Codex itself", steps: ["ready", "protectedRules", "resolveOpenThreadByCodex"], decision: "FINDINGS_OPEN" },
  { name: "behind production 2, history unverified", steps: ["ready", ["behind", 2]], decision: "NEEDS_REFRESH" },
  { name: "behind production 2, run failed", steps: ["ready", "protectedRules", ["behind", 2], ["runConclusion", "failure"]], decision: "NEEDS_REFRESH" },
  { name: "run failed", steps: ["ready", "protectedRules", "resolveOpenThread", ["runConclusion", "failure"]], decision: "CI_FAILED" },
  { name: "run failed and Vercel failed", steps: ["ready", "protectedRules", "resolveOpenThread", ["runConclusion", "failure"], ["vercelState", "FAILURE"]], decision: "CI_FAILED" },
  { name: "run in progress", steps: ["ready", "protectedRules", "resolveOpenThread", "runInProgress"], decision: "CI_PENDING" },
  { name: "run in progress, Vercel pending", steps: ["ready", "protectedRules", "resolveOpenThread", "runInProgress", ["vercelState", "PENDING"]], decision: "CI_PENDING" },
  { name: "no run at the head", steps: ["ready", "protectedRules", "resolveOpenThread", "noRuns"], decision: "CI_NOT_STARTED" },
  { name: "no run, Vercel failed", steps: ["ready", "protectedRules", "resolveOpenThread", "noRuns", ["vercelState", "FAILURE"]], decision: "EXTERNAL_BLOCKED" },
  { name: "required job failed in a successful run", steps: ["ready", "protectedRules", "resolveOpenThread", "requiredJobFailed"], decision: "CI_INCOMPLETE" },
  { name: "Vercel failed", steps: ["ready", "protectedRules", "resolveOpenThread", ["vercelState", "FAILURE"]], decision: "EXTERNAL_BLOCKED" },
  { name: "Vercel error", steps: ["ready", "protectedRules", "resolveOpenThread", ["vercelState", "ERROR"]], decision: "EXTERNAL_BLOCKED" },
  { name: "Vercel pending", steps: ["ready", "protectedRules", "resolveOpenThread", ["vercelState", "PENDING"]], decision: "EXTERNAL_PENDING" },
  { name: "Vercel expected", steps: ["ready", "protectedRules", "resolveOpenThread", ["vercelState", "EXPECTED"]], decision: "EXTERNAL_PENDING" },
  { name: "no Codex review at the head", steps: ["ready", "protectedRules", "resolveOpenThread", "dropHeadReview"], decision: "REVIEW_MISSING" },
  { name: "head review DISMISSED", steps: ["ready", "protectedRules", "resolveOpenThread", ["headReviewState", "DISMISSED"]], decision: "REVIEW_MISSING" },
  { name: "head review PENDING", steps: ["ready", "protectedRules", "resolveOpenThread", ["headReviewState", "PENDING"]], decision: "REVIEW_MISSING" },
  { name: "head review CHANGES_REQUESTED", steps: ["ready", "protectedRules", "resolveOpenThread", ["headReviewState", "CHANGES_REQUESTED"]], decision: "FINDINGS_OPEN" },
  { name: "head review APPROVED", steps: ["ready", "protectedRules", "resolveOpenThread", ["headReviewState", "APPROVED"]], decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { name: "head review by the Codex id typed User", steps: ["ready", "protectedRules", "resolveOpenThread", ["headReviewAuthorType", "User"]], decision: "REVIEW_MISSING" },
  { name: "clean comment at head instead of a review", steps: ["ready", "protectedRules", "resolveOpenThread", "dropHeadReview", "addCleanComment"], decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { name: "clean comment at head, edited", steps: ["ready", "protectedRules", "resolveOpenThread", "dropHeadReview", ["addCleanComment", { edited: true }]], decision: "REVIEW_MISSING" },
  { name: "clean comment for another head", steps: ["ready", "protectedRules", "resolveOpenThread", "dropHeadReview", ["addCleanComment", { marker: "3301ac3cf9" }]], decision: "REVIEW_MISSING" },
  { name: "clean comment at head, open Codex thread", steps: ["ready", "protectedRules", "dropHeadReview", "addCleanComment"], decision: "FINDINGS_OPEN" },
  { name: "merged", steps: ["merged"], decision: "NOT_OPEN" },
  { name: "draft and behind and failing", steps: [["behind", 3], ["runConclusion", "failure"], ["vercelState", "FAILURE"]], decision: "DRAFT_HOLD" },
  { name: "PR based on a feature branch", steps: ["ready", "featureBase"], decision: "UNKNOWN", reason: "base_ref" },
];

/** Collection failures (SPEC-05A §5.3): a failed read, a moving key, an unstable second pass. */
export const FAILING_WORLDS = [
  {
    name: "PR key read fails",
    build: () => ({ ...world(), "pr-key": { fail: { status: 1, stderr: "gh: Bad credentials (HTTP 401)" } } }),
    decision: "UNKNOWN",
    reason: "read_failed",
  },
  {
    name: "review evidence changes between passes",
    build: () => {
      const a = world("ready", "protectedRules");
      const b = world("ready", "protectedRules", "resolveOpenThread");
      return { ...a, "review-evidence": { __seq: [a["review-evidence"], b["review-evidence"]] } };
    },
    decision: "UNKNOWN",
    reason: "unstable_snapshot",
  },
  {
    // GitHub serves the moved head consistently (its rollup echoes the new oid), so only the key differs.
    name: "head moves between passes",
    build: () => {
      const a = world("ready", "protectedRules");
      const MOVED = "2222222222222222222222222222222222222222";
      const moved = clone(a["pr-key"]);
      moved.data.repository.pullRequest.headRefOid = MOVED;
      const rollupFor = (sha) => {
        const r = clone(a["commit-rollup"]);
        r.data.repository.object.oid = sha;
        return r;
      };
      return { ...a, __lenient: true, "pr-key": { __seq: [a["pr-key"], a["pr-key"], moved] }, "commit-rollup": (route) => rollupFor(route.headSha) };
    },
    decision: "UNKNOWN",
    reason: "pr_key_moved",
  },
];
