/* eslint-disable @typescript-eslint/no-explicit-any -- these tests feed raw, untyped GitHub JSON on purpose */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseActivity, parseBranchRules, parseCompare, parseHeadBranchPrs, parsePrContext } from "../../../scripts/eng/v2/adapter/internal/github/parse-base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindBase } from "../../../scripts/eng/v2/adapter/internal/bind/base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseRunJobs, parseWorkflowRuns } from "../../../scripts/eng/v2/adapter/internal/github/parse-ci.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REQUIRED_JOB_TABLE, bindCi, requiredJobs } from "../../../scripts/eng/v2/adapter/internal/bind/ci.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../scripts/classify-changes.mjs";

// ===========================================================================
// ENG-LOOP V1 05A, gap row 3: applicable CI under the V1 conservative model
// (SPEC-05A §3). No run-side attestation: the execution context is proven from
// GitHub-computed evidence, and every negative control must end non-candidate.
// Real fixtures recorded 2026-10-07 unless a case says synthetic.
// ===========================================================================

const F = path.join(__dirname, "fixtures");
const load = (p: string) => JSON.parse(readFileSync(path.join(F, p), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const PROD = "claude/build-hone-saas-hOex7";
const WORKFLOW = 289443461;
const REPO = 1240764106;
const ok = (r: any) => {
  if (!r.ok) throw new Error(`fixture did not parse: ${r.reason} ${r.detail}`);
  return r.record ?? r.value;
};

const PROTECTED = ok(parseBranchRules([{ type: "non_fast_forward" }, { type: "deletion" }])); // synthetic: Option A
const UNPROTECTED = ok(parseBranchRules(load("base/rules-production-unprotected.json"))); // real, today
const ACT_REF = `refs/heads/${PROD}`;
/** Real production history, 2026-10-07: no force push, no deletion, and one creation in May. */
const NO_HISTORY = {
  forcePush: ok(parseActivity(load("base/activity-force-push-none.json"), { activityType: "force_push", ref: ACT_REF })),
  branchDeletion: ok(
    parseActivity(load("base/activity-branch-deletion-none.json"), { activityType: "branch_deletion", ref: ACT_REF }),
  ),
  branchCreation: ok(
    parseActivity(load("base/activity-branch-creation-initial.json"), { activityType: "branch_creation", ref: ACT_REF }),
  ),
};

/** A real PR's whole input to bindCi: key, base, head-branch PRs, runs and jobs. */
function realCase(n: 800 | 810) {
  const keyFile = n === 800 ? "pr-key/pr-800-open-draft.json" : "pr-key/pr-810-open-draft.json";
  const key = parsePrKey(load(keyFile), { expectedNumber: n }).key;
  const compare = ok(parseCompare(load(`base/compare-${n}.json`), { baseSha: key.baseSha }));
  const prContext = ok(parsePrContext(load(`base/pr-context-${n}.json`), { expectedNumber: n }));
  const base = ok(bindBase({ key, productionRef: PROD, compare, prContext }));
  const headBranchPrs = ok(parseHeadBranchPrs(load(`base/head-branch-prs-${n}.json`), { headRef: key.headRef }));
  const runs = ok(parseWorkflowRuns(load(`ci/runs-${n}.json`), { workflowId: WORKFLOW, headSha: key.headSha }));
  const jobsByRunId: Record<string, any> = {};
  for (const r of runs.runs) jobsByRunId[r.id] = ok(parseRunJobs(load(`ci/jobs-${n}.json`), { runId: r.id }));
  const requiredJobNames = requiredJobs(classify(base.files));
  return {
    key,
    base,
    headBranchPrs,
    runs,
    jobsByRunId,
    requiredJobNames,
    rules: PROTECTED,
    activity: NO_HISTORY,
    observedAt: "2026-10-07T21:00:00Z",
    workflowId: WORKFLOW,
    targetRepoId: REPO,
  };
}

const outcome = (input: any) => bindCi(input);

describe("parseWorkflowRuns and parseRunJobs (single-response listings)", () => {
  it("reads #810's one pull_request run, without its mutable pull_requests association", () => {
    const r = ok(
      parseWorkflowRuns(load("ci/runs-810.json"), {
        workflowId: WORKFLOW,
        headSha: "958b9d536e055e746499262cdc1a740e13501bf2",
      }),
    );
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toEqual({
      id: 37680787947,
      runNumber: 2855,
      workflowId: WORKFLOW,
      event: "pull_request",
      headSha: "958b9d536e055e746499262cdc1a740e13501bf2",
      headBranch: "feat/eng-loop-v1-05a",
      headRepoId: REPO,
      status: "completed",
      conclusion: "failure",
      runAttempt: 1,
      createdAt: "2026-10-07T20:16:44Z",
    });
  });

  it("a listing that cannot prove completeness fails closed", () => {
    const raw = load("ci/runs-810.json");
    const over = clone(raw);
    over.total_count = 101;
    expect(parseWorkflowRuns(over, { workflowId: WORKFLOW })).toMatchObject({ reason: "ci_candidate_listing_too_large" });
    // CAP-01 L4: a count that differs from what came back cannot prove completeness.
    const short = clone(raw);
    short.total_count = 2;
    expect(parseWorkflowRuns(short, { workflowId: WORKFLOW })).toMatchObject({ reason: "ci_candidate_listing_too_large" });
    const long = clone(raw);
    long.workflow_runs.push({ ...clone(long.workflow_runs[0]), id: 1, run_number: 1 });
    expect(parseWorkflowRuns(long, { workflowId: WORKFLOW })).toMatchObject({ reason: "ci_candidate_listing_too_large" });
    // A schema violation wins over an incomplete listing, so the reason never depends on which is checked first.
    const both = clone(raw);
    both.total_count = 101;
    both.workflow_runs[0].head_sha = "main";
    expect(parseWorkflowRuns(both, { workflowId: WORKFLOW })).toMatchObject({ reason: "malformed" });
    const dup = clone(raw);
    dup.workflow_runs.push(clone(dup.workflow_runs[0]));
    dup.total_count = 2;
    expect(parseWorkflowRuns(dup, { workflowId: WORKFLOW })).toMatchObject({ reason: "malformed" });
  });

  it("reads #776's jobs, and refuses jobs from another run or an incomplete listing", () => {
    const raw = load("ci/jobs-776.json");
    const runId = raw.jobs[0].run_id;
    expect(ok(parseRunJobs(raw, { runId })).jobs).toHaveLength(10);
    expect(parseRunJobs(raw, { runId: runId + 1 })).toMatchObject({ reason: "malformed" });
    const short = clone(raw);
    short.total_count = 11;
    expect(parseRunJobs(short, { runId })).toMatchObject({ reason: "ci_candidate_listing_too_large" });
  });

  it("any reordering of the same answer normalizes to the same listing (CAP-01 L7)", () => {
    const runsRaw = load("ci/runs-810.json");
    const second = { ...clone(runsRaw.workflow_runs[0]), id: 1, run_number: 1, status: "queued", conclusion: null };
    const forward = { ...clone(runsRaw), total_count: 2, workflow_runs: [runsRaw.workflow_runs[0], second] };
    const backward = { ...clone(runsRaw), total_count: 2, workflow_runs: [second, runsRaw.workflow_runs[0]] };
    expect(parseWorkflowRuns(backward, {})).toEqual(parseWorkflowRuns(forward, {}));
    expect(ok(parseWorkflowRuns(forward, {})).runs.map((r: any) => r.runNumber)).toEqual([1, 2855]);

    const jobsRaw = load("ci/jobs-776.json");
    const runId = jobsRaw.jobs[0].run_id;
    const reversed = { ...clone(jobsRaw), jobs: [...clone(jobsRaw.jobs)].reverse() };
    expect(parseRunJobs(reversed, { runId })).toEqual(parseRunJobs(jobsRaw, { runId }));
  });

  it("parseRunJobs needs the run it asked for: a missing or invalid run id is malformed, even for an empty listing", () => {
    const jobs = load("ci/jobs-810.json");
    const runId = jobs.jobs[0].run_id;
    for (const opts of [undefined, null, {}, { runId: String(runId) }, { runId: 0 }]) {
      for (const raw of [jobs, { total_count: 0, jobs: [] }]) {
        expect(() => parseRunJobs(raw, opts as any)).not.toThrow();
        expect(parseRunJobs(raw, opts as any), JSON.stringify(opts) ?? "undefined").toMatchObject({ ok: false, reason: "malformed" });
      }
    }
    expect(parseRunJobs(jobs, { runId }).ok).toBe(true);
  });

  it("an exotic listing is malformed, never an exception", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile proxy");
      },
    });
    for (const parse of [() => parseWorkflowRuns(hostile), () => parseRunJobs(hostile, { runId: 1 })]) {
      expect(parse).not.toThrow();
      expect(parse()).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("any status string parses; an unknown one is the binder's unrecognized_ci_status, not a parse failure", () => {
    const raw = load("ci/runs-810.json");
    for (const status of ["", "paused", "COMPLETED"]) {
      const r = clone(raw);
      r.workflow_runs[0].status = status;
      expect(ok(parseWorkflowRuns(r, {})).runs[0].status, status).toBe(status);
    }
    const jobs = load("ci/jobs-776.json");
    const odd = clone(jobs);
    odd.jobs[0].status = "";
    expect(parseRunJobs(odd, { runId: jobs.jobs[0].run_id }).ok).toBe(true);
  });
});

describe("requiredJobs: lanes from production's own classifier", () => {
  it("a docs-only diff requires only path detection and the browser aggregator", () => {
    expect(requiredJobs(classify(["docs/x.md"]))).toEqual(["changed-path detection", "browser e2e (local stack)"]);
  });

  it("application code also requires the validate lane", () => {
    expect(requiredJobs(classify(["scripts/eng/v2/contract/pr-key.mjs"]))).toContain(
      "typecheck / lint / build / test / safety gates",
    );
  });

  it("the full matrix requires every lane", () => {
    const all = requiredJobs(classify(["package.json"]));
    for (const j of REQUIRED_JOB_TABLE.map((r: any) => r.name)) expect(all).toContain(j);
  });

  it("every required job name exists in production's ci.yml, so a rename turns this red", () => {
    const ci = readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    for (const { name } of REQUIRED_JOB_TABLE) expect(ci).toContain(`name: ${name}`);
  });
});

describe("bindCi: real PRs", () => {
  it("#800 (docs only, one successful run, both required jobs green) is SUCCEEDED once production is protected", () => {
    expect(outcome(realCase(800))).toMatchObject({ ok: true, value: { outcome: "SUCCEEDED" } });
  });

  it("#810's real failing run is FAILED", () => {
    expect(outcome(realCase(810))).toMatchObject({ ok: true, value: { outcome: "FAILED" } });
  });

  it("today's unprotected production makes every PR base_history_unverified", () => {
    expect(outcome({ ...realCase(800), rules: UNPROTECTED })).toMatchObject({
      ok: false,
      reason: "base_history_unverified",
    });
  });
});

describe("bindCi: provenance negative controls (SPEC-05A §3.5)", () => {
  it("NC1 (synthetic): another PR from the same head branch is shared_head", () => {
    const c = realCase(800);
    expect(outcome({ ...c, headBranchPrs: { numbers: [800, 640], capped: false } })).toMatchObject({
      ok: false,
      reason: "shared_head",
    });
  });

  it("NC1 (synthetic): another PR's run from a different branch at the same SHA is ignored", () => {
    const c = realCase(800);
    const other = clone(c.runs.runs[0]);
    other.id = 1;
    other.runNumber = 1;
    other.headBranch = "other/branch";
    other.conclusion = "failure";
    expect(outcome({ ...c, runs: { runs: [...c.runs.runs, other] } })).toMatchObject({ value: { outcome: "SUCCEEDED" } });
  });

  it("NC2 (synthetic): a production force push after the run is base_history_unverified", () => {
    const c = realCase(800);
    const forced = { events: [{ timestamp: "2026-10-07T19:30:00Z", before: "a".repeat(40), after: "b".repeat(40) }], capped: false };
    expect(outcome({ ...c, activity: { ...c.activity, forcePush: forced } })).toMatchObject({
      ok: false,
      reason: "base_history_unverified",
    });
  });

  it("A1 (synthetic): a force push BEFORE the run record still blocks — the test merge predates the record", () => {
    // GitHub fixes a pull_request run's base when it computes the test merge, before the run
    // record exists. A rewrite in that gap leaves behind_by 0 and an earlier created_at, so no
    // run timestamp can bound it: any force push or deletion in the recorded year blocks.
    const c = realCase(800);
    const created = c.runs.runs[0].createdAt;
    const secondsBefore = new Date(Date.parse(created) - 5_000).toISOString().replace(".000Z", "Z");
    for (const timestamp of [secondsBefore, "2026-09-01T00:00:00Z", "2025-10-20T00:00:00Z"]) {
      const forced = { events: [{ timestamp, before: "a".repeat(40), after: "b".repeat(40) }], capped: false };
      expect(outcome({ ...c, activity: { ...c.activity, forcePush: forced } }), timestamp).toMatchObject({
        ok: false,
        reason: "base_history_unverified",
      });
      const deleted = { events: [{ timestamp, before: "a".repeat(40), after: "0".repeat(40) }], capped: false };
      expect(outcome({ ...c, activity: { ...c.activity, branchDeletion: deleted } }), timestamp).toMatchObject({
        ok: false,
        reason: "base_history_unverified",
      });
    }
  });

  it("A1 (real): production's one creation, in May, precedes every run and does not block", () => {
    const c = realCase(800);
    expect(c.activity.branchCreation.events).toHaveLength(1);
    expect(outcome(c)).toMatchObject({ ok: true, value: { outcome: "SUCCEEDED" } });
  });

  it("A1 (synthetic): production (re-)created at or after the earliest run, or a capped creation listing, blocks", () => {
    const c = realCase(800);
    const created = c.runs.runs[0].createdAt;
    const later = new Date(Date.parse(created) + 60_000).toISOString().replace(".000Z", "Z");
    for (const timestamp of [created, later]) {
      const recreated = {
        events: [...c.activity.branchCreation.events, { timestamp, before: "0".repeat(40), after: "b".repeat(40) }],
        capped: false,
      };
      expect(outcome({ ...c, activity: { ...c.activity, branchCreation: recreated } }), timestamp).toMatchObject({
        ok: false,
        reason: "base_history_unverified",
      });
    }
    expect(
      outcome({ ...c, activity: { ...c.activity, branchCreation: { events: [], capped: true } } }),
    ).toMatchObject({ reason: "base_history_unverified" });
  });

  it("A1: a history input outside the contract is malformed — never clean history, and checked before any rule", () => {
    const c = realCase(800);
    const withoutCreation: any = { ...c.activity };
    delete withoutCreation.branchCreation;
    expect(outcome({ ...c, activity: withoutCreation })).toMatchObject({ ok: false, reason: "malformed" });
    const listings = [
      { events: [] },
      { events: [], capped: "false" },
      { events: {}, capped: false },
      { capped: false },
      { events: [{ timestamp: "not a time", before: "a".repeat(40), after: "b".repeat(40) }], capped: false },
    ];
    for (const listing of listings) {
      expect(
        outcome({ ...c, activity: { ...c.activity, forcePush: listing } }),
        JSON.stringify(listing),
      ).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("every bindCi input outside SPEC-05A §3.4's shapes is malformed, whatever the rules would say", () => {
    const c = realCase(800);
    const runId = c.runs.runs[0].id;
    const parseFailure = { ok: false, reason: "read_failed", detail: "x" };
    const variants: Array<[string, any]> = [
      ["no input", null],
      ["requiredJobNames ''", { requiredJobNames: "" }],
      ["requiredJobNames []", { requiredJobNames: [] }],
      ["requiredJobNames as a Set", { requiredJobNames: new Set(c.requiredJobNames) }],
      ["requiredJobNames without the browser aggregator", { requiredJobNames: ["changed-path detection"] }],
      ["requiredJobNames with an unknown job", { requiredJobNames: [...c.requiredJobNames, "deploy"] }],
      ["requiredJobNames repeated", { requiredJobNames: [...c.requiredJobNames, c.requiredJobNames[0]] }],
      ["a key with an extra field", { key: { ...c.key, extra: 1 } }],
      ["an open key without its base tip", { key: { ...c.key, baseSha: null } }],
      ["headBranchPrs.capped missing", { headBranchPrs: { numbers: [800] } }],
      ["headBranchPrs.capped 'false'", { headBranchPrs: { numbers: [800], capped: "false" } }],
      ["headBranchPrs.capped 0", { headBranchPrs: { numbers: [800], capped: 0 } }],
      ["base without filesCapped", { base: Object.fromEntries(Object.entries(c.base).filter(([k]) => k !== "filesCapped")) }],
      ["jobsByRunId as a Map", { jobsByRunId: new Map([[runId, c.jobsByRunId[runId]]]) }],
      ["a parser failure in jobsByRunId", { jobsByRunId: { [runId]: parseFailure } }],
      ["rules without flags", { rules: { types: ["non_fast_forward", "deletion"] } }],
      ["workflowId 0", { workflowId: 0 }],
      ["workflowId as a string", { workflowId: "289443461" }],
      ["targetRepoId missing", { targetRepoId: undefined }],
      ["observedAt not a time", { observedAt: "now" }],
    ];
    for (const [label, over] of variants) {
      const input = over === null ? null : { ...c, ...over };
      expect(() => outcome(input), label).not.toThrow();
      expect(outcome(input), label).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("NC2: a branch deletion after the run, or a capped history, is base_history_unverified", () => {
    const c = realCase(800);
    const deleted = { events: [{ timestamp: "2026-10-07T20:00:00Z", before: "a".repeat(40), after: "0".repeat(40) }], capped: false };
    expect(outcome({ ...c, activity: { ...c.activity, branchDeletion: deleted } })).toMatchObject({
      reason: "base_history_unverified",
    });
    expect(outcome({ ...c, activity: { ...c.activity, forcePush: { events: [], capped: true } } })).toMatchObject({
      reason: "base_history_unverified",
    });
  });

  it("NC3 (synthetic pairing of a real run shape): a successful push run at H never counts", () => {
    const c = realCase(800);
    const push = clone(c.runs.runs[0]);
    push.event = "push";
    expect(outcome({ ...c, runs: { runs: [push] } })).toMatchObject({ ok: true, value: { outcome: "NO_RUN" } });
  });

  it("NC4 (real: #720 was retargeted from feat/ui-r02-product-polish) is base_ref_changed", () => {
    const c = realCase(800);
    const retargeted = ok(parsePrContext(load("base/pr-context-720.json"), { expectedNumber: 720 }));
    expect(outcome({ ...c, base: { ...c.base, baseRefChanges: retargeted.baseRefChanges } })).toMatchObject({
      ok: false,
      reason: "base_ref_changed",
    });
    expect(outcome({ ...c, base: { ...c.base, baseRefChanges: "too_many" } })).toMatchObject({ reason: "base_ref_changed" });
  });

  it("NC5 (real job shapes): a required job skipped or missing is INCOMPLETE", () => {
    const c = realCase(800);
    const runId = c.runs.runs[0].id;
    const skipped = clone(c.jobsByRunId[runId]);
    skipped.jobs = skipped.jobs.map((j: any) =>
      j.name === "browser e2e (local stack)" ? { ...j, conclusion: "skipped" } : j,
    );
    expect(outcome({ ...c, jobsByRunId: { [runId]: skipped } })).toMatchObject({ value: { outcome: "INCOMPLETE" } });
    const missing = clone(c.jobsByRunId[runId]);
    missing.jobs = missing.jobs.filter((j: any) => j.name !== "changed-path detection");
    expect(outcome({ ...c, jobsByRunId: { [runId]: missing } })).toMatchObject({ value: { outcome: "INCOMPLETE" } });
    // #800 is docs-only; asking the same run for the validate lane (an application diff) is INCOMPLETE.
    expect(
      outcome({ ...c, requiredJobNames: requiredJobs(classify(["scripts/eng/cli.mjs"])) }),
    ).toMatchObject({ value: { outcome: "INCOMPLETE" } });
  });

  it("NC5: zero applicable runs is NO_RUN, never success", () => {
    expect(outcome({ ...realCase(800), runs: { runs: [] } })).toMatchObject({ ok: true, value: { outcome: "NO_RUN" } });
  });

  it("NC6 (synthetic): unrelated runs at the same SHA — other workflow, fork, other branch — are ignored", () => {
    const c = realCase(800);
    const base = c.runs.runs[0];
    const unrelated = [
      { ...base, id: 11, runNumber: 11, workflowId: 325801278 },
      { ...base, id: 12, runNumber: 12, headRepoId: 999 },
      { ...base, id: 13, runNumber: 13, headBranch: null },
    ].map((r) => ({ ...r, conclusion: "failure" }));
    expect(outcome({ ...c, runs: { runs: [base, ...unrelated] } })).toMatchObject({ value: { outcome: "SUCCEEDED" } });
    expect(outcome({ ...c, runs: { runs: unrelated } })).toMatchObject({ value: { outcome: "NO_RUN" } });
  });
});

describe("bindCi: rule order and the closed run-state table", () => {
  it("a fork head is fork_head before anything else", () => {
    const c = realCase(800);
    expect(outcome({ ...c, key: { ...c.key, headRepoId: 42 } })).toMatchObject({ reason: "fork_head" });
  });

  it("an unprovable diff is diff_too_large", () => {
    const c = realCase(800);
    expect(outcome({ ...c, base: { ...c.base, filesCapped: true } })).toMatchObject({ reason: "diff_too_large" });
    expect(outcome({ ...c, base: { ...c.base, changedFiles: 3 } })).toMatchObject({ reason: "diff_too_large" });
  });

  it("a PR that changes CI's own definition is ci_definition_changed", () => {
    const c = realCase(800);
    for (const f of [".github/workflows/ci.yml", "scripts/classify-changes.mjs", "scripts/browser-groups.mjs"]) {
      const files = [...c.base.files.slice(0, -1), f];
      expect(outcome({ ...c, base: { ...c.base, files } })).toMatchObject({ reason: "ci_definition_changed" });
    }
  });

  it("an associated-PR list that is not exactly this PR is shared_head", () => {
    const c = realCase(800);
    expect(outcome({ ...c, base: { ...c.base, associatedPrNumbers: [800, 801] } })).toMatchObject({ reason: "shared_head" });
    expect(outcome({ ...c, base: { ...c.base, associatedPrNumbers: "too_many" } })).toMatchObject({ reason: "shared_head" });
    expect(outcome({ ...c, headBranchPrs: { numbers: [800], capped: true } })).toMatchObject({ reason: "shared_head" });
  });

  it("a run older than the 360-day history window is base_history_unverified", () => {
    const c = realCase(800);
    expect(outcome({ ...c, observedAt: "2027-10-07T00:00:00Z" })).toMatchObject({ reason: "base_history_unverified" });
  });

  const withRun = (edit: object) => {
    const c = realCase(800);
    return outcome({ ...c, runs: { runs: [{ ...c.runs.runs[0], ...edit }] } });
  };

  it.each(["queued", "in_progress", "waiting", "requested", "pending"])("status %s is PENDING", (status) => {
    expect(withRun({ status, conclusion: null })).toMatchObject({ value: { outcome: "PENDING" } });
  });

  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"])(
    "completed + %s is FAILED",
    (conclusion) => {
      expect(withRun({ conclusion })).toMatchObject({ value: { outcome: "FAILED" } });
    },
  );

  it("an unknown status, an unknown conclusion, or a completed run with no conclusion fails closed", () => {
    expect(withRun({ status: "paused" })).toMatchObject({ reason: "unrecognized_ci_status" });
    expect(withRun({ status: "" })).toMatchObject({ reason: "unrecognized_ci_status" });
    expect(withRun({ conclusion: "kinda" })).toMatchObject({ reason: "unrecognized_ci_conclusion" });
    expect(withRun({ conclusion: null })).toMatchObject({ reason: "malformed" });
  });

  it("every applicable run counts: one failure among successes is FAILED; one pending is PENDING", () => {
    const c = realCase(800);
    const okRun = c.runs.runs[0];
    const failed = { ...okRun, id: 2, runNumber: 2, conclusion: "failure" };
    const pending = { ...okRun, id: 3, runNumber: 3, status: "in_progress", conclusion: null };
    expect(outcome({ ...c, runs: { runs: [okRun, failed] } })).toMatchObject({ value: { outcome: "FAILED" } });
    expect(outcome({ ...c, runs: { runs: [okRun, pending] } })).toMatchObject({ value: { outcome: "PENDING" } });
    expect(outcome({ ...c, runs: { runs: [failed, pending] } })).toMatchObject({ value: { outcome: "FAILED" } });
  });

  it("a successful run whose jobs listing is missing cannot be proven: ci_candidate_listing_too_large", () => {
    const c = realCase(800);
    expect(outcome({ ...c, jobsByRunId: {} })).toMatchObject({ reason: "ci_candidate_listing_too_large" });
  });
});
