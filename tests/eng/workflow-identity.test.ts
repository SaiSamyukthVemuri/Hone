import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { AUTHORIZED, COMPLETE, INCOMPLETE, UNKNOWN, evidence, mayAssertPositive } from "../../scripts/eng/evidence.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { CI_WORKFLOW, isConfiguredRun, latestExecution, resolveWorkflowIdentity, selectHeadRun, selectStreakRuns } from "../../scripts/eng/workflow-identity.mjs";

// ===========================================================================
// ENG-LOOP-03 acceptance: the repository's CI workflow is a workflow ID, and
// its latest run is its latest EXECUTION.
// ===========================================================================
//
// PR #795 matched CI runs by string equality on `path`, which GitHub documents
// only as "the full path of the workflow" - with ref-qualified examples. A valid
// CI run could be missed and read as "no CI yet". This lane's first review then
// showed that "latest" by highest run id is wrong too: a re-run keeps its id.
// What is proved here:
//
//   1. the configured ci.yml is resolved ONCE, by GitHub, to its workflow id;
//      a malformed or partial workflow override, or a missing or malformed
//      identity, fails CLOSED - UNKNOWN, never "no CI" - and nothing throws;
//   2. every path form of the configured workflow - plain, ref-qualified,
//      owner-qualified, renamed under the same id - selects the same run;
//   3. a similarly named workflow with another id never matches, not even one
//      whose path is byte-identical;
//   4. unrelated workflows and events never affect the result: a seeded
//      property test against the rule restated independently;
//   5. exact-head selection is the latest EXECUTION at the exact head: by the
//      latest attempt's start, then the attempt, then the run id - in any
//      listing order, and a re-run of an older run counts as the newest;
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

const BASE = Date.parse("2026-10-05T12:00:00Z");
/** A GitHub timestamp `minutes` after BASE, in GitHub's second-precision form. */
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * A workflow run as GitHub lists it; the field names were checked live on this
 * repository. By default its only attempt started `id` minutes after BASE, so a
 * higher id is also a later execution unless a test says otherwise.
 */
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
  run_started_at: at(id),
  created_at: at(id),
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

/** The selected run at the head as [id, attempt], null when none applies, or UNKNOWN. */
const pick = (runs: Json, head = H): Json => {
  const r = selectHeadRun({ identity: ID, runs, head });
  if (!mayAssertPositive(r)) return UNKNOWN;
  return r.value ? [r.value.id, r.value.attempt] : null;
};
const headId = (runs: Json, head = H): Json => {
  const p = pick(runs, head);
  return Array.isArray(p) ? p[0] : p;
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
  const pickOne = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  return { rand, pick: pickOne };
}

/**
 * A random run set: mixed workflows, events, path forms, outcomes, attempts,
 * start times (with ties) and listing order. Run ids are unique; start times
 * are deliberately NOT in id order, as after re-runs.
 */
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
      run_attempt: 1 + Math.floor(r.rand() * 3),
      run_started_at: at(Math.floor(r.rand() * 12)),
      head_sha: r.pick(heads),
    });
  });
  return runs.sort(() => r.rand() - 0.5);
}

/** The rule, restated independently of the code under test (ids unique). */
const expectedAt = (runs: Json[], head: string): number | null => {
  const ok = runs.filter((x) => x.head_sha === head && x.workflow_id === CI_ID && x.event === "pull_request");
  if (!ok.length) return null;
  const key = (x: Json) => [Date.parse(x.run_started_at), x.run_attempt, x.id];
  const later = (a: Json, b: Json) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
    return false;
  };
  return ok.reduce((best, x) => (later(x, best) ? x : best)).id;
};

const permutations = <T>(xs: T[]): T[][] =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

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
      // Authorized envelopes holding something no resolution produces.
      evidence({ id: "289443461", event: "pull_request" }, { completeness: COMPLETE, authority: AUTHORIZED, reason: "hand-made" }),
      evidence({ id: CI_ID }, { completeness: COMPLETE, authority: AUTHORIZED, reason: "no event" }),
      evidence(null, { completeness: COMPLETE, authority: AUTHORIZED, reason: "empty" }),
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

describe("1b. a workflow override is validated in full before any lookup, and fails closed", () => {
  const resolveWith = (workflow: Json) => {
    const calls: Json[] = [];
    let identity: Json;
    let threw: unknown = null;
    try {
      identity = resolveWorkflowIdentity({ fetcher: fetcherFor(workflowAnswer(), calls), workflow });
    } catch (err) {
      threw = err;
    }
    return { identity, calls, threw };
  };
  const expectClosed = (label: string, workflow: Json) => {
    const { identity, calls, threw } = resolveWith(workflow);
    expect({ label, threw }).toEqual({ label, threw: null });
    expect({ label, positive: mayAssertPositive(identity), value: identity.value, requests: calls.length }).toEqual({
      label,
      positive: false,
      value: UNKNOWN,
      requests: 0,
    });
    // And nothing selected with it is a run, or "no run".
    expect(selectHeadRun({ identity, runs: [run(3003)], head: H }).value).toBe(UNKNOWN);
  };

  it("missing event", () => {
    expectClosed("no event", { file: CI_PATH });
  });

  it("missing file", () => {
    expectClosed("no file", { event: "pull_request" });
  });

  it("malformed file type or value", () => {
    const files: Json[] = [42, null, true, [CI_PATH], {}, "", "ci.yml", ".github/workflows/", ".github/workflows/ci",
      ".github/workflows/ci.txt", ".github/workflows/sub/ci.yml", `${CI_PATH}@main`, `../${CI_PATH}`, ` ${CI_PATH}`,
      ".github/workflows/c i.yml", "octocat/octo-repo/.github/workflows/ci.yml"];
    for (const file of files) expectClosed(`file ${JSON.stringify(file)}`, { file, event: "pull_request" });
  });

  it("malformed event type or value", () => {
    const events: Json[] = [1, null, false, ["pull_request"], {}, "", " ", "Pull Request", "pull-request", "pull_request ", "PULL_REQUEST", "pull__request"];
    for (const event of events) expectClosed(`event ${JSON.stringify(event)}`, { file: CI_PATH, event });
  });

  it("an override that is not a workflow object at all", () => {
    for (const workflow of [null, [], "ci.yml", 7, true]) expectClosed(`workflow ${JSON.stringify(workflow)}`, workflow);
  });

  it("a valid override is honoured: its own file is resolved and its own event selects", () => {
    const calls: Json[] = [];
    const nightly = resolveWorkflowIdentity({
      fetcher: fetcherFor(workflowAnswer({ id: NIGHTLY_ID, path: ".github/workflows/nightly.yml" }), calls),
      workflow: { file: ".github/workflows/nightly.yml", event: "schedule" },
    });
    expect(mayAssertPositive(nightly)).toBe(true);
    expect(nightly.value).toEqual({ id: NIGHTLY_ID, event: "schedule", file: ".github/workflows/nightly.yml" });
    expect(calls).toEqual([["repos/{repo}/actions/workflows/nightly.yml"]]);
    const runs = [run(3003), run(3004, { workflow_id: NIGHTLY_ID, path: ".github/workflows/nightly.yml", event: "schedule" })];
    expect(selectHeadRun({ identity: nightly, runs, head: H }).value.id).toBe(3004);
    // `.yaml` is a runnable workflow file too.
    expect(mayAssertPositive(resolveWorkflowIdentity({ fetcher: fetcherFor(workflowAnswer()), workflow: { file: ".github/workflows/ci.yaml", event: "pull_request" } }))).toBe(true);
  });

  it("no input makes the module throw: everything ends inside an evidence envelope", () => {
    const outcomes: Json[] = [];
    const attempt = (fn: () => Json) => {
      try {
        outcomes.push(fn().value);
      } catch (err) {
        outcomes.push(`threw: ${String(err)}`);
      }
    };
    attempt(() => resolveWorkflowIdentity());
    attempt(() => resolveWorkflowIdentity(null));
    attempt(() => resolveWorkflowIdentity({}));
    attempt(() => resolveWorkflowIdentity({ fetcher: "gh" }));
    attempt(() =>
      resolveWorkflowIdentity({
        fetcher: () => {
          throw new Error("gh: spawn failed");
        },
      }),
    );
    attempt(() => selectHeadRun());
    attempt(() => selectHeadRun(null));
    attempt(() => selectStreakRuns());
    attempt(() => selectStreakRuns(null));
    expect(outcomes).toEqual(Array(outcomes.length).fill(UNKNOWN));
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

  it("cannot displace the CI run, even when it executed later and failed", () => {
    for (const [p, workflowId] of LOOKALIKES) {
      const runs = [run(3003), run(9999, { path: p, workflow_id: workflowId, conclusion: "failure" })];
      expect({ p, id: headId(runs) }).toEqual({ p, id: 3003 });
    }
  });

  it("membership is the workflow id and the event, and nothing else", () => {
    const identity = ID.value;
    const as = (over: Json) => ({ id: 1, workflowId: CI_ID, event: "pull_request", path: CI_PATH, ...over });
    expect(isConfiguredRun(as({}), identity)).toBe(true);
    expect(isConfiguredRun(as({ path: `${CI_PATH}@main` }), identity)).toBe(true);
    expect(isConfiguredRun(as({ path: "anything at all" }), identity)).toBe(true);
    expect(isConfiguredRun(as({ workflowId: OTHER_ID }), identity)).toBe(false);
    expect(isConfiguredRun(as({ event: "push" }), identity)).toBe(false);
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
      run(9005, { event: "a-new-github-event", conclusion: "failure" }),
    ];
    expect(headId([run(3003), ...unrelated])).toBe(3003);
    expect(headId(unrelated)).toBeNull();
  });

  it("an unrelated run's attempt, start time or state is never even read", () => {
    const unread = { run_attempt: undefined, run_started_at: "yesterday", status: 1, conclusion: 0 };
    const unrelated = [
      run(9001, { workflow_id: NIGHTLY_ID, event: "schedule", ...unread }),
      run(9002, { event: "push", ...unread }),
    ];
    expect(headId([run(3003), ...unrelated])).toBe(3003);
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
      if (got !== want || again !== want) {
        mismatches.push(`${JSON.stringify(runs.map((x) => [x.id, x.workflow_id, x.event, x.run_attempt, x.run_started_at]))}: ${got}/${again} vs ${want}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. exact-head selection: the latest EXECUTION at the exact head
// ---------------------------------------------------------------------------

describe("5. exact-head selection: the latest applicable pull_request run at the exact head", () => {
  it("with no re-runs, the later run wins in every listing order - a later failure as much as a later pass", () => {
    const a = run(2990, { conclusion: "failure" });
    const b = run(3003);
    const c = run(2995, { conclusion: "cancelled" });
    for (const order of permutations([a, b, c])) expect(headId(order)).toBe(3003);
    expect(headId([run(3003), run(3010, { conclusion: "failure" })])).toBe(3010);
    expect(headId([run(3003), run(3010, { status: "in_progress", conclusion: null })])).toBe(3010);
  });

  it("returns the selected execution itself, for the caller to grade", () => {
    const r = selectHeadRun({ identity: ID, runs: [run(3003, { path: `${CI_PATH}@main`, conclusion: "failure", run_attempt: 2, run_started_at: at(5000) })], head: H });
    expect(r.value).toEqual({
      id: 3003,
      workflowId: CI_ID,
      event: "pull_request",
      headSha: H,
      attempt: 2,
      startedAt: at(5000),
      status: "completed",
      conclusion: "failure",
      path: `${CI_PATH}@main`,
    });
  });

  it("a run listed for the head that names another commit makes the answer UNKNOWN", () => {
    expect(headId([run(3003), run(3004, { head_sha: sha("elsewhere") })])).toBe(UNKNOWN);
  });

  it("a run that cannot be placed - no usable id, workflow_id, event or sha - makes the answer UNKNOWN", () => {
    const unplaceable: Json[] = [
      { workflow_id: undefined },
      { workflow_id: null },
      { workflow_id: String(CI_ID) },
      { workflow_id: 0 },
      { workflow_id: 1.5 },
      { id: "3004" },
      { head_sha: "not-a-sha" },
      { event: null },
      { event: 7 },
    ];
    for (const over of unplaceable) expect({ over, id: headId([run(3003), run(3004, over)]) }).toEqual({ over, id: UNKNOWN });
    for (const runs of [null, undefined, {}, "runs", [null], [[]]]) expect(headId(runs)).toBe(UNKNOWN);
    expect(selectHeadRun({ identity: ID, runs: [run(3003)], head: "HEAD" }).value).toBe(UNKNOWN);
  });

  it("an APPLICABLE run without a usable attempt, start time, status or conclusion makes the answer UNKNOWN", () => {
    const undecidable: Json[] = [
      { run_attempt: undefined },
      { run_attempt: 0 },
      { run_attempt: "2" },
      { run_attempt: 1.5 },
      { run_started_at: undefined },
      { run_started_at: null },
      { run_started_at: "2026-10-05" },
      { run_started_at: "yesterday" },
      { run_started_at: "2026-13-45T99:99:99Z" },
      { run_started_at: 1759665600000 },
      { status: 1 },
      { status: undefined },
      { conclusion: 0 },
    ];
    for (const over of undecidable) expect({ over, id: headId([run(3003), run(3004, over)]) }).toEqual({ over, id: UNKNOWN });
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

describe("5b. latest means the latest EXECUTION, not the highest run id (re-runs keep their id)", () => {
  it("a newer run id that executed earlier loses to an older run id re-run later - whichever way it went", () => {
    // Run 101 passed first; run 100 was then re-run, later, and FAILED.
    // Highest-id would say GREEN from a stale execution.
    const failedRerun = [run(101, { run_started_at: at(20) }), run(100, { run_attempt: 2, run_started_at: at(30), conclusion: "failure" })];
    expect(pick(failedRerun)).toEqual([100, 2]);
    // And the other way: the re-run of the older run passed after the newer one failed.
    const passedRerun = [run(101, { run_started_at: at(20), conclusion: "failure" }), run(100, { run_attempt: 2, run_started_at: at(30) })];
    expect(pick(passedRerun)).toEqual([100, 2]);
    // Once the newer run is itself re-run later still, it is the newest again.
    expect(pick([run(101, { run_attempt: 2, run_started_at: at(40) }), run(100, { run_attempt: 2, run_started_at: at(30) })])).toEqual([101, 2]);
  });

  it("the same run id listed twice: the later attempt wins, in either order", () => {
    const first = run(100, { run_attempt: 1, run_started_at: at(10), conclusion: "failure" });
    const second = run(100, { run_attempt: 2, run_started_at: at(30), conclusion: "success" });
    expect(pick([first, second])).toEqual([100, 2]);
    expect(pick([second, first])).toEqual([100, 2]);
    const r = selectHeadRun({ identity: ID, runs: [second, first], head: H });
    expect(r.value.conclusion).toBe("success");
    // An exact duplicate is the same execution read twice, not a conflict.
    expect(pick([second, { ...second }])).toEqual([100, 2]);
  });

  it("listing order is irrelevant: every permutation of a re-run history selects the same execution", () => {
    const history = [
      run(100, { run_attempt: 3, run_started_at: at(50), conclusion: "failure" }),
      run(101, { run_started_at: at(20) }),
      run(102, { run_attempt: 2, run_started_at: at(45), conclusion: "cancelled" }),
      run(100, { run_attempt: 2, run_started_at: at(35), conclusion: "success" }),
      run(9001, { workflow_id: OTHER_ID, run_started_at: at(99), conclusion: "success" }),
    ];
    const seen = new Set(permutations(history).map((order) => JSON.stringify(pick(order))));
    expect([...seen]).toEqual([JSON.stringify([100, 3])]);
  });

  it("a tie in start time is broken deterministically: the higher attempt, then the higher run id", () => {
    const t = at(30);
    expect(pick([run(100, { run_attempt: 2, run_started_at: t }), run(101, { run_attempt: 1, run_started_at: t })])).toEqual([100, 2]);
    expect(pick([run(101, { run_attempt: 1, run_started_at: t }), run(100, { run_attempt: 2, run_started_at: t })])).toEqual([100, 2]);
    expect(pick([run(100, { run_started_at: t }), run(101, { run_started_at: t })])).toEqual([101, 1]);
    expect(pick([run(101, { run_started_at: t }), run(100, { run_started_at: t })])).toEqual([101, 1]);
  });

  it("copies of one run that contradict each other make the answer UNKNOWN", () => {
    // A later attempt that started before an earlier one.
    expect(pick([run(100, { run_attempt: 1, run_started_at: at(30) }), run(100, { run_attempt: 2, run_started_at: at(10) })])).toBe(UNKNOWN);
    // The same attempt read twice in different states.
    expect(pick([run(100, { run_attempt: 2, run_started_at: at(30), conclusion: "failure" }), run(100, { run_attempt: 2, run_started_at: at(30) })])).toBe(UNKNOWN);
    expect(pick([run(100, { run_attempt: 2, run_started_at: at(30) }), run(100, { run_attempt: 2, run_started_at: at(31) })])).toBe(UNKNOWN);
  });

  it("over 500 seeded histories with re-runs and tied start times, the selection is exactly the rule restated", () => {
    const r = seeded(4188883055 % 2 ** 31);
    const mismatches: string[] = [];
    for (let k = 0; k < 500; k++) {
      const runs = randomRuns(r, [H]);
      const want = expectedAt(runs, H);
      const got = headId(runs);
      if (got !== want) mismatches.push(`${JSON.stringify(runs.map((x) => [x.id, x.workflow_id, x.event, x.run_attempt, x.run_started_at]))}: ${got} vs ${want}`);
    }
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. the failure streak selects by the SAME rule
// ---------------------------------------------------------------------------

describe("6. failure-streak selection uses exactly the exact-head rule", () => {
  it("per head, in the order given, the latest execution - whatever form its path takes", () => {
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

  it("a re-run of an older run is that head's latest execution in the streak too", () => {
    const runs = [
      // At H2 the newer run passed first, then the older run was re-run and failed.
      run(202, { head_sha: H2, run_started_at: at(20) }),
      run(201, { head_sha: H2, run_attempt: 2, run_started_at: at(30), conclusion: "failure" }),
      // At H1, the same run read twice: its later attempt passed.
      run(101, { head_sha: H1, run_attempt: 1, run_started_at: at(5), conclusion: "failure" }),
      run(101, { head_sha: H1, run_attempt: 2, run_started_at: at(8) }),
    ];
    const streak = selectStreakRuns({ identity: ID, runs, heads: [H2, H1] });
    expect(streak.value.map((x: Json) => [x.run.id, x.run.attempt, x.run.conclusion])).toEqual([
      [201, 2, "failure"],
      [101, 2, "success"],
    ]);
  });

  it("agrees with the exact-head selection, and with the rule restated, on every head of 300 seeded histories", () => {
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
    expect(selectStreakRuns({ identity: ID, runs: [run(303, { head_sha: H3 }), run(202, { head_sha: H2, workflow_id: "289443461" })], heads: [H3, H2] }).value).toBe(UNKNOWN);
    expect(selectStreakRuns({ identity: ID, runs: [run(303, { head_sha: H3 }), run(202, { head_sha: H2, run_started_at: "soon" })], heads: [H3, H2] }).value).toBe(UNKNOWN);
    expect(selectStreakRuns({ identity: ID, runs: [], heads: [H3, "not-a-sha"] }).value).toBe(UNKNOWN);
  });

  it("each rule is written once: one id comparison, one recency order, and the streak is built FROM the exact-head selection", () => {
    const src = readFileSync(path.resolve(__dirname, "../../scripts/eng/workflow-identity.mjs"), "utf8");
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(code).toContain("export function isConfiguredRun");
    expect(code.match(/workflowId ===/g)).toEqual(["workflowId ==="]);
    expect(code.match(/isConfiguredRun\(/g)).toHaveLength(2); // its definition, and latestExecution
    expect(code.match(/isNewer\(/g)).toHaveLength(2); // its definition, and latestExecution
    expect(code.match(/latestExecution\(/g)).toHaveLength(2); // its definition, and selectHeadRun
    const streakBody = code.slice(code.indexOf("export function selectStreakRuns"));
    expect(streakBody).toMatch(/selectHeadRun\(\{/);
    expect(streakBody).not.toMatch(/latestExecution\(|isConfiguredRun\(|isNewer\(/);
    // A run's path is projected for display and read nowhere else.
    const projection = code.slice(code.indexOf("function projectExecution"), code.indexOf("export function isConfiguredRun"));
    expect(code.replace(projection, "")).not.toMatch(/\.path\b/);
    expect(typeof latestExecution).toBe("function");
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
