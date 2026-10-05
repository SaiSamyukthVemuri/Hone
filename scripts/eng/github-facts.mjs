#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005a: GitHub fact ingestion for one pull request, at an EXACT head.
//
// WHY THIS EXISTS
// Delivery state was reconstructed by hand from the GitHub web UI, and the
// surfaces disagree with each other in ways a screenshot cannot show:
//
//   * an inline finding raised at an OLD head is RE-ANCHORED by GitHub onto a
//     newer head, so `commit_id` alone reads as "found at current head" while
//     `original_commit_id` says otherwise (6 of 22 comments on PR #610);
//   * the Codex verdict may live in a separate ISSUE comment carrying its own
//     "Reviewed commit" sha, or in a submitted review body;
//   * a review object can arrive with an EMPTY body, which is not a verdict;
//   * a check run belongs to one exact `head_sha`, and a LIST surface is
//     paginated, so "CI is green" is only ever a statement about a specific
//     commit AND about a collection that was read in full.
//
// On PR #610 an operator wrote "no review came back for 3859f636" 43 minutes
// after a clean review for that exact head had already been posted. That is the
// cost this module removes.
//
// FACT QUALITY IS CARRIED, NOT ASSUMED. Every surface that can contribute to a
// positive state returns an evidence envelope (scripts/eng/evidence.mjs) with a
// COMPLETENESS and an AUTHORITY, and only `mayAssertPositive` may turn one into
// GREEN or CLEAN. UNKNOWN is first class throughout: "we could not read it" and
// "there is none" are different answers and never collapse into each other.
//
// It FETCHES and PROJECTS. It does not decide release readiness, apply a stop
// law, record findings state, or merge. Interpretation lives in shepherd.mjs
// (ENG-LOOP-01), which consumes these facts; no findings ledger exists.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import {
  AUTHORIZED,
  COMPLETE,
  INCOMPLETE,
  collectionEvidence,
  evidence,
  mayAssertPositive,
  verdictEvidence,
  UNKNOWN,
} from "./evidence.mjs";

export { UNKNOWN };

/** Repository these facts are read from. Overridable for tests and forks. */
export const DEFAULT_REPO = "SaiSamyukthVemuri/Hone";

/**
 * A Codex finding announces its severity with a shields.io badge. A comment
 * WITHOUT one is a reply, an acknowledgement or a human note - never a finding.
 * That keeps "acknowledgement" from being counted as review completion.
 */
const SEVERITY_BADGE = /!\[(P[0-3]) Badge\]/;

/** The title follows the badge markup on the same line, in bold. */
const FINDING_TITLE = /<\/sub><\/sub>\s+(.+?)\*\*/s;

/** Codex states the head it reviewed. Matching this proves NOTHING about who
 *  wrote it, which is precisely why authority is a separate dimension. */
const REVIEWED_COMMIT = /Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/;

/** Codex's clean wording. Again: wording is not authority. */
const CLEAN_VERDICT = /Didn't find any major issues/i;

/** An operator asks for a review by mentioning the bot. */
const REVIEW_REQUEST = /@codex\s+review/i;

/** A sha named in a review request, so the ask is bound to a head. */
const SHA_IN_TEXT = /`([0-9a-f]{7,40})`/;

/**
 * Default fetcher: `gh api`. Injectable so the tests run against recorded
 * fixtures with no network and no credentials.
 *
 * `--paginate --slurp` returns an ARRAY OF PAGES for both array and object
 * responses, which is what makes a collection's completeness checkable: each
 * check-runs page carries `total_count`, so collected-versus-reported is a
 * comparison rather than an assumption.
 *
 * Returns `{ ok, data }` or `{ ok: false, reason }`. It never throws: a missing
 * surface must reach the caller as UNKNOWN, not as an exception someone might
 * catch and treat as "nothing there".
 *
 * READ-ONLY BY CONSTRUCTION. A REST request is only ever `gh api <path>`: no
 * method and no fields, so it is a GET. GraphQL is the one request sent with
 * fields, and only a read QUERY is ever sent; any other document is refused
 * here rather than trusted to the caller. `exec` is injectable so a test can
 * see the exact argv.
 */
export function ghFetcher({ repo = DEFAULT_REPO, exec = execFileSync } = {}) {
  return (path, { paginate = false, graphql = null } = {}) => {
    const args = ["api", path.replace("{repo}", repo)];
    if (paginate) args.push("--paginate", "--slurp");
    if (graphql !== null) {
      if (path !== "graphql" || !isReadQuery(graphql.query)) {
        return { ok: false, reason: "refused: only a read-only GraphQL query may be sent" };
      }
      for (const [key, value] of Object.entries(graphql.variables ?? {})) {
        // `-F` types integers; strings go raw so a leading "@" is never a file.
        args.push(Number.isInteger(value) ? "-F" : "-f", `${key}=${value}`);
      }
      args.push("-f", `query=${graphql.query}`);
    }
    try {
      const out = exec("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      return { ok: true, data: JSON.parse(out) };
    } catch (err) {
      const stderr = String(err.stderr ?? err.message ?? "").trim().split("\n")[0];
      return { ok: false, reason: stderr || "gh api call failed" };
    }
  };
}

const shortSha = (sha) => (typeof sha === "string" ? sha.slice(0, 10) : sha);

/**
 * Project one inline review comment.
 *
 * BOTH shas are kept, deliberately. `originalCommitId` is where the finding was
 * RAISED; `commitId` is only where GitHub currently displays it. They differ
 * whenever GitHub re-anchors an older comment onto a newer head, and reading the
 * wrong one is how a stale finding is mistaken for a fresh one.
 */
export function projectInlineComment(c) {
  const body = String(c.body ?? "");
  const severity = body.match(SEVERITY_BADGE)?.[1] ?? null;
  const title = body.match(FINDING_TITLE)?.[1]?.trim().replace(/\*+$/, "") ?? null;
  return {
    id: c.id,
    author: c.user?.login ?? UNKNOWN,
    authorId: c.user?.id ?? null,
    commitId: c.commit_id ?? null,
    originalCommitId: c.original_commit_id ?? null,
    path: c.path ?? null,
    line: c.line ?? c.original_line ?? null,
    inReplyToId: c.in_reply_to_id ?? null,
    severity,
    title: severity ? title : null,
    reactionCount: c.reactions?.total_count ?? 0,
    createdAt: c.created_at ?? null,
  };
}

/**
 * Project a submitted review, and normalize any verdict in its body into the
 * SAME shape an issue-comment verdict uses. Giving the two surfaces separate
 * truth logic is what previously made a clean result readable from one and
 * invisible from the other.
 */
export function projectReview(r) {
  const body = String(r.body ?? "");
  const hasBody = body.trim().length > 0;
  const reviewedCommit = body.match(REVIEWED_COMMIT)?.[1] ?? null;
  return {
    id: r.id,
    author: r.user?.login ?? UNKNOWN,
    authorId: r.user?.id ?? null,
    state: r.state ?? UNKNOWN,
    commitId: r.commit_id ?? null,
    submittedAt: r.submitted_at ?? null,
    hasBody,
    verdict: verdictEvidence({
      sourceType: "review_object",
      sourceId: r.id,
      user: r.user,
      // A review body may state its head explicitly; otherwise the object's own
      // commit_id is the head it was submitted against.
      reviewedCommit: reviewedCommit ?? r.commit_id ?? null,
      clean: hasBody ? CLEAN_VERDICT.test(body) : null,
      hasBody,
    }),
  };
}

/**
 * Project an issue comment. Two kinds matter and they are different surfaces:
 * the reviewer's VERDICT, and an operator's REQUEST for a review.
 *
 * A comment is only ever a verdict CANDIDATE here. Whether it counts is decided
 * by the authority carried in its envelope, never by its wording - anyone can
 * copy the wording, which is exactly the hole this closes.
 */
export function projectIssueComment(c) {
  const body = String(c.body ?? "");
  const verdictCommit = body.match(REVIEWED_COMMIT)?.[1] ?? null;
  const isRequest = REVIEW_REQUEST.test(body);
  return {
    id: c.id,
    author: c.user?.login ?? UNKNOWN,
    authorId: c.user?.id ?? null,
    createdAt: c.created_at ?? null,
    isVerdictCandidate: verdictCommit !== null,
    verdict:
      verdictCommit === null
        ? null
        : verdictEvidence({
            sourceType: "issue_comment",
            sourceId: c.id,
            user: c.user,
            reviewedCommit: verdictCommit,
            clean: CLEAN_VERDICT.test(body),
            hasBody: body.trim().length > 0,
          }),
    isReviewRequest: isRequest,
    requestedCommit: isRequest ? (body.match(SHA_IN_TEXT)?.[1] ?? null) : null,
  };
}

/** Project a check run. Every check belongs to exactly one head sha. */
export function projectCheckRun(c) {
  return {
    name: c.name ?? UNKNOWN,
    status: c.status ?? UNKNOWN,
    conclusion: c.conclusion ?? null,
    headSha: c.head_sha ?? null,
  };
}

/**
 * Flatten `--slurp` pages of a check-runs response into items plus the
 * advertised total, so completeness is a comparison rather than a hope. Pages
 * are objects `{ total_count, check_runs }`; a single un-slurped object is
 * accepted too, so a caller may hand in one page.
 */
export function flattenCheckRunPages(data) {
  const pages = Array.isArray(data) ? data : [data];
  const items = [];
  let totalCount = null;
  for (const p of pages) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.total_count === "number") totalCount = p.total_count;
    for (const r of p.check_runs ?? []) items.push(projectCheckRun(r));
  }
  return { items, totalCount, pages: pages.length };
}

/** Flatten `--slurp` pages of an array response (reviews, comments). */
function flattenArrayPages(data) {
  const pages = Array.isArray(data) && Array.isArray(data[0]) ? data : [data];
  return { items: pages.flat().filter(Boolean), pages: pages.length };
}

/**
 * Collect every surface for one PR.
 *
 * Each surface resolves independently, so one unreadable surface degrades that
 * surface instead of failing the whole read or - worse - silently returning an
 * empty list that reads like "there is nothing there".
 */
export function collectFacts({ pr, fetcher, repo = DEFAULT_REPO }) {
  const fetch = fetcher ?? ghFetcher({ repo });
  const unavailable = [];

  const raw = (name, path, opts) => {
    const r = fetch(path, opts);
    if (!r.ok) {
      unavailable.push({ surface: name, reason: r.reason });
      return { error: r.reason };
    }
    return { data: r.data };
  };

  const prRaw = raw("pull_request", `repos/{repo}/pulls/${pr}`);
  const head = prRaw.error ? UNKNOWN : (prRaw.data.head?.sha ?? UNKNOWN);

  const listSurface = (name, path, project) => {
    const r = raw(name, path, { paginate: true });
    if (r.error) return collectionEvidence(null, { error: r.error });
    const { items, pages } = flattenArrayPages(r.data);
    return collectionEvidence(items.map(project), { totalCount: null, pages });
  };

  const reviews = listSurface("reviews", `repos/{repo}/pulls/${pr}/reviews`, projectReview);
  const inlineComments = listSurface("inline_comments", `repos/{repo}/pulls/${pr}/comments`, projectInlineComment);
  const issueComments = listSurface("issue_comments", `repos/{repo}/issues/${pr}/comments`, projectIssueComment);

  // Check runs are addressed BY SHA, never "latest", and collected in FULL:
  // a rollup or a first page would happily describe less than the whole truth.
  let checkRuns;
  if (head === UNKNOWN) {
    checkRuns = collectionEvidence(null, { error: "the head sha is unknown, so no check runs can be bound to it" });
  } else {
    const r = raw("check_runs", `repos/{repo}/commits/${head}/check-runs`, { paginate: true });
    if (r.error) checkRuns = collectionEvidence(null, { error: r.error });
    else {
      const { items, totalCount, pages } = flattenCheckRunPages(r.data);
      checkRuns = collectionEvidence(items, { totalCount, pages });
    }
  }

  return {
    repo,
    pr: Number(pr),
    head,
    pullRequest: prRaw.error
      ? UNKNOWN
      : {
          number: prRaw.data.number,
          state: prRaw.data.state,
          isDraft: Boolean(prRaw.data.draft),
          head: prRaw.data.head?.sha ?? UNKNOWN,
          baseRef: prRaw.data.base?.ref ?? UNKNOWN,
          baseSha: prRaw.data.base?.sha ?? UNKNOWN,
          mergedAt: prRaw.data.merged_at ?? null,
          mergeCommit: prRaw.data.merge_commit_sha ?? null,
        },
    checkRuns,
    reviews,
    inlineComments,
    issueComments,
    unavailable,
  };
}

// ===========================================================================
// ENG-LOOP-01: what `shepherd` reads, and how STRICTLY.
// ===========================================================================
//
// `collectFacts` serves `status` and is unchanged: same requests, same lenient
// projection. The shepherd turns facts into a next step, so it holds the answers
// it is handed to a stricter contract. CP-005's retired vehicles (#617-#623)
// failed one way, repeatedly: an unreadable or malformed answer fell through a
// permissive default into a positive state. Here nothing malformed is coerced:
//
//   * every item is checked against the SHAPE of the fields the shepherd reads,
//     and one failing item invalidates its whole collection - it is never
//     skipped, because a skipped failing check run is a missing failure;
//   * a collection that advertises a total is COMPLETE only when every page
//     states the same non-negative integer total and exactly that many items
//     arrived; one that advertises none is checked against the count the pull
//     request itself states (`commits`, `changed_files`);
//   * an item in a by-sha collection that names another sha makes the
//     collection invalid, not "foreign" and quietly dropped.
//
// The shape lists are hand-written, which is precisely the weakness the
// roadmap's re-entry gate names (CANONICAL_ROADMAP §16.5): a validator is
// authoritative only over the fields someone remembered to list. They are
// therefore NOT trusted to be complete. tests/eng/shepherd.test.ts corrupts
// every leaf of every recorded answer, one at a time, and requires that no
// corruption turns a pull request that is not ready into READY_FOR_HUMAN_MERGE.

/** A read QUERY, never a mutation or subscription. */
function isReadQuery(query) {
  return typeof query === "string" && /^\s*query\b/.test(query) && !/\b(mutation|subscription)\b/.test(query);
}

const SHA40 = /^[0-9a-f]{40}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Field checks. A shape is an object of checks or nested shapes. */
const is = {
  int: (v) => Number.isInteger(v),
  count: (v) => Number.isInteger(v) && v >= 0,
  str: (v) => typeof v === "string",
  bool: (v) => typeof v === "boolean",
  sha: (v) => typeof v === "string" && SHA40.test(v),
  time: (v) => typeof v === "string" && ISO_TIME.test(v),
};

/** A shape compiled once into one predicate, so a read does not re-walk it. */
const compiled = new WeakMap();
function compile(shape) {
  if (typeof shape === "function") return shape;
  if (!compiled.has(shape)) {
    const fields = Object.entries(shape).map(([key, s]) => [key, compile(s)]);
    compiled.set(shape, (v) =>
      v !== null && typeof v === "object" && !Array.isArray(v) && fields.every(([key, check]) => check(v[key])),
    );
  }
  return compiled.get(shape);
}
const nullable = (shape) => {
  const check = compile(shape);
  return (v) => v === null || check(v);
};
const optional = (shape) => {
  const check = compile(shape);
  return (v) => v === undefined || v === null || check(v);
};
const listOf = (shape, min = 0) => {
  const check = compile(shape);
  return (v) => Array.isArray(v) && v.length >= min && v.every(check);
};

export function conforms(value, shape) {
  return compile(shape)(value);
}

const ACTOR = { id: is.int, login: is.str, type: is.str };

/** Only the fields the shepherd reads; anything else in an answer is ignored. */
export const SHAPES = Object.freeze({
  pull: {
    number: is.int,
    state: is.str,
    draft: is.bool,
    merged_at: nullable(is.time),
    mergeable: nullable(is.bool),
    commits: is.count,
    changed_files: is.count,
    head: { sha: is.sha, ref: is.str },
    base: { ref: is.str, repo: { default_branch: is.str } },
  },
  review: { id: is.int, user: ACTOR, body: is.str, state: is.str, commit_id: nullable(is.sha) },
  inlineComment: {
    id: is.int,
    user: ACTOR,
    body: is.str,
    original_commit_id: is.sha,
    commit_id: nullable(is.sha),
    in_reply_to_id: optional(is.int),
  },
  issueComment: { id: is.int, user: ACTOR, body: is.str, created_at: is.time },
  checkRun: { name: is.str, status: is.str, conclusion: nullable(is.str), head_sha: is.sha },
  workflowRun: {
    id: is.int,
    path: is.str,
    status: is.str,
    conclusion: nullable(is.str),
    head_sha: is.sha,
  },
  commitStatus: { context: is.str, state: is.str },
  commit: { sha: is.sha, parents: listOf({ sha: is.sha }, 1), commit: { committer: { date: is.time } } },
  file: { filename: is.str, previous_filename: optional(is.str) },
  thread: { isResolved: is.bool, isOutdated: is.bool, comments: { nodes: listOf({ databaseId: is.int }, 1) } },
  ref: { object: { sha: is.sha, type: is.str } },
  comparison: { status: is.str, ahead_by: is.count, behind_by: is.count, base_commit: { sha: is.sha } },
});

const invalid = (reason) => evidence(UNKNOWN, { completeness: UNKNOWN, authority: UNKNOWN, reason });

/** One object, held to its shape (and an optional cross-field check). */
function strictObject(res, shape, project, check = () => null) {
  if (!res.ok) return invalid(`could not be read: ${res.reason}`);
  if (!conforms(res.data, shape)) return invalid("malformed: the answer does not have the expected shape");
  const problem = check(res.data);
  if (problem) return invalid(`inconsistent: ${problem}`);
  return evidence(project(res.data), { completeness: COMPLETE, authority: AUTHORIZED, reason: "read in full" });
}

/**
 * An array endpoint read with `--paginate --slurp`: an array of pages, each an
 * array. REST list endpoints state no total, so `expected` - a count the pull
 * request states about itself - is what makes completeness checkable.
 */
function strictList(res, shape, { expected = null, project = (x) => x } = {}) {
  if (!res.ok) return invalid(`could not be read: ${res.reason}`);
  if (!Array.isArray(res.data) || !res.data.every(Array.isArray)) return invalid("malformed: expected an array of pages");
  const raw = res.data.flat();
  if (!raw.every((x) => conforms(x, shape))) return invalid("malformed: an item does not have the expected shape");
  const items = raw.map(project);
  if (expected === null) {
    return evidence(items, { completeness: COMPLETE, authority: AUTHORIZED, reason: `collected ${items.length} item(s)` });
  }
  if (!is.count(expected)) return invalid("no usable count to check this list against");
  if (items.length > expected) return invalid(`collected ${items.length}, more than the ${expected} stated`);
  return evidence(items, {
    completeness: items.length === expected ? COMPLETE : INCOMPLETE,
    authority: AUTHORIZED,
    reason: `collected ${items.length} of ${expected} stated by the pull request`,
  });
}

/**
 * A paged endpoint whose pages each state a total. With `single`, the answer is
 * one page read without `--paginate`, so a larger total is reported as
 * INCOMPLETE and the reader must treat what it has as a lower bound.
 */
function strictPaged(res, { items, total, shape, bindTo = null, pageSha = null, project = (x) => x, single = false }) {
  if (!res.ok) return invalid(`could not be read: ${res.reason}`);
  const pages = single ? [res.data] : res.data;
  if (!Array.isArray(pages) || pages.length === 0) return invalid("malformed: expected at least one page");
  let stated = null;
  const out = [];
  for (const page of pages) {
    if (page === null || typeof page !== "object" || Array.isArray(page)) return invalid("malformed: a page is not an object");
    if (Array.isArray(page.errors) && page.errors.length > 0) return invalid("the API reported errors in its answer");
    // A page that names its commit (the combined status does) must name ours.
    if (pageSha !== null && page.sha !== pageSha) return invalid("the answer describes another commit than the head");
    const t = total(page);
    const xs = items(page);
    if (!is.count(t)) return invalid("malformed: a page does not state a non-negative integer total");
    if (stated !== null && t !== stated) return invalid("malformed: pages disagree about the total");
    stated = t;
    if (!Array.isArray(xs)) return invalid("malformed: a page carries no item list");
    for (const x of xs) {
      if (!conforms(x, shape)) return invalid("malformed: an item does not have the expected shape");
      if (bindTo !== null && x.head_sha !== bindTo) {
        return invalid(`an item names ${shortSha(x.head_sha)}, not the head this collection was requested for`);
      }
      out.push(project(x));
    }
  }
  if (out.length > stated) return invalid(`collected ${out.length}, more than the stated total ${stated}`);
  return evidence(out, {
    completeness: out.length === stated ? COMPLETE : INCOMPLETE,
    authority: AUTHORIZED,
    reason: `collected ${out.length} of ${stated} stated by the API`,
  });
}

const projectRun = (r) => ({ id: r.id, path: r.path, status: r.status, conclusion: r.conclusion, headSha: r.head_sha });

/** compare/{base}...{head}: every combination GitHub can state, held consistent. */
function comparisonProblem(d, base) {
  if (d.base_commit.sha !== base) return "the comparison is not against the production head that was read";
  const expected = {
    identical: d.ahead_by === 0 && d.behind_by === 0,
    ahead: d.ahead_by > 0 && d.behind_by === 0,
    behind: d.ahead_by === 0 && d.behind_by > 0,
    diverged: d.ahead_by > 0 && d.behind_by > 0,
  };
  if (!(d.status in expected)) return `unrecognized comparison status "${d.status}"`;
  return expected[d.status] ? null : `status "${d.status}" contradicts ahead ${d.ahead_by} / behind ${d.behind_by}`;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { isResolved isOutdated comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

const threadsOf = (page) => page.data?.repository?.pullRequest?.reviewThreads;

/**
 * Collect everything `shepherd` reads for one PR, bound to ONE head.
 *
 * `collectFacts` runs first through a memoizing fetcher, so the pull request it
 * binds provenance to is the same answer every surface below is bound to - one
 * read, not two that might straddle a push. The head is then re-read UNCACHED at
 * the end: if it moved, the answers are not one snapshot and the caller is told
 * so, rather than handed check runs for one head and review threads for another.
 */
export function collectShepherdFacts({ pr, fetcher, repo = DEFAULT_REPO }) {
  // An answer that is not a JSON object or array is malformed, and is turned
  // into a failed read before ANY consumer - collectFacts included - can
  // dereference it.
  const read0 = fetcher ?? ghFetcher({ repo });
  const source = (path, opts) => {
    const r = read0(path, opts);
    return r?.ok && (r.data === null || typeof r.data !== "object")
      ? { ok: false, reason: "malformed: the answer is not a JSON object or array" }
      : r;
  };
  // Memoized by path: the REST reads collectFacts makes are the ones read
  // twice. The single GraphQL read is never repeated, so it is not cached.
  const answers = new Map();
  const fetch = (path, opts = {}) => {
    if (opts.graphql) return source(path, opts);
    const key = opts.paginate ? `${path}#paginate` : path;
    if (!answers.has(key)) answers.set(key, source(path, opts));
    return answers.get(key);
  };

  // collectFacts serves `status` unchanged, and that includes its lenient
  // projection throwing on some malformed answers (a `check_runs` that is not a
  // list). Here such an answer must degrade to UNKNOWN, not end the read.
  let facts;
  try {
    facts = collectFacts({ pr, fetcher: fetch, repo });
  } catch (err) {
    const lost = invalid(`the answers could not be projected: ${err?.message ?? err}`);
    facts = {
      repo, pr: Number(pr), head: UNKNOWN, pullRequest: UNKNOWN,
      checkRuns: lost, reviews: lost, inlineComments: lost, issueComments: lost,
      unavailable: [{ surface: "projection", reason: lost.reason }],
    };
  }
  const unavailable = [...facts.unavailable];
  const read = (surface, path, opts) => {
    const r = fetch(path, opts);
    if (!r.ok) unavailable.push({ surface, reason: r.reason });
    return r;
  };

  const prPath = `repos/{repo}/pulls/${pr}`;
  const pull = strictObject(
    fetch(prPath),
    SHAPES.pull,
    (d) => ({
      number: d.number,
      state: d.state,
      draft: d.draft,
      merged: d.merged_at !== null,
      head: d.head.sha,
      headRef: d.head.ref,
      baseRef: d.base.ref,
      productionBranch: d.base.repo.default_branch,
      mergeable: d.mergeable,
      commitCount: d.commits,
      changedFiles: d.changed_files,
    }),
    (d) => (d.number === Number(pr) ? null : `the answer is for #${d.number}, not #${pr}`),
  );
  const p = mayAssertPositive(pull) ? pull.value : null;
  const head = p ? p.head : UNKNOWN;
  const none = invalid("the pull request could not be read strictly, so nothing can be bound to its head");

  // The provenance surfaces `status` reads, re-checked from the SAME answers.
  const provenance = {
    reviews: strictList(fetch(`repos/{repo}/pulls/${pr}/reviews`, { paginate: true }), SHAPES.review),
    inlineComments: strictList(fetch(`repos/{repo}/pulls/${pr}/comments`, { paginate: true }), SHAPES.inlineComment),
    issueComments: strictList(fetch(`repos/{repo}/issues/${pr}/comments`, { paginate: true }), SHAPES.issueComment),
  };

  if (!p) {
    return {
      repo, pr: Number(pr), head, facts, pull, provenance,
      checkRuns: none, workflowRuns: none, statuses: none, production: none, comparison: none,
      commits: none, files: none, threads: none, branchRuns: none, headAfter: UNKNOWN, unavailable,
    };
  }

  const [owner, name] = repo.split("/");
  const checkRuns = strictPaged(fetch(`repos/{repo}/commits/${head}/check-runs`, { paginate: true }), {
    items: (pg) => pg.check_runs,
    total: (pg) => pg.total_count,
    shape: SHAPES.checkRun,
    bindTo: head,
    project: (c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }),
  });
  const workflowRuns = strictPaged(
    read("workflow_runs", `repos/{repo}/actions/runs?head_sha=${head}&per_page=100`, { paginate: true }),
    { items: (pg) => pg.workflow_runs, total: (pg) => pg.total_count, shape: SHAPES.workflowRun, bindTo: head, project: projectRun },
  );
  const statuses = strictPaged(read("commit_statuses", `repos/{repo}/commits/${head}/status?per_page=100`, { paginate: true }), {
    items: (pg) => pg.statuses,
    total: (pg) => pg.total_count,
    shape: SHAPES.commitStatus,
    pageSha: head,
    project: (s) => ({ context: s.context, state: s.state }),
  });

  const branchPath = p.productionBranch.split("/").map(encodeURIComponent).join("/");
  const production = strictObject(
    read("production_ref", `repos/{repo}/git/ref/heads/${branchPath}`),
    SHAPES.ref,
    (d) => ({ branch: p.productionBranch, head: d.object.sha }),
    (d) => (d.object.type === "commit" ? null : `the production ref points at a ${d.object.type}, not a commit`),
  );
  const productionHead = mayAssertPositive(production) ? production.value.head : null;
  const comparison = productionHead
    ? strictObject(
        read("comparison", `repos/{repo}/compare/${productionHead}...${head}?per_page=1`),
        SHAPES.comparison,
        (d) => ({ status: d.status, aheadBy: d.ahead_by, behindBy: d.behind_by }),
        (d) => comparisonProblem(d, productionHead),
      )
    : invalid("the production head is unknown, so the branch cannot be compared with it");

  const commits = strictList(read("commits", `repos/{repo}/pulls/${pr}/commits`, { paginate: true }), SHAPES.commit, {
    expected: p.commitCount,
    project: (c) => ({ sha: c.sha, parents: c.parents.map((x) => x.sha), committedAt: c.commit.committer.date }),
  });
  const files = strictList(read("files", `repos/{repo}/pulls/${pr}/files`, { paginate: true }), SHAPES.file, {
    expected: p.changedFiles,
    project: (f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]),
  });
  const threads = strictPaged(
    read("review_threads", "graphql", {
      paginate: true,
      graphql: { query: THREADS_QUERY, variables: { owner, name, number: Number(pr) } },
    }),
    {
      items: (pg) => threadsOf(pg)?.nodes,
      total: (pg) => threadsOf(pg)?.totalCount,
      shape: SHAPES.thread,
      project: (t) => ({ rootCommentId: t.comments.nodes[0].databaseId, isResolved: t.isResolved, isOutdated: t.isOutdated }),
    },
  );
  // The newest 100 runs of this branch. Older history is deliberately not
  // paged in: the reader needs the last few heads, and treats a page that does
  // not reach back far enough as a lower bound, never as a clean history.
  const branchRuns = strictPaged(
    read("branch_runs", `repos/{repo}/actions/runs?branch=${encodeURIComponent(p.headRef)}&event=pull_request&per_page=100`),
    { items: (pg) => pg.workflow_runs, total: (pg) => pg.total_count, shape: SHAPES.workflowRun, project: projectRun, single: true },
  );

  // Uncached on purpose: this is the only way to see a push that landed mid-read.
  const after = source(prPath);
  const headAfter = after.ok && is.sha(after.data?.head?.sha) ? after.data.head.sha : UNKNOWN;
  if (!after.ok) unavailable.push({ surface: "pull_request_reread", reason: after.reason });

  return {
    repo, pr: Number(pr), head, facts, pull, provenance,
    checkRuns, workflowRuns, statuses, production, comparison, commits, files, threads, branchRuns,
    headAfter, unavailable,
  };
}

/** Stable ordering + key order, so two reads of one state serialize identically. */
export function serializeFacts(facts) {
  const env = (e, sort) =>
    !e || e.value === UNKNOWN || e.value === null
      ? { value: UNKNOWN, completeness: e?.completeness ?? UNKNOWN, authority: e?.authority ?? UNKNOWN, reason: e?.reason ?? UNKNOWN }
      : { value: sort ? sort([...e.value]) : e.value, completeness: e.completeness, authority: e.authority, reason: e.reason };
  const byId = (xs) => xs.sort((a, b) => a.id - b.id);
  return JSON.stringify(
    {
      repo: facts.repo,
      pr: facts.pr,
      head: facts.head,
      pullRequest: facts.pullRequest,
      checkRuns: env(facts.checkRuns, (xs) => xs.sort((a, b) => a.name.localeCompare(b.name))),
      reviews: env(facts.reviews, byId),
      inlineComments: env(facts.inlineComments, byId),
      issueComments: env(facts.issueComments, byId),
      unavailable: facts.unavailable,
    },
    null,
    2,
  );
}

export { shortSha, evidence };
