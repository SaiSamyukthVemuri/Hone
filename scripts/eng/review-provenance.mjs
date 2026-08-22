#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005a: provenance classification over projected GitHub facts.
//
// Pure. Every function here takes the projection from github-facts.mjs and
// answers a question about WHAT IS TRUE AT ONE EXACT HEAD. Nothing decides
// release readiness, applies a stop law, or records a finding state - those are
// CP-005c and CP-005b.
//
// THE FOUR CONFUSIONS THIS EXISTS TO PREVENT, each observed on a real Hone PR:
//
//   1. RE-ANCHORING. GitHub moves an old inline comment onto a newer head, so
//      `commitId` says "current" while `originalCommitId` says "raised eight
//      heads ago". PR #610 carries 6 such comments; #615 carried its only
//      finding this way. Freshness is decided by originalCommitId, always.
//
//   2. ACKNOWLEDGEMENT AS COMPLETION. Half of #610's inline comments are
//      replies, not findings. A reply, a reaction, or a request to review is
//      never evidence that a review completed.
//
//   3. AN EMPTY REVIEW OBJECT AS A CLEAN VERDICT. A review can be submitted
//      with no body (observed on #615 at 0bee1350). That is UNKNOWN, not clean.
//
//   4. STALE EVIDENCE AS CURRENT. #610 accumulated 19 review objects across 8
//      heads and 4 clean verdicts at 3 different shas. Only evidence bound to
//      the head under evaluation is current; everything else is stale, and is
//      reported as stale rather than dropped.
//
// UNKNOWN IS FIRST CLASS throughout. "We could not read it" and "there is none"
// are different answers and never collapse into each other.
// ---------------------------------------------------------------------------

import { UNKNOWN } from "./github-facts.mjs";

/**
 * Compare a possibly-abbreviated sha against a full one. Codex writes 10-char
 * shas in its verdicts, so exact string equality would silently never match and
 * every verdict would read as "for some other head".
 */
export function shaMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.min(a.length, b.length);
  if (n < 7) return false;
  return a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

/**
 * A finding is an inline comment carrying a severity badge. Everything else is
 * a reply/acknowledgement. FRESHNESS is decided by where the comment was
 * RAISED, never by where GitHub currently displays it.
 */
export function classifyInlineComment(c, head) {
  const isFinding = Boolean(c.severity);
  const raisedAt = c.originalCommitId;
  const displayedAt = c.commitId;
  const reAnchored =
    Boolean(raisedAt) && Boolean(displayedAt) && !shaMatches(raisedAt, displayedAt);

  let freshness;
  if (!raisedAt || head === UNKNOWN) freshness = UNKNOWN;
  else if (shaMatches(raisedAt, head)) freshness = "fresh";
  else freshness = "carried";

  return {
    id: c.id,
    kind: isFinding ? "finding" : "acknowledgement",
    severity: c.severity ?? null,
    title: c.title ?? null,
    path: c.path,
    line: c.line,
    raisedAt,
    displayedAt,
    // True when GitHub shows this at a head it was not raised at. A caller that
    // reads `displayedAt` alone would mistake it for a current-head finding.
    reAnchored,
    freshness,
    isReply: c.inReplyToId !== null && c.inReplyToId !== undefined,
  };
}

/**
 * A submitted review is evidence only for the head it was submitted against.
 * `hasBody` matters: an empty review object is not a verdict.
 */
export function classifyReview(r, head) {
  const atHead = head !== UNKNOWN && shaMatches(r.commitId ?? "", head);
  return {
    id: r.id,
    author: r.author,
    state: r.state,
    reviewedHead: r.commitId,
    submittedAt: r.submittedAt,
    atHead,
    // Only a review AT the head, WITH a body, carries a verdict.
    carriesVerdict: atHead && r.hasBody,
    // Recorded rather than silently ignored: this is the shape that reads as a
    // completed review while saying nothing at all.
    emptyBodyAtHead: atHead && !r.hasBody,
    staleness: head === UNKNOWN ? UNKNOWN : atHead ? "current" : "stale",
  };
}

/**
 * Review completion at the exact head.
 *
 * Completion requires a stated verdict FOR THIS HEAD, from either surface:
 *   * an issue comment naming this head ("Reviewed commit: <sha>"), or
 *   * a review object at this head whose body names this head.
 *
 * Deliberately NOT completion: an empty-body review at this head, a verdict for
 * another head, an acknowledgement, a reaction, or a review request that never
 * got an answer.
 */
export function reviewCompletionAtHead(facts) {
  const head = facts.head;
  const reviews = facts.reviews;
  const issues = facts.issueComments;
  const inline = facts.inlineComments;

  if (head === UNKNOWN || reviews === UNKNOWN || issues === UNKNOWN || inline === UNKNOWN) {
    return {
      status: UNKNOWN,
      reason: "one or more review surfaces could not be read",
      evidence: [],
      staleEvidence: [],
      freshFindings: UNKNOWN,
    };
  }

  const evidence = [];
  const staleEvidence = [];

  for (const raw of issues) {
    if (!raw.isVerdict) continue;
    if (shaMatches(raw.verdictCommit, head)) {
      evidence.push({
        surface: "issue_comment_verdict",
        id: raw.id,
        head: raw.verdictCommit,
        clean: raw.verdictClean,
      });
    } else {
      staleEvidence.push({ surface: "issue_comment_verdict", id: raw.id, head: raw.verdictCommit });
    }
  }

  for (const raw of reviews) {
    const c = classifyReview(raw, head);
    if (c.carriesVerdict) {
      evidence.push({
        surface: "review_object",
        id: c.id,
        head: c.reviewedHead,
        declares: raw.declaresReviewedCommit,
      });
    } else if (c.emptyBodyAtHead) {
      // At the head, but says nothing. Neither completion nor stale.
      evidence.push({ surface: "review_object_empty_body", id: c.id, head: c.reviewedHead, clean: null });
    } else {
      staleEvidence.push({ surface: "review_object", id: c.id, head: c.reviewedHead });
    }
  }

  const classified = inline.map((c) => classifyInlineComment(c, head));
  const freshFindings = classified.filter((c) => c.kind === "finding" && c.freshness === "fresh");
  const carriedFindings = classified.filter((c) => c.kind === "finding" && c.freshness === "carried");

  const stated = evidence.filter((e) => e.surface !== "review_object_empty_body");
  const emptyOnly = evidence.length > 0 && stated.length === 0;

  // An unanswered request is worth naming: it is the state that looks like
  // "review in progress" and is easy to forget about.
  const requestsAtHead = issues.filter(
    (c) => c.isReviewRequest && (c.requestedCommit === null || shaMatches(c.requestedCommit, head)),
  );

  let status;
  let reason;
  if (stated.length === 0) {
    if (emptyOnly) {
      status = UNKNOWN;
      reason = "a review object exists at this head but carries no body, so it states no verdict";
    } else if (requestsAtHead.length > 0) {
      status = "REQUESTED_UNANSWERED";
      reason = "a review was requested for this head and no verdict for this head exists yet";
    } else {
      status = "NONE";
      reason = "no review verdict names this head";
    }
  } else if (freshFindings.length > 0) {
    status = "COMPLETE_WITH_FINDINGS";
    reason = `verdict stated for this head, with ${freshFindings.length} finding(s) raised at it`;
  } else if (stated.some((e) => e.clean === true)) {
    status = "COMPLETE_CLEAN";
    reason = "verdict stated for this head reports no findings";
  } else {
    // A verdict exists for this head but does not say "clean" and raised no
    // fresh findings. Do not guess which it meant.
    status = UNKNOWN;
    reason = "a verdict names this head but states neither a clean result nor findings";
  }

  return {
    status,
    reason,
    evidence,
    staleEvidence,
    freshFindings,
    carriedFindings,
    acknowledgements: classified.filter((c) => c.kind === "acknowledgement").length,
    reAnchored: classified.filter((c) => c.reAnchored).length,
    requestsAtHead: requestsAtHead.length,
  };
}

/**
 * CI status at the exact head. Only checks whose `headSha` is this head are
 * counted; a check for another commit is not evidence about this one.
 *
 * ZERO checks bound to this head is UNKNOWN, never GREEN. "Nothing failed"
 * and "nothing ran" are different facts.
 */
export function ciAtHead(facts) {
  const head = facts.head;
  if (head === UNKNOWN || facts.checkRuns === UNKNOWN) {
    return { status: UNKNOWN, reason: "check runs could not be read", atHead: 0, failing: [], pending: [] };
  }
  const bound = facts.checkRuns.filter((c) => shaMatches(c.headSha ?? "", head));
  const foreign = facts.checkRuns.length - bound.length;
  if (bound.length === 0) {
    return {
      status: UNKNOWN,
      reason: "no check run is bound to this head",
      atHead: 0,
      foreign,
      failing: [],
      pending: [],
    };
  }
  const pending = bound.filter((c) => c.status !== "completed").map((c) => c.name);
  const failing = bound
    .filter((c) => c.status === "completed" && !["success", "skipped", "neutral"].includes(c.conclusion))
    .map((c) => c.name);

  let status;
  if (failing.length > 0) status = "RED";
  else if (pending.length > 0) status = "PENDING";
  else status = "GREEN";

  return {
    status,
    reason: `${bound.length} check(s) bound to this head`,
    atHead: bound.length,
    foreign,
    failing,
    pending,
  };
}

/**
 * The whole picture at one exact head. A report, not a decision: it deliberately
 * contains no release verdict, no stop law and no findings state.
 */
export function summarize(facts) {
  const review = reviewCompletionAtHead(facts);
  const ci = ciAtHead(facts);
  return {
    repo: facts.repo,
    pr: facts.pr,
    head: facts.head,
    pullRequest: facts.pullRequest,
    ci,
    review: {
      status: review.status,
      reason: review.reason,
      evidenceCount: review.evidence.length,
      staleEvidenceCount: review.staleEvidence.length,
      requestsAtHead: review.requestsAtHead,
    },
    findings: {
      fresh: review.freshFindings === UNKNOWN ? UNKNOWN : review.freshFindings.length,
      carried: review.carriedFindings === undefined ? UNKNOWN : review.carriedFindings.length,
      reAnchored: review.reAnchored ?? UNKNOWN,
      acknowledgements: review.acknowledgements ?? UNKNOWN,
      bySeverity:
        review.freshFindings === UNKNOWN
          ? UNKNOWN
          : review.freshFindings.reduce((acc, f) => {
              acc[f.severity] = (acc[f.severity] ?? 0) + 1;
              return acc;
            }, {}),
    },
    unavailable: facts.unavailable,
  };
}
