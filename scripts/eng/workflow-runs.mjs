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
// INPUT IS EVIDENCE TOO. A collection is read index by index and must be a
// DENSE array - a hole is not a snapshot, and `every` would silently skip it -
// and a start time must be a REAL calendar instant in GitHub's documented form
// ("All timestamps return in UTC time, ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ"):
// `Date.parse` alone turns `2026-02-30` into March 2, so each parsed instant
// must give back exactly the calendar fields it was written with.
//
// FAILS CLOSED and is PURE: no I/O, no network, no clock, no timers. Anything
// it cannot place, any contradiction, any tie at the top is UNKNOWN - never
// "no CI run" - and no input makes it throw.
// ---------------------------------------------------------------------------

import { AUTHORIZED, COMPLETE, UNKNOWN, evidence } from "./evidence.mjs";

export { UNKNOWN };

/** The event that runs the repository's CI. */
export const CI_EVENT = "pull_request";

/** GitHub's returned-timestamp form: UTC (`Z`, no offset), to the second, with an optional fraction. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const isStr = (v) => typeof v === "string";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A REAL calendar instant in milliseconds, or NaN. The form is necessary but
 * not sufficient: the instant built from the fields must give back exactly
 * those fields, so February 30, a 13th month, day 00, hour 24 or second 60 -
 * all of which date arithmetic would quietly roll over - are NaN.
 */
function instant(v) {
  const m = isStr(v) ? TIMESTAMP.exec(v) : null;
  if (!m) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const real =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  if (!real) return NaN;
  return date.getTime() + (m[7] ? Math.floor(Number(`0${m[7]}`) * 1000) : 0);
}

/**
 * The entries of a DENSE array, read index by index - or null for anything
 * else: not an array, or an array with a hole. `every` and `for...of` would
 * skip or invent entries for holes; this never does.
 */
function denseEntries(xs) {
  if (!Array.isArray(xs)) return null;
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(xs, i)) return null;
    out.push(xs[i]);
  }
  return out;
}
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
 * order. It re-checks its own input, so it never handles a hole or an
 * unplaceable snapshot whoever calls it.
 */
export function canonicalize(snapshots, workflowId) {
  const list = denseEntries(snapshots);
  if (list === null) return { reason: "the snapshots are not a dense array" };
  for (let i = 0; i < list.length; i++) {
    if (!placeable(list[i])) return { reason: "a snapshot has no usable run id, workflow_id, event or head sha" };
  }
  const byRun = new Map();
  for (const s of list) {
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
  const list = denseEntries(executions);
  if (list === null) return { reason: "the executions are not a dense array" };
  let top = -Infinity;
  for (const e of list) top = Math.max(top, Date.parse(e.startedAt));
  const atTop = list.filter((e) => Date.parse(e.startedAt) === top);
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
  const list = denseEntries(snapshots);
  if (list === null) return unknown("the run listing for this head is not a dense array");
  for (let i = 0; i < list.length; i++) {
    if (!placeable(list[i])) return unknown("a snapshot has no usable run id, workflow_id, event or head sha");
  }
  for (let i = 0; i < list.length; i++) {
    if (list[i].head_sha !== head) return unknown("a snapshot listed for this head names another commit");
  }
  const canonical = canonicalize(list, workflowId);
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
  const headList = denseEntries(heads);
  if (headList === null) return unknown("the heads are not a dense array");
  for (let i = 0; i < headList.length; i++) {
    if (!isSha(headList[i])) return unknown("the heads are not commit shas");
  }
  const list = denseEntries(snapshots);
  if (list === null) return unknown("the run history is not a dense array");
  for (let i = 0; i < list.length; i++) {
    if (!placeable(list[i])) return unknown("a snapshot has no usable run id, workflow_id, event or head sha");
  }
  const canonical = canonicalize(list, workflowId);
  if (canonical.reason) return unknown(canonical.reason);
  const out = [];
  for (const head of headList) {
    const pick = latestOf(canonical.executions.filter((e) => e.headSha === head));
    if (pick.reason) return unknown(`head ${head.slice(0, 10)}: ${pick.reason}`);
    out.push(Object.freeze({ head, execution: pick.execution }));
  }
  return known(out, `${out.length} head(s) of workflow ${workflowId}`);
}
