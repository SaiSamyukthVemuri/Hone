// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, row 3: applicable CI under the V1 conservative model
// (SPEC-05A §3.3–§3.4). Pure: the observation time is an input.
//
// V1 has no run-side attestation, so a run counts only when GitHub-computed
// evidence proves it tested this PR's head on a production base:
//   * it is the authoritative workflow's pull_request run at K0.headSha, from
//     the PR's own repository and head branch;
//   * that head branch has only ever had this PR, and H is associated with
//     this PR alone;
//   * this PR's base never changed;
//   * production's RECORDED history has no force push or deletion anywhere in
//     the recorded year, and production was created before every applicable
//     run (current rules alone are never treated as history);
//   * required jobs come from production's own classifier, and a PR that
//     changes CI's definition is never evaluated by its own definition.
// The rules apply in a fixed order; the first that fires decides.
// ---------------------------------------------------------------------------

import { fail, isIsoUtc, isObject, isPosInt, okValue } from "../../../contract/strict.mjs";
import {
  isActivityRecord,
  isBaseValue,
  isHeadBranchPrsRecord,
  isJobsByRunId,
  isOpenKey,
  isRulesRecord,
  isRunsRecord,
} from "./shapes.mjs";

/** Job names come from production's ci.yml; a test pins them against it. */
export const REQUIRED_JOB_TABLE = Object.freeze([
  { name: "changed-path detection", when: () => true },
  { name: "browser e2e (local stack)", when: () => true },
  { name: "typecheck / lint / build / test / safety gates", when: (c) => !c.docs_only },
  { name: "db integration (local supabase)", when: (c) => c.database || c.security || c.full_matrix_required },
  { name: "payment browser e2e (fake stripe)", when: (c) => c.payment || c.full_matrix_required },
  { name: "mobile completion e2e (chromium iphone-profile)", when: (c) => c.mobile || c.full_matrix_required },
  { name: "google browser e2e (fake google)", when: (c) => c.google_calendar || c.full_matrix_required },
]);

const CLASSIFICATION_FLAGS = [
  "docs_only",
  "database",
  "security",
  "payment",
  "mobile",
  "google_calendar",
  "full_matrix_required",
];

/** The files whose change would let a PR choose its own required lanes. */
export const CI_DEFINITION_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  "scripts/classify-changes.mjs",
  "scripts/browser-groups.mjs",
]);

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
]);
const PENDING_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/** Recorded production history must cover every applicable run. */
const HISTORY_WINDOW_MS = 360 * 24 * 60 * 60 * 1000;

/**
 * Required job names for one classification. A classification that is not a
 * complete set of boolean flags requires every job: it never narrows the set.
 */
export function requiredJobs(classification) {
  const complete =
    classification !== null &&
    typeof classification === "object" &&
    CLASSIFICATION_FLAGS.every((f) => typeof classification[f] === "boolean");
  return REQUIRED_JOB_TABLE.filter((row) => !complete || row.when(classification) === true).map((row) => row.name);
}

/** The closed run-state table (CI-ATTEST-01 §5's states, applied to each applicable run). */
function runState(run) {
  if (run.status === "completed") {
    if (run.conclusion === "success") return { state: "SUCCEEDED" };
    if (typeof run.conclusion !== "string") return { unknown: "malformed" };
    if (FAILED_CONCLUSIONS.has(run.conclusion)) return { state: "FAILED" };
    return { unknown: "unrecognized_ci_conclusion" };
  }
  if (PENDING_STATUSES.has(run.status)) return { state: "PENDING" };
  return { unknown: "unrecognized_ci_status" };
}

/**
 * SPEC-05A §3.4 step 7: is this run the authoritative workflow's pull_request
 * run at the key's head, from the PR's own repository and head branch? The
 * collector reads jobs for exactly these runs, so the two cannot drift.
 */
export function isApplicableRun(run, key, workflowId) {
  return (
    run.workflowId === workflowId &&
    run.event === "pull_request" &&
    run.headSha === key.headSha &&
    run.headRepoId === key.headRepoId &&
    run.headBranch === key.headRef
  );
}

/** The floor of every required set: what even a docs-only diff requires (SPEC-05A §3.3). */
const ALWAYS_REQUIRED = Object.freeze(
  requiredJobs({
    docs_only: true,
    database: false,
    security: false,
    payment: false,
    mobile: false,
    google_calendar: false,
    full_matrix_required: false,
  }),
);
const TABLE_NAMES = REQUIRED_JOB_TABLE.map((row) => row.name);

/** A required-job set: a non-empty list of distinct table names that includes every always-required job. */
const isRequiredJobNames = (names) =>
  Array.isArray(names) &&
  names.length > 0 &&
  new Set(names).size === names.length &&
  names.every((n) => TABLE_NAMES.includes(n)) &&
  ALWAYS_REQUIRED.every((n) => names.includes(n));

/** SPEC-05A §3.4: every input has its specified shape, or the result is `malformed` before any rule runs. */
function inputsValid({ key, base, headBranchPrs, runs, jobsByRunId, requiredJobNames, rules, activity, observedAt, workflowId, targetRepoId }) {
  return (
    isOpenKey(key) &&
    isBaseValue(base) &&
    isHeadBranchPrsRecord(headBranchPrs) &&
    isRunsRecord(runs) &&
    isJobsByRunId(jobsByRunId) &&
    isRequiredJobNames(requiredJobNames) &&
    isRulesRecord(rules) &&
    isObject(activity) &&
    isActivityRecord(activity.forcePush) &&
    isActivityRecord(activity.branchDeletion) &&
    isActivityRecord(activity.branchCreation) &&
    isIsoUtc(observedAt) &&
    isPosInt(workflowId) &&
    isPosInt(targetRepoId)
  );
}

const onlyThisPr = (list, prNumber) => Array.isArray(list) && list.length === 1 && list[0] === prNumber;

export function bindCi(input) {
  try {
    if (!isObject(input) || !inputsValid(input)) return fail("malformed", "bindCi received an input outside its contract");
    const { key, base, headBranchPrs, runs, jobsByRunId, requiredJobNames, rules, activity, observedAt, workflowId, targetRepoId } =
      input;
    // 1. A fork's head is not a trusted writer in V1.
    if (key.headRepoId !== targetRepoId) return fail("fork_head", "the head repository is not the target repository");

    // 2. The changed files must be provably complete, or the required lanes are unknowable.
    if (base.filesCapped || base.files.length !== base.changedFiles) {
      return fail("diff_too_large", "the changed-file list cannot be proven complete");
    }

    // 3. A PR that changes CI's definition would choose its own required lanes.
    if (base.files.some((f) => CI_DEFINITION_FILES.includes(f))) {
      return fail("ci_definition_changed", "the pull request changes CI's own definition");
    }

    // 4. Any base change, ever: an old run may have tested another base. Recovery is a new PR.
    if (base.baseRefChanges !== 0) return fail("base_ref_changed", "the pull request's base was changed");

    // 5. The head branch and the head commit belong to this PR alone.
    if (
      headBranchPrs.capped ||
      !onlyThisPr(headBranchPrs.numbers, key.prNumber) ||
      !onlyThisPr(base.associatedPrNumbers, key.prNumber)
    ) {
      return fail("shared_head", "another pull request shares this head branch or head commit");
    }

    // 6. Production must prevent rewrites now. This is necessary, never sufficient: history is step 8.
    if (!rules.nonFastForward || !rules.deletion) {
      return fail("base_history_unverified", "production does not currently block force pushes and deletion");
    }

    // 7. Applicable runs; every other run neither grants nor blocks.
    const applicable = runs.runs.filter((r) => isApplicableRun(r, key, workflowId));
    if (applicable.length === 0) return okValue({ outcome: "NO_RUN", applicableRunIds: [] });
    const ids = applicable.map((r) => r.id);

    // 8. Recorded production history. A run's base is fixed when GitHub computes the test
    //    merge, which happens BEFORE the run record exists, so `created_at` cannot bound a
    //    rewrite: any force push or deletion in the recorded year blocks. Production's
    //    creation is benign only when it precedes every applicable run.
    const observed = Date.parse(observedAt);
    const earliest = Math.min(...applicable.map((r) => Date.parse(r.createdAt)));
    if (!Number.isFinite(observed) || !Number.isFinite(earliest)) return fail("malformed", "a time is not a time");
    if (observed - earliest > HISTORY_WINDOW_MS) {
      return fail("base_history_unverified", "a run is older than the recorded production history covers");
    }
    const { forcePush, branchDeletion, branchCreation } = activity;
    if (forcePush.capped || branchDeletion.capped || branchCreation.capped) {
      return fail("base_history_unverified", "production history does not fit one response");
    }
    if (forcePush.events.length !== 0 || branchDeletion.events.length !== 0) {
      return fail("base_history_unverified", "production's recorded year contains a force push or a deletion");
    }
    if (branchCreation.events.some((e) => !(Date.parse(e.timestamp) < earliest))) {
      return fail("base_history_unverified", "production was created at or after an applicable run");
    }

    // 9. Each applicable run's state, from the closed table.
    const states = [];
    for (const r of applicable) {
      const s = runState(r);
      if (s.unknown) return fail(s.unknown, `run ${r.id} is ${r.status}/${r.conclusion}`);
      states.push({ run: r, state: s.state });
    }

    // 10. Every applicable run counts.
    if (states.some((s) => s.state === "FAILED")) return okValue({ outcome: "FAILED", applicableRunIds: ids });
    if (states.some((s) => s.state === "PENDING")) return okValue({ outcome: "PENDING", applicableRunIds: ids });
    for (const { run } of states) {
      const listing = Object.hasOwn(jobsByRunId, run.id) ? jobsByRunId[run.id] : undefined;
      if (listing === undefined) {
        return fail("ci_candidate_listing_too_large", `the jobs of run ${run.id} are not available`);
      }
      for (const name of requiredJobNames) {
        const jobs = listing.jobs.filter((j) => j.name === name);
        if (jobs.length === 0 || jobs.some((j) => j.status !== "completed" || j.conclusion !== "success")) {
          return okValue({ outcome: "INCOMPLETE", applicableRunIds: ids, missingJob: name });
        }
      }
    }
    return okValue({ outcome: "SUCCEEDED", applicableRunIds: ids });
  } catch {
    return fail("malformed", "bindCi received an input outside its contract");
  }
}
