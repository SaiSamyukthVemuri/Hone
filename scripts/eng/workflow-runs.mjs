#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ENG-LOOP-04: canonical workflow-run snapshot reconciliation.
//
// WHY THIS EXISTS
// The latest execution of the CI workflow at a head is read from a LISTING of
// workflow runs, and a listing is a snapshot of state that changes while it is
// read. A re-run keeps its run id and increments `run_attempt`
// ("run_started_at ... resets on re-run"), and a page read while runs move can
// show one run more than once, in different states. ENG-LOOP-03 (#798, parked)
// reconciled such copies pairwise, against whichever copy currently looked
// newest, so a contradiction between OLDER copies could be hidden - and whether
// the answer failed closed depended on the order GitHub listed them in.
//
// THE ARCHITECTURE (operator decision): canonicalize the WHOLE set, then select.
//
//   1. Group every snapshot by its run id.
//   2. Every run's copies must agree on what the run IS - its workflow, event
//      and commit - or the listing cannot be trusted at all.
//   3. For each CI run (a `pull_request` run of the given workflow id), ALL of
//      its copies are validated before any is used: copies of one attempt must
//      be identical, and no attempt may start before an earlier attempt. Only a
//      run consistent as a whole yields ONE canonical latest attempt - its
//      highest attempt number.
//   4. Across DIFFERENT runs, only when each run's latest attempt started orders
//      them. A run id is identity, never recency; attempt numbers are never
//      compared across runs; a latest start shared by more than one run is
//      UNKNOWN, because no documented field orders them.
//
// Every step is a function of the MULTISET of snapshots, never of their order:
// grouping, iteration in run-id and attempt order, and checks that do not
// depend on which copy came first. tests/eng/workflow-runs.test.ts evaluates
// every permutation of each multiset and requires one identical answer.
//
// Exact-head CI and the failure streak share this ONE canonical result: both
// reconcile with `canonicalize` and pick with `latestOf`. The streak
// canonicalizes the whole history at once, so a run whose copies disagree
// across heads is caught, not split between them.
//
// SCOPE. Which workflow is CI is decided elsewhere - ENG-LOOP-03 resolves the
// configured file to its workflow id and owns event authorization - so this
// module takes that id and reconciles the `pull_request` runs of it. Runs of
// other workflows or events never contribute: only what they ARE must be
// consistent, and their attempts, start times and states are never read.
//
// FAILS CLOSED and is PURE: no I/O, no network, no clock, no timers. Anything
// it cannot place, any contradiction, any tie at the top is UNKNOWN - never
// "no CI run" - and no input makes it throw.
// ---------------------------------------------------------------------------

import { AUTHORIZED, COMPLETE, UNKNOWN, evidence } from "./evidence.mjs";

export { UNKNOWN };

/** The event that runs the repository's CI. */
export const CI_EVENT = "pull_request";

/** GitHub's timestamp form: UTC, to the second, with an optional fraction. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const isStr = (v) => typeof v === "string";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const instant = (v) => (isStr(v) && TIMESTAMP.test(v) ? Date.parse(v) : NaN);
const ascending = (a, b) => a - b;
const unknown = (reason) => evidence(UNKNOWN, { completeness: UNKNOWN, authority: UNKNOWN, reason });
const known = (value, reason) => evidence(value, { completeness: COMPLETE, authority: AUTHORIZED, reason });

/** What PLACES a snapshot: the run, workflow, event and commit it belongs to. */
const placeable = (s) => isObject(s) && isId(s.id) && isId(s.workflow_id) && isStr(s.event) && isSha(s.head_sha);

/** One attempt as a snapshot shows it, or null when the snapshot cannot say. */
function attemptOf(s) {
  const at = instant(s.run_started_at);
  if (!isId(s.run_attempt) || !Number.isFinite(at)) return null;
  if (!isStr(s.status) || !(s.conclusion === null || isStr(s.conclusion))) return null;
  return { attempt: s.run_attempt, at, status: s.status, conclusion: s.conclusion };
}

const sameState = (a, b) => a.at === b.at && a.status === b.status && a.conclusion === b.conclusion;

/**
 * THE CANONICALIZATION. Groups every snapshot by run id and validates each run
 * as a WHOLE before anything is selected. Returns `{ executions }` - one
 * canonical latest attempt per CI run, in run-id order - or `{ reason }`. A
 * function of the multiset alone: no part of the answer depends on listing
 * order. Expects placeable snapshots; the selectors check that first.
 */
export function canonicalize(snapshots, workflowId) {
  const byRun = new Map();
  for (const s of snapshots) {
    if (!byRun.has(s.id)) byRun.set(s.id, []);
    byRun.get(s.id).push(s);
  }
  const executions = [];
  for (const id of [...byRun.keys()].sort(ascending)) {
    const copies = byRun.get(id);
    const [first] = copies;
    // What the run IS must not depend on which copy is read.
    if (copies.some((c) => c.workflow_id !== first.workflow_id || c.event !== first.event || c.head_sha !== first.head_sha)) {
      return { reason: `run ${id}: its copies disagree on its workflow, event or commit` };
    }
    // Only CI runs are reconciled further; another workflow's or event's attempts never enter the answer.
    if (first.workflow_id !== workflowId || first.event !== CI_EVENT) continue;

    // The WHOLE run, before any of it is used: every copy usable, every
    // attempt's copies identical, every attempt no earlier than the one before.
    const states = copies.map(attemptOf);
    if (states.some((a) => a === null)) {
      return { reason: `run ${id}: a copy carries no usable attempt, start time, status or conclusion` };
    }
    const attempts = [...new Set(states.map((a) => a.attempt))].sort(ascending);
    const timeline = [];
    for (const n of attempts) {
      const copiesOfN = states.filter((a) => a.attempt === n);
      if (copiesOfN.some((a) => !sameState(a, copiesOfN[0]))) {
        return { reason: `run ${id}: attempt ${n} was read in conflicting states` };
      }
      timeline.push(copiesOfN[0]);
    }
    for (let i = 1; i < timeline.length; i++) {
      if (timeline[i].at < timeline[i - 1].at) {
        return { reason: `run ${id}: attempt ${timeline[i].attempt} started before attempt ${timeline[i - 1].attempt}` };
      }
    }
    const latest = timeline[timeline.length - 1];
    executions.push(
      Object.freeze({
        id,
        workflowId: first.workflow_id,
        event: first.event,
        headSha: first.head_sha,
        attempt: latest.attempt,
        startedAt: new Date(latest.at).toISOString(),
        status: latest.status,
        conclusion: latest.conclusion,
      }),
    );
  }
  return { executions };
}

/**
 * Across DIFFERENT runs: the one whose latest attempt started last. A run id
 * never orders runs, an attempt number never crosses runs, and a latest start
 * shared by more than one run is UNKNOWN. `{ execution }` (null when there is
 * none) or `{ reason }`.
 */
export function latestOf(executions) {
  let top = -Infinity;
  for (const e of executions) top = Math.max(top, Date.parse(e.startedAt));
  const atTop = executions.filter((e) => Date.parse(e.startedAt) === top);
  if (atTop.length === 0) return { execution: null };
  if (atTop.length > 1) {
    return { reason: `runs ${atTop.map((e) => e.id).join(", ")} all started at ${atTop[0].startedAt}; nothing documented orders them` };
  }
  return { execution: atTop[0] };
}

/**
 * Exact-head CI: the canonical latest execution of the CI workflow AT this
 * head - the Actions authority for it. Every snapshot must be placeable and
 * must name this head. Never throws.
 */
export function selectHeadExecution(input) {
  const { snapshots, head, workflowId } = isObject(input) ? input : {};
  if (!isId(workflowId)) return unknown("no usable CI workflow id");
  if (!isSha(head)) return unknown("the head is not a commit sha");
  if (!Array.isArray(snapshots)) return unknown("no run listing for this head");
  if (!snapshots.every(placeable)) return unknown("a snapshot has no usable run id, workflow_id, event or head sha");
  if (snapshots.some((s) => s.head_sha !== head)) return unknown("a snapshot listed for this head names another commit");
  const canonical = canonicalize(snapshots, workflowId);
  if (canonical.reason) return unknown(canonical.reason);
  const pick = latestOf(canonical.executions);
  if (pick.reason) return unknown(pick.reason);
  const e = pick.execution;
  return known(e, e ? `run ${e.id} attempt ${e.attempt} of workflow ${workflowId}` : `no ${CI_EVENT} run of workflow ${workflowId} at this head`);
}

/**
 * The failure streak's selection: the WHOLE history canonicalized at once,
 * then, for each head in the order given (newest first), its latest execution
 * by `latestOf` - the same canonical result exact-head CI uses. Any head that
 * cannot be decided makes the whole selection UNKNOWN. Never throws.
 */
export function selectStreakExecutions(input) {
  const { snapshots, heads, workflowId } = isObject(input) ? input : {};
  if (!isId(workflowId)) return unknown("no usable CI workflow id");
  if (!Array.isArray(heads) || !heads.every(isSha)) return unknown("the heads are not commit shas");
  if (!Array.isArray(snapshots)) return unknown("no run history");
  if (!snapshots.every(placeable)) return unknown("a snapshot has no usable run id, workflow_id, event or head sha");
  const canonical = canonicalize(snapshots, workflowId);
  if (canonical.reason) return unknown(canonical.reason);
  const out = [];
  for (const head of heads) {
    const pick = latestOf(canonical.executions.filter((e) => e.headSha === head));
    if (pick.reason) return unknown(`head ${head.slice(0, 10)}: ${pick.reason}`);
    out.push(Object.freeze({ head, execution: pick.execution }));
  }
  return known(out, `${out.length} head(s) of workflow ${workflowId}`);
}
