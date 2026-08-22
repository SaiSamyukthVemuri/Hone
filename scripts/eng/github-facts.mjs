#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005a: GitHub fact ingestion for one pull request, at an EXACT head.
//
// WHY THIS EXISTS
// Delivery state was being reconstructed by hand from the GitHub web UI, and
// the surfaces disagree with each other in ways a screenshot cannot show:
//
//   * an inline finding raised at an OLD head is RE-ANCHORED by GitHub onto a
//     newer head, so `commit_id` alone reads as "found at current head" while
//     `original_commit_id` says otherwise (6 of 22 comments on PR #610);
//   * the Codex verdict is not in the review object at all - it arrives as a
//     separate ISSUE comment carrying its own "Reviewed commit" sha;
//   * a review object can arrive with an EMPTY body, which is not a verdict;
//   * a check run belongs to one exact `head_sha`, so "CI is green" is only
//     ever a statement about a specific commit.
//
// On PR #610 an operator wrote "no review came back for 3859f636" 43 minutes
// after a clean review for that exact head had already been posted. That is the
// cost this module removes.
//
// WHAT THIS MODULE DOES, AND DOES NOT
// It FETCHES and PROJECTS. It does not decide anything: no release readiness,
// no stop laws, no findings ledger, no state transitions, and no merge. Those
// are CP-005b and CP-005c. Everything here is a statement of what GitHub said.
//
// UNKNOWN IS FIRST CLASS. A surface that could not be read is reported as
// UNKNOWN with a reason. It is never flattened into empty, none, clean or
// closed - which is the specific failure this whole program exists to prevent.
// `gh` is an operator dependency that no other repository script requires, so
// its absence is a normal, expected UNKNOWN rather than an error.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

export const UNKNOWN = "UNKNOWN";

/** Repository these facts are read from. Overridable for tests and forks. */
export const DEFAULT_REPO = "SaiSamyukthVemuri/Hone";

/**
 * A Codex finding announces its severity with a shields.io badge in the comment
 * body. A comment WITHOUT one is a reply, an acknowledgement or a human note -
 * never a finding. That distinction is mechanical, and it is what keeps
 * "acknowledgement" from being counted as review completion.
 */
const SEVERITY_BADGE = /!\[(P[0-3]) Badge\]/;

/** The title follows the badge markup on the same line, in bold. */
const FINDING_TITLE = /<\/sub><\/sub>\s+(.+?)\*\*/s;

/** Codex states the head it reviewed inside its verdict comment. */
const REVIEWED_COMMIT = /Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/;

/** Codex's clean verdict wording is stable enough to detect, but see below. */
const CLEAN_VERDICT = /Didn't find any major issues/i;

/** An operator asks for a review by mentioning the bot. */
const REVIEW_REQUEST = /@codex\s+review/i;

/** A 40-char sha mentioned in a review request, so the ask is bound to a head. */
const SHA_IN_TEXT = /`([0-9a-f]{7,40})`/;

/**
 * Default fetcher: `gh api`. Injectable so the provenance tests run against
 * recorded fixtures with no network and no credentials.
 *
 * Returns `{ ok: true, data }` or `{ ok: false, reason }`. It never throws:
 * a missing surface must reach the caller as UNKNOWN, not as an exception that
 * some caller might catch and treat as "nothing there".
 */
export function ghFetcher({ repo = DEFAULT_REPO } = {}) {
  return (path, { paginate = false } = {}) => {
    const args = ["api", path.replace("{repo}", repo)];
    if (paginate) args.push("--paginate");
    try {
      const out = execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      // `--paginate` concatenates JSON arrays as `][`; stitch them back.
      const stitched = paginate ? out.replace(/\]\s*\[/g, ",") : out;
      return { ok: true, data: JSON.parse(stitched) };
    } catch (err) {
      const stderr = String(err.stderr ?? err.message ?? "").trim().split("\n")[0];
      return { ok: false, reason: stderr || "gh api call failed" };
    }
  };
}

const shortSha = (sha) => (typeof sha === "string" ? sha.slice(0, 10) : sha);

/**
 * Project one inline review comment down to the fields provenance depends on.
 *
 * BOTH shas are kept, deliberately. `originalCommitId` is where the finding was
 * actually raised; `commitId` is only where GitHub currently displays it. They
 * differ whenever GitHub re-anchors an older comment onto a newer head, and
 * reading the wrong one is how a stale finding is mistaken for a fresh one.
 */
export function projectInlineComment(c) {
  const body = String(c.body ?? "");
  const severity = body.match(SEVERITY_BADGE)?.[1] ?? null;
  const title = body.match(FINDING_TITLE)?.[1]?.trim().replace(/\*+$/, "") ?? null;
  return {
    id: c.id,
    author: c.user?.login ?? UNKNOWN,
    // Where it is DISPLAYED now.
    commitId: c.commit_id ?? null,
    // Where it was RAISED. This is the one that decides freshness.
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

/** Project a submitted review. `commitId` is the head it was submitted against. */
export function projectReview(r) {
  const body = String(r.body ?? "");
  return {
    id: r.id,
    author: r.user?.login ?? UNKNOWN,
    state: r.state ?? UNKNOWN,
    commitId: r.commit_id ?? null,
    submittedAt: r.submitted_at ?? null,
    // An EMPTY body is not a verdict. Recorded so a caller can tell "reviewed
    // and said nothing" from "reviewed and reported clean".
    hasBody: body.trim().length > 0,
    declaresReviewedCommit: body.match(REVIEWED_COMMIT)?.[1] ?? null,
  };
}

/**
 * Project an issue comment. Two kinds matter and they are different surfaces:
 * the bot's VERDICT (which names the head it reviewed) and the operator's
 * REQUEST for a review (which may name the head it is asking about).
 */
export function projectIssueComment(c) {
  const body = String(c.body ?? "");
  const verdictCommit = body.match(REVIEWED_COMMIT)?.[1] ?? null;
  const isRequest = REVIEW_REQUEST.test(body);
  return {
    id: c.id,
    author: c.user?.login ?? UNKNOWN,
    createdAt: c.created_at ?? null,
    isVerdict: verdictCommit !== null,
    verdictCommit,
    // Only meaningful when isVerdict: a verdict either reports clean or points
    // at inline findings. Absence of the clean phrase is NOT proof of findings.
    verdictClean: verdictCommit !== null ? CLEAN_VERDICT.test(body) : null,
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
 * Collect every surface for one PR.
 *
 * Each surface resolves independently, so one unreadable surface degrades that
 * surface to UNKNOWN instead of failing the whole read or - worse - silently
 * returning an empty list that reads like "there is nothing there".
 */
export function collectFacts({ pr, fetcher, repo = DEFAULT_REPO }) {
  const fetch = fetcher ?? ghFetcher({ repo });
  const unavailable = [];

  const surface = (name, path, opts) => {
    const r = fetch(path, opts);
    if (!r.ok) {
      unavailable.push({ surface: name, reason: r.reason });
      return UNKNOWN;
    }
    return r.data;
  };

  const prRaw = surface("pull_request", `repos/{repo}/pulls/${pr}`);
  const head = prRaw === UNKNOWN ? UNKNOWN : (prRaw.head?.sha ?? UNKNOWN);

  const reviewsRaw = surface("reviews", `repos/{repo}/pulls/${pr}/reviews`, { paginate: true });
  const inlineRaw = surface("inline_comments", `repos/{repo}/pulls/${pr}/comments`, { paginate: true });
  const issueRaw = surface("issue_comments", `repos/{repo}/issues/${pr}/comments`, { paginate: true });

  // Check runs are addressed BY SHA, never "latest": a rollup on the PR would
  // happily describe a different commit than the one under evaluation.
  const checksRaw =
    head === UNKNOWN
      ? UNKNOWN
      : surface("check_runs", `repos/{repo}/commits/${head}/check-runs`);

  return {
    repo,
    pr: Number(pr),
    head,
    pullRequest:
      prRaw === UNKNOWN
        ? UNKNOWN
        : {
            number: prRaw.number,
            state: prRaw.state,
            isDraft: Boolean(prRaw.draft),
            head: prRaw.head?.sha ?? UNKNOWN,
            baseRef: prRaw.base?.ref ?? UNKNOWN,
            baseSha: prRaw.base?.sha ?? UNKNOWN,
            mergedAt: prRaw.merged_at ?? null,
            mergeCommit: prRaw.merge_commit_sha ?? null,
          },
    checkRuns:
      checksRaw === UNKNOWN ? UNKNOWN : (checksRaw.check_runs ?? []).map(projectCheckRun),
    reviews: reviewsRaw === UNKNOWN ? UNKNOWN : reviewsRaw.map(projectReview),
    inlineComments: inlineRaw === UNKNOWN ? UNKNOWN : inlineRaw.map(projectInlineComment),
    issueComments: issueRaw === UNKNOWN ? UNKNOWN : issueRaw.map(projectIssueComment),
    unavailable,
  };
}

/** Stable ordering + key order, so two reads of one state serialize identically. */
export function serializeFacts(facts) {
  const sortById = (xs) => (xs === UNKNOWN ? UNKNOWN : [...xs].sort((a, b) => a.id - b.id));
  return JSON.stringify(
    {
      repo: facts.repo,
      pr: facts.pr,
      head: facts.head,
      pullRequest: facts.pullRequest,
      checkRuns:
        facts.checkRuns === UNKNOWN
          ? UNKNOWN
          : [...facts.checkRuns].sort((a, b) => a.name.localeCompare(b.name)),
      reviews: sortById(facts.reviews),
      inlineComments: sortById(facts.inlineComments),
      issueComments: sortById(facts.issueComments),
      unavailable: facts.unavailable,
    },
    null,
    2,
  );
}

export { shortSha };
