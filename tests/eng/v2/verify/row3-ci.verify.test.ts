/* eslint-disable @typescript-eslint/no-explicit-any -- the verifier feeds raw, untyped GitHub answers to the parsers on purpose */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
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
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../../scripts/classify-changes.mjs";
import { canon, clone, deepFreeze, isDeepFrozen, noThrow } from "./support/deep";
import { pick, purityViolations, sprinkle } from "./support/parser-props";
import { evaluate, type Impl } from "./support/pipeline";
import { rng } from "./support/prng";
import { SCENARIOS, matches, orderScenarios, show, type Scenario } from "./support/scenarios";
import { modelRequiredJobs } from "./support/spec-model";
import { H810, JOB, REAL, REAL_810_FILES, RUN_810, WORKFLOW_ID, ownRun, sha40, type World } from "./support/world";

// ===========================================================================
// INDEPENDENT VERIFIER — ENG-LOOP V1 05A row 3: applicable CI, the V1 model.
// Oracle: SPEC-05A §3 (b5f3affb), CAP-01 §4/§15 (the single-response listing law,
// fixtures L1-L9) and CI-ATTEST-01 §5 (the closed run-state table). Scenario rows
// carry their own provenance (real / synthetic) and negative-control label.
// ===========================================================================

const IMPL: Impl = {
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

const failsWith = (r: any, reasons: string[], label = "") => {
  expect(r?.ok, `${label} should fail closed`).toBe(false);
  expect(reasons, `${label}: got ${JSON.stringify(r?.reason)}`).toContain(r?.reason);
  expect(isUnknownReason(r?.reason)).toBe(true);
};
const realRuns = () => REAL.verify("runs-810-pull-request.json");
const realPushRuns = () => REAL.verify("runs-6cdd830b-push.json");
const realJobsRaw = () => REAL.verify("jobs-810-run-latest.json");
const runsOf = (runs: any[], total = runs.length) => ({ total_count: total, workflow_runs: runs });
const runN = (i: number, over: any = {}) => ({ ...clone(realRuns().workflow_runs[0]), id: 40_000_000_000 + i, run_number: 5000 + i, ...over });
const P = { workflowId: WORKFLOW_ID, headSha: H810 };

// ---------------------------------------------------------------------------
// §3.1 parseWorkflowRuns — CAP-01 single-response listing law
// ---------------------------------------------------------------------------
describe("row 3 verify: parseWorkflowRuns (§3.1, CAP-01 L1-L9)", () => {
  it("real answers parse: #810's pull_request run and production's push run (the parser does not filter)", () => {
    expect(parseWorkflowRuns(realRuns(), P).ok).toBe(true);
    expect(parseWorkflowRuns(realPushRuns(), { workflowId: WORKFLOW_ID, headSha: "6cdd830b0bcc5e3532016bc612bd0298db3533fb" }).ok).toBe(true);
  });

  it("the record never carries pull_requests, display_title or head_commit (CAP-01 §4: raw fields stay in the transport)", () => {
    const r = parseWorkflowRuns(realRuns(), P);
    const s = canon(r.record);
    for (const leak of ["pull_requests", "pullRequests", "display_title", "displayTitle", "head_commit", "headCommit", "/pulls/810"])
      expect(s.includes(leak), leak).toBe(false);
    expect(s.includes(realRuns().workflow_runs[0].display_title), "the run's title text").toBe(false);
  });

  it("L1/L2: an empty listing and a full one of 100 are complete", () => {
    expect(parseWorkflowRuns(runsOf([]), P).ok).toBe(true);
    expect(parseWorkflowRuns(runsOf(Array.from({ length: 100 }, (_, i) => runN(i))), P).ok).toBe(true);
  });

  it("L3: 100 runs with total_count 101 is ci_candidate_listing_too_large", () => {
    failsWith(parseWorkflowRuns(runsOf(Array.from({ length: 100 }, (_, i) => runN(i)), 101), P), ["ci_candidate_listing_too_large"]);
  });

  it("L4: a total_count that differs from the runs returned fails closed (SPEC says malformed, CAP-01 L4 says too_large)", () => {
    failsWith(parseWorkflowRuns(runsOf([runN(1)], 2), P), ["ci_candidate_listing_too_large", "malformed"], "1 of 2");
    failsWith(parseWorkflowRuns(runsOf([runN(1), runN(2)], 1), P), ["ci_candidate_listing_too_large", "malformed"], "2 of 1");
  });

  it("L5/L6: a duplicated run id or run_number is malformed", () => {
    failsWith(parseWorkflowRuns(runsOf([runN(1), runN(2, { id: runN(1).id })]), P), ["malformed"], "same id");
    failsWith(parseWorkflowRuns(runsOf([runN(1), runN(2, { run_number: runN(1).run_number })]), P), ["malformed"], "same run_number");
  });

  it("L7: any reordering of a valid listing gives the same normalized listing", () => {
    const runs = Array.from({ length: 7 }, (_, i) => runN(i));
    const a = parseWorkflowRuns(runsOf(runs), P);
    const r = rng(0x17);
    for (let k = 0; k < 10; k++) expect(canon(parseWorkflowRuns(runsOf(r.shuffle(runs)), P))).toBe(canon(a));
  });

  it("L9: a bad total_count, a missing or non-array workflow_runs, or a run outside the schema is malformed", () => {
    const envelopes: Array<[string, unknown]> = [
      ["total_count -1", { total_count: -1, workflow_runs: [] }],
      ["total_count '1'", { total_count: "1", workflow_runs: [runN(1)] }],
      ["total_count 1.5", { total_count: 1.5, workflow_runs: [runN(1)] }],
      ["total_count missing", { workflow_runs: [runN(1)] }],
      ["workflow_runs missing", { total_count: 0 }],
      ["workflow_runs null", { total_count: 0, workflow_runs: null }],
      ["workflow_runs an object", { total_count: 1, workflow_runs: { 0: runN(1) } }],
      ["a null run", { total_count: 1, workflow_runs: [null] }],
      ["an array answer", [runN(1)]],
    ];
    for (const [label, raw] of envelopes) failsWith(parseWorkflowRuns(raw, P), ["malformed"], label);
    const fields: Array<[string, any]> = [
      ["id 0", { id: 0 }],
      ["id '1'", { id: "1" }],
      ["run_number 0", { run_number: 0 }],
      ["run_number missing", { run_number: undefined }],
      ["workflow_id 0", { workflow_id: 0 }],
      ["workflow_id '289443461'", { workflow_id: "289443461" }],
      ["event 5", { event: 5 }],
      ["event null", { event: null }],
      ["head_sha 39 hex", { head_sha: H810.slice(1) }],
      ["head_sha 'main'", { head_sha: "main" }],
      ["head_branch 5", { head_branch: 5 }],
      ["head_repository {}", { head_repository: {} }],
      ["head_repository { id: 0 }", { head_repository: { id: 0 } }],
      ["head_repository { id: '1240764106' }", { head_repository: { id: "1240764106" } }],
      ["status 5", { status: 5 }],
      ["status null", { status: null }],
      ["conclusion 5", { conclusion: 5 }],
      ["run_attempt 0", { run_attempt: 0 }],
      ["run_attempt missing", { run_attempt: undefined }],
      ["run_attempt 1.5", { run_attempt: 1.5 }],
      ["created_at 'yesterday'", { created_at: "yesterday" }],
      ["created_at null", { created_at: null }],
      ["created_at month 13", { created_at: "2026-13-07T20:16:44Z" }],
      ["created_at 23:59:60 (NaN to Date.parse)", { created_at: "2026-10-07T23:59:60Z" }],
    ];
    for (const [label, over] of fields) failsWith(parseWorkflowRuns(runsOf([runN(1, over)]), P), ["malformed"], label);
  });

  it("null head_branch, null head_repository and null conclusion are allowed", () => {
    expect(parseWorkflowRuns(runsOf([runN(1, { head_branch: null, head_repository: null, conclusion: null, status: "queued" })]), P).ok).toBe(true);
  });

  it("REST: stripped to consumed fields or sprinkled with new ones, the record is the same", () => {
    const shape = {
      total_count: true,
      workflow_runs: [
        {
          id: true,
          run_number: true,
          workflow_id: true,
          event: true,
          head_sha: true,
          head_branch: true,
          head_repository: { id: true },
          status: true,
          conclusion: true,
          run_attempt: true,
          created_at: true,
        },
      ],
    };
    const full = parseWorkflowRuns(realRuns(), P);
    expect(parseWorkflowRuns(pick(realRuns(), shape), P)).toEqual(full);
    expect(parseWorkflowRuns(sprinkle(realRuns()), P)).toEqual(full);
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseWorkflowRuns, realRuns(), P)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3.2 parseRunJobs
// ---------------------------------------------------------------------------
describe("row 3 verify: parseRunJobs (§3.2)", () => {
  const job = (i: number, over: any = {}) => ({ ...clone(realJobsRaw().jobs[0]), id: 1_000 + i, name: `job ${i}`, ...over });

  it("real answer: #810's eight latest-attempt jobs", () => {
    expect(parseRunJobs(realJobsRaw(), { runId: RUN_810 }).ok).toBe(true);
  });

  it("a listing for another run is malformed", () => {
    failsWith(parseRunJobs(realJobsRaw(), { runId: RUN_810 + 1 }), ["malformed"]);
  });

  it("101 jobs is ci_candidate_listing_too_large; a count that differs fails closed", () => {
    failsWith(parseRunJobs({ total_count: 101, jobs: Array.from({ length: 100 }, (_, i) => job(i)) }, { runId: RUN_810 }), ["ci_candidate_listing_too_large"]);
    failsWith(parseRunJobs({ ...realJobsRaw(), total_count: 9 }, { runId: RUN_810 }), ["ci_candidate_listing_too_large", "malformed"], "9 vs 8");
  });

  it("violations are malformed", () => {
    for (const [label, over] of [
      ["name ''", { name: "" }],
      ["name missing", { name: undefined }],
      ["name 5", { name: 5 }],
      ["run_id '37680787947'", { run_id: String(RUN_810) }],
      ["status 5", { status: 5 }],
      ["status null", { status: null }],
      ["conclusion 5", { conclusion: 5 }],
    ] as const)
      failsWith(parseRunJobs({ total_count: 1, jobs: [job(1, over)] }, { runId: RUN_810 }), ["malformed"], label);
    for (const [label, raw] of [
      ["jobs missing", { total_count: 0 }],
      ["jobs null", { total_count: 0, jobs: null }],
      ["total_count missing", { jobs: [] }],
      ["null", null],
    ] as const)
      failsWith(parseRunJobs(raw, { runId: RUN_810 }), ["malformed"], label);
  });

  it("a null conclusion is allowed", () => {
    expect(parseRunJobs({ total_count: 1, jobs: [job(1, { status: "in_progress", conclusion: null })] }, { runId: RUN_810 }).ok).toBe(true);
  });

  it("REST: stripped to consumed fields or sprinkled with new ones, the result is the same", () => {
    const full = parseRunJobs(realJobsRaw(), { runId: RUN_810 });
    expect(parseRunJobs(pick(realJobsRaw(), { total_count: true, jobs: [{ name: true, run_id: true, status: true, conclusion: true }] }), { runId: RUN_810 })).toEqual(full);
    expect(parseRunJobs(sprinkle(realJobsRaw()), { runId: RUN_810 })).toEqual(full);
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseRunJobs, realJobsRaw(), { runId: RUN_810 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3.3 requiredJobs
// ---------------------------------------------------------------------------
describe("row 3 verify: requiredJobs (§3.3)", () => {
  const FLAGS = ["docs_only", "database", "security", "full_matrix_required", "payment", "mobile", "google_calendar"];

  it("matches the §3.3 table on all 128 combinations of its seven flags", () => {
    const bad: string[] = [];
    for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
      const c: Record<string, boolean> = { application: true, browser_core: false, ci_workflows: false };
      FLAGS.forEach((f, i) => (c[f] = Boolean(mask & (1 << i))));
      const got = [...requiredJobs(c)].sort();
      const want = modelRequiredJobs(c);
      if (canon(got) !== canon(want)) bad.push(`${canon(c)}: got ${canon(got)}, required ${canon(want)}`);
    }
    expect(bad).toEqual([]);
  });

  it("every name it can require is a job name in this tree's .github/workflows/ci.yml, verbatim", () => {
    const ciYml = readFileSync(path.join(__dirname, "..", "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    const names = new Set([...ciYml.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim()));
    const all = new Set<string>();
    for (const f of FLAGS) for (const n of requiredJobs({ [f]: true, docs_only: f === "docs_only" })) all.add(n);
    for (const n of requiredJobs({ full_matrix_required: true })) all.add(n);
    expect([...all].sort()).toEqual(Object.values(JOB).sort());
    for (const n of all) expect(names.has(n), n).toBe(true);
  });

  it("production's own classify() of #810's real changed files requires changed-path detection, the aggregator and validate", () => {
    expect([...requiredJobs(classify(REAL_810_FILES))].sort()).toEqual([JOB.aggregator, JOB.changes, JOB.validate].sort());
  });
});

// ---------------------------------------------------------------------------
// §3.4 bindCi — the scenario table, through the real parsers and binders
// ---------------------------------------------------------------------------
const label = (s: Scenario) => `${s.id}${s.nc ? ` [${s.nc}]` : ""}${s.rule !== undefined ? ` (rule ${s.rule})` : ""}: ${s.title} — ${s.source}`;

describe("row 3 verify: bindCi scenario table (§3.4, §3.5 negative controls NC1-NC6)", () => {
  for (const s of SCENARIOS) {
    it(label(s), () => {
      const e = evaluate(s.world(), IMPL);
      expect(
        matches(e.result, s.expect),
        `required ${show(s.expect)}; got ${e.result.ok ? `${e.result.outcome} ${JSON.stringify(e.result.runs)}` : `UNKNOWN(${e.result.reason})`} at ${e.stage}${s.note ? `\nnote: ${s.note}` : ""}`,
      ).toBe(true);
    });
  }
});

describe("row 3 verify: rule order — the first rule that fires decides (55 pairs, 40 random 3-5 sets)", () => {
  it("every combination of injected faults is decided by its lowest-numbered rule", () => {
    const bad: string[] = [];
    for (const s of orderScenarios()) {
      const e = evaluate(s.world(), IMPL);
      if (!matches(e.result, s.expect))
        bad.push(`${s.id}: required ${show(s.expect)}, got ${e.result.ok ? `${e.result.outcome}` : `UNKNOWN(${e.result.reason})`} at ${e.stage}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3.4 bindCi — metamorphic properties
// ---------------------------------------------------------------------------
describe("row 3 verify: bindCi metamorphic properties", () => {
  const outcome = (w: World) => {
    const r = evaluate(w, IMPL).result;
    return r.ok ? { ok: true, outcome: r.outcome, runs: [...r.runs].sort((a, b) => a - b) } : r;
  };

  it("the order of runs and of jobs in GitHub's answers never matters", () => {
    const r = rng(0x0dde);
    const bad: string[] = [];
    for (const s of SCENARIOS) {
      const want = canon(outcome(s.world()));
      for (let k = 0; k < 3; k++) {
        const w = s.world();
        w.runs = r.shuffle(w.runs);
        for (const id of Object.keys(w.jobs)) {
          const js = w.jobs[Number(id)];
          if (Array.isArray(js)) w.jobs[Number(id)] = r.shuffle(js);
        }
        const got = canon(outcome(w));
        if (got !== want) bad.push(`${s.id}: ${want} became ${got}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("adding runs that are not applicable — any state, any kind — never changes the result", () => {
    const r = rng(0x1601);
    const kinds: Array<(i: number) => any> = [
      (i) => ({ workflowId: WORKFLOW_ID + 7, id: 41_000_000_000 + i }),
      (i) => ({ event: r.pick(["push", "pull_request_target", "merge_group", "workflow_dispatch", "schedule"]), id: 41_000_000_000 + i }),
      (i) => ({ headRepoId: r.pick([null, 4242]), id: 41_000_000_000 + i }),
      (i) => ({ headBranch: r.pick([null, "feat/elsewhere"]), id: 41_000_000_000 + i }),
      (i) => ({ headSha: sha40(0xabc000 + i), id: 41_000_000_000 + i }),
    ];
    const bad: string[] = [];
    for (const s of SCENARIOS) {
      const want = canon(outcome(s.world()));
      const w = s.world();
      const n = 1 + r.int(4);
      for (let i = 0; i < n; i++) {
        const status = r.pick(["completed", "queued", "in_progress", "exploded"]);
        w.runs.push(
          ownRun({
            runNumber: 9000 + i,
            status,
            conclusion: status === "completed" ? r.pick(["success", "failure", null, "weird"]) : null,
            createdAt: r.pick(["2026-10-07T23:00:00Z", "2025-01-01T00:00:00Z", "2026-10-07T20:16:44Z"]),
            ...r.pick(kinds)(i),
          }),
        );
      }
      const got = canon(outcome(w));
      if (got !== want) bad.push(`${s.id}: ${want} became ${got} with ${n} unrelated run(s)`);
    }
    expect(bad).toEqual([]);
  });

  it("adding rewrites strictly before the earliest applicable run never changes the result", () => {
    const bad: string[] = [];
    for (const s of SCENARIOS) {
      const w0 = s.world();
      if (w0.activity.forcePush.length > 90 || w0.activity.branchDeletion.length > 90) continue;
      const times = w0.runs.map((x) => Date.parse(x.createdAt)).filter((t) => !Number.isNaN(t));
      if (times.length === 0) continue;
      const before = new Date(Math.min(...times) - 3_600_000).toISOString().replace(".000Z", "Z");
      const want = canon(outcome(w0));
      const w = s.world();
      w.activity.forcePush.push({ timestamp: before, before: sha40(1), after: sha40(2) });
      w.activity.branchDeletion.push({ timestamp: before, before: sha40(3), after: "0".repeat(40) });
      const got = canon(outcome(w));
      if (got !== want) bad.push(`${s.id}: ${want} became ${got}`);
    }
    expect(bad).toEqual([]);
  });

  it("is pure: deep-frozen arguments give the same result, nothing throws, and the value is deeply frozen", () => {
    const bad: string[] = [];
    for (const s of SCENARIOS) {
      const e = evaluate(s.world(), IMPL);
      if (!e.bindCiArgs) continue;
      const again = noThrow(() => bindCi(deepFreeze(clone(e.bindCiArgs))));
      if (again.threw) bad.push(`${s.id}: threw on frozen args`);
      else {
        const a = (again as any).value;
        const r = a.ok ? { ok: true, outcome: a.value.outcome, runs: [...a.value.applicableRunIds].sort() } : { ok: false, reason: a.reason };
        const want = e.result.ok ? { ok: true, outcome: e.result.outcome, runs: [...e.result.runs].sort() } : e.result;
        if (canon(r) !== canon(want)) bad.push(`${s.id}: ${canon(want)} vs frozen ${canon(r)}`);
        if (a.ok && !isDeepFrozen(a.value)) bad.push(`${s.id}: value not deeply frozen`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("missing inputs fail closed with a closed reason and never throw", () => {
    const e = evaluate(SCENARIOS[0].world(), IMPL);
    const args = e.bindCiArgs;
    for (const k of Object.keys(args)) {
      const out = noThrow(() => bindCi({ ...args, [k]: undefined }));
      expect(out.threw, `${k} undefined: threw ${(out as any).error}`).toBe(false);
      const v = (out as any).value;
      expect(v?.ok === true && v.value?.outcome === "SUCCEEDED", `${k} undefined still SUCCEEDED`).toBe(false);
    }
  });
});
