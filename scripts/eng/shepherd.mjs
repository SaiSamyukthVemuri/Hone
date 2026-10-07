#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ENG-LOOP-01: `npm run eng -- shepherd <pr> [--json]`
//
// SINGLE-SHOT and OBSERVATION ONLY (docs/decisions/eng-loop-01-observation-only.md).
// The shepherd reads a pull request's exact-head facts from GitHub ONCE,
// normalizes them into one state, and RECOMMENDS a next step. It does not poll
// - a bounded watch is ENG-LOOP-02 - and it is not release authority:
//
//   * it never merges, rebases, amends, squashes, force-pushes or refreshes a
//     branch, never writes to GitHub, and persists nothing - every answer is
//     re-derived at read time (no ledger: CP-005b retired on exactly that);
//   * its best state, CANDIDATE_READY_FOR_HUMAN_REVIEW, is ADVISORY. Neither it
//     nor green CI authorizes a merge; the human / existing release procedure
//     decides (CANONICAL_ROADMAP §16.2, Phase 1);
//   * it infers NOTHING about review requests - not from comments, not from
//     when a PR was opened or marked ready. The one review fact it reads is
//     whether a TRUSTED Codex verdict exists for the CURRENT exact head;
//   * every comment-derived input passes ONE authority gate (`admit`): only
//     the trusted Codex account, by immutable id and type, is evidence;
//   * CI is the LATEST applicable workflow run for the exact head - never every
//     run that ever ran at that sha;
//   * EXTERNAL head checks (non-Actions check runs, commit statuses - Vercel's,
//     say) are a separate, NEGATIVE-ONLY signal: a failed one blocks candidacy
//     and a pending one holds it, but no external state can make CI green, make
//     a PR a candidate, or stand in for a failed or missing Actions run.
//
// Stop laws are still evaluated, as recommendations: consecutive P0-P2 review
// rounds, or consecutive red CI heads, past the tier's repair budget (§7.4)
// read ESCALATE, and no repair is recommended while that budget is unreadable.
// A root-cause FAMILY stays a human judgement.
//
// THE DECISION IS A TOTAL FUNCTION over a closed set of signals (DOMAINS), in
// one fixed precedence:
//
//   CLOSED > ESCALATE > BLOCKED > ACTION_RECOMMENDED > WAITING
//          > BLOCKED (not proven) > CANDIDATE_READY_FOR_HUMAN_REVIEW
//
// The candidate state is an explicit conjunction - every signal at its one
// positive value (CANDIDATE_POINT) - never a fall-through.
// tests/eng/shepherd.test.ts enumerates the whole product of DOMAINS.
// ---------------------------------------------------------------------------

import { classify } from "../classify-changes.mjs";
import { AUTHORIZED, COMPLETE, UNKNOWN, actorAuthority, mayAssertPositive } from "./evidence.mjs";
import { PR_WORKFLOW, latestApplicableRun, projectInlineComment, projectIssueComment, projectReview } from "./github-facts.mjs";
import { shaMatches } from "./review-provenance.mjs";

export { UNKNOWN };

export const STATE = Object.freeze({
  CANDIDATE_READY_FOR_HUMAN_REVIEW: "CANDIDATE_READY_FOR_HUMAN_REVIEW",
  WAITING: "WAITING",
  ACTION_RECOMMENDED: "ACTION_RECOMMENDED",
  BLOCKED: "BLOCKED",
  ESCALATE: "ESCALATE",
  CLOSED: "CLOSED",
});

/** One exit code per state, so a shell loop can branch. None is authorization. */
export const EXIT_CODE = Object.freeze({
  CANDIDATE_READY_FOR_HUMAN_REVIEW: 0,
  WAITING: 10,
  ACTION_RECOMMENDED: 20,
  BLOCKED: 30,
  ESCALATE: 40,
  CLOSED: 50,
});

export const POLICY = Object.freeze({
  /** The pull-request workflow; its latest run at the head is the head's CI. */
  workflow: PR_WORKFLOW,
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
  external: Object.freeze(["CLEAR", "PENDING", "FAILED", UNKNOWN]),
  review: Object.freeze(["VERDICT_AT_HEAD", "NO_VERDICT_AT_HEAD", UNKNOWN]),
  findings: Object.freeze(["NONE_BLOCKING", "FRESH", "CARRIED", UNKNOWN]),
  history: Object.freeze(["INTACT", "REWRITTEN", UNKNOWN]),
  rounds: Object.freeze(["WITHIN_CAP", "EXCEEDED", UNKNOWN]),
  ciStreak: Object.freeze(["WITHIN_CAP", "EXCEEDED", UNKNOWN]),
});

/** The ONE point of that product at which a PR is a candidate for human review. */
export const CANDIDATE_POINT = Object.freeze({
  pr: "OPEN",
  base: "PRODUCTION",
  snapshot: "CONSISTENT",
  branch: "CURRENT",
  conflicts: "NONE",
  ci: "GREEN",
  // CLEAR is "nothing external holds the PR back" - including no external
  // check at all. It is a precondition, never a contribution.
  external: "CLEAR",
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
 * one state, and the candidate state only at CANDIDATE_POINT. Each tier of the
 * precedence is a list, so everything that applies at the winning tier is
 * reported, not just the first thing found. Every output is a recommendation.
 */
export function decide(s) {
  if (s.pr === UNKNOWN) return outcome(STATE.BLOCKED, { blocks: ["UNREADABLE_PULL_REQUEST"] });
  if (s.pr === "MERGED") return outcome(STATE.CLOSED, { blocks: ["PR_MERGED"] });
  if (s.pr === "CLOSED") return outcome(STATE.CLOSED, { blocks: ["PR_CLOSED"] });
  // Answers that straddle a push are not one snapshot; nothing else is decided.
  if (s.snapshot === "TORN") return outcome(STATE.WAITING, { waits: ["HEAD_MOVED_DURING_READ"] });

  // Stop laws. A CONFIRMED breach recommends stopping whatever else is true.
  const stops = [];
  if (s.rounds === "EXCEEDED") stops.push("REVIEW_ROUNDS_EXCEEDED");
  if (s.ciStreak === "EXCEEDED") stops.push("CI_FAILURES_REPEATED");
  if (stops.length) return outcome(STATE.ESCALATE, { stops });

  // Blocks: nothing the loop should do next without a human.
  const blocks = [];
  if (s.pr === "DRAFT") blocks.push("PR_DRAFT");
  if (s.base === "OTHER") blocks.push("BASE_NOT_PRODUCTION");
  if (s.history === "REWRITTEN") blocks.push("HISTORY_REWRITTEN");
  // A repair is never recommended while the budget that would forbid it is unread.
  if (s.findings === "FRESH" && s.rounds !== "WITHIN_CAP") blocks.push("REPAIR_BUDGET_UNKNOWN");
  if (s.ci === "FAILED" && s.ciStreak !== "WITHIN_CAP") blocks.push("CI_BUDGET_UNKNOWN");
  if (blocks.length) return outcome(STATE.BLOCKED, { blocks });

  // Recommendations. The first three each produce a new head, so nothing the
  // new head would immediately make stale is recommended alongside them.
  const actions = [];
  if (s.conflicts === "CONFLICTING") actions.push("RESOLVE_CONFLICTS");
  if (s.findings === "FRESH") actions.push("REPAIR_FINDINGS");
  if (s.ci === "FAILED") actions.push("FIX_CI");
  const newHeadComing = actions.length > 0;
  if (s.findings === "CARRIED") actions.push("DISPOSITION_FINDINGS");
  // A failed external check holds the PR back; its cause lives with its provider.
  if (s.external === "FAILED") actions.push("CHECK_EXTERNAL");
  if (!newHeadComing) {
    // Production comes in once CI has settled, before the review it would make
    // stale; a refresh re-runs every lane, so it replaces a re-run.
    const settled = s.ci === "GREEN" || s.ci === "CANCELLED";
    if (s.branch === "BEHIND" && settled) actions.push("REFRESH_PRODUCTION");
    if (s.ci === "CANCELLED" && s.branch === "CURRENT") actions.push("RERUN_CI");
    // No trusted verdict for this exact head: recommend asking for one. Whether
    // someone already asked is deliberately NOT inferred.
    if (s.review === "NO_VERDICT_AT_HEAD" && s.branch === "CURRENT") actions.push("REQUEST_EXACT_HEAD_REVIEW");
  }
  if (actions.length) return outcome(STATE.ACTION_RECOMMENDED, { actions });

  const waits = [];
  if (s.ci === "RUNNING" || s.ci === "QUEUED" || s.ci === "NOT_STARTED") waits.push("WAIT_CI");
  if (s.external === "PENDING") waits.push("WAIT_EXTERNAL");
  if (s.conflicts === "PENDING") waits.push("WAIT_MERGEABILITY");
  if (waits.length) return outcome(STATE.WAITING, { waits });

  // The candidate state: an explicit conjunction over EVERY signal.
  const unproven = Object.keys(CANDIDATE_POINT).filter((k) => s[k] !== CANDIDATE_POINT[k]);
  if (unproven.length === 0) return outcome(STATE.CANDIDATE_READY_FOR_HUMAN_REVIEW);
  return outcome(STATE.BLOCKED, { blocks: unproven.map((k) => `NOT_PROVEN_${k.toUpperCase()}`) });
}

// ---------------------------------------------------------------------------
// THE AUTHORITY GATE.
// ---------------------------------------------------------------------------

/**
 * Every comment-derived input - submitted reviews, issue comments, inline
 * review comments - passes here ONCE, and only what the trusted reviewer wrote
 * comes out as evidence. Trust is `actorAuthority` (evidence.mjs): the Codex
 * reviewer's immutable account id AND type. Never a login, never wording,
 * never `author_association`; and no public commenter is ever an operator -
 * the shepherd reads no requests at all.
 *
 * Untrusted items come out only as COUNTS, for display. No derivation receives
 * them, and tests/eng/shepherd.test.ts proves it: adding or re-attributing any
 * comment, in any situation, changes nothing but those counts.
 *
 * Returns null for a collection that could not be read strictly.
 */
export function admit(comments) {
  const split = (env) => {
    if (!mayAssertPositive(env)) return null;
    const trusted = [];
    let untrusted = 0;
    for (const item of env.value) {
      if (actorAuthority(item.user).authority === AUTHORIZED) trusted.push(item);
      else untrusted += 1;
    }
    return { trusted, untrusted };
  };
  return { reviews: split(comments.reviews), inline: split(comments.inline), issues: split(comments.issues) };
}

// ---------------------------------------------------------------------------
// Facts -> signals. Each derivation reads only evidence that passed the strict
// collector (and, for comments, the gate). Anything it cannot establish is
// UNKNOWN - never a default.
// ---------------------------------------------------------------------------

const P0_P2 = new Set(["P0", "P1", "P2"]);
const PASSED = new Set(["success", "skipped", "neutral"]);
const QUEUED = new Set(["queued", "waiting", "requested", "pending"]);
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const TIERS = ["T0", "T1", "T2", "T3"];

const listIn = (env) => (env && Array.isArray(env.value) ? env.value : null);
const fullList = (env) => (mayAssertPositive(env) ? env.value : null);
const sorted = (xs) => [...xs].sort();

/**
 * CI at the exact head: the LATEST applicable run (github-facts.mjs) and its
 * own jobs. The run's status and conclusion are the authority; the jobs name
 * the lanes. A failed job is a negative fact and stands even while the run is
 * still going; a "success" run with any job that did not pass is a
 * contradiction, so it is UNKNOWN, not GREEN.
 */
export function deriveCi(sf, policy = POLICY) {
  const lanes = { failed: [], cancelled: [], running: [], queued: [], unrecognized: [] };
  const report = (signal, run, reason, jobs = null) => ({
    signal,
    run: run ? { id: run.id, status: run.status, conclusion: run.conclusion } : null,
    workflow: policy.workflow.path,
    ...Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, sorted(v)])),
    jobs: jobs === null ? UNKNOWN : jobs.length,
    reason,
  });
  const env = sf.ciRun;
  if (!mayAssertPositive(env)) return report(UNKNOWN, null, env?.reason ?? "not read");
  if (env.value === null) return report("NOT_STARTED", null, env.reason);

  const { run, jobs } = env.value;
  for (const j of jobs) {
    if (j.status === "completed") {
      if (!PASSED.has(j.conclusion)) (j.conclusion === "cancelled" ? lanes.cancelled : lanes.failed).push(j.name);
    } else if (j.status === "in_progress") lanes.running.push(j.name);
    else if (QUEUED.has(j.status)) lanes.queued.push(j.name);
    else lanes.unrecognized.push(j.name);
  }
  const unsettledJobs = lanes.running.length + lanes.queued.length + lanes.unrecognized.length;

  let signal;
  if (run.status === "completed" && run.conclusion === "success") {
    signal = jobs.length > 0 && lanes.failed.length + lanes.cancelled.length + unsettledJobs === 0 ? "GREEN" : UNKNOWN;
  } else if (lanes.failed.length) {
    signal = "FAILED";
  } else if (run.status !== "completed") {
    const known = run.status === "in_progress" || QUEUED.has(run.status);
    if (!known || lanes.unrecognized.length) signal = UNKNOWN;
    else signal = run.status === "in_progress" || lanes.running.length ? "RUNNING" : "QUEUED";
  } else if (run.conclusion === "cancelled") {
    signal = "CANCELLED";
    if (!lanes.cancelled.length) lanes.cancelled.push(`workflow ${run.path}`);
  } else if (RED.has(run.conclusion)) {
    signal = "FAILED";
    lanes.failed.push(`workflow ${run.path}`);
  } else {
    signal = UNKNOWN;
  }
  const reason = signal === UNKNOWN ? `run ${run.id} reads ${run.status}/${run.conclusion} with jobs that do not agree` : null;
  return report(signal, run, reason, jobs);
}

const EXTERNAL_PASSED = new Set(["success", "neutral", "skipped"]);
const EXTERNAL_RED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/**
 * EXTERNAL checks at the exact head - non-Actions check runs and commit
 * statuses - as a NEGATIVE-ONLY signal (decision record, amendment):
 *
 *   FAILED  a check failed, errored or was cancelled: it blocks candidacy;
 *   PENDING one has not finished: candidacy waits for it. With no required
 *           checks configured on production, every external check reported
 *           for the exact head is treated as relevant;
 *   UNKNOWN unreadable, partial, or a state GitHub never documented: it can
 *           only keep a PR from candidacy;
 *   CLEAR   nothing external holds the PR back - which includes there being
 *           no external check at all, so CLEAR can never contribute anything.
 *
 * Nothing here reads Actions: the latest applicable run is CI's authority, and
 * an external pass cannot make it green or stand in for it.
 */
export function deriveExternal(sf) {
  const failed = [];
  const pending = [];
  const unrecognized = [];
  const checks = listIn(sf.externalChecks);
  const statuses = listIn(sf.commitStatuses);
  for (const c of checks ?? []) {
    const name = `${c.name} (${c.app})`;
    if (c.status === "completed") {
      if (EXTERNAL_RED.has(c.conclusion)) failed.push(name);
      else if (!EXTERNAL_PASSED.has(c.conclusion)) unrecognized.push(name);
    } else if (c.status === "in_progress" || QUEUED.has(c.status)) pending.push(name);
    else unrecognized.push(name);
  }
  for (const s of statuses ?? []) {
    const name = `${s.context} (status)`;
    if (s.state === "failure" || s.state === "error") failed.push(name);
    else if (s.state === "pending") pending.push(name);
    else if (s.state !== "success") unrecognized.push(name);
  }
  const complete = mayAssertPositive(sf.externalChecks) && mayAssertPositive(sf.commitStatuses);
  let signal;
  // A failure is a negative fact and stands on whatever was read.
  if (failed.length) signal = "FAILED";
  else if (!complete || unrecognized.length) signal = UNKNOWN;
  else if (pending.length) signal = "PENDING";
  else signal = "CLEAR";
  const unread = [sf.externalChecks, sf.commitStatuses].find((e) => !mayAssertPositive(e));
  return {
    signal,
    failed: sorted(failed),
    pending: sorted(pending),
    unrecognized: sorted(unrecognized),
    checks: checks ? checks.length : UNKNOWN,
    statuses: statuses ? statuses.length : UNKNOWN,
    reason: unread ? unread.reason : unrecognized.length ? `undocumented state: ${list(unrecognized)}` : null,
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
 * Review, findings, history and the review-round stop law, from GATED evidence
 * only. They share their inputs, so they are derived together and fail
 * together: one unreadable surface makes every one of them UNKNOWN.
 */
export function deriveReview(sf, gate, { budget }) {
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
  const unread = ["reviews", "inline", "issues"].find((k) => gate[k] === null);
  if (unread) return unknown(`${unread}: ${sf.comments[unread].reason}`);

  const commits = fullList(sf.commits);
  const threads = fullList(sf.threads);
  // Trusted evidence, projected by the same parsers `status` uses.
  const verdicts = [
    ...gate.reviews.trusted.map((r) => projectReview(r).verdict),
    ...gate.issues.trusted.map(projectIssueComment).flatMap((c) => (c.verdict ? [c.verdict] : [])),
  ].filter((v) => v.completeness === COMPLETE);
  const roots = gate.inline.trusted.map(projectInlineComment).filter((c) => c.inReplyToId === null);
  const findings = roots.filter((c) => c.severity);
  // A Codex root comment without a severity badge is a finding nobody can
  // grade. It is never read as "no finding".
  const ungraded = roots.filter((c) => !c.severity);
  const raisedAt = (sha) => (c) => c.originalCommitId === sha;
  const atHead = raisedAt(head);

  // THE review fact: a trusted verdict that names this exact head. One that
  // states neither a clean result nor any finding is not a result anyone can
  // act on.
  const verdictsAtHead = verdicts.filter((v) => shaMatches(v.reviewedCommit, head));
  let review = "NO_VERDICT_AT_HEAD";
  if (verdictsAtHead.length) {
    const statesSomething = verdictsAtHead.some((v) => v.clean === true) || findings.some(atHead) || ungraded.some(atHead);
    review = statesSomething ? "VERDICT_AT_HEAD" : UNKNOWN;
  }

  // Resolution is GitHub's review-thread state, set by someone with write
  // access after checking the finding against the current head (§7.5) - read
  // here, never written. The collector has already proved threads and root
  // comments describe the same set.
  const threadOf = threads ? new Map(threads.map((t) => [t.rootCommentId, t])) : null;
  const gating = [...findings.filter((c) => P0_P2.has(c.severity)), ...ungraded];
  const unresolved = threadOf ? gating.filter((c) => !threadOf.get(c.id)?.isResolved) : null;
  let findingsSignal;
  if (!unresolved) findingsSignal = UNKNOWN;
  else if (unresolved.some((c) => c.severity && atHead(c))) findingsSignal = "FRESH";
  else if (unresolved.some((c) => !c.severity)) findingsSignal = UNKNOWN;
  else findingsSignal = unresolved.length ? "CARRIED" : "NONE_BLOCKING";

  // History: every head a trusted verdict or finding names must still be in
  // the PR. One that is not means the branch was rewritten after review.
  const indexOf = (sha) => (commits ? commits.findIndex((c) => shaMatches(sha, c.sha)) : -1);
  const seen = [
    ...verdicts.map((v) => v.reviewedCommit),
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
      const clean = verdicts.some((v) => shaMatches(v.reviewedCommit, sha) && v.clean === true);
      const minorOnly = !p02 && findings.some(raised);
      if (!p02 && (clean || minorOnly)) break;
      streakHeads.push(sha);
    }
    rounds = streakHeads.length > budget ? "EXCEEDED" : "WITHIN_CAP";
  }

  const lastReviewedIndex = verdicts.length && commits ? Math.max(...verdicts.map((v) => indexOf(v.reviewedCommit))) : -1;
  const since = lastReviewedIndex >= 0 ? commits.slice(lastReviewedIndex + 1) : [];
  const brief = (c) => ({ id: c.id, severity: c.severity ?? UNKNOWN, path: c.path, line: c.line, title: c.title ?? null, raisedAt: c.originalCommitId });
  const byId = (a, b) => a.id - b.id;
  return {
    review,
    findings: findingsSignal,
    history,
    rounds,
    detail: {
      trustedVerdictsAtHead: verdictsAtHead.length,
      cleanAtHead: verdictsAtHead.some((v) => v.clean === true),
      lastReviewedHead: lastReviewedIndex >= 0 ? commits[lastReviewedIndex].sha : null,
      commitsSinceReview: since.length,
      mergeCommitsSinceReview: since.filter((c) => c.parents.length > 1).length,
      untrusted: { reviews: gate.reviews.untrusted, issueComments: gate.issues.untrusted, inlineComments: gate.inline.untrusted },
      reason: review === UNKNOWN ? "a trusted verdict names this head but states neither a clean result nor a finding" : null,
    },
    findingsDetail: {
      fresh: (unresolved ?? []).filter((c) => c.severity && atHead(c)).map(brief).sort(byId),
      carried: (unresolved ?? []).filter((c) => c.severity && !atHead(c)).map(brief).sort(byId),
      ungraded: (unresolved ?? []).filter((c) => !c.severity).map(brief).sort(byId),
      resolvedAtHead: threadOf ? gating.filter((c) => atHead(c) && threadOf.get(c.id)?.isResolved).length : UNKNOWN,
      minorAtHead: findings.filter((c) => atHead(c) && !P0_P2.has(c.severity)).length,
      reason: threadOf ? null : sf.threads.reason,
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
 * The CI-repetition stop law: consecutive heads, newest first, whose LATEST
 * applicable run FAILED - the same "latest applicable run" rule as the head's
 * own CI. A cancelled run is no verdict (superseded, or cut at a budget), so it
 * neither counts nor breaks the streak. Only the newest page of branch runs is
 * read; if it does not reach a passing head, the count is a LOWER bound -
 * enough to escalate, never enough to clear.
 */
export function deriveCiStreak(sf, { policy = POLICY, budget }) {
  const runs = listIn(sf.branchRuns);
  const commits = fullList(sf.commits);
  if (!runs || !commits) {
    return { signal: UNKNOWN, streak: UNKNOWN, budget, heads: [], lowerBound: false, reason: (runs ? sf.commits : sf.branchRuns).reason };
  }
  const byHead = new Map();
  for (const r of runs) byHead.set(r.headSha, [...(byHead.get(r.headSha) ?? []), r]);
  const heads = [];
  let passed = false;
  for (let i = commits.length - 1; i >= 0 && !passed; i--) {
    const run = latestApplicableRun(byHead.get(commits[i].sha) ?? [], policy.workflow);
    if (!run || run.status !== "completed") continue;
    if (RED.has(run.conclusion)) heads.push(commits[i].sha);
    else if (run.conclusion === "success") passed = true;
  }
  const exhaustive = passed || sf.branchRuns.completeness === COMPLETE;
  const signal = heads.length > budget ? "EXCEEDED" : exhaustive ? "WITHIN_CAP" : UNKNOWN;
  return { signal, streak: heads.length, budget, heads, lowerBound: !exhaustive, reason: null };
}

/** Facts -> signals + the detail a human (or a caller) needs to act on them. */
export function deriveSignals(sf, { tier = null, policy = POLICY } = {}) {
  const p = mayAssertPositive(sf.pull) ? sf.pull.value : null;
  let pr = UNKNOWN;
  if (p && p.merged) pr = p.state === "closed" ? "MERGED" : UNKNOWN;
  else if (p && p.state === "closed") pr = "CLOSED";
  else if (p && p.state === "open") pr = p.draft ? "DRAFT" : "OPEN";

  const tierDetail = deriveTier(sf, tier, policy);
  const ci = deriveCi(sf, policy);
  const external = deriveExternal(sf);
  const rv = deriveReview(sf, admit(sf.comments), { budget: tierDetail.budget });
  // A head whose latest run PASSED ends any failure streak by definition, so
  // its own evidence settles the count; history is only needed when it did not.
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
    external: external.signal,
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
    external,
    review: rv.detail,
    findings: rv.findingsDetail,
    rounds: { ...rv.roundsDetail, ...tierDetail },
    ciStreak,
  };
  return { signals, detail };
}

// ---------------------------------------------------------------------------
// Signals -> words. Every code the decision can emit has exactly one text, and
// every text is a recommendation. None proposes anything outside the delivery
// rules: new commits on top, production brought in by a normal merge commit.
// ---------------------------------------------------------------------------

const short = (sha) => (typeof sha === "string" && sha !== UNKNOWN ? sha.slice(0, 10) : UNKNOWN);
const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const list = (xs, max = 6) => (xs.length > max ? `${xs.slice(0, max).join(", ")}, +${xs.length - max} more` : xs.join(", "));

const TEXT = {
  UNREADABLE_PULL_REQUEST: (d) => `The pull request could not be read strictly, so there is no head to bind anything to (${d.pull.reason}).`,
  PR_MERGED: () => "Merged. After a merge, only branch containment, deployment and a clean tree are worth checking; no full CI re-run.",
  PR_CLOSED: () => "Closed without merging. Nothing to observe.",
  HEAD_MOVED_DURING_READ: (d, h) => `The head moved while it was being read (${short(h)} -> ${short(d.headAfter)}). Read again.`,
  REVIEW_ROUNDS_EXCEEDED: (d) =>
    `${n(d.rounds.streak, "consecutive review round")} raised P0-P2 findings (${d.rounds.heads.map(short).join(", ")}), past the ` +
    `${d.rounds.tier} repair budget of ${d.rounds.budget}. Recommended: stop patching - under §7.4 this is an architecture-review ` +
    "trigger, and the operator decides what comes next.",
  CI_FAILURES_REPEATED: (d) =>
    `The latest ${d.ci.workflow} run failed at ${n(d.ciStreak.streak, "consecutive head")}${d.ciStreak.lowerBound ? " (at least)" : ""} ` +
    `(${d.ciStreak.heads.map(short).join(", ")}), past the ${d.rounds.tier} repair budget of ${d.ciStreak.budget}. Recommended: stop ` +
    "and escalate rather than push one more fix - and first check whether the same failure is red on production, which no PR can repair.",
  PR_DRAFT: () => "The pull request is a draft. Parking a PR is an operator decision; nothing is recommended for a draft.",
  BASE_NOT_PRODUCTION: (d) => `The base is ${d.pull.baseRef}, not production (${d.pull.productionBranch}). A stacked PR is outside this shepherd.`,
  HISTORY_REWRITTEN: () =>
    "A head that a trusted verdict or finding names is no longer in this PR's history: the branch was rewritten after review. " +
    "Exact-head evidence cannot be trusted across that; an operator should decide.",
  REPAIR_BUDGET_UNKNOWN: (d) =>
    "Fresh P0-P2 findings need repair, but the review-round history cannot be read, so the stop law cannot be checked. " +
    `Recommended: no repair until it can (${d.rounds.reason ?? "rounds UNKNOWN"}).`,
  CI_BUDGET_UNKNOWN: (d) =>
    "CI failed, but the run history cannot establish how many heads in a row it has failed, so the stop law cannot be checked. " +
    `Recommended: no fix until it can (${d.ciStreak.reason ?? "history incomplete"}).`,
  RESOLVE_CONFLICTS: (d) =>
    `GitHub reports merge conflicts with production. Recommended: merge origin/${d.branch.production.branch} into the branch with a ` +
    "normal merge commit, resolve the conflicts, and push normally.",
  REPAIR_FINDINGS: (d, h) => {
    const fresh = d.findings.fresh;
    const family =
      fresh.length >= 2
        ? ` Before patching, decide whether these ${fresh.length} share a root-cause family: if they do, stop - §7.4 treats that as an architecture-review trigger, not ${fresh.length} patches.`
        : "";
    return (
      `${n(fresh.length, "unresolved P0-P2 finding")} raised at ${short(h)} by the trusted reviewer: ` +
      `${list(fresh.map((f) => `${f.severity} ${f.path}:${f.line}`))}. Recommended: verify each premise against the head, repair with ` +
      `a new commit on top, then request an exact-head review. Review round ${d.rounds.streak} of a ${d.rounds.tier} budget of ${d.rounds.budget}.${family}`
    );
  },
  FIX_CI: (d, h) =>
    `The latest ${d.ci.workflow} run (${d.ci.run ? d.ci.run.id : UNKNOWN}) failed at ${short(h)}: ${list(d.ci.failed)}. Recommended: check ` +
    "whether the same failure is red on production first - an inherited failure is not this PR's to fix - and otherwise fix it " +
    `with a new commit on top (${n(d.ciStreak.streak, "consecutive red head")} so far, budget ${d.ciStreak.budget}).`,
  DISPOSITION_FINDINGS: (d, h) =>
    `${n(d.findings.carried.length, "unresolved P0-P2 finding")} raised by the trusted reviewer at earlier heads: ` +
    `${list(d.findings.carried.map((f) => `${f.severity} ${f.path}:${f.line} @${short(f.raisedAt)}`))}. Recommended: verify each against ` +
    `${short(h)} by line, reply with that evidence, and resolve that one thread (§7.5). A later clean review does not close it.`,
  RERUN_CI: (d, h) =>
    `The latest ${d.ci.workflow} run at ${short(h)} was cancelled (${list(d.ci.cancelled)}). A cancellation is not a verdict on the code. ` +
    "Recommended: check what the lane completed before it stopped (a budget cut reads like a failure), then re-run it.",
  REQUEST_EXACT_HEAD_REVIEW: (d, h) => {
    const r = d.review;
    const stale = r.lastReviewedHead
      ? ` The last trusted verdict was for ${short(r.lastReviewedHead)}, ${n(r.commitsSinceReview, "commit")} ago` +
        `${r.mergeCommitsSinceReview ? ` (${n(r.mergeCommitsSinceReview, "merge commit")})` : ""}; any new commit makes a verdict stale.`
      : "";
    return (
      `No trusted Codex verdict names ${short(h)}.${stale} Recommended: comment "@codex review" naming \`${short(h)}\`. ` +
      "Whether someone already asked is not inferred; this stays the recommendation until a trusted verdict for this exact head exists."
    );
  },
  REFRESH_PRODUCTION: (d) =>
    `The branch is ${n(d.branch.behindBy, "commit")} behind production (${short(d.branch.production.head)}). Recommended: merge ` +
    `origin/${d.branch.production.branch} with a normal merge commit and push normally; the new head then needs CI and an exact-head review.`,
  WAIT_CI: (d, h) => {
    const c = d.ci;
    if (c.signal === "NOT_STARTED") return `No ${c.workflow} run for a pull request exists at ${short(h)} yet.`;
    const parts = [c.running.length ? `${c.running.length} running: ${list(c.running, 4)}` : "", c.queued.length ? `${c.queued.length} queued: ${list(c.queued, 4)}` : ""];
    const lanes = parts.filter(Boolean).join("; ");
    return `The latest ${c.workflow} run (${c.run.id}) at ${short(h)} is ${c.run.status}${lanes ? `: ${lanes}` : ""}.`;
  },
  WAIT_MERGEABILITY: () => "GitHub has not finished computing mergeability. Read again.",
  CHECK_EXTERNAL: (d, h) =>
    `An external check at ${short(h)} failed: ${list(d.external.failed)}. External checks can only hold a PR back, never pass it. ` +
    "Recommended: inspect it at its provider - the shepherd cannot see why it failed - and, if this PR caused it, fix it with a " +
    "new commit on top; otherwise it is the operator's to route.",
  WAIT_EXTERNAL: (d, h) =>
    `External check(s) at ${short(h)} still pending: ${list(d.external.pending)}. They cannot make the PR a candidate, but candidacy waits for them.`,
};

const NOT_PROVEN = {
  pr: (d) => `the pull request state (${d.pull.reason ?? "unrecognized"})`,
  base: (d) => `that the base is production (${d.pull.reason ?? "unknown"})`,
  snapshot: () => "that the head held still for the whole read",
  branch: (d) => `the branch's position against production (${d.branch.reason ?? "unknown"})`,
  conflicts: (d) => `mergeability (${d.pull.reason ?? "unknown"})`,
  ci: (d) => `CI at this head (${d.ci.reason ?? "not conclusive"})`,
  external: (d) => `that no external check holds this head back (${d.external.reason ?? "unknown"})`,
  review: (d) => `a trusted exact-head review result (${d.review.reason ?? "unknown"})`,
  findings: (d) => `that no actionable finding is open (${d.findings.reason ?? "a trusted finding could not be graded"})`,
  history: (d) => `that the branch history is intact (${d.rounds.reason ?? "unknown"})`,
  rounds: (d) => `the review-round count (${d.rounds.reason ?? "unknown"})`,
  ciStreak: (d) => `the CI failure streak (${d.ciStreak.reason ?? "history does not reach a passing head"})`,
};

function explain(code, detail, head) {
  if (code.startsWith("NOT_PROVEN_")) {
    const key = Object.keys(NOT_PROVEN).find((k) => `NOT_PROVEN_${k.toUpperCase()}` === code);
    return `Cannot establish ${NOT_PROVEN[key](detail)}, so the PR is not a candidate.`;
  }
  return TEXT[code](detail, head);
}

/** Every code `decide` can emit, so a test can hold the catalogue complete. */
export const CODES = Object.freeze([...Object.keys(TEXT), ...Object.keys(NOT_PROVEN).map((k) => `NOT_PROVEN_${k.toUpperCase()}`)]);

const CANDIDATE_TEXT =
  "Every mechanical check holds at this exact head, so this PR is a CANDIDATE for human review. That is advisory: neither green " +
  "CI nor this state authorizes a merge - the operator and the existing release procedure decide.";

/** The whole answer for one read: state, why, what is recommended, and the evidence. */
export function interpret(sf, { now = Date.now(), tier = null, policy = POLICY } = {}) {
  const { signals, detail } = deriveSignals(sf, { tier, policy });
  const d = decide(signals);
  const say = (code) => ({ code, text: explain(code, detail, sf.head) });
  return {
    schema: "hone.eng.shepherd/v2",
    advisory: true,
    repo: sf.repo,
    pr: sf.pr,
    observedAt: new Date(now).toISOString(),
    head: sf.head,
    production: detail.branch.production,
    state: d.state,
    exitCode: EXIT_CODE[d.state],
    summary: d.state === STATE.CANDIDATE_READY_FOR_HUMAN_REVIEW ? CANDIDATE_TEXT : null,
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
  "Observation only: the shepherd reads GitHub and recommends. It never merges, rebases, amends, squashes, force-pushes " +
  "or refreshes a branch, and nothing it reports is authorization - the human release procedure decides.";

export const SHEPHERD_USAGE = `
  npm run eng -- shepherd <pr> [--json] [--tier T0|T1|T2|T3]

Observes a pull request once, at its exact head, and recommends one next step:
CANDIDATE_READY_FOR_HUMAN_REVIEW, WAITING, ACTION_RECOMMENDED, BLOCKED, ESCALATE
or CLOSED (exit 0/10/20/30/40/50). Every state is advisory.
--tier may raise the classifier's baseline tier, never lower it.

${LAW}
`;

export function renderShepherd(result) {
  const s = result.signals;
  const d = result.detail;
  const out = [];
  const row = (label, value, note) => out.push(`  ${label.padEnd(11)}${String(value).padEnd(20)}${DIM}${note}${RESET}`);
  out.push("");
  out.push(`PR #${result.pr}  head ${short(result.head)}  production ${d.branch.production.branch} @ ${short(d.branch.production.head)}  ${DIM}(advisory)${RESET}`);
  row("branch", s.branch, `${d.branch.behindBy} behind, ${d.branch.aheadBy} ahead`);
  const c = d.ci;
  const ciNote = c.run
    ? `latest ${c.workflow} run ${c.run.id}: ${c.run.status}/${c.run.conclusion ?? "-"}` +
      (c.failed.length ? `; failed: ${list(c.failed, 4)}` : c.running.length || c.queued.length ? `; ${c.running.length} running, ${c.queued.length} queued` : "")
    : (c.reason ?? "");
  row("ci", s.ci, ciNote);
  const x = d.external;
  row(
    "external",
    s.external,
    x.failed.length
      ? `failed: ${list(x.failed, 4)}`
      : x.pending.length
        ? `pending: ${list(x.pending, 4)}`
        : x.reason ?? `${x.checks} check run(s), ${x.statuses} status(es) at head; negative-only, never a pass`,
  );
  const rv = d.review;
  const untrusted = rv.untrusted ? rv.untrusted.reviews + rv.untrusted.issueComments + rv.untrusted.inlineComments : 0;
  row(
    "review",
    s.review,
    rv.lastReviewedHead !== undefined
      ? `trusted verdicts at head: ${rv.trustedVerdictsAtHead}${rv.lastReviewedHead ? `; last trusted verdict ${short(rv.lastReviewedHead)}` : ""}` +
          `${untrusted ? `; ${untrusted} comment(s) from untrusted authors ignored` : ""}`
      : rv.reason,
  );
  const f = d.findings;
  row(
    "findings",
    s.findings,
    f.fresh
      ? `unresolved trusted P0-P2: ${f.fresh.length} at head, ${f.carried.length} carried; ${f.minorAtHead} P3 at head` +
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
