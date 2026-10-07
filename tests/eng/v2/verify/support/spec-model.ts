// Independent verifier support: an executable reading of SPEC-05A §2.6 (bindBase),
// §3.3 (requiredJobs) and §3.4 (bindCi, rules 1-10), over the World description.
// It is written from the spec text alone and is used for two things only:
//   1. a self-check that the hand-written scenario table is internally consistent
//      (the unmutated model must reproduce every hand-derived expectation), and
//   2. mutation detection: each flag below is an intentionally UNSAFE deviation,
//      and the scenario table must reject every one of them.
// The implementation under test is never compared against this model directly;
// it is compared against the hand-written expectations.

import {
  CI_DEFINITION_FILES,
  FAILED_CONCLUSIONS,
  JOB,
  PENDING_STATUSES,
  PRODUCTION_REF,
  TARGET_REPO_ID,
  WORKFLOW_ID,
  type RunSpec,
  type World,
} from "./world";

export type Outcome = "SUCCEEDED" | "FAILED" | "PENDING" | "NO_RUN" | "INCOMPLETE";
export type Result = { ok: true; outcome: Outcome; runs: number[] } | { ok: false; reason: string };

export interface Mutations {
  /** (a) any run at the head SHA counts, whatever its workflow, event, repository or branch */
  anyRunAtHead?: boolean;
  /** (b) the activity history (force pushes, deletions, caps) is ignored */
  ignoreActivity?: boolean;
  /** (c) base changes are counted from the unfiltered timeline totalCount */
  useTotalCount?: boolean;
  /** timestamps compared as strings rather than instants */
  stringTimeCompare?: boolean;
  /** `>` instead of `>=` against the earliest applicable run */
  strictlyAfter?: boolean;
  /** only the newest applicable run (highest run_number) is aggregated */
  newestRunOnly?: boolean;
  /** a skipped required job counts as success */
  skippedIsSuccess?: boolean;
  /** rule 5 omitted */
  noSharedHead?: boolean;
  /** rule 4 omitted */
  noBaseRefChanged?: boolean;
  /** the 360-day window omitted */
  noWindow?: boolean;
  /** rule 3 omitted */
  noCiDefinition?: boolean;
  /** an unparseable timestamp is let through, and compared as NaN */
  acceptInvalidTime?: boolean;
}

const DAY = 86_400_000;

export function modelRequiredJobs(c: Record<string, boolean>): string[] {
  const out: string[] = [JOB.changes, JOB.aggregator];
  if (!c.docs_only) out.push(JOB.validate);
  if (c.database || c.security || c.full_matrix_required) out.push(JOB.db);
  if (c.payment || c.full_matrix_required) out.push(JOB.payment);
  if (c.mobile || c.full_matrix_required) out.push(JOB.mobile);
  if (c.google_calendar || c.full_matrix_required) out.push(JOB.google);
  return out.sort();
}

export function specModel(w: World, m: Mutations = {}): Result {
  const fail = (reason: string): Result => ({ ok: false, reason });
  // Parse stage: a timestamp that is not a real instant cannot be ordered, so its
  // parser (§2.5, §3.1 "ISO-8601") must not let it through.
  const instant = (s: string) => !Number.isNaN(Date.parse(s));
  if (!m.acceptInvalidTime) {
    if (!w.runs.every((r) => instant(r.createdAt))) return fail("malformed");
    if (![...w.activity.forcePush, ...w.activity.branchDeletion].every((e) => instant(e.timestamp))) return fail("malformed");
  }
  // Parse stage, §2.1: the compare answer must report the base it was requested with (K0.baseSha).
  // bindBase consumes the parsed record, so this precedes every bindBase rule.
  if ((w.compare.baseSha ?? w.pr.baseSha) !== w.pr.baseSha) return fail("malformed");
  // §2.6 bindBase
  if (w.pr.baseRef !== PRODUCTION_REF) return fail("base_ref");
  const files = w.compare.files;
  const filesCapped = files.length >= 300;
  const baseRefChanges: number | "too_many" = w.prContext.baseRefHasNext
    ? "too_many"
    : m.useTotalCount && w.prContext.timelineTotalCount !== undefined
      ? w.prContext.timelineTotalCount
      : w.prContext.baseRefEvents;
  const associated: number[] | "too_many" = w.prContext.associatedHasNext ? "too_many" : w.prContext.associated;

  // §3.4 rule 1
  if (w.pr.headRepoId !== TARGET_REPO_ID) return fail("fork_head");
  // rule 2
  if (filesCapped || files.length !== w.prContext.changedFiles) return fail("diff_too_large");
  // rule 3
  if (!m.noCiDefinition && files.some((f) => (CI_DEFINITION_FILES as readonly string[]).includes(f)))
    return fail("ci_definition_changed");
  // rule 4
  if (!m.noBaseRefChanged && baseRefChanges !== 0) return fail("base_ref_changed");
  // rule 5
  if (!m.noSharedHead) {
    const numbers = w.headBranchPrs.map((p) => p.number);
    const capped = numbers.length >= 100;
    if (capped || numbers.length !== 1 || numbers[0] !== w.pr.number) return fail("shared_head");
    if (associated === "too_many" || associated.length !== 1 || associated[0] !== w.pr.number)
      return fail("shared_head");
  }
  // rule 6
  if (!(w.rules.includes("non_fast_forward") && w.rules.includes("deletion"))) return fail("base_history_unverified");
  // rule 7
  const applicable = w.runs.filter((r) =>
    m.anyRunAtHead
      ? r.headSha === w.pr.headSha
      : r.workflowId === WORKFLOW_ID &&
        r.event === "pull_request" &&
        r.headSha === w.pr.headSha &&
        r.headRepoId === w.pr.headRepoId &&
        r.headBranch === w.pr.headRef,
  );
  const ids = (rs: RunSpec[]) => rs.map((r) => r.id).sort((a, b) => a - b);
  if (applicable.length === 0) return { ok: true, outcome: "NO_RUN", runs: [] };
  // rule 8
  const at = (s: string) => Date.parse(s);
  const earliest = applicable
    .map((r) => r.createdAt)
    .reduce((a, b) => (m.stringTimeCompare ? (b < a ? b : a) : at(b) < at(a) ? b : a));
  if (!m.noWindow && at(w.observedAt) - at(earliest) > 360 * DAY) return fail("base_history_unverified");
  if (!m.ignoreActivity) {
    if (w.activity.forcePush.length >= 100 || w.activity.branchDeletion.length >= 100)
      return fail("base_history_unverified");
    const after = (t: string) =>
      m.stringTimeCompare
        ? m.strictlyAfter
          ? t > earliest
          : t >= earliest
        : m.strictlyAfter
          ? at(t) > at(earliest)
          : at(t) >= at(earliest);
    if ([...w.activity.forcePush, ...w.activity.branchDeletion].some((e) => after(e.timestamp)))
      return fail("base_history_unverified");
  }
  // rule 9
  const considered = m.newestRunOnly
    ? [applicable.reduce((a, b) => (b.runNumber > a.runNumber ? b : a))]
    : applicable;
  const states: string[] = [];
  for (const r of considered) {
    if (r.status === "completed") {
      if (r.conclusion === null) return fail("malformed");
      if (r.conclusion === "success") states.push("SUCCEEDED");
      else if ((FAILED_CONCLUSIONS as readonly string[]).includes(r.conclusion)) states.push("FAILED");
      else return fail("unrecognized_ci_conclusion");
    } else if ((PENDING_STATUSES as readonly string[]).includes(r.status)) states.push("PENDING");
    else return fail("unrecognized_ci_status");
  }
  // rule 10
  const value = (outcome: Outcome): Result => ({ ok: true, outcome, runs: ids(applicable) });
  if (states.includes("FAILED")) return value("FAILED");
  if (states.includes("PENDING")) return value("PENDING");
  const required = modelRequiredJobs(w.classification);
  let incomplete = false;
  for (const r of considered) {
    const listing = w.jobs[r.id];
    if (listing === undefined) {
      incomplete = true;
      continue;
    }
    if (!Array.isArray(listing)) return fail("ci_candidate_listing_too_large");
    for (const name of required) {
      const named = listing.filter((j) => j.name === name);
      const good = (j: { status: string; conclusion: string | null }) =>
        j.status === "completed" && (j.conclusion === "success" || (m.skippedIsSuccess && j.conclusion === "skipped"));
      if (named.length === 0 || !named.every(good)) incomplete = true;
    }
  }
  return value(incomplete ? "INCOMPLETE" : "SUCCEEDED");
}
