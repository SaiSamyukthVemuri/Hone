#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005a: provenance classification over projected GitHub facts.
//
// Pure. Every function takes the projection from github-facts.mjs and answers a
// question about WHAT IS TRUE AT ONE EXACT HEAD. Nothing here decides release
// readiness, applies a stop law, or records a finding state - CP-005b/CP-005c.
//
// THIS MODULE EMITS NO POSITIVE CONCLUSION. There is no GREEN, no
// COMPLETE_CLEAN, no TRUSTED and no RELEASE_READY, because five vehicles
// (#617-#621) proved that deciding when evidence is "good enough" to say so is
// the defect, not the guard around it. Each retired for the same family:
// unknown, invalid or incomplete evidence producing a positive assertion.
//
// What remains is what was always sound - OBSERVATIONS, and NEGATIVES proven
// directly: an observed failing check, an incomplete collection, a verified
// finding, a stale reviewed sha, and a surface we could not read, stated as
// UNKNOWN. The absence of bad evidence is NOT converted into "ready". The
// operator reads the facts and decides.
//
// THE FOUR CONFUSIONS, each observed on a real Hone PR:
//   1. RE-ANCHORING - GitHub moves an old comment onto a newer head, so
//      `commitId` reads as current while `originalCommitId` says otherwise.
//      #610 carries 6; #615 carried its only finding this way.
//   2. ACKNOWLEDGEMENT AS COMPLETION - half of #610's inline comments are
//      replies. A reply, reaction or request is never review completion.
//   3. AN EMPTY REVIEW OBJECT AS A CLEAN VERDICT - observed on #615.
//   4. STALE EVIDENCE AS CURRENT - #610 has 19 reviews across 8 heads and 4
//      clean verdicts at 3 shas. Stale evidence is reported as stale, not
//      dropped.
// ---------------------------------------------------------------------------

import { AUTHORIZED, UNKNOWN } from "./evidence.mjs";

/**
 * Compare a possibly-abbreviated sha against a full one. Codex writes 10-char
 * shas, so exact equality would silently never match and every verdict would
 * read as "for some other head".
 */
export function shaMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.min(a.length, b.length);
  if (n < 7) return false;
  return a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

/** Unwrap an evidence envelope's value, or UNKNOWN when it carries none. */
const valueOf = (env) => (!env || env.value === null || env.value === UNKNOWN ? UNKNOWN : env.value);

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
    originalLine: c.originalLine,
    raisedAt,
    displayedAt,
    reAnchored,
    freshness,
    isReply: c.inReplyToId !== null && c.inReplyToId !== undefined,
  };
}

/**
 * Every verdict from BOTH surfaces, normalized and graded once.
 *
 * A verdict is CURRENT only when it names this head; it is USABLE only when it
 * is also complete and authorized. Everything else is retained and labelled
 * rather than discarded, so an unauthorized look-alike is visible as evidence
 * without ever becoming clean.
 */
export function collectVerdicts(facts) {
  const head = facts.head;
  const reviews = valueOf(facts.reviews);
  const issues = valueOf(facts.issueComments);
  if (head === UNKNOWN || reviews === UNKNOWN || issues === UNKNOWN) return UNKNOWN;

  const all = [
    ...issues.filter((c) => c.verdict).map((c) => c.verdict),
    ...reviews.map((r) => r.verdict),
  ];

  return all.map((v) => ({
    ...v,
    atHead: shaMatches(v.reviewedCommit ?? "", head),
    // `statedOutcome` is decided once, at the parse site, by POSITIVE
    // identification of the text. It is not re-derived here and there is no
    // "not clean" branch to get wrong.
  }));
}

/**
 * Review FACTS at the exact head. There is no "completion" here any more,
 * because deciding when a review counts as complete is exactly what five
 * retired vehicles got wrong.
 *
 * Each of these was previously folded into a single word and is now reported
 * on its own, because each means something different to a reader: an
 * empty-body review at this head, a verdict for another head, a look-alike
 * from an untrusted actor, a verdict whose actor could not be identified, an
 * acknowledgement, and a review request that never got an answer.
 */
export function reviewFactsAtHead(facts) {
  const head = facts.head;
  const inline = valueOf(facts.inlineComments);
  const issues = valueOf(facts.issueComments);
  const verdicts = collectVerdicts(facts);

  if (head === UNKNOWN || inline === UNKNOWN || issues === UNKNOWN || verdicts === UNKNOWN) {
    return {
      verdictObjects: UNKNOWN,
      verdictsAtHead: UNKNOWN,
      staleEvidence: UNKNOWN,
      unauthorizedAtHead: UNKNOWN,
      unknownAuthorityAtHead: UNKNOWN,
      trustedOutcomesAtHead: UNKNOWN,
      currentFindings: UNKNOWN,
      carriedFindings: UNKNOWN,
      undecidableFreshness: UNKNOWN,
      reAnchored: UNKNOWN,
      acknowledgements: UNKNOWN,
      requestsAtHead: UNKNOWN,
      reason: "one or more review surfaces could not be read",
    };
  }

  const atHead = verdicts.filter((v) => v.atHead);
  const classified = inline.map((c) => classifyInlineComment(c, head));

  // Every field below is a COUNT OR LIST OF SOMETHING OBSERVED. Nothing decides
  // whether the observations add up to a review that "passed".
  return {
    verdictObjects: verdicts.length,
    verdictsAtHead: atHead.length,
    // Stale and unauthorized evidence is retained and attributed rather than
    // dropped: a look-alike stays visible precisely because it never counted.
    staleEvidence: verdicts.filter((v) => !v.atHead),
    unauthorizedAtHead: atHead.filter((v) => v.authority !== AUTHORIZED && v.authority !== UNKNOWN),
    unknownAuthorityAtHead: atHead.filter((v) => v.authority === UNKNOWN),
    // Every trusted verdict at this head, INCLUDING ones that stated nothing.
    // Filtering those out would hide the #615 confusion - an empty review
    // object at the head, which is not a clean verdict and is not an absence
    // either. `statedOutcome: UNKNOWN` is the fact, so it is reported.
    trustedOutcomesAtHead: atHead
      .filter((v) => v.authority === AUTHORIZED)
      .map((v) => ({
        sourceType: v.sourceType,
        sourceId: v.sourceId,
        statedOutcome: v.statedOutcome,
        completeness: v.completeness,
      })),
    currentFindings: classified.filter((c) => c.kind === "finding" && c.freshness === "fresh"),
    carriedFindings: classified.filter((c) => c.kind === "finding" && c.freshness === "carried"),
    undecidableFreshness: classified.filter((c) => c.kind === "finding" && c.freshness === UNKNOWN),
    reAnchored: classified.filter((c) => c.reAnchored).length,
    acknowledgements: classified.filter((c) => c.kind === "acknowledgement").length,
    requestsAtHead: issues.filter(
      (c) => c.isReviewRequest && (c.requestedCommit === null || shaMatches(c.requestedCommit, head)),
    ).length,
  };
}

/**
 * CI status at the exact head.
 *
 * GREEN requires the check-run collection to pass the gate - complete AND
 * authorized - and every counted run to be bound to this head. An incomplete
 * collection cannot be green however green the part that was read looks, which
 * is the specific defect this replaces: 5 of 12 checks read, reported GREEN.
 */
export function ciFactsAtHead(facts) {
  const head = facts.head;
  const env = facts.checkRuns;
  const runs = valueOf(env);

  if (head === UNKNOWN || runs === UNKNOWN) {
    return {
      checksObserved: UNKNOWN,
      boundToHead: UNKNOWN,
      foreign: UNKNOWN,
      completeness: env?.completeness ?? UNKNOWN,
      reason: env?.reason ?? "check runs could not be read",
      failuresObserved: UNKNOWN,
      stillRunning: UNKNOWN,
      passedObserved: UNKNOWN,
      skippedObserved: UNKNOWN,
    };
  }

  const bound = runs.filter((c) => shaMatches(c.headSha ?? "", head));
  const done = bound.filter((c) => c.status === "completed");

  // Observations only. There is deliberately no GREEN: "nothing we saw failed"
  // is not "nothing failed", and converting the first into the second is the
  // exact defect that retired five vehicles.
  return {
    checksObserved: runs.length,
    boundToHead: bound.length,
    foreign: runs.length - bound.length,
    completeness: env.completeness,
    reason: env.reason,
    // A confirmed failure is a NEGATIVE fact, proven directly, so it stands on
    // its own however incomplete the rest of the collection was.
    failuresObserved: done
      .filter((c) => !["success", "skipped", "neutral"].includes(c.conclusion))
      .map((c) => c.name),
    stillRunning: bound.filter((c) => c.status !== "completed").map((c) => c.name),
    passedObserved: done.filter((c) => c.conclusion === "success").length,
    skippedObserved: done.filter((c) => ["skipped", "neutral"].includes(c.conclusion)).length,
  };
}

/**
 * THE OPERATOR PACKET: everything observed at one exact head, and nothing
 * concluded from it.
 *
 * `controlPlaneResult` is a CONSTANT, not a computation. It is never branched
 * on and can never be anything else. The moment it becomes conditional, this
 * tool is asserting readiness again - which is precisely what five retired
 * vehicles established it must not do.
 */
export const WAIT_FOR_OPERATOR_GO = "WAIT_FOR_OPERATOR_GO";

export function summarize(facts) {
  const review = reviewFactsAtHead(facts);
  const bySeverity =
    review.currentFindings === UNKNOWN
      ? UNKNOWN
      : review.currentFindings.reduce((acc, f) => {
          acc[f.severity] = (acc[f.severity] ?? 0) + 1;
          return acc;
        }, {});
  const count = (xs) => (xs === UNKNOWN ? UNKNOWN : xs.length);
  return {
    repo: facts.repo,
    pr: facts.pr,
    head: facts.head,
    pullRequest: facts.pullRequest,
    ci: ciFactsAtHead(facts),
    review: {
      verdictObjects: review.verdictObjects,
      verdictsAtHead: review.verdictsAtHead,
      staleEvidence: count(review.staleEvidence),
      unauthorizedAtHead: count(review.unauthorizedAtHead),
      unknownAuthorityAtHead: count(review.unknownAuthorityAtHead),
      trustedOutcomesAtHead: review.trustedOutcomesAtHead,
      requestsAtHead: review.requestsAtHead,
      reason: review.reason,
    },
    findings: {
      currentHead: count(review.currentFindings),
      carried: count(review.carriedFindings),
      undecidableFreshness: count(review.undecidableFreshness),
      reAnchored: review.reAnchored,
      acknowledgements: review.acknowledgements,
      bySeverity,
    },
    unknownEvidence: facts.unavailable,
    controlPlaneResult: WAIT_FOR_OPERATOR_GO,
  };
}
