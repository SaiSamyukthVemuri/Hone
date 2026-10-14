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
  /** the PRE-AMENDMENT step 8 (b5f3affb): only rewrites at or after the earliest run count; creation unread (hole A1) */
  oldStep8?: boolean;
  /** branch_creation events are not read */
  ignoreCreation?: boolean;
  /** "at or after" computed as t >= earliest, so an unparseable (NaN) time counts as before */
  geqNotStrict?: boolean;
  /** the PRE-AMENDMENT §2.2 (before 4b0662a2): only BaseRefChangedEvent counts; GitHub's automatic retargeting is missed (R-AUTOBASE) */
  manualBaseChangesOnly?: boolean;
}

/** SPEC §2.2 as amended at 4b0662a2: the three base-change event types. */
export const BASE_CHANGE_TYPES = ["BaseRefChangedEvent", "AutomaticBaseChangeSucceededEvent", "AutomaticBaseChangeFailedEvent"] as const;

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
    const events = [...w.activity.forcePush, ...w.activity.branchDeletion, ...w.activity.branchCreation];
    if (!events.every((e) => instant(e.timestamp))) return fail("malformed");
  }
  // Parse stage, §2.1: the compare answer must report the base it was requested with (K0.baseSha).
  // bindBase consumes the parsed record, so this precedes every bindBase rule.
  if ((w.compare.baseSha ?? w.pr.baseSha) !== w.pr.baseSha) return fail("malformed");
  // Parse stage, §2.2 (amended 4b0662a2): every base-change node is one of the three event types, else malformed.
  const extraBaseEvents = w.prContext.extraBaseEvents ?? [];
  if (extraBaseEvents.some((t) => !(BASE_CHANGE_TYPES as readonly string[]).includes(t))) return fail("malformed");
  const counted = m.manualBaseChangesOnly ? extraBaseEvents.filter((t) => t === "BaseRefChangedEvent").length : extraBaseEvents.length;
  // §2.6 bindBase
  if (w.pr.baseRef !== PRODUCTION_REF) return fail("base_ref");
  const files = w.compare.files;
  const filesCapped = files.length >= 300;
  const baseRefChanges: number | "too_many" = w.prContext.baseRefHasNext
    ? "too_many"
    : m.useTotalCount && w.prContext.timelineTotalCount !== undefined
      ? w.prContext.timelineTotalCount
      : w.prContext.baseRefEvents + counted;
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
    const { forcePush, branchDeletion, branchCreation } = w.activity;
    if (forcePush.length >= 100 || branchDeletion.length >= 100 || (!m.oldStep8 && branchCreation.length >= 100))
      return fail("base_history_unverified");
    // "at or after the earliest applicable run": >= (or > under the strictlyAfter mutant)
    const notBefore = (t: string) =>
      m.stringTimeCompare
        ? m.strictlyAfter
          ? t > earliest
          : t >= earliest
        : m.strictlyAfter
          ? at(t) > at(earliest)
          : m.geqNotStrict
            ? at(t) >= at(earliest)
            : !(at(t) < at(earliest)); // an unparseable time is not "strictly before"
    if (m.oldStep8) {
      if ([...forcePush, ...branchDeletion].some((e) => notBefore(e.timestamp))) return fail("base_history_unverified");
    } else {
      // amended (203ed1f4): any force push or deletion in the listing blocks, whatever its time
      if (forcePush.length > 0 || branchDeletion.length > 0) return fail("base_history_unverified");
      // a creation blocks unless strictly before the earliest applicable created_at
      if (!m.ignoreCreation && branchCreation.some((e) => notBefore(e.timestamp))) return fail("base_history_unverified");
    }
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
  // amended step 10: a SUCCEEDED run with no (complete) job listing -> ci_candidate_listing_too_large
  if (considered.some((r) => !Array.isArray(w.jobs[r.id]))) return fail("ci_candidate_listing_too_large");
  let incomplete = false;
  for (const r of considered) {
    const listing = w.jobs[r.id];
    if (!Array.isArray(listing)) continue;
    for (const name of required) {
      const named = listing.filter((j) => j.name === name);
      const good = (j: { status: string; conclusion: string | null }) =>
        j.status === "completed" && (j.conclusion === "success" || (m.skippedIsSuccess && j.conclusion === "skipped"));
      if (named.length === 0 || !named.every(good)) incomplete = true;
    }
  }
  return value(incomplete ? "INCOMPLETE" : "SUCCEEDED");
}
