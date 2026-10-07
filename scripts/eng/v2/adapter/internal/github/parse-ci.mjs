// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, row 3: strict parsers for workflow runs and their jobs
// (SPEC-05A §3.1–§3.2). One response proves the whole listing, or the listing
// fails closed (CAP-01 §4, §15). A run's mutable `pull_requests` association is
// never read: it is GitHub's current view, not what triggered the run.
// ---------------------------------------------------------------------------

import {
  fail,
  isIsoUtc,
  isNonEmptyString,
  isNonNegInt,
  isObject,
  isPosInt,
  isSha40,
  okRecord,
} from "../../../contract/strict.mjs";

const PAGE = 100;

const isStringOrNull = (v) => v === null || typeof v === "string";

/** REST actions/workflows/{workflowId}/runs?head_sha=H&event=pull_request&per_page=100. */
export function parseWorkflowRuns(raw) {
  if (!isObject(raw) || !isNonNegInt(raw.total_count) || !Array.isArray(raw.workflow_runs)) {
    return fail("malformed", "the run listing is not { total_count, workflow_runs }");
  }
  if (raw.total_count > PAGE) {
    return fail("ci_candidate_listing_too_large", `${raw.total_count} candidate runs do not fit one response`);
  }
  if (raw.total_count !== raw.workflow_runs.length) {
    return fail("malformed", "total_count does not match the runs returned");
  }
  const runs = [];
  const ids = new Set();
  const numbers = new Set();
  for (const r of raw.workflow_runs) {
    if (
      !isObject(r) ||
      !isPosInt(r.id) ||
      !isPosInt(r.run_number) ||
      !isPosInt(r.workflow_id) ||
      !isNonEmptyString(r.event) ||
      !isSha40(r.head_sha) ||
      !isStringOrNull(r.head_branch) ||
      !(r.head_repository === null || (isObject(r.head_repository) && isPosInt(r.head_repository.id))) ||
      !isNonEmptyString(r.status) ||
      !isStringOrNull(r.conclusion) ||
      !isPosInt(r.run_attempt) ||
      !isIsoUtc(r.created_at)
    ) {
      return fail("malformed", "a run does not carry its identity, state and creation time");
    }
    if (ids.has(r.id) || numbers.has(r.run_number)) return fail("malformed", "a run id or run_number repeats");
    ids.add(r.id);
    numbers.add(r.run_number);
    runs.push({
      id: r.id,
      runNumber: r.run_number,
      workflowId: r.workflow_id,
      event: r.event,
      headSha: r.head_sha,
      headBranch: r.head_branch,
      headRepoId: r.head_repository === null ? null : r.head_repository.id,
      status: r.status,
      conclusion: r.conclusion,
      runAttempt: r.run_attempt,
      createdAt: r.created_at,
    });
  }
  return okRecord({ runs });
}

/** REST actions/runs/{runId}/jobs?filter=latest&per_page=100: the latest attempt's jobs. */
export function parseRunJobs(raw, { runId } = {}) {
  if (!isObject(raw) || !isNonNegInt(raw.total_count) || !Array.isArray(raw.jobs)) {
    return fail("malformed", "the job listing is not { total_count, jobs }");
  }
  if (raw.total_count > PAGE) return fail("ci_candidate_listing_too_large", "the jobs do not fit one response");
  if (raw.total_count !== raw.jobs.length) return fail("malformed", "total_count does not match the jobs returned");
  const jobs = [];
  for (const j of raw.jobs) {
    if (!isObject(j) || !isNonEmptyString(j.name) || !isNonEmptyString(j.status) || !isStringOrNull(j.conclusion)) {
      return fail("malformed", "a job does not carry a name, status and conclusion");
    }
    if (j.run_id !== runId) return fail("malformed", "a job belongs to another run");
    jobs.push({ name: j.name, status: j.status, conclusion: j.conclusion });
  }
  return okRecord({ jobs });
}
