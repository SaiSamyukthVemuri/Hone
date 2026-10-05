#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ENG-LOOP-03: which workflow runs ARE the repository's CI - decided by
// workflow IDENTITY, never by the workflow's path string - and which of them
// is the LATEST EXECUTION.
//
// WHY THIS EXISTS
// A workflow run names its workflow two ways. `path` is documented only as "the
// full path of the workflow", and GitHub's own examples show several forms:
// `.github/workflows/ci.yml`, `.github/workflows/build.yml@main` and
// `octocat/octo-repo/.github/workflows/ci.yml@main`. `workflow_id` is a
// required integer, "the ID of the parent workflow". Matching CI by string
// equality on `path` misses a valid run as soon as GitHub qualifies it, and
// that run then reads as "no CI yet" (the P1 that blocks PR #795).
//
// Normalizing the string instead would mean parsing a format GitHub does not
// specify: a git ref may itself contain "@", and stripping an `owner/repo/`
// prefix would make another repository's ci.yml look exactly like this one.
//
// So identity is the integer. The configured file is resolved ONCE per read -
// GitHub itself turns `ci.yml` into its workflow id - and ONE predicate,
// `isConfiguredRun`, decides membership for every selection.
//
// LATEST MEANS THE LATEST EXECUTION. A re-run keeps its run id and increments
// `run_attempt`, and `run_started_at` "resets on re-run". So an older run
// re-run after a newer one holds the most recent result, and "highest run id"
// would report a stale one - a false GREEN when the re-run failed. Among the
// runs the identity admits, the latest is the one whose latest attempt started
// last; then the higher attempt; then the higher run id, as the final
// deterministic tie-breaker. The same run listed twice - a listing read while
// it changed - resolves to its later attempt, and contradictory copies make the
// answer UNKNOWN. `latestExecution` is that rule, written once; the failure
// streak's selection IS the exact-head selection, applied to each head, so the
// two cannot drift apart. A run's `path` is carried for display only.
//
// FAILS CLOSED. A workflow override that is not a complete file + event, an
// identity that cannot be read or reads malformed, an applicable run without a
// usable attempt, start time, status or conclusion: each is UNKNOWN, and so is
// every selection made with it. "Could not tell which runs are CI" is never
// reported as "no CI run exists", and no input makes this module throw.
//
// READ-ONLY. One GET through the injected fetcher. Nothing here writes, merges,
// polls, waits or retries, and it reads no check runs or commit statuses -
// external checks are a separate signal and stay out of CI's identity.
// ---------------------------------------------------------------------------

import { AUTHORIZED, COMPLETE, UNKNOWN, evidence, mayAssertPositive } from "./evidence.mjs";

export { UNKNOWN };

/** The repository's CI: the pull-request workflow's file, and the event that runs it. */
export const CI_WORKFLOW = Object.freeze({ file: ".github/workflows/ci.yml", event: "pull_request" });

/** A workflow file GitHub runs: directly under .github/workflows/, .yml or .yaml, never ref-qualified. */
const WORKFLOW_FILE = /^\.github\/workflows\/[^/\s@]+\.ya?ml$/;
/** A GitHub event name: lowercase words joined by underscores (`pull_request`, `workflow_dispatch`). */
const EVENT_NAME = /^[a-z]+(?:_[a-z]+)*$/;
/** GitHub's timestamp form: UTC, to the second, with an optional fraction. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const isStr = (v) => typeof v === "string";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isTime = (v) => isStr(v) && TIMESTAMP.test(v) && Number.isFinite(Date.parse(v));
const isEvent = (v) => isStr(v) && EVENT_NAME.test(v);
const unknown = (reason) => evidence(UNKNOWN, { completeness: UNKNOWN, authority: UNKNOWN, reason });
const known = (value, reason) => evidence(value, { completeness: COMPLETE, authority: AUTHORIZED, reason });

/** A complete workflow configuration: a runnable workflow file, and the event that runs it. */
const isWorkflowConfig = (w) => isObject(w) && isStr(w.file) && WORKFLOW_FILE.test(w.file) && isEvent(w.event);
/** An identity as `resolveWorkflowIdentity` produces it. */
const isIdentity = (v) => isObject(v) && isId(v.id) && isEvent(v.event);
const usableIdentity = (identity) => mayAssertPositive(identity) && isIdentity(identity.value);

/**
 * The configured workflow's stable identity, from ONE read of
 * `actions/workflows/<file name>` - GitHub answers that endpoint for a file
 * name as well as for an id. A workflow override is validated in full BEFORE
 * any request, and anything but an answer carrying a positive integer `id` is
 * UNKNOWN. Never throws.
 */
export function resolveWorkflowIdentity(input) {
  const { fetcher, workflow = CI_WORKFLOW } = isObject(input) ? input : {};
  if (typeof fetcher !== "function") return unknown("no fetcher to resolve the workflow with");
  if (!isWorkflowConfig(workflow)) {
    return unknown("the workflow is not a complete configuration: a .github/workflows/<name>.yml file and an event name");
  }
  const name = workflow.file.slice(workflow.file.lastIndexOf("/") + 1);
  let res;
  try {
    res = fetcher(`repos/{repo}/actions/workflows/${encodeURIComponent(name)}`);
  } catch (err) {
    return unknown(`${workflow.file} could not be resolved: ${String(err?.message ?? err)}`);
  }
  if (!res || res.ok !== true) return unknown(`${workflow.file} could not be resolved: ${res?.reason ?? "no answer"}`);
  if (!isObject(res.data) || !isId(res.data.id)) return unknown(`${workflow.file} resolved to no usable workflow id`);
  const identity = Object.freeze({ id: res.data.id, event: workflow.event, file: workflow.file });
  return known(identity, `${workflow.file} is workflow ${identity.id}`);
}

/**
 * What PLACES a run - which run, workflow, event and commit. Every run handed
 * in must carry these, or it cannot even be told apart from the CI workflow.
 */
function placeRun(r) {
  // Any string event places a run: only the CONFIGURED event is held to GitHub's name form.
  if (!isObject(r) || !isId(r.id) || !isId(r.workflow_id) || !isStr(r.event) || !isSha(r.head_sha)) return null;
  return Object.freeze({ id: r.id, workflowId: r.workflow_id, event: r.event, headSha: r.head_sha, raw: r });
}

/**
 * What an APPLICABLE run must also carry: its latest attempt, when that
 * attempt started, and its state. Asked only of the runs the identity admits,
 * so an unrelated run's fields can never affect the answer.
 */
function projectExecution(p) {
  const r = p.raw;
  if (!isId(r.run_attempt) || !isTime(r.run_started_at)) return null;
  if (!isStr(r.status) || !(r.conclusion === null || isStr(r.conclusion))) return null;
  return Object.freeze({
    id: p.id,
    workflowId: p.workflowId,
    event: p.event,
    headSha: p.headSha,
    attempt: r.run_attempt,
    startedAt: r.run_started_at,
    status: r.status,
    conclusion: r.conclusion,
    // Display only. Its form varies, so no decision may read it.
    path: isStr(r.path) ? r.path : null,
  });
}

/** THE identity rule - the only place a run is matched to the configured workflow. */
export function isConfiguredRun(run, identity) {
  return run.workflowId === identity.id && run.event === identity.event;
}

/** Recency of an EXECUTION: when its latest attempt started, then its attempt number, then its run id. */
function isNewer(a, b) {
  const ta = Date.parse(a.startedAt);
  const tb = Date.parse(b.startedAt);
  if (ta !== tb) return ta > tb;
  if (a.attempt !== b.attempt) return a.attempt > b.attempt;
  return a.id > b.id;
}

/**
 * THE selection rule: among the placed runs the identity admits, the latest
 * EXECUTION, in any listing order. Returns `{ run }` (null when none applies),
 * or `{ reason }` when the runs cannot decide it.
 */
export function latestExecution(placed, identity) {
  const byRun = new Map();
  for (const p of placed) {
    if (!isConfiguredRun(p, identity)) continue;
    const e = projectExecution(p);
    if (!e) return { reason: `run ${p.id} carries no usable attempt, start time, status or conclusion` };
    const seen = byRun.get(e.id);
    if (!seen) {
      byRun.set(e.id, e);
      continue;
    }
    // The same run listed twice: a listing read while the run changed.
    const [lo, hi] = seen.attempt <= e.attempt ? [seen, e] : [e, seen];
    if (lo.attempt === hi.attempt) {
      const same = lo.startedAt === hi.startedAt && lo.status === hi.status && lo.conclusion === hi.conclusion;
      if (!same) return { reason: `run ${e.id} attempt ${e.attempt} was read twice in different states` };
      continue;
    }
    if (Date.parse(hi.startedAt) < Date.parse(lo.startedAt)) {
      return { reason: `run ${e.id}: attempt ${hi.attempt} started before attempt ${lo.attempt}` };
    }
    byRun.set(e.id, hi);
  }
  let latest = null;
  for (const e of byRun.values()) {
    if (latest === null || isNewer(e, latest)) latest = e;
  }
  return { run: latest };
}

/**
 * Exact-head CI: the latest execution of the configured workflow AT this head,
 * which stays the Actions authority for it. Every run handed in must be
 * placeable and must name this head - a run listed for one sha that names
 * another is a wrong answer, not a run to skip. Never throws.
 */
export function selectHeadRun(input) {
  const { identity, runs, head } = isObject(input) ? input : {};
  if (!usableIdentity(identity)) return unknown(`no workflow identity: ${identity?.reason ?? "not resolved"}`);
  if (!isSha(head)) return unknown("the head is not a commit sha");
  if (!Array.isArray(runs)) return unknown("no run listing for this head");
  const placed = runs.map(placeRun);
  if (!placed.every(Boolean)) return unknown("a run at this head has no usable id, workflow_id, event or head sha");
  if (placed.some((p) => p.headSha !== head)) return unknown("a run listed for this head names another commit");
  const { run, reason } = latestExecution(placed, identity.value);
  if (reason) return unknown(reason);
  const { id, event } = identity.value;
  return known(run, run ? `run ${run.id} attempt ${run.attempt} of workflow ${id}` : `no ${event} run of workflow ${id} at this head`);
}

/**
 * The failure streak's selection: for each head, in the order given (newest
 * first), the latest execution at that head - computed BY `selectHeadRun`, so
 * the streak and the exact-head CI share one rule by construction. Any head
 * that cannot be decided makes the whole selection UNKNOWN. Never throws.
 */
export function selectStreakRuns(input) {
  const { identity, runs, heads } = isObject(input) ? input : {};
  if (!usableIdentity(identity)) return unknown(`no workflow identity: ${identity?.reason ?? "not resolved"}`);
  if (!Array.isArray(heads) || !heads.every(isSha)) return unknown("the heads are not commit shas");
  if (!Array.isArray(runs)) return unknown("no run history");
  const placed = runs.map(placeRun);
  if (!placed.every(Boolean)) return unknown("a run in the history has no usable id, workflow_id, event or head sha");
  const out = [];
  for (const head of heads) {
    const at = selectHeadRun({ identity, runs: runs.filter((_, i) => placed[i].headSha === head), head });
    if (!mayAssertPositive(at)) return unknown(`head ${head.slice(0, 10)}: ${at.reason}`);
    out.push(Object.freeze({ head, run: at.value }));
  }
  return known(out, `${out.length} head(s) by workflow ${identity.value.id}`);
}
