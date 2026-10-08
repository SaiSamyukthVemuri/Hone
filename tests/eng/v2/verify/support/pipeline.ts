/* eslint-disable @typescript-eslint/no-explicit-any -- records cross between the functions under test untyped */
// Independent verifier support: World -> raw GitHub answers -> the REAL parsers ->
// the REAL binders. The verifier never builds a normalized record itself: every
// record bindBase/bindCi receive was produced by the implementation's own parser.
//
// COMPOSITION, from SPEC-05A §3.4 "Inputs" (amended at 203ed1f4):
//   base            = bindBase(...).value                         (§2.6 value)
//   headBranchPrs   = parseHeadBranchPrs(...).record              (§2.3 record)
//   runs            = parseWorkflowRuns(raw).record = { runs }    (§3.1; the parser takes no parameters)
//   jobsByRunId     = plain object, run id -> parseRunJobs(...).record (§3.2). A listing that cannot be
//                     complete (ci_candidate_listing_too_large) leaves the run WITHOUT an entry ("a run with
//                     no entry has no available listing"); any other parser failure ends the pipeline.
//   requiredJobNames= requiredJobs(classification)                (§3.3)
//   rules           = parseBranchRules(raw).record                (§2.4)
//   activity        = { forcePush, branchDeletion, branchCreation }, each parseActivity(...).record (§2.5),
//                     requested with the FULL ref refs/heads/<productionRef>
//   parsePrContext's parameters are { expectedNumber } (§2.2 as amended).

import { noThrow } from "./deep";
import type { Result } from "./spec-model";
import {
  PROD_REF_FULL,
  PRODUCTION_REF,
  TARGET_REPO_ID,
  WORKFLOW_ID,
  rawActivityFor,
  rawCompareFor,
  rawHeadBranchPrsFor,
  rawJobsFor,
  rawKeyFor,
  rawPrContextFor,
  rawRulesFor,
  rawRunsFor,
  type World,
} from "./world";

export interface Impl {
  parsePrKey: (raw: unknown, p: { expectedNumber: number }) => any;
  parseCompare: (raw: unknown, p: { baseSha: string }) => any;
  parsePrContext: (raw: unknown, p: { expectedNumber: number }) => any;
  parseHeadBranchPrs: (raw: unknown, p: { headRef: string }) => any;
  parseBranchRules: (raw: unknown) => any;
  parseActivity: (raw: unknown, p: { activityType: string; ref: string }) => any;
  parseWorkflowRuns: (raw: unknown) => any;
  parseRunJobs: (raw: unknown, p: { runId: number }) => any;
  bindBase: (a: any) => any;
  requiredJobs: (c: any) => any;
  bindCi: (a: any) => any;
}

export interface Evaluation {
  result: Result;
  stage: string;
  bindCiArgs?: any;
}

const failed = (r: any, stage: string): Evaluation => ({ result: { ok: false, reason: String(r?.reason) }, stage });

/** The whole pipeline for one world. Any exception is reported as a result, so "nothing throws" is visible. */
export function evaluate(w: World, impl: Impl): Evaluation {
  const run = noThrow(() => evaluateUnsafe(w, impl));
  if (run.threw) return { result: { ok: false, reason: `THREW: ${String(run.error)}` }, stage: "exception" };
  return run.value;
}

export const ACTIVITY_TYPES = [
  ["forcePush", "force_push"],
  ["branchDeletion", "branch_deletion"],
  ["branchCreation", "branch_creation"],
] as const;

function evaluateUnsafe(w: World, impl: Impl): Evaluation {
  const keyR = impl.parsePrKey(rawKeyFor(w), { expectedNumber: w.pr.number });
  if (!keyR?.ok) throw new Error(`test setup: the scenario's key does not parse (${keyR?.reason})`);
  const key = keyR.key;

  const compare = impl.parseCompare(rawCompareFor(w), { baseSha: key.baseSha });
  if (!compare?.ok) return failed(compare, "parseCompare");
  const prContext = impl.parsePrContext(rawPrContextFor(w), { expectedNumber: w.pr.number });
  if (!prContext?.ok) return failed(prContext, "parsePrContext");
  const base = impl.bindBase({ key, productionRef: PRODUCTION_REF, compare: compare.record, prContext: prContext.record });
  if (!base?.ok) return failed(base, "bindBase");

  const headBranchPrs = impl.parseHeadBranchPrs(rawHeadBranchPrsFor(w), { headRef: key.headRef });
  if (!headBranchPrs?.ok) return failed(headBranchPrs, "parseHeadBranchPrs");
  const rules = impl.parseBranchRules(rawRulesFor(w.rules));
  if (!rules?.ok) return failed(rules, "parseBranchRules");
  const activity: Record<string, unknown> = {};
  for (const [field, type] of ACTIVITY_TYPES) {
    const r = impl.parseActivity(rawActivityFor(type, w.activity[field]), { activityType: type, ref: PROD_REF_FULL });
    if (!r?.ok) return failed(r, `parseActivity(${type})`);
    activity[field] = r.record;
  }
  const runs = impl.parseWorkflowRuns(rawRunsFor(w));
  if (!runs?.ok) return failed(runs, "parseWorkflowRuns");
  const jobsByRunId: Record<number, unknown> = {};
  for (const [id, spec] of Object.entries(w.jobs)) {
    const parsed = impl.parseRunJobs(rawJobsFor(Number(id), spec), { runId: Number(id) });
    if (parsed?.ok) jobsByRunId[Number(id)] = parsed.record;
    else if (parsed?.reason !== "ci_candidate_listing_too_large") return failed(parsed, `parseRunJobs(${id})`);
  }
  const requiredJobNames = impl.requiredJobs(w.classification);

  const bindCiArgs = {
    key,
    base: base.value,
    headBranchPrs: headBranchPrs.record,
    runs: runs.record,
    jobsByRunId,
    requiredJobNames,
    rules: rules.record,
    activity,
    observedAt: w.observedAt,
    workflowId: WORKFLOW_ID,
    targetRepoId: TARGET_REPO_ID,
  };
  const r = impl.bindCi(bindCiArgs);
  if (!r?.ok) return { ...failed(r, "bindCi"), bindCiArgs };
  return {
    result: { ok: true, outcome: r.value?.outcome, runs: [...(r.value?.applicableRunIds ?? ["<missing applicableRunIds>"])] },
    stage: "bindCi",
    bindCiArgs,
  };
}
