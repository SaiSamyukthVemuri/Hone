/* eslint-disable @typescript-eslint/no-explicit-any -- mutants wrap untyped functions under test */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseActivity, parseBranchRules, parseCompare, parseHeadBranchPrs, parsePrContext } from "../../../../scripts/eng/v2/adapter/internal/github/parse-base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindBase } from "../../../../scripts/eng/v2/adapter/internal/bind/base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseRunJobs, parseWorkflowRuns } from "../../../../scripts/eng/v2/adapter/internal/github/parse-ci.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindCi, requiredJobs } from "../../../../scripts/eng/v2/adapter/internal/bind/ci.mjs";
import { clone } from "./support/deep";
import { evaluate, type Impl } from "./support/pipeline";
import { ADVERSARIAL, SCENARIOS, matches, orderScenarios, type Scenario } from "./support/scenarios";
import { WORKFLOW_ID, type World } from "./support/world";

// ===========================================================================
// INDEPENDENT VERIFIER — mutation detection through the REAL pipeline.
// Each mutant wraps the builder's real functions with one intentionally UNSAFE
// change. A mutant is detected when some row that the real implementation
// satisfies is broken by the mutant.
// ===========================================================================

const REAL_IMPL: Impl = {
  parsePrKey,
  parseCompare,
  parsePrContext,
  parseHeadBranchPrs,
  parseBranchRules,
  parseActivity,
  parseWorkflowRuns,
  parseRunJobs,
  bindBase,
  requiredJobs,
  bindCi,
};

const TABLE: Scenario[] = [...SCENARIOS, ...orderScenarios(), ...ADVERSARIAL];

type MutantFactory = (w: World) => Impl;

const MUTANTS: Array<[string, MutantFactory, string[]]> = [
  [
    "(a) any successful run at the head SHA counts, regardless of event/branch/workflow/repository",
    (w) => ({
      ...REAL_IMPL,
      parseWorkflowRuns: (raw: any) => {
        const r = clone(raw);
        for (const run of r?.workflow_runs ?? [])
          if (run?.head_sha === w.pr.headSha)
            Object.assign(run, { event: "pull_request", workflow_id: WORKFLOW_ID, head_branch: w.pr.headRef, head_repository: { ...(run.head_repository ?? {}), id: w.pr.headRepoId } });
        return REAL_IMPL.parseWorkflowRuns(r);
      },
    }),
    ["NC3-push-run", "NC6-other-workflow", "NC1-other-branch"],
  ],
  [
    "(b) the activity history is ignored",
    () => ({ ...REAL_IMPL, parseActivity: (_raw: any, p: any) => REAL_IMPL.parseActivity([], p) }),
    ["NC2-force-push-after", "NC2-deletion-after"],
  ],
  [
    "(c) base changes counted from the unfiltered timelineItems totalCount",
    (w) => ({
      ...REAL_IMPL,
      parsePrContext: (raw: any, p: any) => {
        const r = clone(raw);
        const changes = r?.data?.repository?.pullRequest?.baseRefChanges;
        if (changes && w.prContext.timelineTotalCount !== undefined && !changes.pageInfo.hasNextPage)
          changes.nodes = Array.from({ length: w.prContext.timelineTotalCount }, () => ({ __typename: "BaseRefChangedEvent" }));
        return REAL_IMPL.parsePrContext(r, p);
      },
    }),
    ["G-golden", "R4-totalcount-trap"],
  ],
  [
    "closed PRs dropped from the head-branch listing (state=open)",
    () => ({
      ...REAL_IMPL,
      parseHeadBranchPrs: (raw: any, p: any) => REAL_IMPL.parseHeadBranchPrs(Array.isArray(raw) ? raw.filter((e: any) => e.state === "open") : raw, p),
    }),
    ["NC1-same-branch", "A3-branch-deleted-and-recreated"],
  ],
  [
    "skipped jobs reported as success",
    () => ({
      ...REAL_IMPL,
      parseRunJobs: (raw: any, p: any) => {
        const r = clone(raw);
        for (const j of r?.jobs ?? []) if (j.conclusion === "skipped") j.conclusion = "success";
        return REAL_IMPL.parseRunJobs(r, p);
      },
    }),
    ["NC5-validate-skipped"],
  ],
  [
    "no required jobs (job evidence ignored)",
    () => ({
      ...REAL_IMPL,
      requiredJobs: (c: any) => {
        const r = REAL_IMPL.requiredJobs(c);
        return Array.isArray(r) ? [] : new Set();
      },
    }),
    ["NC5-validate-missing"],
  ],
  [
    "the PRE-AMENDMENT step 8 (b5f3affb): rewrites before the earliest applicable run ignored, creation unread (hole A1)",
    () => ({
      ...REAL_IMPL,
      bindCi: (a: any) => {
        // the record shapes are SPEC §3.1 / §2.5 as amended: { runs: [...] }, { events, capped }
        const applicable = (a?.runs?.runs ?? []).filter(
          (r: any) =>
            r.workflowId === a.workflowId &&
            r.event === "pull_request" &&
            r.headSha === a.key.headSha &&
            r.headRepoId === a.key.headRepoId &&
            r.headBranch === a.key.headRef,
        );
        if (applicable.length === 0) return REAL_IMPL.bindCi(a);
        const earliest = Math.min(...applicable.map((r: any) => Date.parse(r.createdAt)));
        const keepAfter = (l: any) => ({ ...l, events: l.events.filter((e: any) => !(Date.parse(e.timestamp) < earliest)) });
        return REAL_IMPL.bindCi({
          ...a,
          activity: {
            forcePush: keepAfter(a.activity.forcePush),
            branchDeletion: keepAfter(a.activity.branchDeletion),
            branchCreation: { events: [], capped: false },
          },
        });
      },
    }),
    ["A1-merge-before-created-at", "NC2-force-push-before", "R8-one-second-before", "R8-creation-after-run"],
  ],
  [
    "branch_creation unread",
    () => ({
      ...REAL_IMPL,
      bindCi: (a: any) => REAL_IMPL.bindCi({ ...a, activity: { ...a.activity, branchCreation: { events: [], capped: false } } }),
    }),
    ["R8-creation-after-run", "R8-creation-at-run", "A8a-creation-recorded-after-run"],
  ],
  [
    "rules in force trusted as history (no activity, no window)",
    () => ({
      ...REAL_IMPL,
      parseActivity: (_raw: any, p: any) => REAL_IMPL.parseActivity([], p),
      bindCi: (a: any) => REAL_IMPL.bindCi({ ...a, observedAt: "2026-10-07T21:00:00Z" }),
    }),
    ["NC2-force-push-after", "A5-rerun-after-rewrite"],
  ],
];

describe("mutation detection C: the real pipeline, mutated, is rejected by the table", () => {
  const realResults = new Map(TABLE.map((s) => [s.id, evaluate(s.world(), REAL_IMPL).result]));
  const realPasses = TABLE.filter((s) => matches(realResults.get(s.id)!, s.expect));

  it("baseline: the rows the real implementation satisfies (reported, not asserted here)", () => {
    expect(realPasses.length).toBeGreaterThan(0);
  });

  for (const [name, factory, mustDetect] of MUTANTS) {
    it(`detects the UNSAFE mutant: ${name}`, () => {
      const detected = realPasses.filter((s) => !matches(evaluate(s.world(), factory(s.world())).result, s.expect)).map((s) => s.id);
      expect(detected.length, "no row that the real implementation satisfies breaks under this mutant").toBeGreaterThan(0);
      for (const id of mustDetect)
        if (realPasses.some((s) => s.id === id)) expect(detected, `row ${id} should detect it`).toContain(id);
    });
  }
});
