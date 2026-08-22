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
// law, record findings state, or merge. Those are CP-005b and CP-005c.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { collectionEvidence, evidence, verdictEvidence, UNKNOWN } from "./evidence.mjs";

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
 */
export function ghFetcher({ repo = DEFAULT_REPO } = {}) {
  return (path, { paginate = false } = {}) => {
    const args = ["api", path.replace("{repo}", repo)];
    if (paginate) args.push("--paginate", "--slurp");
    try {
      const out = execFileSync("gh", args, {
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
    // TWO DIFFERENT FACTS. `line` is where GitHub currently DISPLAYS the
    // comment and is nulled once it goes outdated - 20 of 34 comments measured
    // across #610/#617/#619/#622 have none. `originalLine` is where it was
    // RAISED and never moves; it was null in ZERO of those 34. The ledger keys
    // on the stable one, so they must not be coalesced into a single field.
    line: c.line ?? null,
    originalLine: c.original_line ?? null,
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
