#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005a: provenance classification over projected GitHub facts.
//
// Pure. Every function takes the projection from github-facts.mjs and answers a
// question about WHAT IS TRUE AT ONE EXACT HEAD. Nothing here decides release
// readiness, applies a stop law, or records a finding state - CP-005b/CP-005c.
//
// EVERY POSITIVE FACT PASSES THROUGH ONE GATE. `mayAssertPositive` in
// evidence.mjs is the only way GREEN or CLEAN is reachable, and it requires the
// evidence to be both COMPLETE and AUTHORIZED. That mechanism exists because
// this module previously stated the rule in prose and broke it twice: reporting
// GREEN from an unpaginated read, and accepting any actor's comment as a Codex
// verdict.
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

import { AUTHORIZED, COMPLETE, mayAssertPositive, UNKNOWN } from "./evidence.mjs";
import { classifyEvidence, RAW_EVIDENCE, TRUSTED_FINDING } from "./finding-identity.mjs";

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
  // CP-005b-1: severity markup alone no longer makes a finding. It must come
  // from the trusted reviewer AND not be a reply, or it is retained as raw
  // evidence attributed to whoever actually wrote it. Both guards are
  // independent; see scripts/eng/finding-identity.mjs.
  const evidence = classifyEvidence(c);
  const isFinding = evidence.kind === TRUSTED_FINDING;
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
    kind: isFinding ? "finding" : evidence.kind === RAW_EVIDENCE ? "raw_evidence" : "acknowledgement",
    identity: evidence.identity?.key ?? null,
    certainty: evidence.certainty,
    actor: evidence.actor,
    actorId: evidence.actorId,
    evidenceReason: evidence.reason,
    severity: c.severity ?? null,
    title: c.title ?? null,
    path: c.path,
    line: c.line,
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
    usable: mayAssertPositive(v),
  }));
}

/**
 * Review completion at the exact head.
 *
 * Completion requires a verdict that is AT this head, COMPLETE and AUTHORIZED.
 * Deliberately NOT completion: an empty-body review at this head, a verdict for
 * another head, a look-alike from an untrusted actor, an acknowledgement, a
 * reaction, or a request that never got an answer.
 */
export function reviewCompletionAtHead(facts) {
  const head = facts.head;
  const inline = valueOf(facts.inlineComments);
  const issues = valueOf(facts.issueComments);
  const verdicts = collectVerdicts(facts);

  if (head === UNKNOWN || inline === UNKNOWN || issues === UNKNOWN || verdicts === UNKNOWN) {
    return {
      status: UNKNOWN,
      reason: "one or more review surfaces could not be read",
      evidence: [],
      staleEvidence: [],
      unauthorizedEvidence: [],
      freshFindings: UNKNOWN,
    };
  }

  const atHead = verdicts.filter((v) => v.atHead);
  const usable = atHead.filter((v) => v.usable);
  const unauthorizedEvidence = atHead.filter((v) => v.authority !== AUTHORIZED);
  const incompleteAtHead = atHead.filter((v) => v.authority === AUTHORIZED && v.completeness !== COMPLETE);
  const staleEvidence = verdicts.filter((v) => !v.atHead);

  const classified = inline.map((c) => classifyInlineComment(c, head));
  const freshFindings = classified.filter((c) => c.kind === "finding" && c.freshness === "fresh");
  // Trusted, non-reply, finding-shaped evidence that could not be NAMED is
  // still the reviewer speaking. It cannot be tracked, so it is not a finding
  // record - but it must not be silently dropped either, or a clean verdict for
  // the same head would report CLEAN over the top of it.
  const unnameableAtHead = classified.filter(
    (c) => c.certainty === UNKNOWN && c.freshness !== "carried",
  );
  const carriedFindings = classified.filter((c) => c.kind === "finding" && c.freshness === "carried");

  const requestsAtHead = issues.filter(
    (c) => c.isReviewRequest && (c.requestedCommit === null || shaMatches(c.requestedCommit, head)),
  );

  let status;
  let reason;
  if (usable.length === 0) {
    if (unauthorizedEvidence.length > 0) {
      status = UNKNOWN;
      reason = `a verdict names this head but its actor is not the trusted reviewer (${unauthorizedEvidence[0].reason})`;
    } else if (incompleteAtHead.length > 0) {
      status = UNKNOWN;
      reason = `a trusted review object exists at this head but states no verdict (${incompleteAtHead[0].reason})`;
    } else if (requestsAtHead.length > 0) {
      status = "REQUESTED_UNANSWERED";
      reason = "a review was requested for this head and no usable verdict for this head exists yet";
    } else {
      status = "NONE";
      reason = "no usable verdict names this head";
    }
  } else if (freshFindings.length > 0) {
    status = "COMPLETE_WITH_FINDINGS";
    reason = `trusted verdict for this head, with ${freshFindings.length} finding(s) raised at it`;
  } else if (unnameableAtHead.length > 0) {
    // Never CLEAN over the top of a reviewer's own finding-shaped evidence.
    status = UNKNOWN;
    reason = `a trusted verdict reports clean, but ${unnameableAtHead.length} trusted finding-shaped comment(s) at this head lack stable provenance and cannot be reconciled (${unnameableAtHead[0].evidenceReason})`;
  } else if (usable.some((v) => v.clean === true)) {
    status = "COMPLETE_CLEAN";
    reason = "trusted, complete verdict for this head reports no findings";
  } else {
    status = UNKNOWN;
    reason = "a trusted verdict names this head but states neither a clean result nor findings";
  }

  return {
    status,
    reason,
    evidence: usable,
    staleEvidence,
    unauthorizedEvidence,
    freshFindings,
    carriedFindings,
    acknowledgements: classified.filter((c) => c.kind === "acknowledgement").length,
    // Retained and attributed: a look-alike stays visible, never a finding.
    rawEvidence: classified.filter((c) => c.kind === "raw_evidence"),
    unnameableAtHead,
    reAnchored: classified.filter((c) => c.reAnchored).length,
    requestsAtHead: requestsAtHead.length,
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
export function ciAtHead(facts) {
  const head = facts.head;
  const env = facts.checkRuns;
  const runs = valueOf(env);

  if (head === UNKNOWN || runs === UNKNOWN) {
    return {
      status: UNKNOWN,
      reason: env?.reason ?? "check runs could not be read",
      completeness: env?.completeness ?? UNKNOWN,
      atHead: 0,
      failing: [],
      pending: [],
    };
  }

  const bound = runs.filter((c) => shaMatches(c.headSha ?? "", head));
  const foreign = runs.length - bound.length;
  const pending = bound.filter((c) => c.status !== "completed").map((c) => c.name);
  const failing = bound
    .filter((c) => c.status === "completed" && !["success", "skipped", "neutral"].includes(c.conclusion))
    .map((c) => c.name);

  const base = {
    completeness: env.completeness,
    atHead: bound.length,
    foreign,
    failing,
    pending,
  };

  // A failure is a NEGATIVE fact and stands on its own: one confirmed failing
  // check is red whether or not the rest of the collection was readable.
  if (failing.length > 0) return { status: "RED", reason: `${failing.length} check(s) failing at this head`, ...base };

  // Every remaining answer is positive-ish, so it must pass the gate.
  if (!mayAssertPositive(env)) {
    return { status: UNKNOWN, reason: env.reason, ...base };
  }
  if (bound.length === 0) {
    return {
      status: UNKNOWN,
      reason: "no check run is bound to this head; nothing ran is not the same as nothing failed",
      ...base,
    };
  }
  if (pending.length > 0) return { status: "PENDING", reason: `${pending.length} check(s) still running`, ...base };
  return { status: "GREEN", reason: `${bound.length} complete check(s) bound to this head`, ...base };
}

/**
 * The whole picture at one exact head. A report, not a decision: no release
 * verdict, no stop law, no findings state.
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
      unauthorizedEvidenceCount: review.unauthorizedEvidence.length,
      requestsAtHead: review.requestsAtHead,
    },
    findings: {
      fresh: review.freshFindings === UNKNOWN ? UNKNOWN : review.freshFindings.length,
      carried: review.carriedFindings === undefined ? UNKNOWN : review.carriedFindings.length,
      reAnchored: review.reAnchored ?? UNKNOWN,
      acknowledgements: review.acknowledgements ?? UNKNOWN,
      rawEvidence:
        review.rawEvidence === undefined
          ? UNKNOWN
          : review.rawEvidence.map((e) => ({ id: e.id, actor: e.actor, actorId: e.actorId, severity: e.severity, reason: e.evidenceReason })),
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
