#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ENG-LOOP-01: `npm run eng -- shepherd <pr> [--json] [--watch]`
//
// `status` answers "what does GitHub say about this PR, at its exact head?".
// The shepherd answers the question an operator kept answering by hand from
// screenshots: GIVEN those facts, what happens next - wait, act, stop, or hand
// the merge decision to a human.
//
// It is the smallest deterministic layer over the CP-005a facts, bounded on
// every side:
//
//   * It READS. It never merges, never writes to GitHub, and persists nothing:
//     every answer is re-derived from GitHub at read time, so there is no
//     ledger to corrupt (CP-005b retired on exactly that). The only process it
//     runs is `gh api`, read-only by construction (github-facts.mjs).
//   * READY_FOR_HUMAN_MERGE is a HAND-OFF, not an authorization: every
//     mechanical gate holds at this exact head, and the merge decision stays
//     the operator's (CANONICAL_ROADMAP §16.2, Phase 1). Green CI alone never
//     reaches it.
//   * Stop laws are evaluated, not merely displayed. Consecutive P0-P2 review
//     rounds, or consecutive red CI heads, beyond the tier's repair budget
//     (§7.4) ESCALATE - and no repair is proposed while that budget cannot be
//     read.
//   * A root-cause FAMILY is a semantic judgement. The shepherd does not guess
//     one: with two or more fresh findings it says the family check is owed
//     before any patch.
//
// THE DECISION IS A TOTAL FUNCTION over a closed set of signals (DOMAINS), in
// one fixed precedence:
//
//   CLOSED > ESCALATE > BLOCKED > ACTION_REQUIRED > WAITING
//          > BLOCKED (not proven) > READY_FOR_HUMAN_MERGE
//
// READY is an explicit conjunction - every signal at its one positive value
// (READY_POINT) - and never a fall-through. tests/eng/shepherd.test.ts
// enumerates the whole product of DOMAINS, so "UNKNOWN never reaches READY" is
// checked for every combination, not for the ones someone thought of.
// ---------------------------------------------------------------------------

import { classify } from "../classify-changes.mjs";
import { AUTHORIZED, CODEX_ACTOR, COMPLETE, UNKNOWN, mayAssertPositive } from "./evidence.mjs";
import { collectVerdicts, shaMatches } from "./review-provenance.mjs";

export { UNKNOWN };

export const STATE = Object.freeze({
  READY_FOR_HUMAN_MERGE: "READY_FOR_HUMAN_MERGE",
  WAITING: "WAITING",
  ACTION_REQUIRED: "ACTION_REQUIRED",
  BLOCKED: "BLOCKED",
  ESCALATE: "ESCALATE",
  CLOSED: "CLOSED",
});

/** One exit code per state, so a shell loop can branch without parsing. */
export const EXIT_CODE = Object.freeze({
  READY_FOR_HUMAN_MERGE: 0,
  WAITING: 10,
  ACTION_REQUIRED: 20,
  BLOCKED: 30,
  ESCALATE: 40,
  CLOSED: 50,
});

export const POLICY = Object.freeze({
  /**
   * The pull-request workflow. Every check at the head gates - production has
   * no branch protection and no rulesets, so GitHub marks nothing required -
   * AND this workflow's run at the head must have finished. Jobs behind
   * `needs:`, the `browser e2e (local stack)` aggregator among them, have no
   * check run until their dependencies finish, so "every visible check passed"
   * can be true while CI is still running (seen live on #793).
   */
  requiredWorkflow: ".github/workflows/ci.yml",
  /** Codex answered within 2-7 minutes of every request on #730-#792. */
  reviewAnswerMs: 30 * 60_000,
  /** Repairs allowed before the stop law fires (CANONICAL_ROADMAP §7.4). */
  repairBudget: Object.freeze({ T0: 2, T1: 2, T2: 1, T3: 1 }),
});

/** Every signal, and every value it can take. `decide` is total over this. */
export const DOMAINS = Object.freeze({
  pr: Object.freeze(["OPEN", "DRAFT", "MERGED", "CLOSED", UNKNOWN]),
  base: Object.freeze(["PRODUCTION", "OTHER", UNKNOWN]),
  snapshot: Object.freeze(["CONSISTENT", "TORN", UNKNOWN]),
  branch: Object.freeze(["CURRENT", "BEHIND", UNKNOWN]),
  conflicts: Object.freeze(["NONE", "CONFLICTING", "PENDING", UNKNOWN]),
  ci: Object.freeze(["GREEN", "RUNNING", "QUEUED", "NOT_STARTED", "CANCELLED", "FAILED", UNKNOWN]),
  review: Object.freeze(["VERDICT_AT_HEAD", "REQUESTED", "REQUEST_OVERDUE", "STALE", "NONE", UNKNOWN]),
  findings: Object.freeze(["NONE_BLOCKING", "FRESH", "CARRIED", UNKNOWN]),
  history: Object.freeze(["INTACT", "REWRITTEN", UNKNOWN]),
  rounds: Object.freeze(["WITHIN_CAP", "EXCEEDED", UNKNOWN]),
  ciStreak: Object.freeze(["WITHIN_CAP", "EXCEEDED", UNKNOWN]),
});

/** The ONE point of that product at which the human merge gate is reached. */
export const READY_POINT = Object.freeze({
  pr: "OPEN",
  base: "PRODUCTION",
  snapshot: "CONSISTENT",
  branch: "CURRENT",
  conflicts: "NONE",
  ci: "GREEN",
  review: "VERDICT_AT_HEAD",
  findings: "NONE_BLOCKING",
  history: "INTACT",
  rounds: "WITHIN_CAP",
  ciStreak: "WITHIN_CAP",
});

const outcome = (state, { stops = [], blocks = [], actions = [], waits = [] } = {}) => ({
  state,
  stops,
  blocks,
  actions,
  waits,
});

/**
 * THE DECISION. Pure and total: every combination of DOMAINS maps to exactly
 * one state, and READY only at READY_POINT. Each tier of the precedence is a
 * list, so everything that applies at the winning tier is reported, not just
 * the first thing found.
 */
export function decide(s) {
  if (s.pr === UNKNOWN) return outcome(STATE.BLOCKED, { blocks: ["UNREADABLE_PULL_REQUEST"] });
  if (s.pr === "MERGED") return outcome(STATE.CLOSED, { blocks: ["PR_MERGED"] });
  if (s.pr === "CLOSED") return outcome(STATE.CLOSED, { blocks: ["PR_CLOSED"] });
  // Answers that straddle a push are not one snapshot; nothing else is decided.
  if (s.snapshot === "TORN") return outcome(STATE.WAITING, { waits: ["HEAD_MOVED_DURING_READ"] });

  // Stop laws. A CONFIRMED breach stops the loop whatever else is true.
  const stops = [];
  if (s.rounds === "EXCEEDED") stops.push("REVIEW_ROUNDS_EXCEEDED");
  if (s.ciStreak === "EXCEEDED") stops.push("CI_FAILURES_REPEATED");
  if (stops.length) return outcome(STATE.ESCALATE, { stops });

  // Hard blocks: the loop may not continue without a human.
  const blocks = [];
  if (s.pr === "DRAFT") blocks.push("PR_DRAFT");
  if (s.base === "OTHER") blocks.push("BASE_NOT_PRODUCTION");
  if (s.history === "REWRITTEN") blocks.push("HISTORY_REWRITTEN");
  if (s.review === "REQUEST_OVERDUE") blocks.push("REVIEW_UNANSWERED");
  // A repair is never proposed while the budget that would forbid it is unread.
  if (s.findings === "FRESH" && s.rounds !== "WITHIN_CAP") blocks.push("REPAIR_BUDGET_UNKNOWN");
  if (s.ci === "FAILED" && s.ciStreak !== "WITHIN_CAP") blocks.push("CI_BUDGET_UNKNOWN");
  if (blocks.length) return outcome(STATE.BLOCKED, { blocks });

  // Actions the loop can take now. The first three each produce a new head,
  // so nothing that the new head would immediately invalidate is proposed
  // alongside them.
  const actions = [];
  if (s.conflicts === "CONFLICTING") actions.push("RESOLVE_CONFLICTS");
  if (s.findings === "FRESH") actions.push("REPAIR_FINDINGS");
  if (s.ci === "FAILED") actions.push("FIX_CI");
  const newHeadComing = actions.length > 0;
  if (s.findings === "CARRIED") actions.push("DISPOSITION_FINDINGS");
  if (!newHeadComing) {
    // Production is merged in at release review, not on every move it makes:
    // only once CI has settled and no review is in flight. A refresh also
    // re-runs every lane, so it replaces a re-run of cancelled ones.
    const settled = s.ci === "GREEN" || s.ci === "CANCELLED";
    if (s.branch === "BEHIND" && settled && s.review !== "REQUESTED") actions.push("REFRESH_PRODUCTION");
    if (s.ci === "CANCELLED" && s.branch === "CURRENT") actions.push("RERUN_CI");
    if ((s.review === "NONE" || s.review === "STALE") && s.branch === "CURRENT") actions.push("REQUEST_REVIEW");
  }
  if (actions.length) return outcome(STATE.ACTION_REQUIRED, { actions });

  const waits = [];
  if (s.ci === "RUNNING" || s.ci === "QUEUED" || s.ci === "NOT_STARTED") waits.push("WAIT_CI");
  if (s.review === "REQUESTED") waits.push("WAIT_REVIEW");
  if (s.conflicts === "PENDING") waits.push("WAIT_MERGEABILITY");
  if (waits.length) return outcome(STATE.WAITING, { waits });

  // The human merge gate: an explicit conjunction over EVERY signal.
  const unproven = Object.keys(READY_POINT).filter((k) => s[k] !== READY_POINT[k]);
  if (unproven.length === 0) return outcome(STATE.READY_FOR_HUMAN_MERGE);
  return outcome(STATE.BLOCKED, { blocks: unproven.map((k) => `NOT_PROVEN_${k.toUpperCase()}`) });
}

// ---------------------------------------------------------------------------
// Facts -> signals. Each derivation reads only evidence that passed the strict
// collector, and anything it cannot establish is UNKNOWN - never a default.
// ---------------------------------------------------------------------------

const P0_P2 = new Set(["P0", "P1", "P2"]);
const PASSED = new Set(["success", "skipped", "neutral"]);
const QUEUED = new Set(["queued", "waiting", "requested", "pending"]);
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const TIERS = ["T0", "T1", "T2", "T3"];

const listIn = (env) => (env && Array.isArray(env.value) ? env.value : null);
const fullList = (env) => (mayAssertPositive(env) ? env.value : null);

/**
 * CI at the exact head, across check runs, workflow runs and commit statuses.
 * A confirmed failing, running or cancelled lane is a NEGATIVE fact and stands
 * on what was read; GREEN needs all three collections complete, every lane
 * passed, and the required workflow's run finished successfully.
 */
export function deriveCi(sf, policy = POLICY) {
  const failed = [];
  const cancelled = [];
  const running = [];
  const queued = [];
  const unrecognized = [];
  const lane = (name, status, conclusion) => {
    if (status === "completed") {
      if (!PASSED.has(conclusion)) (conclusion === "cancelled" ? cancelled : failed).push(name);
    } else if (status === "in_progress") running.push(name);
    else if (QUEUED.has(status)) queued.push(name);
    else unrecognized.push(name);
  };
  const runs = listIn(sf.checkRuns);
  const workflows = listIn(sf.workflowRuns);
  const statuses = listIn(sf.statuses);
  for (const r of runs ?? []) lane(r.name, r.status, r.conclusion);
  for (const w of workflows ?? []) lane(`workflow ${w.path}`, w.status, w.conclusion);
  for (const s of statuses ?? []) {
    if (s.state === "success") continue;
    if (s.state === "pending") running.push(s.context);
    else if (s.state === "failure" || s.state === "error") failed.push(s.context);
    else unrecognized.push(s.context);
  }
  const required = (workflows ?? []).filter((w) => w.path === policy.requiredWorkflow);
  const complete = [sf.checkRuns, sf.workflowRuns, sf.statuses].every(mayAssertPositive);

  let signal;
  if (failed.length) signal = "FAILED";
  else if (running.length) signal = "RUNNING";
  else if (queued.length) signal = "QUEUED";
  else if (cancelled.length) signal = "CANCELLED";
  else if (!complete || unrecognized.length) signal = UNKNOWN;
  else if (required.length === 0) signal = "NOT_STARTED";
  else if (runs.length === 0 || !required.every((w) => w.conclusion === "success")) signal = UNKNOWN;
  else signal = "GREEN";

  const sorted = (xs) => [...xs].sort();
  return {
    signal,
    failed: sorted(failed),
    cancelled: sorted(cancelled),
    running: sorted(running),
    queued: sorted(queued),
    unrecognized: sorted(unrecognized),
    lanes: runs ? runs.length : UNKNOWN,
    requiredWorkflow: policy.requiredWorkflow,
    requiredRuns: workflows ? required.length : UNKNOWN,
    reason: complete ? null : [sf.checkRuns, sf.workflowRuns, sf.statuses].find((e) => !mayAssertPositive(e))?.reason,
  };
}

/**
 * The repair budget comes from the risk tier. The baseline is the CI
 * classifier's own (scripts/classify-changes.mjs), so local and CI cannot
 * disagree; `--tier` may RAISE it and never lower it, because automated
 * classification never justifies de-escalation (ENGINEERING_STANDARDS §3).
 * An unreadable file list gets the strictest budget, not the loosest.
 */
export function deriveTier(sf, override = null, policy = POLICY) {
  const files = fullList(sf.files);
  const baselineTier = files ? classify(files.flat()).baselineRiskTier : UNKNOWN;
  const raised = override && baselineTier !== UNKNOWN && TIERS.indexOf(override) > TIERS.indexOf(baselineTier);
  const tier = raised ? override : baselineTier;
  const budget = tier === UNKNOWN ? Math.min(...Object.values(policy.repairBudget)) : policy.repairBudget[tier];
  return { baselineTier, requestedTier: override, tier, budget };
}

/**
 * Review provenance, findings, history and the review-round stop law. They
 * share their inputs, so they are derived together and fail together: one
 * unreadable surface makes every one of them UNKNOWN.
 */
export function deriveReview(sf, { now, policy = POLICY, budget }) {
  const head = sf.head;
  const unknown = (reason) => ({
    review: UNKNOWN,
    findings: UNKNOWN,
    history: UNKNOWN,
    rounds: UNKNOWN,
    detail: { reason },
    findingsDetail: { reason },
    roundsDetail: { streak: UNKNOWN, heads: [], reason },
  });
  if (head === UNKNOWN) return unknown("the head is unknown");
  const strict = ["reviews", "inlineComments", "issueComments"].find((k) => !mayAssertPositive(sf.provenance[k]));
  if (strict) return unknown(`${strict}: ${sf.provenance[strict].reason}`);
  const projected = ["reviews", "inlineComments", "issueComments"].every((k) => Array.isArray(sf.facts[k]?.value));
  const verdicts = projected ? collectVerdicts(sf.facts) : UNKNOWN;
  if (verdicts === UNKNOWN) return unknown("review verdicts could not be collected");

  const commits = fullList(sf.commits);
  const threads = fullList(sf.threads);
  const roots = sf.facts.inlineComments.value.filter((c) => c.inReplyToId === null || c.inReplyToId === undefined);
  const findings = roots.filter((c) => c.severity);
  // A Codex root comment without a severity badge is a finding nobody can
  // grade. It is never read as "no finding".
  const ungraded = roots.filter((c) => !c.severity && c.authorId === CODEX_ACTOR.id);
  const raisedAt = (sha) => (c) => c.originalCommitId === sha;
  const atHead = raisedAt(head);

  // Resolution is GitHub's review-thread state, set by a person after checking
  // the finding against the current head (§7.5) - read here, never written.
  // Threads are also the only TOTAL the inline comments have, so the two
  // surfaces must describe exactly the same root comments.
  let threadOf = null;
  if (threads) {
    const byRoot = new Map(threads.map((t) => [t.rootCommentId, t]));
    const rootIds = new Set(roots.map((c) => c.id));
    const agree =
      byRoot.size === threads.length &&
      threads.every((t) => rootIds.has(t.rootCommentId)) &&
      roots.every((c) => byRoot.has(c.id));
    if (agree) threadOf = byRoot;
  }
  const gating = [...findings.filter((c) => P0_P2.has(c.severity)), ...ungraded];
  const unresolved = threadOf ? gating.filter((c) => !threadOf.get(c.id).isResolved) : null;
  let findingsSignal;
  if (!unresolved) findingsSignal = UNKNOWN;
  else if (unresolved.some((c) => c.severity && atHead(c))) findingsSignal = "FRESH";
  else if (unresolved.some((c) => !c.severity)) findingsSignal = UNKNOWN;
  else findingsSignal = unresolved.length ? "CARRIED" : "NONE_BLOCKING";

  // Verdicts and requests for THIS head.
  const usable = verdicts.filter((v) => v.usable);
  const usableAtHead = usable.filter((v) => v.atHead);
  const headCommit = commits?.find((c) => c.sha === head) ?? null;
  const requestsAtHead = sf.facts.issueComments.value.filter((c) => {
    // Codex's own summary and verdict comments contain "@codex review" too; a
    // request is something an operator asked for.
    if (!c.isReviewRequest || c.authorId === CODEX_ACTOR.id) return false;
    if (c.requestedCommit) return shaMatches(c.requestedCommit, head);
    // An unbound request only counts if it was made after this head existed.
    return headCommit !== null && Date.parse(c.createdAt) >= Date.parse(headCommit.committedAt);
  });
  // Opening a pull request asks Codex for a review with no comment at all
  // ("Reviews are triggered when you open a pull request for review"). That
  // implicit ask covers the head the PR was opened with - one committed before
  // the PR existed. Without it, every freshly opened PR would be told to
  // request a review Codex is already running.
  const p = mayAssertPositive(sf.pull) ? sf.pull.value : null;
  const askedByOpening =
    p !== null && !p.draft && headCommit !== null && Date.parse(headCommit.committedAt) <= Date.parse(p.createdAt);
  const askedAt = [...requestsAtHead.map((c) => Date.parse(c.createdAt)), ...(askedByOpening ? [Date.parse(p.createdAt)] : [])];
  const latestRequest = askedAt.length ? Math.max(...askedAt) : null;
  let review;
  if (usableAtHead.length) {
    // A trusted verdict that states neither a clean result nor any finding is
    // not a review result anyone can act on.
    const statesSomething = usableAtHead.some((v) => v.clean === true) || findings.some(atHead) || ungraded.some(atHead);
    review = statesSomething ? "VERDICT_AT_HEAD" : UNKNOWN;
  } else if (latestRequest !== null) {
    review = now - latestRequest > policy.reviewAnswerMs ? "REQUEST_OVERDUE" : "REQUESTED";
  } else {
    review = usable.length ? "STALE" : "NONE";
  }

  // History: every head that was reviewed or carries a finding must still be in
  // the PR. One that is not means the branch was rewritten after review.
  const indexOf = (sha) => (commits ? commits.findIndex((c) => shaMatches(sha, c.sha)) : -1);
  const seen = [
    ...usable.map((v) => v.reviewedCommit),
    ...findings.map((c) => c.originalCommitId),
    ...ungraded.map((c) => c.originalCommitId),
  ];
  const history = !commits ? UNKNOWN : seen.every((sha) => indexOf(sha) !== -1) ? "INTACT" : "REWRITTEN";

  // The review-round stop law, §7.4: count the consecutive reviewed heads,
  // newest first, whose round raised a P0-P2 finding. A round that cannot be
  // graded counts AGAINST the budget - erring toward stopping, never toward
  // one more patch. Resolution does not matter here: a dismissed finding was
  // still a round.
  const streakHeads = [];
  let rounds = UNKNOWN;
  if (history === "INTACT") {
    const reviewed = [...new Set(seen.map(indexOf))].sort((a, b) => a - b);
    for (let k = reviewed.length - 1; k >= 0; k--) {
      const sha = commits[reviewed[k]].sha;
      const raised = raisedAt(sha);
      const p02 = findings.some((c) => raised(c) && P0_P2.has(c.severity)) || ungraded.some(raised);
      const clean = usable.some((v) => shaMatches(v.reviewedCommit, sha) && v.clean === true);
      const minorOnly = !p02 && findings.some(raised);
      if (!p02 && (clean || minorOnly)) break;
      streakHeads.push(sha);
    }
    rounds = streakHeads.length > budget ? "EXCEEDED" : "WITHIN_CAP";
  }

  const lastReviewedIndex = usable.length && commits ? Math.max(...usable.map((v) => indexOf(v.reviewedCommit))) : -1;
  const since = lastReviewedIndex >= 0 && headCommit ? commits.slice(lastReviewedIndex + 1) : [];
  const brief = (c) => ({ id: c.id, severity: c.severity ?? UNKNOWN, path: c.path, line: c.line, title: c.title ?? null, raisedAt: c.originalCommitId });
  const byId = (a, b) => a.id - b.id;
  const freshAll = gating.filter(atHead);
  return {
    review,
    findings: findingsSignal,
    history,
    rounds,
    detail: {
      verdictsAtHead: usableAtHead.length,
      cleanAtHead: usableAtHead.some((v) => v.clean === true),
      requestsAtHead: requestsAtHead.length,
      askedByOpening,
      latestRequestAgeMinutes: latestRequest === null ? null : Math.floor((now - latestRequest) / 60_000),
      lastReviewedHead: lastReviewedIndex >= 0 ? commits[lastReviewedIndex].sha : null,
      commitsSinceReview: since.length,
      mergeCommitsSinceReview: since.filter((c) => c.parents.length > 1).length,
      untrustedAtHead: verdicts.filter((v) => v.atHead && v.authority !== AUTHORIZED).length,
      reason: review === UNKNOWN ? "a trusted verdict names this head but states neither a clean result nor a finding" : null,
    },
    findingsDetail: {
      fresh: (unresolved ?? []).filter((c) => c.severity && atHead(c)).map(brief).sort(byId),
      carried: (unresolved ?? []).filter((c) => c.severity && !atHead(c)).map(brief).sort(byId),
      ungraded: (unresolved ?? []).filter((c) => !c.severity).map(brief).sort(byId),
      resolvedAtHead: threadOf ? freshAll.filter((c) => threadOf.get(c.id).isResolved).length : UNKNOWN,
      minorAtHead: findings.filter((c) => atHead(c) && !P0_P2.has(c.severity)).length,
      reason: threadOf ? null : threads ? "review threads and inline comments do not describe the same comments" : sf.threads.reason,
    },
    roundsDetail: {
      streak: history === "INTACT" ? streakHeads.length : UNKNOWN,
      heads: streakHeads,
      reason:
        history === "INTACT"
          ? null
          : history === "REWRITTEN"
            ? "a reviewed head is missing from the branch history"
            : `commits: ${sf.commits.reason}`,
    },
  };
}

/**
 * The CI-repetition stop law: consecutive heads, newest first, whose required
 * workflow run FAILED. A cancelled run is no verdict (superseded, or cut at a
 * budget), so it neither counts nor breaks the streak. Only the newest page of
 * branch runs is read; if it does not reach a passing head, the count is a
 * LOWER bound - enough to escalate, never enough to clear.
 */
export function deriveCiStreak(sf, { policy = POLICY, budget }) {
  const runs = listIn(sf.branchRuns);
  const commits = fullList(sf.commits);
  if (!runs || !commits) {
    return { signal: UNKNOWN, streak: UNKNOWN, budget, heads: [], lowerBound: false, reason: (runs ? sf.commits : sf.branchRuns).reason };
  }
  const latest = new Map();
  for (const r of runs) {
    if (r.path !== policy.requiredWorkflow) continue;
    const prev = latest.get(r.headSha);
    if (!prev || r.id > prev.id) latest.set(r.headSha, r);
  }
  const heads = [];
  let passed = false;
  for (let i = commits.length - 1; i >= 0 && !passed; i--) {
    const run = latest.get(commits[i].sha);
    if (!run || run.status !== "completed") continue;
    if (RED.has(run.conclusion)) heads.push(commits[i].sha);
    else if (run.conclusion === "success") passed = true;
  }
  const exhaustive = passed || sf.branchRuns.completeness === COMPLETE;
  const signal = heads.length > budget ? "EXCEEDED" : exhaustive ? "WITHIN_CAP" : UNKNOWN;
  return { signal, streak: heads.length, budget, heads, lowerBound: !exhaustive, reason: null };
}

/** Facts -> signals + the detail a human (or a caller) needs to act on them. */
export function deriveSignals(sf, { now, tier = null, policy = POLICY } = {}) {
  const p = mayAssertPositive(sf.pull) ? sf.pull.value : null;
  let pr = UNKNOWN;
  if (p && p.merged) pr = p.state === "closed" ? "MERGED" : UNKNOWN;
  else if (p && p.state === "closed") pr = "CLOSED";
  else if (p && p.state === "open") pr = p.draft ? "DRAFT" : "OPEN";

  const tierDetail = deriveTier(sf, tier, policy);
  const ci = deriveCi(sf, policy);
  const rv = deriveReview(sf, { now, policy, budget: tierDetail.budget });
  // A head whose required workflow PASSED ends any failure streak by
  // definition, so its own complete evidence settles the count; the branch
  // history is only needed while the head is not green.
  const ciStreak =
    ci.signal === "GREEN"
      ? { signal: "WITHIN_CAP", streak: 0, budget: tierDetail.budget, heads: [], lowerBound: false, reason: null }
      : deriveCiStreak(sf, { policy, budget: tierDetail.budget });
  const cmp = mayAssertPositive(sf.comparison) ? sf.comparison.value : null;
  const production = mayAssertPositive(sf.production) ? sf.production.value : null;

  const signals = {
    pr,
    base: p ? (p.baseRef === p.productionBranch ? "PRODUCTION" : "OTHER") : UNKNOWN,
    snapshot: sf.head === UNKNOWN || sf.headAfter === UNKNOWN ? UNKNOWN : sf.headAfter === sf.head ? "CONSISTENT" : "TORN",
    branch: cmp ? (cmp.behindBy === 0 ? "CURRENT" : "BEHIND") : UNKNOWN,
    conflicts: p ? (p.mergeable === true ? "NONE" : p.mergeable === false ? "CONFLICTING" : "PENDING") : UNKNOWN,
    ci: ci.signal,
    review: rv.review,
    findings: rv.findings,
    history: rv.history,
    rounds: rv.rounds,
    ciStreak: ciStreak.signal,
  };
  const detail = {
    pull: p ? { baseRef: p.baseRef, productionBranch: p.productionBranch, draft: p.draft, mergeable: p.mergeable } : { reason: sf.pull.reason },
    headAfter: sf.headAfter,
    branch: {
      production: production ?? { branch: p?.productionBranch ?? UNKNOWN, head: UNKNOWN },
      behindBy: cmp ? cmp.behindBy : UNKNOWN,
      aheadBy: cmp ? cmp.aheadBy : UNKNOWN,
      reason: cmp ? null : sf.comparison.reason,
    },
    ci,
    review: rv.detail,
    findings: rv.findingsDetail,
    rounds: { ...rv.roundsDetail, ...tierDetail },
    ciStreak,
  };
  return { signals, detail };
}

// ---------------------------------------------------------------------------
// Signals -> words. Every code the decision can emit has exactly one text.
// None of them instructs anything outside the delivery rules: new commits on
// top, normal merge commits from production, pushes without rewriting.
// ---------------------------------------------------------------------------

const short = (sha) => (typeof sha === "string" && sha !== UNKNOWN ? sha.slice(0, 10) : UNKNOWN);
const askedHow = (d) => (d.review.askedByOpening && d.review.requestsAtHead === 0 ? " (by opening the PR)" : "");
const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const list = (xs, max = 6) => (xs.length > max ? `${xs.slice(0, max).join(", ")}, +${xs.length - max} more` : xs.join(", "));

const TEXT = {
  UNREADABLE_PULL_REQUEST: (d) => `The pull request could not be read strictly, so there is no head to bind anything to (${d.pull.reason}).`,
  PR_MERGED: () => "Merged. After a merge, verify only branch containment, deployment and a clean tree; no full CI re-run.",
  PR_CLOSED: () => "Closed without merging. Nothing to shepherd.",
  HEAD_MOVED_DURING_READ: (d, h) => `The head moved while it was being read (${short(h)} -> ${short(d.headAfter)}). Read again.`,
  REVIEW_ROUNDS_EXCEEDED: (d) =>
    `${n(d.rounds.streak, "consecutive review round")} raised P0-P2 findings (${d.rounds.heads.map(short).join(", ")}), past the ` +
    `${d.rounds.tier} repair budget of ${d.rounds.budget}. Stop patching: §7.4 requires an architecture review before any further repair.`,
  CI_FAILURES_REPEATED: (d) =>
    `The required workflow failed at ${n(d.ciStreak.streak, "consecutive head")}${d.ciStreak.lowerBound ? " (at least)" : ""} ` +
    `(${d.ciStreak.heads.map(short).join(", ")}), past the ${d.rounds.tier} repair budget of ${d.ciStreak.budget}. ` +
    "This is non-convergence, not one more fix: stop and escalate (§7.4).",
  PR_DRAFT: () => "The pull request is a draft. Parking a PR is an operator decision; the shepherd does not drive a draft.",
  BASE_NOT_PRODUCTION: (d) => `The base is ${d.pull.baseRef}, not production (${d.pull.productionBranch}). A stacked PR is outside this shepherd.`,
  HISTORY_REWRITTEN: () =>
    "A head that was reviewed, or that carries a finding, is no longer in this PR's history: the branch was rewritten after review. " +
    "Exact-head evidence cannot be trusted across that; an operator must decide.",
  REVIEW_UNANSWERED: (d, h) =>
    `A review was requested for ${short(h)}${askedHow(d)} ${d.review.latestRequestAgeMinutes} min ago and no trusted verdict ` +
    `has arrived (bound ${POLICY.reviewAnswerMs / 60_000} min). Re-request once, or ask the operator.`,
  REPAIR_BUDGET_UNKNOWN: (d) =>
    `Fresh P0-P2 findings need repair, but the review-round history cannot be read, so the stop law cannot be checked. ` +
    `Do not repair until it can (${d.rounds.reason ?? "rounds UNKNOWN"}).`,
  CI_BUDGET_UNKNOWN: (d) =>
    `CI failed, but the run history cannot establish how many heads in a row it has failed, so the stop law cannot be checked. ` +
    `Do not push a fix until it can (${d.ciStreak.reason ?? "history incomplete"}).`,
  RESOLVE_CONFLICTS: (d) =>
    `GitHub reports merge conflicts with production. Merge origin/${d.branch.production.branch} into the branch with a normal ` +
    "merge commit, resolve the conflicts, and push normally.",
  REPAIR_FINDINGS: (d, h) => {
    const fresh = d.findings.fresh;
    const family =
      fresh.length >= 2
        ? ` Before patching, decide whether these ${fresh.length} share a root-cause family: if they do, stop - §7.4 requires an architecture review, not ${fresh.length} patches.`
        : "";
    return (
      `${n(fresh.length, "unresolved P0-P2 finding")} raised at ${short(h)}: ` +
      `${list(fresh.map((f) => `${f.severity} ${f.path}:${f.line}`))}. Verify each premise against the head, repair with a new ` +
      `commit on top, then request an exact-head review. Review round ${d.rounds.streak} of a ${d.rounds.tier} budget of ${d.rounds.budget}.${family}`
    );
  },
  FIX_CI: (d, h) =>
    `Failed at ${short(h)}: ${list(d.ci.failed)}. Fix with a new commit on top ` +
    `(${n(d.ciStreak.streak, "consecutive red head")} so far, budget ${d.ciStreak.budget}).` +
    (d.branch.behindBy > 0 ? ` Production has moved ${n(d.branch.behindBy, "commit")}: it may be merged in the same push.` : ""),
  DISPOSITION_FINDINGS: (d, h) =>
    `${n(d.findings.carried.length, "unresolved P0-P2 finding")} raised at earlier heads: ` +
    `${list(d.findings.carried.map((f) => `${f.severity} ${f.path}:${f.line} @${short(f.raisedAt)}`))}. For each, verify it against ` +
    `${short(h)} by line, reply with that evidence, and resolve that one thread (§7.5). A later clean review does not close it.`,
  RERUN_CI: (d, h) =>
    `Cancelled at ${short(h)}: ${list(d.ci.cancelled)}. A cancellation is not a verdict on the code - check what the lane ` +
    "completed before it stopped (a budget cut reads like a failure), then re-run it.",
  REQUEST_REVIEW: (d, h) => {
    const r = d.review;
    const stale = r.lastReviewedHead
      ? ` The last trusted verdict was for ${short(r.lastReviewedHead)}, ${n(r.commitsSinceReview, "commit")} ago` +
        `${r.mergeCommitsSinceReview ? ` (${n(r.mergeCommitsSinceReview, "merge commit")})` : ""}; new commits invalidate it.`
      : "";
    return `No trusted verdict names ${short(h)}.${stale} Comment "@codex review" naming \`${short(h)}\`.`;
  },
  REFRESH_PRODUCTION: (d) =>
    `The branch is ${n(d.branch.behindBy, "commit")} behind production (${short(d.branch.production.head)}). Merge ` +
    `origin/${d.branch.production.branch} with a normal merge commit and push normally; the new head then needs CI and an exact-head review.`,
  WAIT_CI: (d, h) => {
    const c = d.ci;
    if (c.signal === "NOT_STARTED") return `No run of ${c.requiredWorkflow} exists for ${short(h)} yet.`;
    const parts = [c.running.length ? `${c.running.length} running: ${list(c.running, 4)}` : "", c.queued.length ? `${c.queued.length} queued: ${list(c.queued, 4)}` : ""];
    return `CI at ${short(h)}: ${parts.filter(Boolean).join("; ")}.`;
  },
  WAIT_REVIEW: (d, h) =>
    `A review was requested for ${short(h)}${askedHow(d)} ${d.review.latestRequestAgeMinutes} min ago; waiting for a trusted verdict.`,
  WAIT_MERGEABILITY: () => "GitHub has not finished computing mergeability. Read again.",
};

const NOT_PROVEN = {
  pr: (d) => `the pull request state (${d.pull.reason ?? "unrecognized"})`,
  base: (d) => `that the base is production (${d.pull.reason ?? "unknown"})`,
  snapshot: () => "that the head held still for the whole read",
  branch: (d) => `the branch's position against production (${d.branch.reason ?? "unknown"})`,
  conflicts: (d) => `mergeability (${d.pull.reason ?? "unknown"})`,
  ci: (d) => `CI at this head (${d.ci.reason ?? (d.ci.unrecognized.length ? `unrecognized status: ${list(d.ci.unrecognized)}` : "not conclusive")})`,
  review: (d) => `an exact-head review result (${d.review.reason ?? "unknown"})`,
  findings: (d) => `that no actionable finding is open (${d.findings.reason ?? "a finding could not be graded"})`,
  history: (d) => `that the branch history is intact (${d.rounds.reason ?? "unknown"})`,
  rounds: (d) => `the review-round count (${d.rounds.reason ?? "unknown"})`,
  ciStreak: (d) => `the CI failure streak (${d.ciStreak.reason ?? "history does not reach a passing head"})`,
};

function explain(code, detail, head) {
  if (code.startsWith("NOT_PROVEN_")) {
    const key = Object.keys(NOT_PROVEN).find((k) => `NOT_PROVEN_${k.toUpperCase()}` === code);
    return `Cannot establish ${NOT_PROVEN[key](detail)}, so readiness is not asserted.`;
  }
  return TEXT[code](detail, head);
}

/** Every code `decide` can emit, so a test can hold the catalogue complete. */
export const CODES = Object.freeze([...Object.keys(TEXT), ...Object.keys(NOT_PROVEN).map((k) => `NOT_PROVEN_${k.toUpperCase()}`)]);

const READY_TEXT =
  "Every mechanical gate holds at this exact head. The merge decision is the operator's: neither green CI nor this state is merge authorization.";

/** The whole answer for one read: state, why, what next, and the evidence. */
export function interpret(sf, { now = Date.now(), tier = null, policy = POLICY } = {}) {
  const { signals, detail } = deriveSignals(sf, { now, tier, policy });
  const d = decide(signals);
  const say = (code) => ({ code, text: explain(code, detail, sf.head) });
  return {
    schema: "hone.eng.shepherd/v1",
    repo: sf.repo,
    pr: sf.pr,
    observedAt: new Date(now).toISOString(),
    head: sf.head,
    production: detail.branch.production,
    state: d.state,
    exitCode: EXIT_CODE[d.state],
    summary: d.state === STATE.READY_FOR_HUMAN_MERGE ? READY_TEXT : null,
    stops: d.stops.map(say),
    blocks: d.blocks.map(say),
    actions: d.actions.map(say),
    waits: d.waits.map(say),
    signals,
    detail,
    unavailable: sf.unavailable,
  };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

export const LAW =
  "The shepherd only reads. It never merges, rebases, amends, squashes or force-pushes, and nothing it reports is merge authorization.";

export const SHEPHERD_USAGE = `
  npm run eng -- shepherd <pr> [--json] [--tier T0|T1|T2|T3]
  npm run eng -- shepherd <pr> --watch [--interval <seconds>] [--max-minutes <minutes>] [--json]

Interprets exact-head facts into one next step: READY_FOR_HUMAN_MERGE, WAITING,
ACTION_REQUIRED, BLOCKED, ESCALATE or CLOSED (exit 0/10/20/30/40/50).
--tier may raise the classifier's baseline tier, never lower it.
--watch polls until the state settles, the head changes, nothing progresses,
or the time bound is reached.

${LAW}
`;

export function renderShepherd(result) {
  const s = result.signals;
  const d = result.detail;
  const out = [];
  const row = (label, value, note) => out.push(`  ${label.padEnd(11)}${String(value).padEnd(16)}${DIM}${note}${RESET}`);
  out.push("");
  out.push(`PR #${result.pr}  head ${short(result.head)}  production ${d.branch.production.branch} @ ${short(d.branch.production.head)}`);
  row("branch", s.branch, `${d.branch.behindBy} behind, ${d.branch.aheadBy} ahead`);
  const ciNote = d.ci.failed.length
    ? `failed: ${list(d.ci.failed, 4)}`
    : d.ci.running.length || d.ci.queued.length
      ? `${d.ci.running.length} running, ${d.ci.queued.length} queued`
      : d.ci.cancelled.length
        ? `cancelled: ${list(d.ci.cancelled, 4)}`
        : `${d.ci.lanes} lane(s); ${d.ci.requiredWorkflow} runs: ${d.ci.requiredRuns}`;
  row("ci", s.ci, ciNote);
  const rv = d.review;
  row(
    "review",
    s.review,
    rv.lastReviewedHead !== undefined
      ? `trusted verdicts at head: ${rv.verdictsAtHead}${rv.lastReviewedHead ? `; last reviewed ${short(rv.lastReviewedHead)}` : ""}` +
          `${rv.untrustedAtHead ? `; ${rv.untrustedAtHead} untrusted look-alike(s) ignored` : ""}`
      : rv.reason,
  );
  const f = d.findings;
  row(
    "findings",
    s.findings,
    f.fresh
      ? `unresolved P0-P2: ${f.fresh.length} at head, ${f.carried.length} carried; ${f.minorAtHead} P3 at head` +
          // Shown at the gate on purpose: a finding raised at this head and then
          // resolved without a new commit is an adjudication a human should see.
          (f.resolvedAtHead > 0 ? `; ${f.resolvedAtHead} raised at head and resolved in its thread without a new commit` : "")
      : f.reason,
  );
  row("rounds", s.rounds, `${d.rounds.streak} consecutive P0-P2 round(s); ${d.rounds.tier} budget ${d.rounds.budget}`);
  row("ci streak", s.ciStreak, `${d.ciStreak.streak}${d.ciStreak.lowerBound ? "+" : ""} consecutive red head(s); budget ${d.ciStreak.budget}`);
  if (s.history !== "INTACT") row("history", s.history, "");
  if (s.snapshot !== "CONSISTENT") row("snapshot", s.snapshot, `re-read head ${short(d.headAfter)}`);

  out.push("");
  out.push(`STATE ${result.state}`);
  if (result.summary) out.push(`  ${result.summary}`);
  for (const group of [result.stops, result.blocks, result.actions, result.waits]) {
    for (const item of group) out.push(`  -> ${item.code}  ${item.text}`);
  }
  if (result.unavailable.length) {
    out.push("");
    out.push("UNAVAILABLE (UNKNOWN, never none/clean):");
    for (const u of result.unavailable) out.push(`  ${u.surface}: ${u.reason}`);
  }
  out.push("");
  out.push(`${DIM}${LAW}${RESET}`);
  out.push("");
  return out.join("\n");
}

/** One line per observed change while watching. */
export function renderTransition(result, at) {
  const s = result.signals;
  return `${new Date(at).toISOString().slice(11, 19)} ${result.state.padEnd(22)} head ${short(result.head)}  ci=${s.ci} review=${s.review} findings=${s.findings} branch=${s.branch}`;
}
