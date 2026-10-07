/* eslint-disable @typescript-eslint/no-explicit-any -- records cross between the functions under test untyped */
// Independent verifier support: World -> raw GitHub answers -> the REAL parsers ->
// the REAL binders. The verifier never builds a normalized record itself: every
// record bindBase/bindCi receive was produced by the implementation's own parser,
// so only the composition below is assumed.
//
// ASSUMED COMPOSITION (SPEC-05A §3.4 names these inputs; where the spec is silent
// the choice is recorded here, and nowhere else):
//   base            = bindBase(...).value                                  (spec: "the §2.6 value")
//   headBranchPrs   = parseHeadBranchPrs(...).record                       (spec: "the §2.3 record")
//   rules           = parseBranchRules(...).record                         (spec: "the §2.4 record")
//   activity        = { forcePush: parseActivity(...).record,
//                       branchDeletion: parseActivity(...).record }        (spec: "each a §2.5 record")
//   requiredJobNames= requiredJobs(classification)                         (spec: "the §3.3 set")
//   runs            = parseWorkflowRuns(...).record                        (spec: silent; read as "the §3.1 record")
//   jobsByRunId     = { [runId]: parseRunJobs(...).record }, and for a listing that cannot be complete, the
//                     failed parser result in its place. The spec is silent; a black-box probe of the builder's
//                     bindCi (7bf0d05c) showed it takes §3.2 RECORDS in a plain object keyed by run id and reads
//                     anything else (absent, a Map, a parser result) as an unavailable listing.
//   parseActivity's `ref` parameter = "refs/heads/<productionRef>", the request's own `ref` value.

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
  parsePrContext: (raw: unknown, p: { expectedNumber: number; headSha: string }) => any;
  parseHeadBranchPrs: (raw: unknown, p: { headRef: string }) => any;
  parseBranchRules: (raw: unknown) => any;
  parseActivity: (raw: unknown, p: { activityType: string; ref: string }) => any;
  parseWorkflowRuns: (raw: unknown, p: { workflowId: number; headSha: string }) => any;
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

function evaluateUnsafe(w: World, impl: Impl): Evaluation {
  const keyR = impl.parsePrKey(rawKeyFor(w), { expectedNumber: w.pr.number });
  if (!keyR?.ok) throw new Error(`test setup: the scenario's key does not parse (${keyR?.reason})`);
  const key = keyR.key;

  const compare = impl.parseCompare(rawCompareFor(w), { baseSha: key.baseSha });
  if (!compare?.ok) return failed(compare, "parseCompare");
  const prContext = impl.parsePrContext(rawPrContextFor(w), { expectedNumber: w.pr.number, headSha: key.headSha });
  if (!prContext?.ok) return failed(prContext, "parsePrContext");
  const base = impl.bindBase({ key, productionRef: PRODUCTION_REF, compare: compare.record, prContext: prContext.record });
  if (!base?.ok) return failed(base, "bindBase");

  const headBranchPrs = impl.parseHeadBranchPrs(rawHeadBranchPrsFor(w), { headRef: key.headRef });
  if (!headBranchPrs?.ok) return failed(headBranchPrs, "parseHeadBranchPrs");
  const rules = impl.parseBranchRules(rawRulesFor(w.rules));
  if (!rules?.ok) return failed(rules, "parseBranchRules");
  const forcePush = impl.parseActivity(rawActivityFor("force_push", w.activity.forcePush), {
    activityType: "force_push",
    ref: PROD_REF_FULL,
  });
  if (!forcePush?.ok) return failed(forcePush, "parseActivity(force_push)");
  const branchDeletion = impl.parseActivity(rawActivityFor("branch_deletion", w.activity.branchDeletion), {
    activityType: "branch_deletion",
    ref: PROD_REF_FULL,
  });
  if (!branchDeletion?.ok) return failed(branchDeletion, "parseActivity(branch_deletion)");
  const runs = impl.parseWorkflowRuns(rawRunsFor(w), { workflowId: WORKFLOW_ID, headSha: key.headSha });
  if (!runs?.ok) return failed(runs, "parseWorkflowRuns");
  const jobsByRunId: Record<number, unknown> = {};
  for (const [id, spec] of Object.entries(w.jobs)) {
    const parsed = impl.parseRunJobs(rawJobsFor(Number(id), spec), { runId: Number(id) });
    jobsByRunId[Number(id)] = parsed?.ok ? parsed.record : parsed;
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
    activity: { forcePush: forcePush.record, branchDeletion: branchDeletion.record },
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
