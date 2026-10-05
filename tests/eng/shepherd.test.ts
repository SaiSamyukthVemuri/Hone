import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { PR_WORKFLOW, collectFacts, collectShepherdFacts, ghFetcher, latestApplicableRun } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { summarize } from "../../scripts/eng/review-provenance.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { CANDIDATE_POINT, CODES, DOMAINS, EXIT_CODE, LAW, STATE, decide, interpret, renderShepherd } from "../../scripts/eng/shepherd.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { renderHuman } from "../../scripts/eng/cli.mjs";
import {
  CI_WORKFLOW,
  CODEX,
  CODEX_ID_AS_USER,
  CODEX_LOGIN_OTHER_ID,
  NOW,
  OPERATOR,
  OUTSIDER,
  PROD_BRANCH,
  REPO,
  ago,
  ciRun,
  cleanVerdict,
  deepFreeze,
  fetcherFor,
  finding,
  findingsVerdict,
  job,
  jobsPage,
  readyWorld,
  sha,
  short,
  type Call,
  type Json,
  type World,
} from "./helpers/github-world";

// ===========================================================================
// ENG-LOOP-01 acceptance: the PR shepherd, OBSERVATION-ONLY
// (docs/decisions/eng-loop-01-observation-only.md).
// ===========================================================================
//
// What is proved here, and how each proof avoids the way CP-005's authority
// vehicles failed (#617-#623: hand-enumerated cases, with omitted surfaces
// falling through permissive defaults into a positive state):
//
//   1. `status` is unchanged - byte-for-byte against output captured from the
//      unmodified production tree BEFORE ENG-LOOP-01.
//   2. The decision is TOTAL and the candidate state is ONE point: every
//      combination of every signal value is enumerated from the exported DOMAINS.
//   3. Each delivery situation maps to the recommendation the delivery rules
//      call for, through the real collector against GitHub-shaped answers.
//   4. THE AUTHORITY GATE: adding, or re-attributing, ANY comment in ANY
//      situation changes nothing - so no untrusted actor's text, request,
//      verdict or badge can reach a decision. Requests are not inferred at all.
//   5. EXACT-HEAD REVIEW: a verdict for any other commit, or a near-miss
//      prefix, is never a verdict for the head.
//   6. CI is the LATEST applicable run: a seeded property test over random run
//      sets at one sha, checked against the rule restated independently.
//   7. The §7.4 stop law fires on REAL history: #786, at 3644d2fb.
//   8. Fault injection BY CONSTRUCTION: the requests and response leaves that
//      are failed, corrupted or truncated are the ones the collector actually
//      made and read, recorded at run time.
//   9. Read-only by construction, and advisory in every word it emits.

const R = (w: World): Json => w.responses;
const threadsOf = (w: World): Json => R(w).threads[0].data.repository.pullRequest.reviewThreads;
const H = (w: World) => w.head;
const dropIssue = (w: World, id: number) => {
  R(w).issues[0] = R(w).issues[0].filter((c: Json) => c.id !== id);
};
const issue = (w: World, id: number): Json => R(w).issues[0].find((c: Json) => c.id === id);

function run(w: World, { tier = null, fault }: { tier?: string | null; fault?: (c: Call) => unknown } = {}) {
  const sf = collectShepherdFacts({ pr: w.pr, fetcher: fetcherFor(w, { fault }), repo: REPO });
  return interpret(sf, { now: NOW, tier });
}

const codesOf = (r: Json): string[] => [...r.stops, ...r.blocks, ...r.actions, ...r.waits].map((x: Json) => x.code);
/** What a decision IS, without the display-only detail. */
const verdictOf = (r: Json) => ({ state: r.state, codes: codesOf(r), signals: r.signals });

function addRoot(w: World, c: { id: number; severity: string | null; at: string; resolved: boolean; user?: Json }) {
  R(w).inline[0].push({
    id: c.id,
    user: c.user ?? CODEX,
    body: c.severity ? finding(c.severity, `Finding ${c.id}`) : "This deserves a second look.",
    commit_id: w.head,
    original_commit_id: c.at,
    path: "scripts/eng/world.mjs",
    line: c.id % 100,
  });
  const t = threadsOf(w);
  t.nodes.push({ isResolved: c.resolved, isOutdated: false, comments: { nodes: [{ databaseId: c.id }] } });
  t.totalCount += 1;
}

/** A trusted Codex round at the head that raised a finding, with no clean verdict for it. */
function findingRoundAtHead(w: World, severity: string, resolved = false) {
  addRoot(w, { id: 5002, severity, at: w.head, resolved });
  R(w).reviews[0].push({ id: 7002, user: CODEX, body: findingsVerdict(w.head), state: "COMMENTED", commit_id: w.head });
  dropIssue(w, 6003);
}

/** The head's latest run failed on one lane; optionally every head's did. */
function failHeadRun(w: World, heads: "head" | "all" = "head") {
  Object.assign(R(w).workflowRuns[0].workflow_runs[0], { conclusion: "failure" });
  R(w).jobs[3003][0].jobs[1].conclusion = "failure";
  for (const r of R(w).branchRuns.workflow_runs) {
    if (heads === "all" || r.head_sha === w.head) r.conclusion = "failure";
  }
}

/** Replace the runs at the head (and their jobs). Jobs default to one passing lane per run. */
function runsAtHead(w: World, runs: Json[], jobsByRun: Record<number, Json[]> = {}) {
  R(w).workflowRuns = [{ total_count: runs.length, workflow_runs: runs }];
  R(w).jobs = Object.fromEntries(
    runs.map((r) => [r.id, jobsPage(jobsByRun[r.id] ?? [job(r.id * 10, r.id, r.head_sha, "lane", r.conclusion ?? null, r.status)])]),
  );
}

interface Scenario {
  mutate: (w: World) => void;
  tier?: string;
  state: string;
  codes: string[];
}

const SCENARIOS: Record<string, Scenario> = {
  // --- CI: the latest applicable run at the exact head -----------------------
  "the latest run failed": { mutate: (w) => failHeadRun(w), state: "ACTION_RECOMMENDED", codes: ["FIX_CI"] },
  "the latest run is still running, its later jobs not yet reported": {
    mutate: (w) => {
      Object.assign(R(w).workflowRuns[0].workflow_runs[0], { status: "in_progress", conclusion: null });
      R(w).jobs[3003][0].jobs.splice(2);
      R(w).jobs[3003][0].total_count = 2;
    },
    state: "WAITING",
    codes: ["WAIT_CI"],
  },
  "the latest run is queued": {
    mutate: (w) => {
      Object.assign(R(w).workflowRuns[0].workflow_runs[0], { status: "queued", conclusion: null });
      R(w).jobs[3003] = jobsPage([]);
    },
    state: "WAITING",
    codes: ["WAIT_CI"],
  },
  "no applicable run exists at the head yet": {
    mutate: (w) => runsAtHead(w, []),
    state: "WAITING",
    codes: ["WAIT_CI"],
  },
  "the latest run was cancelled": {
    mutate: (w) => {
      Object.assign(R(w).workflowRuns[0].workflow_runs[0], { conclusion: "cancelled" });
      R(w).jobs[3003][0].jobs[2].conclusion = "cancelled";
    },
    state: "ACTION_RECOMMENDED",
    codes: ["RERUN_CI"],
  },
  "two runs at one sha: the earlier passed, the latest failed": {
    mutate: (w) => {
      runsAtHead(w, [ciRun(3003, w.head, "success"), ciRun(3010, w.head, "failure")]);
      R(w).branchRuns.workflow_runs.push(ciRun(3010, w.head, "failure"));
      R(w).branchRuns.total_count = 4;
    },
    state: "ACTION_RECOMMENDED",
    codes: ["FIX_CI"],
  },
  "two runs at one sha: the earlier passed, the latest is still running": {
    mutate: (w) => runsAtHead(w, [ciRun(3003, w.head, "success"), ciRun(3010, w.head, null, "in_progress")]),
    state: "WAITING",
    codes: ["WAIT_CI"],
  },
  "the latest run says success while one of its jobs failed": {
    mutate: (w) => {
      R(w).jobs[3003][0].jobs[1].conclusion = "failure";
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "a job answered for this run belongs to another run": {
    mutate: (w) => {
      R(w).jobs[3003][0].jobs[0].run_id = 9999;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "a job of the run names another commit": {
    mutate: (w) => {
      R(w).jobs[3003][0].jobs[0].head_sha = sha("elsewhere");
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "a run answered for the head names another commit": {
    mutate: (w) => {
      R(w).workflowRuns[0].workflow_runs[0].head_sha = sha("elsewhere");
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "the run reports a status GitHub never documented": {
    mutate: (w) => {
      Object.assign(R(w).workflowRuns[0].workflow_runs[0], { status: "paused", conclusion: null });
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "CI failed at three consecutive heads": { mutate: (w) => failHeadRun(w, "all"), state: "ESCALATE", codes: ["CI_FAILURES_REPEATED"] },
  "CI failed and the run history cannot be read": {
    mutate: (w) => {
      failHeadRun(w);
      delete R(w).branchRuns;
    },
    state: "BLOCKED",
    codes: ["CI_BUDGET_UNKNOWN"],
  },
  "CI failed and the newest page of runs never reaches a passing head": {
    mutate: (w) => {
      failHeadRun(w);
      R(w).branchRuns = { total_count: 500, workflow_runs: [ciRun(3003, w.head, "failure")] };
    },
    state: "BLOCKED",
    codes: ["CI_BUDGET_UNKNOWN"],
  },
  "three red heads inside a partial page are already enough to stop": {
    mutate: (w) => {
      failHeadRun(w, "all");
      R(w).branchRuns.total_count = 500;
    },
    state: "ESCALATE",
    codes: ["CI_FAILURES_REPEATED"],
  },

  // --- Review: one fact - a TRUSTED verdict for the CURRENT exact head --------
  "no review present at all": {
    mutate: (w) => {
      R(w).reviews[0] = [];
      R(w).inline[0] = [];
      threadsOf(w).nodes = [];
      threadsOf(w).totalCount = 0;
      dropIssue(w, 6003);
    },
    state: "ACTION_RECOMMENDED",
    codes: ["REQUEST_EXACT_HEAD_REVIEW"],
  },
  "the only trusted verdict is for an older head": {
    mutate: (w) => dropIssue(w, 6003),
    state: "ACTION_RECOMMENDED",
    codes: ["REQUEST_EXACT_HEAD_REVIEW"],
  },
  "a trusted verdict names the head but states nothing": {
    mutate: (w) => {
      issue(w, 6003).body = `**Reviewed commit:** \`${short(w.head)}\`\n\nNotes.`;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_REVIEW"],
  },
  "an outsider posted a look-alike clean verdict for the head": {
    mutate: (w) => {
      dropIssue(w, 6003);
      R(w).issues[0].push({ id: 6006, user: OUTSIDER, body: cleanVerdict(w.head) });
    },
    state: "ACTION_RECOMMENDED",
    codes: ["REQUEST_EXACT_HEAD_REVIEW"],
  },
  "a bot reusing Codex's login under another id posted a clean verdict": {
    mutate: (w) => {
      issue(w, 6003).user = CODEX_LOGIN_OTHER_ID;
    },
    state: "ACTION_RECOMMENDED",
    codes: ["REQUEST_EXACT_HEAD_REVIEW"],
  },
  "Codex's account id, but as a User rather than a Bot, posted a clean verdict": {
    mutate: (w) => {
      issue(w, 6003).user = CODEX_ID_AS_USER;
    },
    state: "ACTION_RECOMMENDED",
    codes: ["REQUEST_EXACT_HEAD_REVIEW"],
  },
  "an untrusted badge cannot lend a trusted verdict that states nothing a result": {
    mutate: (w) => {
      issue(w, 6003).body = `**Reviewed commit:** \`${short(w.head)}\`\n\nNotes.`;
      addRoot(w, { id: 5005, severity: "P3", at: w.head, resolved: false, user: OUTSIDER });
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_REVIEW"],
  },

  // --- Findings, from the trusted reviewer only -----------------------------
  "an unresolved P1 was raised at the head": {
    mutate: (w) => findingRoundAtHead(w, "P1"),
    state: "ACTION_RECOMMENDED",
    codes: ["REPAIR_FINDINGS"],
  },
  "the same P1, on a change raised to T2 (one autonomous repair)": {
    mutate: (w) => findingRoundAtHead(w, "P1"),
    tier: "T2",
    state: "ESCALATE",
    codes: ["REVIEW_ROUNDS_EXCEEDED"],
  },
  "a P2 from an earlier head was never resolved": {
    mutate: (w) => {
      threadsOf(w).nodes[0].isResolved = false;
    },
    state: "ACTION_RECOMMENDED",
    codes: ["DISPOSITION_FINDINGS"],
  },
  "a Codex comment carries no severity badge": {
    mutate: (w) => addRoot(w, { id: 5003, severity: null, at: w.commits[1], resolved: false }),
    state: "BLOCKED",
    codes: ["NOT_PROVEN_FINDINGS"],
  },
  "review threads and inline comments disagree": {
    mutate: (w) => {
      threadsOf(w).nodes.push({ isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 9999 }] } });
      threadsOf(w).totalCount = 2;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_FINDINGS"],
  },
  "a fresh P1 when the commit history cannot be read": {
    mutate: (w) => {
      findingRoundAtHead(w, "P1");
      delete R(w).commits;
    },
    state: "BLOCKED",
    codes: ["REPAIR_BUDGET_UNKNOWN"],
  },
  "a reviewed head is no longer in the branch history": {
    mutate: (w) => R(w).issues[0].push({ id: 6005, user: CODEX, body: cleanVerdict(sha("rewritten")) }),
    state: "BLOCKED",
    codes: ["HISTORY_REWRITTEN"],
  },

  // --- The pull request and its branch --------------------------------------
  "production moved on": {
    mutate: (w) => Object.assign(R(w).comparison, { status: "diverged", behind_by: 2 }),
    state: "ACTION_RECOMMENDED",
    codes: ["REFRESH_PRODUCTION"],
  },
  "the branch conflicts with production": {
    mutate: (w) => {
      R(w).pull.mergeable = false;
    },
    state: "ACTION_RECOMMENDED",
    codes: ["RESOLVE_CONFLICTS"],
  },
  "GitHub has not computed mergeability yet": {
    mutate: (w) => {
      R(w).pull.mergeable = null;
    },
    state: "WAITING",
    codes: ["WAIT_MERGEABILITY"],
  },
  "the pull request is a draft": {
    mutate: (w) => {
      R(w).pull.draft = true;
    },
    state: "BLOCKED",
    codes: ["PR_DRAFT"],
  },
  "the PR is stacked on another branch": {
    mutate: (w) => {
      R(w).pull.base.ref = "feat/parent";
    },
    state: "BLOCKED",
    codes: ["BASE_NOT_PRODUCTION"],
  },
  "a push landed while the PR was being read": {
    mutate: (w) => {
      R(w).pullAfter = { ...structuredClone(R(w).pull), head: { sha: sha("pushed"), ref: "feat/eng-world" } };
    },
    state: "WAITING",
    codes: ["HEAD_MOVED_DURING_READ"],
  },
  "the closing head re-read returns nothing": {
    mutate: (w) => {
      R(w).pullAfter = null;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_SNAPSHOT"],
  },
  "the comparison with production cannot be read": {
    mutate: (w) => {
      delete R(w).comparison;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_BRANCH"],
  },
  "the pull request cannot be read": {
    mutate: (w) => {
      delete R(w).pull;
    },
    state: "BLOCKED",
    codes: ["UNREADABLE_PULL_REQUEST"],
  },
  merged: {
    mutate: (w) => Object.assign(R(w).pull, { state: "closed", merged_at: ago(1) }),
    state: "CLOSED",
    codes: ["PR_MERGED"],
  },
  "closed without merging": {
    mutate: (w) => {
      R(w).pull.state = "closed";
    },
    state: "CLOSED",
    codes: ["PR_CLOSED"],
  },
};

/** Changes that must NOT take candidacy away - each a trap for a sloppy reader. */
const STILL_CANDIDATE: Record<string, (w: World) => void> = {
  "an earlier run at the same sha failed; the latest passed": (w) =>
    runsAtHead(w, [ciRun(2990, w.head, "failure"), ciRun(3003, w.head, "success")], {
      3003: R(w).jobs[3003][0].jobs,
    }),
  "a failed run of another workflow at the same sha, with a higher id": (w) => {
    R(w).workflowRuns[0].workflow_runs.push(
      ciRun(3050, w.head, "failure", "completed", { path: ".github/workflows/nightly.yml", event: "schedule" }),
    );
    R(w).workflowRuns[0].total_count = 2;
  },
  "a failed push-event run of the PR workflow at the same sha": (w) => {
    R(w).workflowRuns[0].workflow_runs.push(ciRun(3051, w.head, "failure", "completed", { event: "push" }));
    R(w).workflowRuns[0].total_count = 2;
  },
  "runs listed oldest-last, newest-first or shuffled": (w) => {
    runsAtHead(w, [ciRun(3003, w.head, "success"), ciRun(2990, w.head, "failure"), ciRun(2995, w.head, "cancelled")], {
      3003: R(w).jobs[3003][0].jobs,
    });
  },
  "a neutral job passes": (w) => {
    R(w).jobs[3003][0].jobs.push(job(9005, 3003, w.head, "advisory", "neutral"));
    R(w).jobs[3003][0].total_count = 5;
  },
  "the run history is unreadable, but the head itself is green": (w) => {
    delete R(w).branchRuns;
  },
  "an operator's request for a review is not evidence of anything": (w) =>
    R(w).issues[0].push({ id: 6010, user: OPERATOR, body: `@codex review \`${short(w.head)}\`` }),
  "a P3 at the head is not actionable": (w) => findingRoundAtHead(w, "P3"),
  "a P1 at the head that was resolved in its thread": (w) => findingRoundAtHead(w, "P1", true),
  "an outsider's P1 badge at the head is not a finding": (w) =>
    addRoot(w, { id: 5101, severity: "P1", at: w.head, resolved: false, user: OUTSIDER }),
  "outsider badges at three consecutive heads cannot force the stop law": (w) =>
    w.commits.forEach((at, i) => addRoot(w, { id: 5110 + i, severity: "P1", at, resolved: false, user: OUTSIDER })),
};

/**
 * A fresh world with one situation applied. JSON-copied so that no object is
 * shared - with another world, with a helper constant, or inside the world -
 * and corrupting one leaf corrupts exactly one leaf.
 */
const build = (mutate?: (w: World) => void): World => {
  const w = readyWorld();
  mutate?.(w);
  return JSON.parse(JSON.stringify(w));
};

const CANDIDATE = STATE.CANDIDATE_READY_FOR_HUMAN_REVIEW;

// ---------------------------------------------------------------------------
// 1. status is unchanged
// ---------------------------------------------------------------------------

describe("`status` stays facts-only and behaviour-compatible", () => {
  const FIXTURES = path.resolve(__dirname, "fixtures");
  const golden = JSON.parse(readFileSync(path.join(FIXTURES, "status-golden.json"), "utf8"));

  it("renders every recorded PR byte-for-byte as the unmodified production tree did", () => {
    for (const pr of [610, 612, 613, 615, 616]) {
      const facts = JSON.parse(readFileSync(path.join(FIXTURES, `pr-${pr}.json`), "utf8"));
      expect(renderHuman(facts)).toBe(golden[pr].human);
      expect(JSON.stringify(summarize(facts), null, 2)).toBe(golden[pr].json);
    }
  });

  it("makes exactly the five reads it made before", () => {
    const record: Call[] = [];
    const w = readyWorld();
    collectFacts({ pr: w.pr, fetcher: fetcherFor(w, { record }), repo: REPO });
    expect(record.map((c) => [c.path, c.opts])).toEqual([
      [`repos/{repo}/pulls/${w.pr}`, {}],
      [`repos/{repo}/pulls/${w.pr}/reviews`, { paginate: true }],
      [`repos/{repo}/pulls/${w.pr}/comments`, { paginate: true }],
      [`repos/{repo}/issues/${w.pr}/comments`, { paginate: true }],
      [`repos/{repo}/commits/${w.head}/check-runs`, { paginate: true }],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. the decision is total, and the candidate state is one point
// ---------------------------------------------------------------------------

describe("the decision is a total function, and CANDIDATE_READY_FOR_HUMAN_REVIEW is exactly one point", () => {
  const keys = Object.keys(DOMAINS) as string[];
  const values = keys.map((k) => DOMAINS[k] as string[]);
  const states = new Set(Object.values(STATE));

  it("DOMAINS and CANDIDATE_POINT describe the same signals, and the candidate value is in each domain", () => {
    expect(Object.keys(CANDIDATE_POINT).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(DOMAINS[k]).toContain(CANDIDATE_POINT[k]);
    for (const k of keys) expect(DOMAINS[k]).toContain("UNKNOWN");
  });

  it("holds every invariant over the whole product of every signal value", () => {
    const violations: string[] = [];
    const emitted = new Set<string>();
    const reached = new Set<string>();
    const pointAt = keys.map((k, i) => values[i].indexOf(CANDIDATE_POINT[k]));
    const unknownAt = keys.map((_, i) => values[i].indexOf("UNKNOWN"));
    const idx = keys.map(() => 0);
    const s: Json = Object.fromEntries(keys.map((k, i) => [k, values[i][0]]));
    let combos = 0;
    const flag = (why: string) => {
      if (violations.length < 10) violations.push(`${why}: ${JSON.stringify(s)}`);
    };
    // An odometer over the product. `s` is reused between combinations, which
    // is safe only because `decide` is pure - the next test pins that.
    for (;;) {
      const out = decide(s);
      combos += 1;
      reached.add(out.state);
      let atPoint = true;
      let anyUnknown = false;
      for (let j = 0; j < idx.length; j++) {
        if (idx[j] !== pointAt[j]) atPoint = false;
        if (idx[j] === unknownAt[j]) anyUnknown = true;
      }
      let codes = 0;
      for (const group of [out.stops, out.blocks, out.actions, out.waits]) {
        codes += group.length;
        for (const c of group) emitted.add(c);
      }

      const live = s.pr !== "UNKNOWN" && s.pr !== "MERGED" && s.pr !== "CLOSED" && s.snapshot !== "TORN";
      if (!states.has(out.state)) flag("unknown state");
      if ((out.state === CANDIDATE) !== atPoint) flag("candidate off the candidate point, or not at it");
      if ((out.state === STATE.CLOSED) !== (s.pr === "MERGED" || s.pr === "CLOSED")) flag("CLOSED mismatch");
      if ((out.state === STATE.ESCALATE) !== (live && (s.rounds === "EXCEEDED" || s.ciStreak === "EXCEEDED"))) {
        flag("ESCALATE does not track a confirmed stop law");
      }
      if (out.actions.includes("REPAIR_FINDINGS") && !(s.findings === "FRESH" && s.rounds === "WITHIN_CAP")) flag("repair outside budget");
      if (out.actions.includes("FIX_CI") && !(s.ci === "FAILED" && s.ciStreak === "WITHIN_CAP")) flag("CI fix outside budget");
      if (out.actions.includes("REQUEST_EXACT_HEAD_REVIEW") && s.review !== "NO_VERDICT_AT_HEAD") flag("review requested with a verdict at head");
      if (out.state !== CANDIDATE && codes === 0) flag("a state with no reason");
      if (out.state === CANDIDATE && codes !== 0) flag("candidate with reasons attached");
      // The final fall-through is for evidence that could not be read. A fully
      // KNOWN situation must always get a concrete next step instead.
      if (out.blocks.length > 0 && out.blocks[0].startsWith("NOT_PROVEN_") && !anyUnknown) {
        flag("a fully known situation fell through with no next step");
      }

      let i = keys.length - 1;
      while (i >= 0 && ++idx[i] === values[i].length) {
        idx[i] = 0;
        s[keys[i]] = values[i][0];
        i -= 1;
      }
      if (i < 0) break;
      s[keys[i]] = values[i][idx[i]];
    }

    expect(violations).toEqual([]);
    expect(combos).toBe(values.reduce((n, v) => n * v.length, 1));
    expect([...emitted].filter((c) => !CODES.includes(c))).toEqual([]);
    expect([...reached].sort()).toEqual([...states].sort());
  }, 60_000);

  it("is pure: the same input gives the same answer and is not modified", () => {
    const s = Object.freeze({ ...CANDIDATE_POINT, ci: "FAILED" });
    expect(decide(s)).toEqual(decide({ ...s }));
  });
});

// ---------------------------------------------------------------------------
// 3. delivery situations, through the real collector
// ---------------------------------------------------------------------------

describe("delivery situations map to the recommendation the rules call for", () => {
  it("POSITIVE CONTROL: a PR at the gate is a CANDIDATE for human review, and says it is advisory", () => {
    const r = run(readyWorld());
    expect(r.state).toBe(CANDIDATE);
    expect(r.exitCode).toBe(EXIT_CODE[CANDIDATE]);
    expect(r.advisory).toBe(true);
    expect(codesOf(r)).toEqual([]);
    expect(r.summary).toMatch(/CANDIDATE for human review/);
    expect(r.summary).toMatch(/advisory/);
    expect(r.summary).toMatch(/neither green CI nor this state authorizes a merge/);
    expect(r.unavailable).toEqual([]);
    expect(r.signals).toEqual(CANDIDATE_POINT);
  });

  for (const [name, sc] of Object.entries(SCENARIOS)) {
    it(`${name} -> ${sc.state} ${sc.codes.join(", ")}`, () => {
      const r = run(build(sc.mutate), { tier: sc.tier ?? null });
      expect({ state: r.state, codes: codesOf(r) }).toEqual({ state: sc.state, codes: sc.codes });
      expect(r.exitCode).toBe(EXIT_CODE[sc.state]);
    });
  }

  for (const [name, mutate] of Object.entries(STILL_CANDIDATE)) {
    it(`${name}: still a candidate`, () => {
      expect(run(build(mutate)).state).toBe(CANDIDATE);
    });
  }

  it("green CI alone never makes a candidate", () => {
    const r = run(build(SCENARIOS["no review present at all"].mutate));
    expect(r.signals.ci).toBe("GREEN");
    expect(r.state).not.toBe(CANDIDATE);
  });

  it("a stale verdict is named, and the recommendation names the exact head", () => {
    const r = run(build(SCENARIOS["the only trusted verdict is for an older head"].mutate));
    expect(r.signals.review).toBe("NO_VERDICT_AT_HEAD");
    expect(r.actions[0].text).toContain(`"@codex review" naming \`${short(sha("head"))}\``);
    expect(r.actions[0].text).toContain(`last trusted verdict was for ${short(sha("c2"))}`);
    expect(r.actions[0].text).toMatch(/Whether someone already asked is not inferred/);
  });

  it("a resolved P1 at the head is shown to the human at the gate, not hidden", () => {
    const r = run(build(STILL_CANDIDATE["a P1 at the head that was resolved in its thread"]));
    expect(r.detail.findings.resolvedAtHead).toBe(1);
    expect(renderShepherd(r)).toMatch(/resolved in its thread without a new commit/);
  });

  it("untrusted comments are counted and shown as ignored, never used", () => {
    const r = run(build(STILL_CANDIDATE["an outsider's P1 badge at the head is not a finding"]));
    expect(r.detail.review.untrusted).toEqual({ reviews: 0, issueComments: 2, inlineComments: 1 });
    expect(renderShepherd(r)).toMatch(/3 comment\(s\) from untrusted authors ignored/);
  });

  it("two fresh findings: the root-cause family check is recommended before patching", () => {
    const r = run(
      build((w) => {
        findingRoundAtHead(w, "P1");
        addRoot(w, { id: 5004, severity: "P2", at: w.head, resolved: false });
      }),
    );
    expect(codesOf(r)).toEqual(["REPAIR_FINDINGS"]);
    expect(r.actions[0].text).toMatch(/share a root-cause family: if they do, stop/);
  });

  it("the tier can be raised by an operator and never lowered", () => {
    const fresh = build((w) => findingRoundAtHead(w, "P1"));
    expect(run(fresh, { tier: "T0" }).detail.rounds).toMatchObject({ baselineTier: "T1", tier: "T1", budget: 2 });
    expect(run(fresh, { tier: "T3" }).detail.rounds).toMatchObject({ baselineTier: "T1", tier: "T3", budget: 1 });
    expect(run(build((w) => void delete R(w).files)).detail.rounds).toMatchObject({ tier: "UNKNOWN", budget: 1 });
  });
});

// ---------------------------------------------------------------------------
// 4. the authority gate: untrusted evidence is inert
// ---------------------------------------------------------------------------

/** Every comment-derived item in a world, as a path into its responses. */
function commentPaths(w: World): Array<{ kind: "reviews" | "issues" | "inline"; i: number }> {
  const out: Array<{ kind: "reviews" | "issues" | "inline"; i: number }> = [];
  for (const kind of ["reviews", "issues", "inline"] as const) {
    if (!Array.isArray(R(w)[kind]?.[0])) continue;
    R(w)[kind][0].forEach((_: Json, i: number) => out.push({ kind, i }));
  }
  return out;
}

/** Remove one comment; an inline root takes its thread with it, as on GitHub. */
function removeComment(w: World, kind: string, i: number) {
  const [item] = R(w)[kind][0].splice(i, 1);
  if (kind === "inline" && (item.in_reply_to_id === undefined || item.in_reply_to_id === null)) {
    const t = threadsOf(w);
    t.nodes = t.nodes.filter((n: Json) => n.comments.nodes[0].databaseId !== item.id);
    t.totalCount = t.nodes.length;
  }
}

const UNTRUSTED = [OUTSIDER, OPERATOR, CODEX_LOGIN_OTHER_ID, CODEX_ID_AS_USER];
const SITUATIONS: Array<[string, (w: World) => void, string | null]> = [
  ["a candidate", () => {}, null],
  ...Object.entries(SCENARIOS).map(([name, sc]): [string, (w: World) => void, string | null] => [name, sc.mutate, sc.tier ?? null]),
  ...Object.entries(STILL_CANDIDATE).map(([name, m]): [string, (w: World) => void, string | null] => [name, m, null]),
];

describe("the authority gate: no untrusted actor's evidence reaches a decision", () => {
  it("ADDING an untrusted copy of any comment, in any situation, changes nothing", () => {
    const changed: string[] = [];
    let checks = 0;
    for (const [name, mutate, tier] of SITUATIONS) {
      const base = build(mutate);
      const expected = verdictOf(run(base, { tier }));
      for (const { kind, i } of commentPaths(base)) {
        for (const user of UNTRUSTED) {
          const w = structuredClone(base);
          const copy = { ...structuredClone(R(w)[kind][0][i]), id: 880000 + i, user };
          R(w)[kind][0].push(copy);
          if (kind === "inline" && (copy.in_reply_to_id === undefined || copy.in_reply_to_id === null)) {
            threadsOf(w).nodes.push({ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: copy.id }] } });
            threadsOf(w).totalCount += 1;
          }
          checks += 1;
          if (JSON.stringify(verdictOf(run(w, { tier }))) !== JSON.stringify(expected)) changed.push(`${name} / +${kind}[${i}] by ${user.login}#${user.id}`);
        }
      }
    }
    expect(changed).toEqual([]);
    expect(checks).toBeGreaterThan(SITUATIONS.length * 4);
  });

  it("RE-ATTRIBUTING any comment to an untrusted actor is exactly the same as deleting it", () => {
    const changed: string[] = [];
    for (const [name, mutate, tier] of SITUATIONS) {
      const base = build(mutate);
      for (const { kind, i } of commentPaths(base)) {
        const removed = structuredClone(base);
        removeComment(removed, kind, i);
        const expected = JSON.stringify(verdictOf(run(removed, { tier })));
        for (const user of UNTRUSTED) {
          const w = structuredClone(base);
          R(w)[kind][0][i].user = user;
          if (JSON.stringify(verdictOf(run(w, { tier }))) !== expected) changed.push(`${name} / ${kind}[${i}] as ${user.login}#${user.id}`);
        }
      }
    }
    expect(changed).toEqual([]);
  });

  it("no request is inferred: asking for a review, from anyone, never stands in for a verdict", () => {
    const w = build(SCENARIOS["no review present at all"].mutate);
    for (const user of [OPERATOR, OUTSIDER, CODEX]) {
      R(w).issues[0].push({ id: 6100 + user.id % 97, user, body: `@codex review \`${short(w.head)}\`` });
    }
    const r = run(w);
    expect(codesOf(r)).toEqual(["REQUEST_EXACT_HEAD_REVIEW"]);
    expect(r.detail.review).not.toHaveProperty("requestsAtHead");
  });
});

// ---------------------------------------------------------------------------
// 5. exact-head review binding
// ---------------------------------------------------------------------------

describe("a verdict counts only for the exact head it names", () => {
  it("only a sha that IS the head - in full or by a 7+ character prefix - is a verdict for it", () => {
    const head = sha("head");
    const nearMiss = head.slice(0, 6) + (head[6] === "0" ? "1" : "0") + head.slice(7, 10);
    const cases: Array<[string, boolean]> = [
      [head, true],
      [head.slice(0, 10), true],
      [head.slice(0, 7), true],
      [nearMiss, false],
      [sha("c2"), false],
      [sha("c2").slice(0, 10), false],
      [sha("c1").slice(0, 7), false],
      [sha("production"), false],
      [sha("elsewhere"), false],
    ];
    for (const [named, isHead] of cases) {
      const w = build((x) => {
        issue(x, 6003).body = `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${named}\``;
      });
      const r = run(w);
      // A verdict for any commit outside the PR is a rewritten history, not a review of the head.
      const inHistory = w.commits.some((c) => c.startsWith(named) || named.startsWith(c.slice(0, named.length)));
      expect({ named, review: r.signals.review }).toEqual({ named, review: isHead ? "VERDICT_AT_HEAD" : "NO_VERDICT_AT_HEAD" });
      expect(r.state).toBe(isHead ? CANDIDATE : inHistory ? STATE.ACTION_RECOMMENDED : STATE.BLOCKED);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. CI is the LATEST applicable run, never all runs at the sha
// ---------------------------------------------------------------------------

describe("CI derives from the latest applicable run at the exact head only", () => {
  it("latestApplicableRun takes the highest id of the PR workflow's pull_request runs, in any order", () => {
    const at = (id: number, over: Json = {}) => ciRun(id, sha("head"), "success", "completed", over);
    expect(latestApplicableRun([at(5), at(9), at(7)]).id).toBe(9);
    expect(latestApplicableRun([at(9, { event: "push" }), at(3)]).id).toBe(3);
    expect(latestApplicableRun([at(9, { path: ".github/workflows/nightly.yml" }), at(3)]).id).toBe(3);
    expect(latestApplicableRun([at(9, { event: "workflow_dispatch" })])).toBeNull();
    expect(latestApplicableRun([])).toBeNull();
    expect(PR_WORKFLOW).toEqual({ path: CI_WORKFLOW, event: "pull_request" });
  });

  it("over 300 seeded random run sets, CI is exactly what the latest applicable run alone says", () => {
    let seed = 795;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const shapes: Array<[string, string | null]> = [
      ["completed", "success"],
      ["completed", "failure"],
      ["completed", "cancelled"],
      ["completed", "timed_out"],
      ["in_progress", null],
      ["queued", null],
    ];
    const mismatches: string[] = [];
    for (let k = 0; k < 300; k++) {
      const base = readyWorld();
      const head = base.head;
      const ids = [...new Set(Array.from({ length: 2 + Math.floor(rand() * 4) }, () => 1000 + Math.floor(rand() * 9000)))];
      const runs = ids.map((id) => {
        const [status, conclusion] = pick(shapes);
        return ciRun(id, head, conclusion, status, {
          path: rand() < 0.75 ? CI_WORKFLOW : ".github/workflows/nightly.yml",
          event: rand() < 0.75 ? "pull_request" : pick(["push", "schedule", "workflow_dispatch"]),
        });
      });
      // Shuffle the listing: order must not matter.
      runs.sort(() => rand() - 0.5);
      const jobsFor = (r: Json) => [job(r.id * 10, r.id, head, "lane", r.conclusion, r.status)];
      // The rule, restated independently of the code under test.
      const applicable = runs.filter((r) => r.path === CI_WORKFLOW && r.event === "pull_request");
      const latest = applicable.length ? applicable.reduce((a, b) => (b.id > a.id ? b : a)) : null;

      const all = structuredClone(base);
      runsAtHead(all, runs, Object.fromEntries(runs.map((r) => [r.id, jobsFor(r)])));
      const alone = structuredClone(base);
      runsAtHead(alone, latest ? [latest] : [], latest ? { [latest.id]: jobsFor(latest) } : {});

      const got = run(all).detail.ci;
      const want = run(alone).detail.ci;
      if (JSON.stringify([got.signal, got.run]) !== JSON.stringify([want.signal, want.run])) {
        mismatches.push(`${JSON.stringify(runs.map((r) => [r.id, r.path.split("/").pop(), r.event, r.status, r.conclusion]))}: ${got.signal} vs ${want.signal}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. the stop law on real history: #786
// ---------------------------------------------------------------------------

describe("the §7.4 review-round stop law, replayed on #786", () => {
  const fx = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/pr-786-history.json"), "utf8"));
  const shas: string[] = fx.commits.map((c: Json) => c.sha);
  const indexOf = (s: string | null) => (s ? shas.findIndex((x) => x.startsWith(s.toLowerCase())) : -1);
  const named = (body: string) => body.match(/Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/)?.[1] ?? body.match(/`([0-9a-f]{7,40})`/)?.[1] ?? null;

  /** #786 as GitHub showed it right after the review of commit `k` landed. */
  function asOf(k: number): World {
    const head = shas[k];
    const next = k + 1 < shas.length ? Date.parse(fx.commits[k + 1].commit.committer.date) : Infinity;
    const keep = (s: string | null, createdAt: string) => (s !== null && indexOf(s) !== -1 ? indexOf(s) <= k : Date.parse(createdAt) < next);
    const inline = fx.inline.filter((c: Json) => indexOf(c.original_commit_id) <= k);
    const roots = new Set(inline.map((c: Json) => c.id));
    const nodes = fx.threads.filter((t: Json) => roots.has(t.comments.nodes[0].databaseId));
    const P = sha("production-786");
    const w = readyWorld();
    const pull = {
      number: 786,
      state: "open",
      draft: false,
      merged_at: null,
      mergeable: true,
      commits: k + 1,
      changed_files: fx.files.length,
      head: { sha: head, ref: "feat/wiki-auto-01" },
      base: { ref: PROD_BRANCH, sha: P, repo: { default_branch: PROD_BRANCH } },
    };
    Object.assign(w, { pr: 786, head, production: P, commits: shas.slice(0, k + 1) });
    Object.assign(w.responses, {
      pull,
      pullAfter: structuredClone(pull),
      reviews: [fx.reviews.filter((r: Json) => keep(named(r.body) ?? r.commit_id, r.submitted_at))],
      inline: [inline],
      issues: [fx.issues.filter((c: Json) => keep(named(c.body), c.created_at))],
      commits: [fx.commits.slice(0, k + 1)],
      files: [fx.files],
      threads: [{ data: { repository: { pullRequest: { reviewThreads: { totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes } } } } }],
      productionRef: { ref: `refs/heads/${PROD_BRANCH}`, object: { sha: P, type: "commit" } },
      comparison: { status: "ahead", ahead_by: k + 1, behind_by: 0, base_commit: { sha: P } },
      workflowRuns: [{ total_count: 1, workflow_runs: [ciRun(4000 + k, head, "success")] }],
      jobs: { [4000 + k]: jobsPage([job(41000 + k, 4000 + k, head, "ci", "success")]) },
      branchRuns: { total_count: k + 1, workflow_runs: shas.slice(0, k + 1).map((s, i) => ciRun(4000 + i, s, "success")) },
    });
    return w;
  }

  it("the fixture is the recorded #786: T1, seven P0-P2 rounds, then clean at 1af828a3", () => {
    expect(shas.map((s) => s.slice(0, 8))).toEqual([
      "7d1e7dd4", "e9cd5d10", "0080ea7b", "2b6b28a2", "3644d2fb", "61c9496a", "2ba37643", "826eea45", "663f86a3", "1af828a3",
    ]);
    expect(run(asOf(9)).detail.rounds.baselineTier).toBe("T1");
  });

  it("repairs are recommended for rounds one and two, and the loop is told to stop at the third - 3644d2fb", () => {
    expect(codesOf(run(asOf(2)))).toEqual(["REPAIR_FINDINGS"]);
    expect(codesOf(run(asOf(3)))).toEqual(["REPAIR_FINDINGS"]);
    const third = run(asOf(4));
    expect(third.state).toBe(STATE.ESCALATE);
    expect(third.detail.rounds.heads.map((s: string) => s.slice(0, 8))).toEqual(["3644d2fb", "2b6b28a2", "0080ea7b"]);
    expect(third.stops[0].text).toMatch(/3 consecutive review rounds .* T1 repair budget of 2\. Recommended: stop patching/);
  });

  it("every round the operator patched past the trigger stays ESCALATE", () => {
    for (const k of [5, 6, 7, 8]) expect(run(asOf(k)).state).toBe(STATE.ESCALATE);
  });

  it("a T2 budget stops one round earlier, at 2b6b28a2", () => {
    expect(run(asOf(2), { tier: "T2" }).state).toBe(STATE.ACTION_RECOMMENDED);
    expect(run(asOf(3), { tier: "T2" }).state).toBe(STATE.ESCALATE);
  });

  it("the clean head ends the streak, but sixteen unresolved findings still stand between it and candidacy", () => {
    const r = run(asOf(9));
    expect(r.detail.rounds.streak).toBe(0);
    expect(r.signals.review).toBe("VERDICT_AT_HEAD");
    expect(codesOf(r)).toEqual(["DISPOSITION_FINDINGS"]);
    expect(r.detail.findings.carried).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// 8. fault injection and corruption, derived from what was actually read
// ---------------------------------------------------------------------------

type Path = Array<string | number>;
type Node = { path: Path; value: Json; parent: Json };

function* nodesOf(value: Json, path: Path = [], parent: Json = null): Generator<Node> {
  if (path.length) yield { path, value, parent };
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* nodesOf(value[i], [...path, i], value);
  else if (value !== null && typeof value === "object") for (const k of Object.keys(value)) yield* nodesOf(value[k], [...path, k], value);
}

const DELETE = Symbol("delete");
const COUNT_KEY = /(^|_)count$|Count$|_by$|^commits$|^changed_files$/;

/** Type-breaking replacements for one node. Never another VALID value: a valid
 *  value can legitimately change the answer; a malformed one may never make it
 *  more positive. */
function malformations(node: Node): Array<{ label: string; value: unknown }> {
  const { value, path } = node;
  const key = path[path.length - 1];
  const out: Array<{ label: string; value: unknown }> = [];
  if (typeof key === "string") out.push({ label: "deleted", value: DELETE });
  if (value !== null) out.push({ label: "null", value: null });
  if (typeof value === "string") {
    out.push({ label: "number", value: 0 }, { label: "object", value: {} });
    if (/^[0-9a-f]{40}$/.test(value)) out.push({ label: "empty sha", value: "" }, { label: "non-hex sha", value: "g".repeat(40) });
  } else if (typeof value === "number") {
    out.push({ label: "string", value: String(value) });
    if (typeof key === "string" && COUNT_KEY.test(key)) out.push({ label: "negative", value: -1 }, { label: "fraction", value: 0.5 });
  } else if (typeof value === "boolean") {
    out.push({ label: "string", value: String(value) }, { label: "number", value: Number(value) });
  } else if (value === null) {
    out.push({ label: "string", value: "x" }, { label: "number", value: 0 }, { label: "object", value: {} });
  } else if (Array.isArray(value)) {
    out.push({ label: "object", value: {} }, { label: "string", value: "x" });
  } else {
    out.push({ label: "array", value: [] }, { label: "string", value: "x" });
  }
  return out;
}

/** Corrupt one node in place, run `fn`, and restore the node exactly. */
function withCorruption<T>(w: World, path: Path, value: unknown, fn: () => T): T {
  let target: Json = w.responses;
  for (const step of path.slice(0, -1)) target = target[step];
  const last = path[path.length - 1];
  const had = Object.prototype.hasOwnProperty.call(target, last);
  const old = target[last];
  if (value === DELETE) delete target[last];
  else target[last] = value;
  try {
    return fn();
  } finally {
    if (had) target[last] = old;
    else delete target[last];
  }
}

/** Every whole answer the collector can receive: one per key, and one per run's jobs. */
function answers(w: World): Path[] {
  const out: Path[] = [];
  for (const key of Object.keys(w.responses)) {
    if (key === "jobs" && w.responses.jobs && typeof w.responses.jobs === "object") {
      for (const runId of Object.keys(w.responses.jobs)) out.push(["jobs", runId]);
    } else out.push([key]);
  }
  return out;
}

/** Arrays whose length GitHub states, so losing one item is detectable. */
function totalledArrays(w: World): Path[] {
  const out: Path[] = [];
  for (const n of nodesOf(w.responses)) {
    if (!Array.isArray(n.value) || n.parent === null || Array.isArray(n.parent)) continue;
    if (Object.keys(n.parent).some((k) => /^total_?[cC]ount$/.test(k))) out.push(n.path);
  }
  // REST lists GitHub states no total for: the pull request states these two,
  // and review threads (above) carry the total the inline comments are held to.
  for (const key of ["commits", "files", "inline"]) if (Array.isArray(w.responses[key]?.[0])) out.push([key, 0]);
  return out;
}

const NOT_CANDIDATE = Object.entries(SCENARIOS);

/**
 * Surfaces candidacy does not depend on, each for a stated reason. Everything
 * NOT listed here must, when lost, take candidacy away - the request sweep checks.
 */
const CANDIDACY_INDEPENDENT: Record<string, string> = {
  files: "the file list only sets the repair budget; losing it applies the strictest budget, and a zero streak is within any budget",
  branchRuns: "the head's own green run ends any failure streak, so run history is only consulted while the head is not green",
  checkRuns: "read by `status` only; the shepherd never requests it",
};

describe("fault injection and corruption: what was read is what is attacked", () => {
  it("every request the collector makes is answered by the synthetic GitHub (the attack surface is real)", () => {
    const record: Call[] = [];
    const w = readyWorld();
    interpret(collectShepherdFacts({ pr: w.pr, fetcher: fetcherFor(w, { record }), repo: REPO }), { now: NOW });
    expect(record.filter((c) => c.key === null)).toEqual([]);
    // `checkRuns` is read by `status` only; the shepherd never asks for it.
    expect(new Set(record.map((c) => c.key))).toEqual(new Set(Object.keys(w.responses).filter((k) => k !== "checkRuns")));
  });

  it("losing ANY request takes candidacy away, except the two surfaces it provably does not need", () => {
    const record: Call[] = [];
    run(readyWorld(), { fault: (c) => void record.push(c) });
    expect(record.length).toBeGreaterThan(10);
    const kept: string[] = [];
    for (const call of record) {
      const r = run(readyWorld(), { fault: (c) => (c.index === call.index ? { ok: false, reason: "injected" } : undefined) });
      if (r.state === CANDIDATE) kept.push(String(call.key));
    }
    expect(kept.sort()).toEqual(Object.keys(CANDIDACY_INDEPENDENT).filter((k) => k !== "checkRuns").sort());
  });

  it("no lost request, from any situation that is not a candidate, ever produces one", () => {
    const flips: string[] = [];
    for (const [name, sc] of NOT_CANDIDATE) {
      const record: Call[] = [];
      run(build(sc.mutate), { tier: sc.tier ?? null, fault: (c) => void record.push(c) });
      for (const call of record) {
        const r = run(build(sc.mutate), { tier: sc.tier ?? null, fault: (c) => (c.index === call.index ? { ok: false, reason: "x" } : undefined) });
        if (r.state === CANDIDATE) flips.push(`${name} / ${call.key}`);
      }
    }
    expect(flips).toEqual([]);
  });

  it("no malformed WHOLE answer, anywhere, ever produces a candidate from a situation that is not one", () => {
    const shapes: unknown[] = [DELETE, null, {}, [], "x", 0, [[]], [{}], [null]];
    const flips: string[] = [];
    for (const [name, sc] of NOT_CANDIDATE) {
      const base = build(sc.mutate);
      for (const answer of answers(base)) {
        for (const value of shapes) {
          const r = withCorruption(base, answer, value, () => run(base, { tier: sc.tier ?? null }));
          if (r.state === CANDIDATE) flips.push(`${name} / ${answer.join(".")} = ${String(value)}`);
        }
      }
    }
    expect(flips).toEqual([]);
  });

  it("no single corrupted leaf, anywhere in any answer, ever produces a candidate from a situation that is not one", () => {
    const flips: string[] = [];
    let attempts = 0;
    for (const [name, sc] of NOT_CANDIDATE) {
      const base = build(sc.mutate);
      for (const node of [...nodesOf(base.responses)]) {
        for (const m of malformations(node)) {
          attempts += 1;
          const r = withCorruption(base, node.path, m.value, () => run(base, { tier: sc.tier ?? null }));
          if (r.state === CANDIDATE) flips.push(`${name} / ${node.path.join(".")} ${m.label}`);
        }
      }
    }
    expect(flips).toEqual([]);
    // Anti-vacuity: the sweep really ran at scale across every situation.
    expect(attempts).toBeGreaterThan(NOT_CANDIDATE.length * 100);
  }, 120_000);

  it("no item dropped from a collection GitHub states the size of ever produces a candidate", () => {
    const flips: string[] = [];
    for (const [name, sc] of NOT_CANDIDATE) {
      const base = build(sc.mutate);
      for (const arrayPath of totalledArrays(base)) {
        let target: Json = base.responses;
        for (const step of arrayPath) target = target?.[step];
        if (!Array.isArray(target)) continue;
        for (let i = 0; i < target.length; i++) {
          const copy = structuredClone(base);
          let arr: Json = copy.responses;
          for (const step of arrayPath) arr = arr[step];
          arr.splice(i, 1);
          if (run(copy, { tier: sc.tier ?? null }).state === CANDIDATE) flips.push(`${name} / ${arrayPath.join(".")}[${i}]`);
        }
      }
    }
    expect(flips).toEqual([]);
  });

  it("from a candidate, dropping any stated-size item takes candidacy away unless it does not depend on it", () => {
    const base = build();
    const kept: string[] = [];
    for (const arrayPath of totalledArrays(base)) {
      let target: Json = base.responses;
      for (const step of arrayPath) target = target[step];
      for (let i = 0; i < target.length; i++) {
        const copy = structuredClone(base);
        let arr: Json = copy.responses;
        for (const step of arrayPath) arr = arr[step];
        arr.splice(i, 1);
        if (run(copy).state === CANDIDATE) kept.push(String(arrayPath[0]));
      }
    }
    expect([...new Set(kept)].filter((k) => !(k in CANDIDACY_INDEPENDENT))).toEqual([]);
  });

  it("the collector never modifies an answer it reads (so a corruption sweep may reuse one world)", () => {
    const w = build();
    deepFreeze(w.responses);
    expect(run(w).state).toBe(CANDIDATE);
    for (const [, sc] of NOT_CANDIDATE.slice(0, 8)) {
      const v = build(sc.mutate);
      deepFreeze(v.responses);
      expect(() => run(v, { tier: sc.tier ?? null })).not.toThrow();
    }
  });

  it("corruption never crashes the shepherd: every leaf of the candidate world, every malformation", () => {
    const base = build();
    const states = new Set(Object.values(STATE));
    const broken: string[] = [];
    for (const node of [...nodesOf(base.responses)]) {
      for (const m of malformations(node)) {
        withCorruption(base, node.path, m.value, () => {
          try {
            const r = run(base);
            if (!states.has(r.state) || !renderShepherd(r).includes(`STATE ${r.state}`)) broken.push(node.path.join("."));
          } catch (err) {
            broken.push(`${node.path.join(".")} ${m.label}: ${String(err)}`);
          }
        });
      }
    }
    expect(broken).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 9. read-only by construction, and advisory in every word
// ---------------------------------------------------------------------------

describe("the shepherd is read-only by construction, and advisory in what it says", () => {
  it("REST reads are bare `gh api <path>`: no method and no fields, so they are GETs", () => {
    const argv: string[][] = [];
    const exec = (bin: string, args: string[]) => {
      argv.push([bin, ...args]);
      return "{}";
    };
    const fetch = ghFetcher({ repo: "o/r", exec });
    fetch("repos/{repo}/pulls/1");
    fetch("repos/{repo}/pulls/1/commits", { paginate: true });
    fetch("graphql", { paginate: true, graphql: { query: "query($number: Int!) { x }", variables: { owner: "o", number: 1 } } });
    expect(argv).toEqual([
      ["gh", "api", "repos/o/r/pulls/1"],
      ["gh", "api", "repos/o/r/pulls/1/commits", "--paginate", "--slurp"],
      ["gh", "api", "graphql", "--paginate", "--slurp", "-f", "owner=o", "-F", "number=1", "-f", "query=query($number: Int!) { x }"],
    ]);
  });

  it("a GraphQL document that is not a read query is refused before anything runs", () => {
    let ran = false;
    const fetch = ghFetcher({ repo: "o/r", exec: () => ((ran = true), "{}") });
    for (const query of [
      "mutation { mergePullRequest(input: {}) { clientMutationId } }",
      "query { x } mutation { y }",
      "subscription { x }",
      "{ viewer { login } }",
    ]) {
      expect(fetch("graphql", { graphql: { query, variables: {} } }).ok).toBe(false);
    }
    expect(fetch("repos/{repo}/pulls/1", { graphql: { query: "query { x }", variables: {} } }).ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("every request a full read makes is a REST GET path or a read-only GraphQL query", () => {
    const record: Call[] = [];
    const w = readyWorld();
    collectShepherdFacts({ pr: w.pr, fetcher: fetcherFor(w, { record }), repo: REPO });
    for (const c of record) {
      if (c.path === "graphql") {
        expect(c.opts.graphql?.query).toMatch(/^\s*query\b/);
        expect(c.opts.graphql?.query).not.toMatch(/\b(mutation|subscription)\b/);
      } else {
        expect(c.opts.graphql).toBeUndefined();
        expect(c.path).toMatch(/^repos\/\{repo\}\//);
      }
    }
  });

  it("no merge, refresh, history rewrite, GitHub write or local persistence exists in the eng sources", () => {
    const dir = path.resolve(__dirname, "../../scripts/eng");
    const strip = (src: string) => src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    const code = (f: string) => strip(readFileSync(path.join(dir, f), "utf8"));
    for (const f of ["shepherd.mjs", "watch.mjs", "cli.mjs", "github-facts.mjs", "review-provenance.mjs", "evidence.mjs"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/gh\s+pr\s+merge|mergePullRequest|enablePullRequestAutoMerge|\/merges?\b|merge_method/);
      expect(src, f).not.toMatch(/\bgit\s+[a-z]/);
      expect(src, f).not.toMatch(/--amend|--force|--squash|-X\s|--method/);
      expect(src, f).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|mkdirSync|renameSync|unlinkSync|rmSync/);
    }
    for (const f of ["shepherd.mjs", "watch.mjs", "cli.mjs"]) expect(code(f), f).not.toMatch(/child_process|execFile|spawn/);
    expect(code("github-facts.mjs").match(/exec\(/g)).toEqual(["exec("]);
    expect(code("github-facts.mjs")).toMatch(/exec\("gh", args/);
  });

  it("every recommendation is phrased as one, and none rewrites history, merges or forces a push", () => {
    const texts: string[] = [];
    for (const sc of Object.values(SCENARIOS)) {
      const r = run(build(sc.mutate), { tier: sc.tier ?? null });
      for (const a of r.actions) expect(a.text, a.code).toMatch(/Recommended:/);
      texts.push(...[...r.stops, ...r.blocks, ...r.actions, ...r.waits].map((x: Json) => x.text));
    }
    texts.push(run(readyWorld()).summary);
    expect(texts.length).toBeGreaterThan(Object.keys(SCENARIOS).length);
    for (const t of texts) {
      expect(t).not.toMatch(/\b(rebase|amend|squash|force)/i);
      expect(t).not.toMatch(/gh pr merge|merge (the|this) (pull request|PR)\b/i);
      expect(t).not.toMatch(/\b(required|must|mandatory)\b/i);
    }
    expect(LAW).toMatch(/^Observation only/);
    expect(LAW).toMatch(/never merges, rebases, amends, squashes, force-pushes or refreshes a branch/);
  });

  it("the standards and the decision record describe the shepherd as advisory, in its current vocabulary", () => {
    const root = path.resolve(__dirname, "../..");
    const decision = readFileSync(path.join(root, "docs/decisions/eng-loop-01-observation-only.md"), "utf8");
    const standards = readFileSync(path.join(root, "ENGINEERING_STANDARDS.md"), "utf8");
    const section8 = standards.slice(standards.indexOf("## 8."));
    expect(decision).toMatch(/OBSERVATION-ONLY/);
    expect(decision).toMatch(/\*\*Status\*\* \| \*\*ACCEPTED\*\*/);
    expect(section8).toMatch(/advisory/);
    expect(section8).toContain("docs/decisions/eng-loop-01-observation-only.md");
    for (const state of Object.values(STATE)) expect(section8).toContain(state);
    // The superseded authority vocabulary survives only as history in the decision record.
    for (const f of ["shepherd.mjs", "watch.mjs", "cli.mjs", "github-facts.mjs"]) {
      expect(readFileSync(path.join(root, "scripts/eng", f), "utf8"), f).not.toMatch(/READY_FOR_HUMAN_MERGE|ACTION_REQUIRED/);
    }
    expect(section8).not.toMatch(/READY_FOR_HUMAN_MERGE|ACTION_REQUIRED/);
  });

  it("the workflow the shepherd reads as CI is the repository's pull-request workflow", () => {
    const ci = readFileSync(path.resolve(__dirname, "../../", CI_WORKFLOW), "utf8");
    expect(ci).toMatch(/^on:\s*\n\s+pull_request:/m);
  });
});
