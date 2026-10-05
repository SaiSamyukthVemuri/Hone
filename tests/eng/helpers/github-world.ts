import { createHash } from "node:crypto";

// ===========================================================================
// A synthetic GitHub for the shepherd tests.
// ===========================================================================
//
// It answers exactly the requests `collectShepherdFacts` makes, in the shapes
// GitHub returns them - `gh api --paginate --slurp` gives an ARRAY OF PAGES -
// with the field names checked against live responses for this repository
// (#769, #786, #792, #793) on 2026-10-05.
//
// A World holds the raw RESPONSE bodies, metadata included, so a test can
// corrupt any leaf of any answer - a `total_count`, a `head_sha`, a thread's
// `isResolved` - exactly as a malformed or partial answer would arrive.

export const REPO = "SaiSamyukthVemuri/Hone";
export const PROD_BRANCH = "claude/build-hone-saas-hOex7";
export const NOW = Date.parse("2026-10-05T18:00:00Z");
export const CI_WORKFLOW = ".github/workflows/ci.yml";

/** A deterministic, well-formed 40-hex sha per seed. */
export const sha = (seed: string): string => createHash("sha1").update(seed).digest("hex");
export const short = (s: string): string => s.slice(0, 10);
/** An ISO timestamp `minutes` before NOW, in GitHub's second-precision form. */
export const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

export const CODEX = { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "Bot" };
export const OPERATOR = { login: "SaiSamyukthVemuri", id: 26781116, type: "User" };

export const finding = (severity: string, title: string): string =>
  `**<sub><sub>![${severity} Badge](https://img.shields.io/badge/${severity}-yellow?style=flat)</sub></sub>  ${title}**\n\nWhy it matters.`;
export const cleanVerdict = (head: string): string =>
  `Codex Review: Didn't find any major issues. Hooray!\n\n**Reviewed commit:** \`${short(head)}\`\n\nComment "@codex review" to run it again.`;
export const findingsVerdict = (head: string): string =>
  `\n### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${short(head)}\``;
export const reviewRequest = (head: string): string => `@codex review \`${short(head)}\``;
/** Codex's own summary comment: it mentions "@codex review" and a sha, and is no request. */
export const codexSummary = (head: string): string =>
  `<!-- codex-pull-request-review-summary -->\n## Codex Review Summary\n| Review | Status | Commit |\n| --- | --- | --- |\n| Code Review | Completed | \`${head.slice(0, 7)}\` |\n\nComment "@codex review" or "@codex security review".`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface World {
  pr: number;
  head: string;
  production: string;
  commits: string[];
  responses: Record<string, Json>;
}

export interface Call {
  index: number;
  path: string;
  opts: { paginate?: boolean; graphql?: { query: string; variables: Record<string, unknown> } };
  key: string | null;
}

const ROUTES: Array<[RegExp, string]> = [
  [/^repos\/\{repo\}\/pulls\/\d+$/, "pull"],
  [/^repos\/\{repo\}\/pulls\/\d+\/reviews$/, "reviews"],
  [/^repos\/\{repo\}\/pulls\/\d+\/comments$/, "inline"],
  [/^repos\/\{repo\}\/issues\/\d+\/comments$/, "issues"],
  [/^repos\/\{repo\}\/commits\/[0-9a-f]{40}\/check-runs$/, "checkRuns"],
  [/^repos\/\{repo\}\/actions\/runs\?head_sha=[0-9a-f]{40}&per_page=100$/, "workflowRuns"],
  [/^repos\/\{repo\}\/commits\/[0-9a-f]{40}\/status\?per_page=100$/, "statuses"],
  [/^repos\/\{repo\}\/git\/ref\/heads\/.+$/, "productionRef"],
  [/^repos\/\{repo\}\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}\?per_page=1$/, "comparison"],
  [/^repos\/\{repo\}\/pulls\/\d+\/commits$/, "commits"],
  [/^repos\/\{repo\}\/pulls\/\d+\/files$/, "files"],
  [/^graphql$/, "threads"],
  [/^repos\/\{repo\}\/actions\/runs\?branch=[^&]+&event=pull_request&per_page=100$/, "branchRuns"],
];

export const route = (path: string): string | null => ROUTES.find(([re]) => re.test(path))?.[1] ?? null;

/**
 * A fetcher over a World. The SECOND read of the pull request - the
 * collector's uncached head re-read - is the `pullAfter` answer, which is how a
 * push landing mid-read is staged; a world without one answers it 404.
 * `fault` may answer any call in place of the world; `record` sees every call.
 *
 * Answers are served BY REFERENCE: the collector never modifies what it reads,
 * which the suite proves by deep-freezing a world and reading it.
 */
export function fetcherFor(
  world: World,
  { fault, record }: { fault?: (call: Call) => unknown; record?: Call[] } = {},
) {
  let index = 0;
  let pullReads = 0;
  return (path: string, opts: Call["opts"] = {}) => {
    let key = route(path);
    if (key === "pull" && ++pullReads > 1) key = "pullAfter";
    const call: Call = { index: index++, path, opts, key };
    record?.push(call);
    const injected = fault?.(call);
    if (injected !== undefined) return injected;
    if (key === null) return { ok: false, reason: `HTTP 404: no route for ${path}` };
    if (!(key in world.responses)) return { ok: false, reason: `HTTP 404: ${key}` };
    return { ok: true, data: world.responses[key] };
  };
}

/** Freeze every object and array in a value, so any write to it throws. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const ciRun = (id: number, head: string, conclusion: string | null, status = "completed") => ({
  id,
  name: "ci",
  path: CI_WORKFLOW,
  event: "pull_request",
  status,
  conclusion,
  head_sha: head,
  head_branch: "feat/eng-world",
  run_attempt: 1,
  created_at: ago(200 - id + 3000),
});

/**
 * A pull request at the human merge gate. Its history is deliberately not
 * trivial, so READY is reached THROUGH the cases that must not block it:
 *
 *   * a P2 found at C2 is carried, re-anchored onto the head, and RESOLVED;
 *   * C2's review round raised it, then the head's round came back clean;
 *   * CI failed once (C1) and passed since;
 *   * Codex's summary comment mentions "@codex review" and is not a request;
 *   * one lane is `skipped`, and Vercel reports as a commit status.
 */
export function readyWorld(): World {
  const P = sha("production");
  const C1 = sha("c1");
  const C2 = sha("c2");
  const H = sha("head");
  const pull = {
    number: 900,
    state: "open",
    draft: false,
    // Opened before every commit on it, so opening asked for no review of H.
    created_at: ago(240),
    merged_at: null,
    merge_commit_sha: null,
    mergeable: true,
    mergeable_state: "clean",
    commits: 3,
    changed_files: 2,
    head: { sha: H, ref: "feat/eng-world" },
    base: { ref: PROD_BRANCH, sha: P, repo: { default_branch: PROD_BRANCH } },
  };
  const check = (name: string, conclusion: string) => ({ name, status: "completed", conclusion, head_sha: H });
  return {
    pr: 900,
    head: H,
    production: P,
    commits: [C1, C2, H],
    responses: {
      pull,
      pullAfter: structuredClone(pull),
      reviews: [
        [{ id: 7001, user: CODEX, body: findingsVerdict(C2), state: "COMMENTED", commit_id: C2, submitted_at: ago(90) }],
      ],
      inline: [
        [
          {
            id: 5001,
            user: CODEX,
            body: finding("P2", "A carried, resolved finding"),
            commit_id: H,
            original_commit_id: C2,
            path: "scripts/eng/world.mjs",
            line: 12,
            original_line: 12,
            created_at: ago(90),
            reactions: { total_count: 0 },
          },
        ],
      ],
      issues: [
        [
          { id: 6000, user: CODEX, body: codexSummary(H), created_at: ago(200) },
          { id: 6001, user: OPERATOR, body: reviewRequest(C2), created_at: ago(95) },
          { id: 6002, user: OPERATOR, body: reviewRequest(H), created_at: ago(20) },
          { id: 6003, user: CODEX, body: cleanVerdict(H), created_at: ago(15) },
        ],
      ],
      checkRuns: [
        {
          total_count: 5,
          check_runs: [
            check("changed-path detection", "success"),
            check("typecheck / lint / build / test / safety gates", "success"),
            check("browser e2e (local stack)", "success"),
            check("payment browser e2e (fake stripe)", "skipped"),
            check("Vercel Preview Comments", "success"),
          ],
        },
      ],
      workflowRuns: [{ total_count: 1, workflow_runs: [ciRun(3003, H, "success")] }],
      statuses: [{ sha: H, state: "success", total_count: 1, statuses: [{ context: "Vercel", state: "success" }] }],
      productionRef: { ref: `refs/heads/${PROD_BRANCH}`, object: { sha: P, type: "commit" } },
      comparison: { status: "ahead", ahead_by: 3, behind_by: 0, total_commits: 3, base_commit: { sha: P }, merge_base_commit: { sha: P } },
      commits: [
        [
          { sha: C1, parents: [{ sha: P }], commit: { committer: { date: ago(180) } } },
          { sha: C2, parents: [{ sha: C1 }], commit: { committer: { date: ago(100) } } },
          { sha: H, parents: [{ sha: C2 }], commit: { committer: { date: ago(40) } } },
        ],
      ],
      files: [[{ filename: "scripts/eng/world.mjs" }, { filename: "tests/eng/world.test.ts" }]],
      threads: [
        {
          data: {
            repository: {
              pullRequest: {
                // Never a draft, so no ready-for-review event.
                timelineItems: { nodes: [] },
                reviewThreads: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: "Y3Vyc29yOjE=" },
                  nodes: [{ isResolved: true, isOutdated: true, comments: { nodes: [{ databaseId: 5001 }] } }],
                },
              },
            },
          },
        },
      ],
      branchRuns: {
        total_count: 3,
        workflow_runs: [ciRun(3003, H, "success"), ciRun(3002, C2, "success"), ciRun(3001, C1, "failure")],
      },
    },
  };
}

export { ciRun };
