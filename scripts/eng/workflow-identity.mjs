#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ENG-LOOP-03: which workflow runs ARE the repository's CI - decided by
// workflow IDENTITY, never by the workflow's path string.
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
// `isConfiguredRun`, decides membership for every selection. The failure
// streak's selection IS the exact-head selection, applied to each head, so the
// two cannot drift apart. A run's `path` is carried for display only; no
// decision reads it.
//
// FAILS CLOSED. An identity that cannot be read, or reads malformed, is
// UNKNOWN, and so is every selection made with it: "could not tell which runs
// are CI" is never reported as "no CI run exists". A run without a usable
// `workflow_id` cannot be placed, so the collection holding it is UNKNOWN too.
//
// READ-ONLY. One GET through the injected fetcher. Nothing here writes, merges,
// polls, waits or retries, and it reads no check runs or commit statuses -
// external checks are a separate signal and stay out of CI's identity.
// ---------------------------------------------------------------------------

import { AUTHORIZED, COMPLETE, UNKNOWN, evidence, mayAssertPositive } from "./evidence.mjs";

export { UNKNOWN };

/** The repository's CI: the pull-request workflow's file, and the event that runs it. */
export const CI_WORKFLOW = Object.freeze({ file: ".github/workflows/ci.yml", event: "pull_request" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const isStr = (v) => typeof v === "string";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const unknown = (reason) => evidence(UNKNOWN, { completeness: UNKNOWN, authority: UNKNOWN, reason });
const known = (value, reason) => evidence(value, { completeness: COMPLETE, authority: AUTHORIZED, reason });

/**
 * The configured workflow's stable identity, from ONE read of
 * `actions/workflows/<file name>` - GitHub answers that endpoint for a file
 * name as well as for an id. Anything but an answer carrying a positive
 * integer `id` is UNKNOWN.
 */
export function resolveWorkflowIdentity({ fetcher, workflow = CI_WORKFLOW }) {
  const name = workflow.file.split("/").pop();
  const res = fetcher(`repos/{repo}/actions/workflows/${encodeURIComponent(name)}`);
  if (!res || res.ok !== true) return unknown(`${workflow.file} could not be resolved: ${res?.reason ?? "no answer"}`);
  if (!isObject(res.data) || !isId(res.data.id)) return unknown(`${workflow.file} resolved to no usable workflow id`);
  const identity = Object.freeze({ id: res.data.id, event: workflow.event, file: workflow.file });
  return known(identity, `${workflow.file} is workflow ${identity.id}`);
}

/** The fields a selection reads, checked. Null when the run cannot be placed. */
function projectRun(r) {
  if (!isObject(r) || !isId(r.id) || !isId(r.workflow_id) || !isSha(r.head_sha)) return null;
  if (!isStr(r.event) || !isStr(r.status) || !(r.conclusion === null || isStr(r.conclusion))) return null;
  return Object.freeze({
    id: r.id,
    workflowId: r.workflow_id,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    headSha: r.head_sha,
    // Display only. Its form varies, so no decision may read it.
    path: isStr(r.path) ? r.path : null,
  });
}

function projectAll(runs) {
  if (!Array.isArray(runs)) return null;
  const out = runs.map(projectRun);
  return out.every(Boolean) ? out : null;
}

/** THE identity rule - the only place a run is matched to the configured workflow. */
export function isConfiguredRun(run, identity) {
  return run.workflowId === identity.id && run.event === identity.event;
}

/** The latest (highest-id) run the rule admits, in any listing order; null when it admits none. */
export function latestApplicableRun(runs, identity) {
  let latest = null;
  for (const r of runs) {
    if (isConfiguredRun(r, identity) && (latest === null || r.id > latest.id)) latest = r;
  }
  return latest;
}

/**
 * Exact-head CI: the latest applicable run AT this head, which stays the
 * Actions authority for it. Every run handed in must be well-formed and must
 * name this head - a run listed for one sha that names another is a wrong
 * answer, not a run to skip.
 */
export function selectHeadRun({ identity, runs, head }) {
  if (!mayAssertPositive(identity)) return unknown(`no workflow identity: ${identity?.reason ?? "not resolved"}`);
  if (!isSha(head)) return unknown("the head is not a commit sha");
  const projected = projectAll(runs);
  if (!projected) return unknown("a run at this head is malformed or carries no usable workflow_id");
  if (projected.some((r) => r.headSha !== head)) return unknown("a run listed for this head names another commit");
  const { id, event } = identity.value;
  const run = latestApplicableRun(projected, identity.value);
  return known(run, run ? `run ${run.id} of workflow ${id}` : `no ${event} run of workflow ${id} at this head`);
}

/**
 * The failure streak's selection: for each head, in the order given (newest
 * first), the latest applicable run at that head - computed BY `selectHeadRun`,
 * so the streak and the exact-head CI share one identity rule by construction.
 * Any head that cannot be decided makes the whole selection UNKNOWN.
 */
export function selectStreakRuns({ identity, runs, heads }) {
  if (!mayAssertPositive(identity)) return unknown(`no workflow identity: ${identity?.reason ?? "not resolved"}`);
  if (!Array.isArray(heads) || !heads.every(isSha)) return unknown("the heads are not commit shas");
  const projected = projectAll(runs);
  if (!projected) return unknown("a run in the history is malformed or carries no usable workflow_id");
  const out = [];
  for (const head of heads) {
    const at = selectHeadRun({ identity, runs: runs.filter((_, i) => projected[i].headSha === head), head });
    if (!mayAssertPositive(at)) return unknown(`head ${head.slice(0, 10)}: ${at.reason}`);
    out.push(Object.freeze({ head, run: at.value }));
  }
  return known(out, `${out.length} head(s) by workflow ${identity.value.id}`);
}
