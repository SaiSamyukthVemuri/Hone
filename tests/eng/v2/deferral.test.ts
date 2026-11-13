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
import { bindCi, isDraftDeferral, requiredJobs } from "../../../scripts/eng/v2/adapter/internal/bind/ci.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../scripts/classify-changes.mjs";

// ===========================================================================
// SHEP-LATEST-01 PR3 (SPEC-05A step 10, option B, REV3): a draft DEFERRAL run, and only that, is ignored once the PR
// was marked ready and a newer, non-deferral run of this PR exists. Everything else keeps "every applicable run counts".
// The deferral listing is the REAL one captured from #1441's draft run 43459049109 (fixtures/ci-deferral).
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
const ACT_REF = `refs/heads/${PROD}`;
const PROTECTED = ok(parseBranchRules([{ type: "non_fast_forward" }, { type: "deletion" }]));
const NO_HISTORY = {
  forcePush: ok(parseActivity(load("base/activity-force-push-none.json"), { activityType: "force_push", ref: ACT_REF })),
  branchDeletion: ok(parseActivity(load("base/activity-branch-deletion-none.json"), { activityType: "branch_deletion", ref: ACT_REF })),
  branchCreation: ok(parseActivity(load("base/activity-branch-creation-initial.json"), { activityType: "branch_creation", ref: ACT_REF })),
};

const DEFERRAL_RUN = 43459049109;
const DEFERRAL_JOBS = load("ci-deferral/draft-run-43459049109-jobs.json");
const T = {
  deferral: "2026-11-13T14:13:35Z",
  ready: "2026-11-13T14:20:00Z",
  success: "2026-11-13T14:23:42Z",
};

/** #800 is a real docs-only PR: its required jobs are exactly the always-required pair. Its key is made non-draft here. */
function world() {
  const key0 = parsePrKey(load("pr-key/pr-800-open-draft.json"), { expectedNumber: 800 }).key;
  const key = { ...key0, isDraft: false };
  const compare = ok(parseCompare(load("base/compare-800.json"), { baseSha: key.baseSha }));
  const prContext = ok(parsePrContext(load("base/pr-context-800.json"), { expectedNumber: 800 }));
  const base = ok(bindBase({ key, productionRef: PROD, compare, prContext }));
  const headBranchPrs = ok(parseHeadBranchPrs(load("base/head-branch-prs-800.json"), { headRef: key.headRef }));
  const green = ok(parseRunJobs(load("ci/jobs-800.json"), { runId: ok(parseWorkflowRuns(load("ci/runs-800.json"), { workflowId: WORKFLOW, headSha: key.headSha })).runs[0].id }));
  const realRun = ok(parseWorkflowRuns(load("ci/runs-800.json"), { workflowId: WORKFLOW, headSha: key.headSha })).runs[0];
  const mk = (id: number, over: any = {}) => ({ ...realRun, id, runNumber: id % 100000, conclusion: "success", status: "completed", pullRequests: [800], ...over });
  const deferralJobs = ok(parseRunJobs(DEFERRAL_JOBS, { runId: DEFERRAL_RUN }));
  return {
    key,
    base,
    headBranchPrs,
    runs: { runs: [] as any[] },
    jobsByRunId: {} as Record<string, any>,
    requiredJobNames: requiredJobs(classify(base.files)),
    rules: PROTECTED,
    activity: NO_HISTORY,
    observedAt: "2026-11-14T00:00:00Z",
    workflowId: WORKFLOW,
    targetRepoId: REPO,
    readyAt: T.ready as string | null,
    green,
    deferralJobs,
    mk,
    D: () => mk(DEFERRAL_RUN, { conclusion: "failure", createdAt: T.deferral, runNumber: 5001 }),
    S: (over: any = {}) => mk(43459049200, { createdAt: T.success, runNumber: 5002, ...over }),
  };
}
type W = ReturnType<typeof world>;
/** The input with the given runs and listings; green listings for every run that has none. */
function input(w: W, runs: any[], jobs: Record<string, any> = {}, over: any = {}) {
  const jobsByRunId: Record<string, any> = {};
  for (const r of runs) {
    if (r.conclusion === "success") jobsByRunId[r.id] = w.green;
    if (r.id === DEFERRAL_RUN) jobsByRunId[r.id] = w.deferralJobs;
  }
  Object.assign(jobsByRunId, jobs);
  const { green, deferralJobs, mk, D, S, ...rest } = w;
  void green; void deferralJobs; void mk; void D; void S;
  return { ...rest, runs: { runs }, jobsByRunId, ...over };
}
const outcomeOf = (r: any) => (r.ok ? r.value.outcome : `${r.reason}`);

describe("the real deferral listing is positively a draft deferral (and nothing near it is)", () => {
  const w = world();
  const D = w.D();
  it("#1441's real draft run is a deferral (Set up job before, Complete job after, the shard job skipped with an unrendered name)", () => {
    expect(isDraftDeferral(D, { [D.id]: w.deferralJobs })).toBe(true);
  });
  const mutate = (f: (jobs: any[]) => void) => {
    const l = clone(w.deferralJobs);
    f(l.jobs);
    return l;
  };
  const agg = (jobs: any[]) => jobs.find((j: any) => j.name === "browser e2e (local stack)");
  const cases: Array<[string, (jobs: any[]) => void]> = [
    // Insurance final660 P1: each of the three named steps is required on its own
    ["the prerequisites step is missing", (j) => (agg(j).steps = agg(j).steps.filter((st: any) => st.name !== "Fail closed on prerequisites"))],
    ["the prerequisites step failed", (j) => (agg(j).steps[1].conclusion = "failure")],
    ["the prerequisites step was skipped", (j) => (agg(j).steps[1].conclusion = "skipped")],
    ["the prerequisites step is duplicated", (j) => agg(j).steps.push({ number: 6, name: "Fail closed on prerequisites", status: "completed", conclusion: "success" })],
    ["the shard aggregation step is missing", (j) => (agg(j).steps = agg(j).steps.filter((st: any) => st.name !== "Aggregate browser shard results"))],
    ["the shard aggregation step ran and succeeded", (j) => (agg(j).steps[3].conclusion = "success")],
    ["the shard aggregation step is cancelled", (j) => (agg(j).steps[3].conclusion = "cancelled")],
    ["the steps are out of order (aggregation before the deferral)", (j) => ((agg(j).steps[2].number = 4), (agg(j).steps[3].number = 3))],
    ["the DRAFT-DEFERRED step succeeded", (j) => (agg(j).steps[2].conclusion = "success")],
    ["the DRAFT-DEFERRED step is cancelled", (j) => (agg(j).steps[2].conclusion = "cancelled")],
    ["the step has another name", (j) => (agg(j).steps[2].name = "DRAFT-DEFERRED-X")],
    ["an earlier step failed", (j) => (agg(j).steps[1].conclusion = "failure")],
    ["an earlier step was skipped", (j) => (agg(j).steps[1].conclusion = "skipped")],
    ["a later step succeeded (the shard aggregation ran)", (j) => (agg(j).steps[3].conclusion = "success")],
    ["a later step failed", (j) => (agg(j).steps[3].conclusion = "failure")],
    ["Complete job did not succeed", (j) => (agg(j).steps[4].conclusion = "cancelled")],
    ["a second DRAFT-DEFERRED step", (j) => agg(j).steps.push({ number: 6, name: "DRAFT-DEFERRED", status: "completed", conclusion: "failure" })],
    // these two are NOT also caught by the other-jobs / later-steps checks, so only "exactly one" can refuse them
    ["a second aggregator job that succeeded", (j) => j.push({ ...clone(agg(j)), conclusion: "success", steps: [] })],
    ["a second, skipped DRAFT-DEFERRED step after the first", (j) => agg(j).steps.push({ number: 6, name: "DRAFT-DEFERRED", status: "completed", conclusion: "skipped" })],
    ["the listing carries no steps", (j) => (agg(j).steps = null)],
    ["a second aggregator job", (j) => j.push(clone(agg(j)))],
    ["the aggregator job is missing", (j) => j.splice(j.indexOf(agg(j)), 1)],
    ["the gate failed", (j) => (j.find((x: any) => x.name === "changed-path detection").conclusion = "failure")],
    ["another job failed", (j) => (j.find((x: any) => x.name.startsWith("typecheck")).conclusion = "failure")],
    ["another job was cancelled", (j) => (j.find((x: any) => x.name.startsWith("typecheck")).conclusion = "cancelled")],
    ["another job is still in progress", (j) => ((j.find((x: any) => x.name.startsWith("typecheck")).status = "in_progress"), (j.find((x: any) => x.name.startsWith("typecheck")).conclusion = null))],
    ["the aggregator job itself was cancelled", (j) => (agg(j).conclusion = "cancelled")],
  ];
  for (const [label, edit] of cases) {
    it(`NOT a deferral: ${label}`, () => {
      expect(isDraftDeferral(D, { [D.id]: mutate(edit) })).toBe(false);
    });
  }
  it("NOT a deferral: the run was cancelled, timed out or has no listing, however the jobs look", () => {
    for (const c of ["cancelled", "timed_out", "startup_failure", "success", null]) {
      expect(isDraftDeferral({ ...D, conclusion: c }, { [D.id]: w.deferralJobs }), String(c)).toBe(false);
    }
    expect(isDraftDeferral(D, {})).toBe(false);
  });
});

describe("step 10: a draft deferral is superseded only by a newer ready run of this PR", () => {
  it("D-pos: deferral, then a green ready run after the ready event → SUCCEEDED", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()])))).toBe("SUCCEEDED");
  });
  it("D-no-newer: the deferral alone stays FAILED", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D()])))).toBe("FAILED");
  });
  it("a PR that is a draft now never supersedes", () => {
    const w = world();
    const r = bindCi(input(w, [w.D(), w.S()], {}, { key: { ...w.key, isDraft: true } }));
    expect(outcomeOf(r)).toBe("FAILED");
  });
  it("D-timeline-missing: no ready-for-review instant (null or absent) → FAILED, never malformed", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], {}, { readyAt: null })))).toBe("FAILED");
    const i: any = input(w, [w.D(), w.S()]);
    delete i.readyAt;
    expect(outcomeOf(bindCi(i))).toBe("FAILED");
  });
  it("(b) the ready event must be strictly after the deferral run: before it, or equal → FAILED", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], {}, { readyAt: "2026-11-13T14:10:00Z" })))).toBe("FAILED");
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], {}, { readyAt: T.deferral })))).toBe("FAILED");
  });
  it("(c) the superseder must be at or after the ready instant: equal counts, one second before does not", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ createdAt: T.ready })])))).toBe("SUCCEEDED");
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ createdAt: "2026-11-13T14:19:59Z" })])))).toBe("FAILED");
  });
  it("D-instant-compare: instants are compared as dates, not strings", () => {
    const w = world();
    // as strings "…:42Z" > "…:42.5Z" would call the run later; as instants it is half a second EARLIER → not a superseder
    const r = bindCi(input(w, [w.D(), w.S({ createdAt: "2026-11-13T14:23:42Z" })], {}, { readyAt: "2026-11-13T14:23:42.5Z" }));
    expect(outcomeOf(r)).toBe("FAILED");
  });
  it("D-pr-empty / D-pr-other: a superseder that lists no PR (a fork's run too), or another PR, cannot supersede", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ pullRequests: [] })])))).toBe("FAILED");
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ pullRequests: [801] })])))).toBe("FAILED");
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ pullRequests: [801, 800] })])))).toBe("SUCCEEDED");
  });
  it("a newer pending, failed, cancelled or timed-out run dominates the superseded deferral", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ status: "in_progress", conclusion: null })])))).toBe("PENDING");
    for (const c of ["failure", "cancelled", "timed_out"]) {
      expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ conclusion: c })], { 43459049200: w.green }))), c).toBe("FAILED");
    }
  });
  it("D-cancelled-draft-run: a draft run cancelled by the press-Ready concurrency cancel is NOT a deferral → FAILED (option C needed)", () => {
    const w = world();
    const cancelled = { ...w.D(), conclusion: "cancelled" };
    expect(outcomeOf(bindCi(input(w, [cancelled, w.S()])))).toBe("FAILED");
  });
  it("D-aggregator-fail-no-step: the aggregator failed alone, without a DRAFT-DEFERRED step → FAILED even with a newer success", () => {
    const w = world();
    const l = clone(w.deferralJobs);
    l.jobs.find((j: any) => j.name === "browser e2e (local stack)").steps = l.jobs.find((j: any) => j.name === "browser e2e (local stack)").steps.filter((s: any) => s.name !== "DRAFT-DEFERRED");
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], { [DEFERRAL_RUN]: l })))).toBe("FAILED");
  });
  it("D-other-job-failed: a real failure in the same run hides behind the deferral step → FAILED", () => {
    const w = world();
    const l = clone(w.deferralJobs);
    l.jobs.find((j: any) => j.name.startsWith("typecheck")).conclusion = "failure";
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], { [DEFERRAL_RUN]: l })))).toBe("FAILED");
  });
  it("D-earlier-failed-ready-run: a genuinely failed run before the green one still dominates", () => {
    const w = world();
    const failed = w.mk(43459049150, { conclusion: "failure", createdAt: "2026-11-13T14:21:00Z", runNumber: 5003 });
    expect(outcomeOf(bindCi(input(w, [w.D(), failed, w.S()], { 43459049150: w.green })))).toBe("FAILED");
  });
  it("D-two-deferrals-only: a deferral never supersedes another; a second deferral after Ready also blocks", () => {
    const w = world();
    const second = { ...w.D(), id: 43459049300, runNumber: 5004, createdAt: T.success };
    expect(outcomeOf(bindCi(input(w, [w.D(), second], { 43459049300: w.deferralJobs })))).toBe("FAILED");
    // D-rerun-deferral-after-ready: green ready run present, but a LATER deferral (a rerun of the draft event) is itself FAILED
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ createdAt: "2026-11-13T14:22:00Z" }), second], { 43459049300: w.deferralJobs })))).toBe("FAILED");
  });
  it("two older deferrals and one newer success → SUCCEEDED", () => {
    const w = world();
    const first = { ...w.D(), id: 43459049000, runNumber: 5000, createdAt: "2026-11-13T14:00:00Z" };
    expect(outcomeOf(bindCi(input(w, [first, w.D(), w.S()], { 43459049000: w.deferralJobs })))).toBe("SUCCEEDED");
  });
  it("the superseded run still counts for the history window (rule 8) and for applicableRunIds", () => {
    const w = world();
    const r = bindCi(input(w, [w.D(), w.S()]));
    expect([...r.value.applicableRunIds].sort()).toEqual([DEFERRAL_RUN, 43459049200].sort());
  });
  it("the superseding run is still held to every required job (INCOMPLETE when one is missing)", () => {
    const w = world();
    const thin = clone(w.green);
    thin.jobs = thin.jobs.filter((j: any) => j.name !== "browser e2e (local stack)");
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], { 43459049200: thin })))).toBe("INCOMPLETE");
  });
  it("classifier / fork guards still come first: a fork head is fork_head", () => {
    const w = world();
    expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], {}, { key: { ...w.key, headRepoId: 4242 } })))).toBe("fork_head");
  });
  it("a bad readyAt is malformed (the shape is closed)", () => {
    const w = world();
    for (const bad of ["yesterday", 5, "2026-11-13"]) {
      expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], {}, { readyAt: bad }))), String(bad)).toBe("malformed");
    }
  });
  it("D-malformed-pullrequests / D-malformed-steps at the record: wrong types are malformed", () => {
    const w = world();
    for (const bad of [undefined, "800", [0], [1.5], ["800"], null, [800, null]]) {
      expect(outcomeOf(bindCi(input(w, [w.D(), w.S({ pullRequests: bad })]))), JSON.stringify(bad)).toBe("malformed");
    }
    for (const bad of ["x", [{ number: 1 }], [{ number: 0, name: "a", status: "completed", conclusion: null }], 5]) {
      const l = clone(w.deferralJobs);
      l.jobs[0].steps = bad;
      expect(outcomeOf(bindCi(input(w, [w.D(), w.S()], { [DEFERRAL_RUN]: l }))), JSON.stringify(bad)).toBe("malformed");
    }
  });
});

describe("the strict readers", () => {
  const rawRuns = () => load("ci/runs-810.json");
  const parseRuns = (raw: any) => parseWorkflowRuns(raw, { workflowId: WORKFLOW });
  it("projects only the PR numbers from run.pull_requests, sorted and distinct", () => {
    const raw = clone(rawRuns());
    raw.workflow_runs[0].pull_requests = [{ number: 9, id: 1, url: "u" }, { number: 3 }, { number: 9 }];
    expect(parseRuns(raw).record.runs[0].pullRequests).toEqual([3, 9]);
  });
  it("D-malformed-pullrequests: a missing, non-array, or ill-typed pull_requests is malformed", () => {
    const bad: any[] = [undefined, null, "800", {}, [null], [5], [{}], [{ number: 0 }], [{ number: "1" }], [{ number: 1.5 }], [{ number: -1 }]];
    for (const b of bad) {
      const raw = clone(rawRuns());
      if (b === undefined) delete raw.workflow_runs[0].pull_requests;
      else raw.workflow_runs[0].pull_requests = b;
      expect(parseRuns(raw), JSON.stringify(b)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });
  it("D-created-vs-started: only created_at is read; run_started_at never changes what the record says", () => {
    const raw = clone(rawRuns());
    raw.workflow_runs[0].run_started_at = "2030-01-01T00:00:00Z";
    expect(parseRuns(raw)).toEqual(parseRuns(rawRuns()));
    expect(JSON.stringify(parseRuns(raw))).not.toContain("2030-01-01");
  });
  it("jobs: steps are parsed, ordered by number, and null when the listing carries none", () => {
    const rec = ok(parseRunJobs(DEFERRAL_JOBS, { runId: DEFERRAL_RUN }));
    const a = rec.jobs.find((j: any) => j.name === "browser e2e (local stack)");
    expect(a.steps.map((s: any) => [s.number, s.name, s.conclusion])).toEqual([
      [1, "Set up job", "success"],
      [2, "Fail closed on prerequisites", "success"],
      [3, "DRAFT-DEFERRED", "failure"],
      [4, "Aggregate browser shard results", "skipped"],
      [5, "Complete job", "success"],
    ]);
    const shard = rec.jobs.find((j: any) => j.name.startsWith("browser shard ${{"));
    expect(shard.steps).toEqual([]);
    const raw = clone(DEFERRAL_JOBS);
    delete raw.jobs[0].steps;
    expect(ok(parseRunJobs(raw, { runId: DEFERRAL_RUN })).jobs.some((j: any) => j.steps === null)).toBe(true);
  });
  it("D-malformed-steps: a present but ill-shaped steps is malformed", () => {
    const bads: any[] = ["x", {}, [null], [{ number: 1, name: "", status: "completed", conclusion: null }], [{ number: 0, name: "a", status: "completed", conclusion: null }], [{ number: 1, name: "a", status: 5, conclusion: null }], [{ number: 1, name: "a", status: "completed", conclusion: 5 }], [{ number: 1, name: "a", status: "completed", conclusion: null }, { number: 1, name: "b", status: "completed", conclusion: null }]];
    for (const b of bads) {
      const raw = clone(DEFERRAL_JOBS);
      raw.jobs[0].steps = b;
      expect(parseRunJobs(raw, { runId: DEFERRAL_RUN }), JSON.stringify(b)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });
  const prCtx = () => clone(load("base/pr-context-800.json"));
  const opts = { expectedNumber: 800 };
  it("PR context: the latest ready-for-review instant is read; no field, no nodes, or a bad timeline is null, never malformed", () => {
    expect(ok(parsePrContext(prCtx(), opts)).readyForReviewAt).toBe(null);
    const withReady = (rfr: any) => {
      const raw = prCtx();
      raw.data.repository.pullRequest.readyForReview = rfr;
      return parsePrContext(raw, opts);
    };
    expect(ok(withReady({ nodes: [{ createdAt: "2026-11-13T14:20:00Z" }] })).readyForReviewAt).toBe("2026-11-13T14:20:00Z");
    for (const bad of [{ nodes: [] }, { nodes: [{ createdAt: "a" }, { createdAt: "2026-11-13T14:20:00Z" }] }, { nodes: [{}] }, { nodes: [{ createdAt: "soon" }] }, { nodes: [{ createdAt: "2026-11-13T14:20:00Z", extra: 1 }] }, { nodes: null }, { nodes: [], extra: 1 }, null, "x", 5]) {
      const r = withReady(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(true);
      expect(r.record.readyForReviewAt, JSON.stringify(bad)).toBe(null);
    }
  });
});

describe("the spec text names what the code requires", () => {
  const spec = readFileSync(path.join(__dirname, "../../../scripts/eng/v2/SPEC-05A.md"), "utf8");
  const readme = readFileSync(path.join(__dirname, "../../../scripts/eng/v2/README.md"), "utf8");
  it("step 10 and the README state the deferral exception, its three clauses and the runner steps", () => {
    for (const phrase of ["Superseded draft deferral", "DRAFT-DEFERRED", "Complete job", "Set up job", "pullRequests", "never as strings", "recovery is a new head"]) {
      expect(spec, phrase).toContain(phrase);
    }
    expect(readme).toContain("SHEP-LATEST-01");
  });
});
