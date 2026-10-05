import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { AUTHORIZED, COMPLETE, INCOMPLETE, UNKNOWN, evidence, mayAssertPositive } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { CI_WORKFLOW, isConfiguredRun, latestApplicableRun, resolveWorkflowIdentity, selectHeadRun, selectStreakRuns } from "../../scripts/eng/workflow-identity.mjs";

// ===========================================================================
// ENG-LOOP-03 acceptance: the repository's CI workflow is a workflow ID.
// ===========================================================================
//
// PR #795 matched CI runs by string equality on `path`, which GitHub documents
// only as "the full path of the workflow" - with ref-qualified examples. A valid
// CI run could be missed and read as "no CI yet". What is proved here:
//
//   1. the configured ci.yml is resolved ONCE, by GitHub, to its workflow id,
//      and a missing or malformed identity fails CLOSED - UNKNOWN, never "no CI";
//   2. every path form of the configured workflow - plain, ref-qualified,
//      owner-qualified, renamed under the same id - selects the same run;
//   3. a similarly named workflow with another id never matches, not even one
//      whose path is byte-identical;
//   4. unrelated workflows and events never affect the result: a seeded
//      property test against the rule restated independently;
//   5. exact-head selection: the latest applicable pull_request run at the
//      exact head, in any listing order, bound to that head;
//   6. the failure streak's selection IS the exact-head selection, per head;
//   7. read-only, single-shot, and blind to external checks by construction.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Live on 2026-10-05 (`gh api repos/SaiSamyukthVemuri/Hone/actions/workflows`). */
const CI_ID = 289443461;
const NIGHTLY_ID = 325801278;
/** A workflow this repository does not have. */
const OTHER_ID = 777000111;
const CI_PATH = ".github/workflows/ci.yml";

const sha = (seed: string): string => createHash("sha1").update(seed).digest("hex");
const H = sha("head");
const [H1, H2, H3] = [sha("h1"), sha("h2"), sha("h3")];

/** A workflow run as GitHub lists it; the field names were checked live on this repository. */
const run = (id: number, over: Json = {}): Json => ({
  id,
  name: "ci",
  workflow_id: CI_ID,
  path: CI_PATH,
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  head_sha: H,
  run_attempt: 1,
  ...over,
});

/** A fetcher that gives one answer to everything and records every request. */
function fetcherFor(answer: Json, calls: Json[] = []) {
  return (...args: Json[]) => {
    calls.push(args);
    return answer;
  };
}
const workflowAnswer = (over: Json = {}) => ({
  ok: true,
  data: { id: CI_ID, node_id: "W_kwDOci", name: "ci", path: CI_PATH, state: "active", ...over },
});
const ID = resolveWorkflowIdentity({ fetcher: fetcherFor(workflowAnswer()) });

const headId = (runs: Json[], head = H) => {
  const r = selectHeadRun({ identity: ID, runs, head });
  return mayAssertPositive(r) ? (r.value?.id ?? null) : UNKNOWN;
};

/** Every form GitHub may print for THE configured workflow - same id. */
const FORMS: Array<string | undefined> = [
  CI_PATH,
  `${CI_PATH}@main`,
  `${CI_PATH}@refs/heads/feat/eng-loop-03-workflow-identity`,
  `${CI_PATH}@refs/pull/798/merge`,
  `SaiSamyukthVemuri/Hone/${CI_PATH}@main`,
  // GitHub's own example for this field.
  `octocat/octo-repo/${CI_PATH}@main`,
  // Renamed, if GitHub keeps the workflow's id across it.
  ".github/workflows/continuous-integration.yml",
  // Absent: a decision never needs it.
  undefined,
];

/** Workflows that are NOT the configured one, however they are named. */
const LOOKALIKES: Array<[string, number]> = [
  [CI_PATH, OTHER_ID],
  [`${CI_PATH}@main`, OTHER_ID],
  [".github/workflows/ci.yaml", OTHER_ID],
  [".github/workflows/ci.yml.bak", OTHER_ID],
  [".github/workflows/nightly-ci.yml", OTHER_ID],
  [`other-org/other-repo/${CI_PATH}@main`, OTHER_ID],
  [".github/workflows/nightly.yml", NIGHTLY_ID],
];

function seeded(seed: number) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  return { rand, pick };
}

/** A random run set: mixed workflows, events, path forms, outcomes and order. */
function randomRuns(r: ReturnType<typeof seeded>, heads: string[]): Json[] {
  const ids = [...new Set(Array.from({ length: 2 + Math.floor(r.rand() * 7) }, () => 1000 + Math.floor(r.rand() * 9000)))];
  const runs = ids.map((id) => {
    const [status, conclusion] = r.pick<[string, string | null]>([
      ["completed", "success"],
      ["completed", "failure"],
      ["completed", "cancelled"],
      ["in_progress", null],
      ["queued", null],
    ]);
    const workflowId = r.pick([CI_ID, CI_ID, NIGHTLY_ID, OTHER_ID]);
    const p = workflowId === CI_ID ? r.pick(FORMS) : r.pick(LOOKALIKES)[0];
    return run(id, {
      workflow_id: workflowId,
      path: p,
      event: r.pick(["pull_request", "pull_request", "push", "schedule", "workflow_dispatch"]),
      status,
      conclusion,
      head_sha: r.pick(heads),
    });
  });
  return runs.sort(() => r.rand() - 0.5);
}

/** The rule, restated independently of the code under test. */
const expectedAt = (runs: Json[], head: string): number | null => {
  const ok = runs.filter((x) => x.head_sha === head && x.workflow_id === CI_ID && x.event === "pull_request");
  return ok.length ? Math.max(...ok.map((x) => x.id)) : null;
};

// ---------------------------------------------------------------------------
// 1. resolved once, by identity; fails closed
// ---------------------------------------------------------------------------

describe("1. the configured CI workflow is resolved once, by identity, and fails closed", () => {
  it("resolves .github/workflows/ci.yml to its workflow id with ONE bare GET of the file name", () => {
    const calls: Json[] = [];
    const identity = resolveWorkflowIdentity({ fetcher: fetcherFor(workflowAnswer(), calls) });
    expect(mayAssertPositive(identity)).toBe(true);
    expect(identity.value).toEqual({ id: CI_ID, event: "pull_request", file: CI_PATH });
    // No method, no fields, no pagination: a GET of exactly one resource.
    expect(calls).toEqual([["repos/{repo}/actions/workflows/ci.yml"]]);
    expect(CI_WORKFLOW).toEqual({ file: CI_PATH, event: "pull_request" });
  });

  it("a failed, empty or malformed answer is UNKNOWN - never an identity", () => {
    const answers: Json[] = [
      { ok: false, reason: "HTTP 404: Not Found" },
      undefined,
      null,
      { ok: "true", data: { id: CI_ID } },
      { ok: true, data: null },
      { ok: true, data: [] },
      { ok: true, data: "ci.yml" },
      { ok: true, data: {} },
      { ok: true, data: { id: String(CI_ID) } },
      { ok: true, data: { id: 0 } },
      { ok: true, data: { id: -1 } },
      { ok: true, data: { id: 1.5 } },
      { ok: true, data: { id: null } },
      { ok: true, data: { id: 2 ** 60 } },
    ];
    for (const answer of answers) {
      const identity = resolveWorkflowIdentity({ fetcher: fetcherFor(answer) });
      expect({ answer, positive: mayAssertPositive(identity), value: identity.value }).toEqual({ answer, positive: false, value: UNKNOWN });
    }
  });

  it("every selection made without a usable identity is UNKNOWN - never 'no CI run'", () => {
    const unusable: Json[] = [
      resolveWorkflowIdentity({ fetcher: fetcherFor({ ok: false, reason: "HTTP 502" }) }),
      resolveWorkflowIdentity({ fetcher: fetcherFor({ ok: true, data: { id: "289443461" } }) }),
      evidence({ id: CI_ID, event: "pull_request" }, { completeness: INCOMPLETE, authority: AUTHORIZED, reason: "partial" }),
      evidence({ id: CI_ID, event: "pull_request" }, { completeness: COMPLETE, authority: UNKNOWN, reason: "unauthorized" }),
      undefined,
    ];
    for (const identity of unusable) {
      expect(selectHeadRun({ identity, runs: [run(3003)], head: H }).value).toBe(UNKNOWN);
      expect(selectStreakRuns({ identity, runs: [run(3003)], heads: [H] }).value).toBe(UNKNOWN);
    }
    // Contrast: with an identity, the absence of a run is a KNOWN fact.
    const none = selectHeadRun({ identity: ID, runs: [], head: H });
    expect({ value: none.value, positive: mayAssertPositive(none) }).toEqual({ value: null, positive: true });
  });
});

// ---------------------------------------------------------------------------
// 2. every path form of the configured workflow is the same workflow
// ---------------------------------------------------------------------------

describe("2. ci.yml and ci.yml@<ref> - every form under the same id - identify the same workflow", () => {
  it("each form selects the run, at the exact head and in the failure streak alike", () => {
    for (const form of FORMS) {
      const runs = [run(3003, { path: form })];
      const streak = selectStreakRuns({ identity: ID, runs, heads: [H] });
      expect({ form, head: headId(runs), streak: streak.value[0].run?.id }).toEqual({ form, head: 3003, streak: 3003 });
    }
  });

  it("which form each run carries never changes which run is selected", () => {
    const outcomes = [run(3001, { conclusion: "failure" }), run(3002, { conclusion: "cancelled" }), run(3003)];
    for (let shift = 0; shift < FORMS.length; shift++) {
      const runs = outcomes.map((x, i) => ({ ...x, path: FORMS[(i + shift) % FORMS.length] }));
      expect({ shift, id: headId(runs) }).toEqual({ shift, id: 3003 });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. a similarly named workflow is not the CI workflow
// ---------------------------------------------------------------------------

describe("3. another workflow with a similar name never matches", () => {
  it("not even with a byte-identical path: alone, it leaves the head with no CI run", () => {
    for (const [p, workflowId] of LOOKALIKES) {
      const runs = [run(9999, { path: p, workflow_id: workflowId })];
      expect({ p, workflowId, id: headId(runs) }).toEqual({ p, workflowId, id: null });
    }
  });

  it("cannot displace the CI run, even at a higher id and failing", () => {
    for (const [p, workflowId] of LOOKALIKES) {
      const runs = [run(3003), run(9999, { path: p, workflow_id: workflowId, conclusion: "failure" })];
      expect({ p, id: headId(runs) }).toEqual({ p, id: 3003 });
    }
  });

  it("membership is the workflow id and the event, and nothing else", () => {
    const identity = ID.value;
    const at = (over: Json) => ({ id: 1, workflowId: CI_ID, event: "pull_request", path: CI_PATH, ...over });
    expect(isConfiguredRun(at({}), identity)).toBe(true);
    expect(isConfiguredRun(at({ path: `${CI_PATH}@main` }), identity)).toBe(true);
    expect(isConfiguredRun(at({ path: "anything at all" }), identity)).toBe(true);
    expect(isConfiguredRun(at({ workflowId: OTHER_ID }), identity)).toBe(false);
    expect(isConfiguredRun(at({ event: "push" }), identity)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. unrelated workflows and events never affect the result
// ---------------------------------------------------------------------------

describe("4. historical runs of unrelated workflows and events change nothing", () => {
  it("later, failing runs of another workflow, or of another event, at the same head", () => {
    const unrelated = [
      run(9001, { workflow_id: NIGHTLY_ID, path: ".github/workflows/nightly.yml", event: "schedule", conclusion: "failure" }),
      run(9002, { event: "push", conclusion: "failure" }),
      run(9003, { event: "workflow_dispatch", conclusion: "failure" }),
      run(9004, { workflow_id: OTHER_ID, conclusion: "failure" }),
    ];
    expect(headId([run(3003), ...unrelated])).toBe(3003);
    expect(headId(unrelated)).toBeNull();
  });

  it("over 500 seeded random run sets: exactly the rule restated, and no path string ever matters", () => {
    const r = seeded(803);
    const mismatches: string[] = [];
    for (let k = 0; k < 500; k++) {
      const runs = randomRuns(r, [H]);
      const want = expectedAt(runs, H);
      const got = headId(runs);
      // The same runs, every path replaced by a random other form: nothing may move.
      const repathed = runs.map((x) => ({ ...x, path: r.pick([...FORMS, ...LOOKALIKES.map(([p]) => p)]) }));
      const again = headId(repathed);
      if (got !== want || again !== want) mismatches.push(`${JSON.stringify(runs.map((x) => [x.id, x.workflow_id, x.event, x.path]))}: ${got}/${again} vs ${want}`);
    }
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. exact-head selection
// ---------------------------------------------------------------------------

describe("5. exact-head selection: the latest applicable pull_request run at the exact head", () => {
  it("the highest id wins, in every listing order - a later failure as much as a later pass", () => {
    const a = run(2990, { conclusion: "failure" });
    const b = run(3003);
    const c = run(2995, { conclusion: "cancelled" });
    for (const order of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) expect(headId(order)).toBe(3003);
    expect(headId([run(3003), run(3010, { conclusion: "failure" })])).toBe(3010);
    expect(headId([run(3003), run(3010, { status: "in_progress", conclusion: null })])).toBe(3010);
  });

  it("returns the selected run itself, for the caller to grade", () => {
    const r = selectHeadRun({ identity: ID, runs: [run(3003, { path: `${CI_PATH}@main`, conclusion: "failure" })], head: H });
    expect(r.value).toEqual({ id: 3003, workflowId: CI_ID, event: "pull_request", status: "completed", conclusion: "failure", headSha: H, path: `${CI_PATH}@main` });
  });

  it("a run listed for the head that names another commit makes the answer UNKNOWN", () => {
    expect(headId([run(3003), run(3004, { head_sha: sha("elsewhere") })])).toBe(UNKNOWN);
  });

  it("a run that cannot be placed - no usable workflow_id, id, sha, event or status - makes the answer UNKNOWN", () => {
    const broken: Json[] = [
      { workflow_id: undefined },
      { workflow_id: null },
      { workflow_id: String(CI_ID) },
      { workflow_id: 0 },
      { workflow_id: 1.5 },
      { id: "3004" },
      { head_sha: "not-a-sha" },
      { event: null },
      { status: 1 },
      { conclusion: 0 },
    ];
    for (const over of broken) expect({ over, id: headId([run(3003), run(3004, over)]) }).toEqual({ over, id: UNKNOWN });
    for (const runs of [null, undefined, {}, "runs", [null], [[]]]) expect(headId(runs as Json)).toBe(UNKNOWN);
    expect(selectHeadRun({ identity: ID, runs: [run(3003)], head: "HEAD" }).value).toBe(UNKNOWN);
  });

  it("no applicable run at the head is a known absence, and says which workflow it looked for", () => {
    const r = selectHeadRun({ identity: ID, runs: [run(9002, { event: "push" })], head: H });
    expect({ value: r.value, positive: mayAssertPositive(r), reason: r.reason }).toEqual({
      value: null,
      positive: true,
      reason: `no pull_request run of workflow ${CI_ID} at this head`,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. the failure streak selects by the SAME rule
// ---------------------------------------------------------------------------

describe("6. failure-streak selection uses exactly the exact-head rule", () => {
  it("per head, in the order given, the latest applicable run - whatever form its path takes", () => {
    const runs = [
      run(303, { head_sha: H3, path: `${CI_PATH}@main`, conclusion: "failure" }),
      run(399, { head_sha: H3, workflow_id: OTHER_ID, path: CI_PATH, conclusion: "success" }),
      run(201, { head_sha: H2, conclusion: "success" }),
      run(202, { head_sha: H2, path: `octocat/octo-repo/${CI_PATH}@main`, conclusion: "failure" }),
      run(101, { head_sha: H1, event: "push", conclusion: "success" }),
    ];
    const streak = selectStreakRuns({ identity: ID, runs, heads: [H3, H2, H1] });
    expect(mayAssertPositive(streak)).toBe(true);
    expect(streak.value.map((x: Json) => [x.head, x.run?.id ?? null])).toEqual([
      [H3, 303],
      [H2, 202],
      [H1, null],
    ]);
  });

  it("agrees with the exact-head selection on every head of 300 seeded histories", () => {
    const r = seeded(795);
    const heads = [H3, H2, H1];
    const disagreements: string[] = [];
    for (let k = 0; k < 300; k++) {
      const runs = randomRuns(r, heads);
      const streak = selectStreakRuns({ identity: ID, runs, heads });
      heads.forEach((head, i) => {
        const alone = selectHeadRun({ identity: ID, runs: runs.filter((x) => x.head_sha === head), head });
        const viaStreak = streak.value[i];
        if (viaStreak.head !== head || JSON.stringify(viaStreak.run) !== JSON.stringify(alone.value) || (alone.value?.id ?? null) !== expectedAt(runs, head)) {
          disagreements.push(`k=${k} head=${head.slice(0, 7)}`);
        }
      });
    }
    expect(disagreements).toEqual([]);
  });

  it("one head that cannot be decided makes the whole streak selection UNKNOWN", () => {
    const runs = [run(303, { head_sha: H3 }), run(202, { head_sha: H2, workflow_id: "289443461" })];
    expect(selectStreakRuns({ identity: ID, runs, heads: [H3, H2] }).value).toBe(UNKNOWN);
    expect(selectStreakRuns({ identity: ID, runs: [], heads: [H3, "not-a-sha"] }).value).toBe(UNKNOWN);
  });

  it("the rule is written once: one id comparison, and the streak is built FROM the exact-head selection", () => {
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/workflow-identity.mjs"), "utf8");
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(code).toContain("export function isConfiguredRun");
    expect(code.match(/workflowId ===/g)).toEqual(["workflowId ==="]);
    expect(code.match(/isConfiguredRun\(/g)).toHaveLength(2); // its definition, and latestApplicableRun
    const streakBody = code.slice(code.indexOf("export function selectStreakRuns"));
    expect(streakBody).toMatch(/selectHeadRun\(\{/);
    expect(streakBody).not.toMatch(/latestApplicableRun\(|isConfiguredRun\(/);
    // A run's path is projected for display and read nowhere else.
    const projection = code.slice(code.indexOf("function projectRun"), code.indexOf("function projectAll"));
    expect(code.replace(projection, "")).not.toMatch(/\.path\b/);
    expect(typeof latestApplicableRun).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 7. boundaries
// ---------------------------------------------------------------------------

describe("7. read-only, single-shot, and CI only, by construction", () => {
  it("issues no write, merge, history rewrite, timer, poll or external-check read", () => {
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/workflow-identity.mjs"), "utf8");
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    // Anti-vacuity: the scan reaches the code it guards.
    expect(code).toContain("export function resolveWorkflowIdentity");
    expect(code).not.toMatch(/gh\s+pr\s+merge|mergePullRequest|merge_method|\/merges?\b/);
    expect(code).not.toMatch(/\bgit\s+[a-z]|--amend|--force|--squash|--method|-X\s|--field/);
    expect(code).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|mkdirSync|renameSync|unlinkSync|rmSync/);
    expect(code).not.toMatch(/child_process|execFile|spawn/);
    expect(code).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|\bsleep\(|--watch/);
    expect(code).not.toMatch(/check-runs|check_runs|\/status\b|statuses/);
    expect(code.match(/fetcher\(/g)).toEqual(["fetcher("]);
  });
});
