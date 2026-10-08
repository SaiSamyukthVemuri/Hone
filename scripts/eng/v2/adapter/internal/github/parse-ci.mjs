// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, row 3: strict parsers for workflow runs and their jobs
// (SPEC-05A §3.1–§3.2). One response proves the whole listing, or the listing
// fails closed (CAP-01 §4, §15): a count that is over the page or differs from
// what came back is `ci_candidate_listing_too_large`, and a schema violation is
// `malformed`, which wins. Records come out in a canonical order, so any
// reordering of the same answer normalizes to the same listing (CAP-01 L7).
// A run's mutable `pull_requests` association is never read: it is GitHub's
// current view, not what triggered the run.
// ---------------------------------------------------------------------------

import {
  fail,
  guarded,
  isIsoUtc,
  isNonEmptyString,
  isNonNegInt,
  isObject,
  isPosInt,
  isSha40,
  okRecord,
  requested,
} from "../../../contract/strict.mjs";

const PAGE = 100;

const isStringOrNull = (v) => v === null || typeof v === "string";

/** Is the listing provably the whole set, in this one response? */
const complete = (totalCount, returned) => totalCount <= PAGE && totalCount === returned;

/** REST actions/workflows/{workflowId}/runs?head_sha=H&event=pull_request&per_page=100. */
export const parseWorkflowRuns = guarded((raw) => {
  if (!isObject(raw) || !isNonNegInt(raw.total_count) || !Array.isArray(raw.workflow_runs)) {
    return fail("malformed", "the run listing is not { total_count, workflow_runs }");
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
      typeof r.status !== "string" ||
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
      // Any string: an unknown status is the binder's `unrecognized_ci_status`, never a parse failure.
      status: r.status,
      conclusion: r.conclusion,
      runAttempt: r.run_attempt,
      createdAt: r.created_at,
    });
  }
  if (!complete(raw.total_count, raw.workflow_runs.length)) {
    return fail(
      "ci_candidate_listing_too_large",
      `${raw.total_count} candidate runs are not provably the ${raw.workflow_runs.length} returned in one response`,
    );
  }
  // run_number is unique (checked above), so this order is total.
  runs.sort((a, b) => a.runNumber - b.runNumber);
  return okRecord({ runs });
});

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const conclusionKey = (c) => (c === null ? "" : `=${c}`);

/** REST actions/runs/{runId}/jobs?filter=latest&per_page=100: the latest attempt's jobs. */
export const parseRunJobs = guarded((raw, opts) => {
  const runId = requested(opts, "runId", isPosInt);
  if (runId === undefined) return fail("malformed", "the requested run id is required");
  if (!isObject(raw) || !isNonNegInt(raw.total_count) || !Array.isArray(raw.jobs)) {
    return fail("malformed", "the job listing is not { total_count, jobs }");
  }
  const jobs = [];
  for (const j of raw.jobs) {
    if (!isObject(j) || !isNonEmptyString(j.name) || typeof j.status !== "string" || !isStringOrNull(j.conclusion)) {
      return fail("malformed", "a job does not carry a name, status and conclusion");
    }
    if (j.run_id !== runId) return fail("malformed", "a job belongs to another run");
    jobs.push({ name: j.name, status: j.status, conclusion: j.conclusion });
  }
  if (!complete(raw.total_count, raw.jobs.length)) {
    return fail("ci_candidate_listing_too_large", "the jobs are not provably complete in one response");
  }
  // Every projected field takes part, so records that tie are identical and the order is canonical.
  jobs.sort(
    (a, b) =>
      byString(a.name, b.name) ||
      byString(a.status, b.status) ||
      byString(conclusionKey(a.conclusion), conclusionKey(b.conclusion)),
  );
  return okRecord({ jobs });
});
