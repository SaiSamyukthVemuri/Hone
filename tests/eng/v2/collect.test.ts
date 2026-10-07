/* eslint-disable @typescript-eslint/no-explicit-any -- the collector is fed raw, untyped GitHub JSON on purpose */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collect } from "../../../scripts/eng/v2/adapter/collect.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { createReaders } from "../../../scripts/eng/v2/adapter/internal/github/index.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../scripts/classify-changes.mjs";
import {
  BASE_800,
  HEAD_800,
  REPO_PATH,
  RUN_800,
  clone,
  fakeGitHub,
  load,
  routes800,
  routes809,
  type Req,
  type Res,
  type Routes,
} from "./support/fake-github";

// ===========================================================================
// ENG-LOOP V1 05A: the collector (SPEC-05A §5). Recorded answers for #800 and
// #809 behind a STRICT fake transport, then fault injection at every request
// position of both passes. A collection either yields complete, confirmed,
// bound evidence or a closed UNKNOWN: never partial evidence.
// ===========================================================================

/** The shepherd's own CI definition, equal to production's at 6cdd830b (recorded blobs). */
const LOCAL = Object.freeze({
  classify,
  blobs: Object.freeze({
    ".github/workflows/ci.yml": load("blob/contents-ci.yml-6cdd830b.json").sha,
    "scripts/classify-changes.mjs": load("blob/contents-classify-changes.mjs-6cdd830b.json").sha,
  }),
  tablePinned: true,
});
const NOW = Date.parse("2026-10-07T21:00:00Z");

function run(routes: Routes, opts: { fault?: (req: Req, position: number) => Res | undefined; local?: any; pr?: number } = {}) {
  const gh = fakeGitHub(routes, opts.fault);
  const result = collect({
    prNumber: opts.pr ?? 800,
    readers: createReaders({ request: gh.request }),
    local: opts.local ?? LOCAL,
    now: () => NOW,
  });
  return { result, log: gh.log };
}

/** One pass for an open PR: K0, the twelve body reads, the jobs of the one successful run, K1. */
const PASS_800 = [
  "pr-key",
  "compare",
  "pr-context",
  "head-branch-prs",
  "branch-rules",
  "activity-force_push",
  "activity-branch_deletion",
  "activity-branch_creation",
  "candidate-runs",
  "review-evidence",
  "commit-rollup",
  "file-blob",
  "file-blob",
  "run-jobs",
  "pr-key",
];

describe("collect: #800 end to end (recorded answers)", () => {
  it("collects, confirms and binds every row, in exactly two passes of fifteen requests", () => {
    const { result, log } = run(routes800());
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject({ attempts: 1, confirmed: true, observedAt: "2026-10-07T21:00:00Z" });
    expect(result.evidence.key).toMatchObject({ prNumber: 800, state: "OPEN", isDraft: true, headSha: HEAD_800, baseSha: BASE_800 });
    expect(result.evidence.terminal).toBe(false);
    const { base, ci, reviews, external } = result.evidence.rows;
    expect(base.ok).toBe(true);
    expect(ci).toMatchObject({ ok: true, value: { outcome: "SUCCEEDED", applicableRunIds: [RUN_800] } });
    expect(reviews.ok).toBe(true);
    expect(external.ok).toBe(true);
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    // The fixed read order, twice: the confirming pass is a full pass.
    expect(log.map((r) => r.label)).toEqual([...PASS_800, ...PASS_800]);
    expect(Object.isFrozen(result.evidence.rows.ci)).toBe(true);
  });

  it("today's unprotected production: the CI row is base_history_unverified, and the other rows stand", () => {
    const { result } = run(routes800({ rules: load("base/rules-production-unprotected.json") }));
    expect(result.ok).toBe(true);
    expect(result.evidence.rows.ci).toMatchObject({ ok: false, reason: "base_history_unverified" });
    expect(result.evidence.rows.base.ok && result.evidence.rows.reviews.ok && result.evidence.rows.external.ok).toBe(true);
  });

  it("a merged PR reads its key only — four requests, no body and no rows", () => {
    const { result, log } = run(routes809(), { pr: 809 });
    expect(result).toMatchObject({ ok: true, evidence: { terminal: true, rows: null }, diagnostics: { confirmed: true } });
    expect(log.map((r) => r.label)).toEqual(["pr-key", "pr-key", "pr-key", "pr-key"]);
  });

  it("is deterministic, and GitHub's listing order never changes the evidence hash", () => {
    const a = run(routes800()).result;
    const b = run(routes800()).result;
    expect(b.evidenceHash).toBe(a.evidenceHash);
    const shuffled = routes800();
    const reviews = shuffled[`review-evidence {"n":800,"name":"Hone","owner":"SaiSamyukthVemuri"}`];
    expect(reviews).toBeDefined();
    shuffled[`review-evidence {"n":800,"name":"Hone","owner":"SaiSamyukthVemuri"}`] = (call) => {
      const raw: any = reviews(call);
      const p = raw.data.repository.pullRequest;
      for (const c of [p.reviews, p.comments, p.reviewThreads]) c.nodes.reverse();
      return raw;
    };
    const jobsRoute = `${REPO_PATH}/actions/runs/${RUN_800}/jobs?filter=latest&per_page=100`;
    shuffled[jobsRoute] = () => {
      const raw = load("ci/jobs-800.json");
      raw.jobs.reverse();
      return raw;
    };
    expect(run(shuffled).result.evidenceHash).toBe(a.evidenceHash);
  });

  it("the observation time is reported but never hashed: the same evidence later has the same hash", () => {
    const gh1 = fakeGitHub(routes800());
    const gh2 = fakeGitHub(routes800());
    const at = (ms: number, gh: ReturnType<typeof fakeGitHub>) =>
      collect({ prNumber: 800, readers: createReaders({ request: gh.request }), local: LOCAL, now: () => ms });
    const a = at(NOW, gh1);
    const b = at(NOW + 3_600_000, gh2);
    expect(b.evidence.observedAt).toBe("2026-10-07T22:00:00Z");
    expect(b.evidenceHash).toBe(a.evidenceHash);
  });

  it("jobs are read only for applicable successful runs: an unrelated run at the same SHA costs no request", () => {
    const routes = routes800();
    const runsRoute = `${REPO_PATH}/actions/workflows/289443461/runs?head_sha=${HEAD_800}&event=pull_request&per_page=100`;
    routes[runsRoute] = () => {
      const raw = load("ci/runs-800.json");
      const base = raw.workflow_runs[0];
      raw.workflow_runs.push(
        { ...clone(base), id: 11, run_number: 11, head_branch: "someone/else" },
        { ...clone(base), id: 12, run_number: 12, event: "push" },
        { ...clone(base), id: 13, run_number: 13, head_repository: { id: 999 } },
      );
      raw.total_count = raw.workflow_runs.length;
      return raw;
    };
    const { result, log } = run(routes);
    expect(result).toMatchObject({ ok: true, evidence: { rows: { ci: { ok: true, value: { outcome: "SUCCEEDED" } } } } });
    expect(log.filter((r) => r.label === "run-jobs").map((r) => r.rest)).toEqual([
      `${REPO_PATH}/actions/runs/${RUN_800}/jobs?filter=latest&per_page=100`,
      `${REPO_PATH}/actions/runs/${RUN_800}/jobs?filter=latest&per_page=100`,
    ]);
  });

  it("the evidence hash changes when the evidence does", () => {
    const a = run(routes800()).result;
    const routes = routes800();
    const rollupKey = `commit-rollup {"h":"${HEAD_800}","name":"Hone","owner":"SaiSamyukthVemuri"}`;
    const rollup = routes[rollupKey];
    routes[rollupKey] = (call) => {
      const raw: any = rollup(call);
      const status = raw.data.repository.object.statusCheckRollup.contexts.nodes.find((n: any) => n.__typename === "StatusContext");
      status.state = "PENDING";
      return raw;
    };
    const b = run(routes).result;
    expect(b.ok).toBe(true);
    expect(b.evidenceHash).not.toBe(a.evidenceHash);
  });
});

describe("collect: options outside the contract fail closed before any request", () => {
  it("null options, missing or partial local CI, incomplete readers or a bad clock: malformed, zero requests, no throw", () => {
    const gh = fakeGitHub(routes800());
    const readers = createReaders({ request: gh.request });
    const base = { prNumber: 800, readers, local: LOCAL, now: () => NOW };
    const variants: Array<[string, any]> = [
      ["null options", null],
      ["no options", undefined],
      ["prNumber 0", { ...base, prNumber: 0 }],
      ["no local", { ...base, local: undefined }],
      ["local without blobs", { ...base, local: { classify, tablePinned: true } }],
      ["local with a short blob", { ...base, local: { ...LOCAL, blobs: { ...LOCAL.blobs, "scripts/classify-changes.mjs": "abc" } } }],
      ["local without tablePinned", { ...base, local: { classify, blobs: LOCAL.blobs } }],
      ["readers missing one", { ...base, readers: { ...readers, readFileBlob: undefined } }],
      ["clock not a function", { ...base, now: 5 }],
      ["clock without a time", { ...base, now: () => Number.NaN }],
      ["clock returning a non-time string", { ...base, now: () => "not a time" }],
      ["clock returning an invalid Date", { ...base, now: () => new Date("x") }],
      ["clock returning a boolean", { ...base, now: () => true }],
      ["clock that throws", { ...base, now: () => { throw new Error("no clock"); } }],
    ];
    for (const [label, args] of variants) {
      expect(() => collect(args), label).not.toThrow();
      expect(collect(args), label).toMatchObject({ ok: false, reason: "malformed", stage: "collect" });
    }
    expect(gh.log).toHaveLength(0);
    // A clock may read as milliseconds, a Date, or an ISO-8601 UTC string: all three are the same time.
    for (const now of [() => NOW, () => new Date(NOW), () => "2026-10-07T21:00:00Z"]) {
      expect(collect({ ...base, readers: createReaders({ request: fakeGitHub(routes800()).request }), now }).evidence.observedAt).toBe(
        "2026-10-07T21:00:00Z",
      );
    }
  });

  it("the evidence hash covers the local CI definition the rows were bound with", () => {
    const a = run(routes800()).result;
    const other = { ...LOCAL, blobs: { ...LOCAL.blobs, "scripts/classify-changes.mjs": "1".repeat(40) } };
    const b = run(routes800(), { local: other }).result;
    expect(b.evidence.rows.ci).toMatchObject({ ok: false, reason: "ci_definition_mismatch" });
    expect(b.evidenceHash).not.toBe(a.evidenceHash);
    expect(run(routes800(), { local: { ...LOCAL, tablePinned: false } }).result.evidenceHash).not.toBe(a.evidenceHash);
  });
});

describe("collect: fault injection at every request of both passes", () => {
  const positions = Array.from({ length: 30 }, (_, i) => i + 1);

  it("an interruption anywhere is read_failed naming the reader — never partial evidence", () => {
    for (const at of positions) {
      const { result } = run(routes800(), {
        fault: (req, position) =>
          position === at ? { ok: false, reason: "read_failed", detail: `${req.label}: gh: Bad Gateway (HTTP 502)` } : undefined,
      });
      expect(result.ok, `position ${at}`).toBe(false);
      expect(result.reason, `position ${at}`).toBe("read_failed");
      expect(result.detail, `position ${at}`).toContain(PASS_800[(at - 1) % 15]);
      expect(result.stage, `position ${at}`).toBe(at <= 15 ? "collect" : "confirm");
      expect(result).not.toHaveProperty("evidence");
    }
  });

  it("a malformed answer anywhere is malformed", () => {
    for (const at of positions) {
      const { result } = run(routes800(), { fault: (_req, position) => (position === at ? { ok: true, body: {} } : undefined) });
      expect(result, `position ${at}`).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("a transport that throws is read_failed, never an exception", () => {
    for (const at of [1, 2, 9, 14, 15, 16, 30]) {
      const fault = (_req: Req, position: number): Res | undefined => {
        if (position === at) throw new Error("socket hang up");
        return undefined;
      };
      expect(() => run(routes800(), { fault })).not.toThrow();
      expect(run(routes800(), { fault }).result, `position ${at}`).toMatchObject({ ok: false, reason: "read_failed" });
    }
  });

  it("a missing permission names the endpoint and the HTTP status", () => {
    const { result } = run(routes800(), {
      fault: (req) =>
        req.label === "candidate-runs"
          ? { ok: false, reason: "read_failed", detail: "candidate-runs: gh: Resource not accessible by personal access token (HTTP 403)" }
          : undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: "read_failed", stage: "collect" });
    expect(result.detail).toContain("candidate-runs");
    expect(result.detail).toContain("HTTP 403");
  });

  const keyRoute = `pr-key {"n":800,"name":"Hone","owner":"SaiSamyukthVemuri"}`;
  /** #800's key with the draft flag chosen per key read (1-based). */
  const draftBy = (isDraft: (call: number) => boolean): Routes => {
    const routes = routes800();
    routes[keyRoute] = (call) => {
      const raw = load("pr-key/pr-800-open-draft.json");
      raw.data.repository.pullRequest.isDraft = isDraft(call);
      return raw;
    };
    return routes;
  };

  it("a draft toggle inside the first pass uses the one retry, then confirms", () => {
    const { result } = run(draftBy((call) => call === 1));
    expect(result).toMatchObject({ ok: true, diagnostics: { attempts: 2, confirmed: true } });
    expect(result.evidence.key.isDraft).toBe(false);
  });

  it("a key that keeps moving is pr_key_moved", () => {
    const { result } = run(draftBy((call) => call % 2 === 1));
    expect(result).toMatchObject({ ok: false, reason: "pr_key_moved", stage: "collect", diagnostics: { attempts: 2 } });
  });

  it("a key change between the passes is pr_key_moved at the confirming pass, never unstable_snapshot", () => {
    const { result } = run(draftBy((call) => call <= 2));
    expect(result).toMatchObject({ ok: false, reason: "pr_key_moved", stage: "confirm" });
  });

  it("CI evidence that changes between the passes is unstable_snapshot, naming what changed", () => {
    const routes = routes800();
    const runsRoute = `${REPO_PATH}/actions/workflows/289443461/runs?head_sha=${HEAD_800}&event=pull_request&per_page=100`;
    routes[runsRoute] = (call) => {
      const raw = load("ci/runs-800.json");
      if (call === 1) Object.assign(raw.workflow_runs[0], { status: "in_progress", conclusion: null });
      return raw;
    };
    const { result, log } = run(routes);
    expect(result).toMatchObject({ ok: false, reason: "unstable_snapshot", stage: "confirm" });
    expect(result.diagnostics.changedFields).toEqual(["jobsByRunId", "runs"]);
    // The in-progress run's jobs were never read in the first pass.
    expect(log.slice(0, 14).some((r) => r.label === "run-jobs")).toBe(false);
  });

  it("a review comment posted between the passes is unstable_snapshot", () => {
    const routes = routes800();
    const reviewKey = `review-evidence {"n":800,"name":"Hone","owner":"SaiSamyukthVemuri"}`;
    routes[reviewKey] = (call) => {
      const raw = load("review/review-800.json");
      if (call === 2) {
        const comments = raw.data.repository.pullRequest.comments;
        comments.nodes.push({ ...clone(comments.nodes[0]), databaseId: 1 });
        comments.totalCount += 1;
      }
      return raw;
    };
    const { result } = run(routes);
    expect(result).toMatchObject({ ok: false, reason: "unstable_snapshot", diagnostics: { changedFields: ["reviewEvidence"] } });
  });

  it("a shepherd whose classifier or ci.yml is not production's cannot certify CI: ci_definition_mismatch", () => {
    const wrongClassifier = { ...LOCAL, blobs: { ...LOCAL.blobs, "scripts/classify-changes.mjs": "0".repeat(40) } };
    const wrongCiYml = { ...LOCAL, blobs: { ...LOCAL.blobs, ".github/workflows/ci.yml": "0".repeat(40) } };
    const unpinned = { ...LOCAL, tablePinned: false };
    for (const local of [wrongClassifier, wrongCiYml, unpinned]) {
      const { result } = run(routes800(), { local });
      expect(result.ok).toBe(true);
      expect(result.evidence.rows.ci).toMatchObject({ ok: false, reason: "ci_definition_mismatch" });
      expect(result.evidence.rows.base.ok && result.evidence.rows.reviews.ok).toBe(true);
    }
    const throwing = { ...LOCAL, classify: () => { throw new Error("broken classifier"); } };
    expect(run(routes800(), { local: throwing }).result.evidence.rows.ci).toMatchObject({ reason: "ci_definition_mismatch" });
  });
});
