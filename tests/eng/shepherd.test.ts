import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectFacts, collectShepherdFacts, ghFetcher } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { summarize } from "../../scripts/eng/review-provenance.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { CODES, DOMAINS, EXIT_CODE, LAW, READY_POINT, STATE, decide, interpret, renderShepherd } from "../../scripts/eng/shepherd.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { renderHuman } from "../../scripts/eng/cli.mjs";
import {
  CI_WORKFLOW,
  CODEX,
  NOW,
  OPERATOR,
  PROD_BRANCH,
  REPO,
  ago,
  ciRun,
  cleanVerdict,
  deepFreeze,
  fetcherFor,
  finding,
  findingsVerdict,
  readyWorld,
  sha,
  short,
  type Call,
  type Json,
  type World,
} from "./helpers/github-world";

// ===========================================================================
// ENG-LOOP-01 acceptance: the PR shepherd.
// ===========================================================================
//
// What is proved here, and how each proof avoids the way CP-005's authority
// vehicles failed (#617-#623: a builder's hand-enumerated cases, with omitted
// surfaces falling through permissive defaults into a positive state):
//
//   1. `status` is unchanged - byte-for-byte against output captured from the
//      unmodified production tree BEFORE this change.
//   2. The decision is TOTAL and READY is ONE point: every combination of every
//      signal value is enumerated from the exported DOMAINS, not hand-picked.
//   3. Each delivery situation maps to the state and next step the delivery
//      rules require, through the real collector against GitHub-shaped answers.
//   4. The §7.4 stop law fires on REAL history: #786 crossed the
//      three-round trigger at 3644d2fb and was patched past it.
//   5. Fault injection BY CONSTRUCTION: the requests and response leaves that
//      are failed, corrupted or truncated are the ones the collector actually
//      made and read, recorded at run time - so a surface added later is
//      covered without anyone remembering to list it.
//   6. Read-only by construction: the exact argv, the refused GraphQL
//      document, and no write or history-rewriting path in the source.

const R = (w: World): Json => w.responses;
const threadsOf = (w: World): Json => R(w).threads[0].data.repository.pullRequest.reviewThreads;
const dropIssue = (w: World, id: number) => {
  R(w).issues[0] = R(w).issues[0].filter((c: Json) => c.id !== id);
};

function run(w: World, { tier = null, fault }: { tier?: string | null; fault?: (c: Call) => unknown } = {}) {
  const sf = collectShepherdFacts({ pr: w.pr, fetcher: fetcherFor(w, { fault }), repo: REPO });
  return interpret(sf, { now: NOW, tier });
}

const codesOf = (r: Json): string[] => [...r.stops, ...r.blocks, ...r.actions, ...r.waits].map((x: Json) => x.code);

function addRoot(w: World, c: { id: number; severity: string | null; at: string; resolved: boolean; user?: Json }) {
  R(w).inline[0].push({
    id: c.id,
    user: c.user ?? CODEX,
    body: c.severity ? finding(c.severity, `Finding ${c.id}`) : "This deserves a second look.",
    commit_id: w.head,
    original_commit_id: c.at,
    path: "scripts/eng/world.mjs",
    line: c.id % 100,
    original_line: c.id % 100,
    created_at: ago(10),
    reactions: { total_count: 0 },
  });
  const t = threadsOf(w);
  t.nodes.push({ isResolved: c.resolved, isOutdated: false, comments: { nodes: [{ databaseId: c.id }] } });
  t.totalCount += 1;
}

/** A Codex round at the head that raised a finding, with no clean verdict for it. */
function findingRoundAtHead(w: World, severity: string, resolved = false) {
  addRoot(w, { id: 5002, severity, at: w.head, resolved });
  R(w).reviews[0].push({ id: 7002, user: CODEX, body: findingsVerdict(w.head), state: "COMMENTED", commit_id: w.head, submitted_at: ago(10) });
  dropIssue(w, 6003);
}

function failLane(w: World, heads: "head" | "all" = "head") {
  R(w).checkRuns[0].check_runs[1].conclusion = "failure";
  R(w).workflowRuns[0].workflow_runs[0].conclusion = "failure";
  for (const run of R(w).branchRuns.workflow_runs) {
    if (heads === "all" || run.head_sha === w.head) run.conclusion = "failure";
  }
}

interface Scenario {
  mutate: (w: World) => void;
  tier?: string;
  state: string;
  codes: string[];
}

const SCENARIOS: Record<string, Scenario> = {
  "a lane failed at the head": { mutate: (w) => failLane(w), state: "ACTION_REQUIRED", codes: ["FIX_CI"] },
  "every visible check passed, but the workflow is still running (its aggregator has no check run yet)": {
    mutate: (w) => {
      const run = R(w).workflowRuns[0].workflow_runs[0];
      run.status = "in_progress";
      run.conclusion = null;
      R(w).checkRuns[0].check_runs.splice(2, 1);
      R(w).checkRuns[0].total_count = 4;
    },
    state: "WAITING",
    codes: ["WAIT_CI"],
  },
  "no run of the required workflow exists for the head yet": {
    mutate: (w) => {
      R(w).workflowRuns = [{ total_count: 0, workflow_runs: [] }];
    },
    state: "WAITING",
    codes: ["WAIT_CI"],
  },
  "a lane was cancelled": {
    mutate: (w) => {
      R(w).checkRuns[0].check_runs[2].conclusion = "cancelled";
      R(w).workflowRuns[0].workflow_runs[0].conclusion = "cancelled";
    },
    state: "ACTION_REQUIRED",
    codes: ["RERUN_CI"],
  },
  "a commit status failed": {
    mutate: (w) => {
      R(w).statuses[0].state = "failure";
      R(w).statuses[0].statuses[0].state = "failure";
    },
    state: "ACTION_REQUIRED",
    codes: ["FIX_CI"],
  },
  "an unresolved P1 was raised at the head": {
    mutate: (w) => findingRoundAtHead(w, "P1"),
    state: "ACTION_REQUIRED",
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
    state: "ACTION_REQUIRED",
    codes: ["DISPOSITION_FINDINGS"],
  },
  "production moved on": {
    mutate: (w) => Object.assign(R(w).comparison, { status: "diverged", behind_by: 2 }),
    state: "ACTION_REQUIRED",
    codes: ["REFRESH_PRODUCTION"],
  },
  "the branch conflicts with production": {
    mutate: (w) => {
      R(w).pull.mergeable = false;
    },
    state: "ACTION_REQUIRED",
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
  "the only trusted verdict is for an older head": {
    mutate: (w) => {
      dropIssue(w, 6002);
      dropIssue(w, 6003);
    },
    state: "ACTION_REQUIRED",
    codes: ["REQUEST_REVIEW"],
  },
  "a review was requested 20 minutes ago": {
    mutate: (w) => dropIssue(w, 6003),
    state: "WAITING",
    codes: ["WAIT_REVIEW"],
  },
  "a PR was just opened: Codex reviews it unasked, so the shepherd waits instead of re-asking": {
    mutate: (w) => {
      dropIssue(w, 6002);
      dropIssue(w, 6003);
      // The head (committed 40 minutes ago) is the head the PR was opened with.
      R(w).pull.created_at = ago(10);
    },
    state: "WAITING",
    codes: ["WAIT_REVIEW"],
  },
  "a PR opened 39 minutes ago that Codex never answered": {
    mutate: (w) => {
      dropIssue(w, 6002);
      dropIssue(w, 6003);
      R(w).pull.created_at = ago(39);
    },
    state: "BLOCKED",
    codes: ["REVIEW_UNANSWERED"],
  },
  "an unbound request made before this head existed does not count for it": {
    mutate: (w) => {
      dropIssue(w, 6002);
      dropIssue(w, 6003);
      // The head was committed 40 minutes ago; this ask predates it.
      R(w).issues[0].push({ id: 6007, user: OPERATOR, body: "@codex review", created_at: ago(60) });
    },
    state: "ACTION_REQUIRED",
    codes: ["REQUEST_REVIEW"],
  },
  "an unbound request made after this head counts for it": {
    mutate: (w) => {
      dropIssue(w, 6002);
      dropIssue(w, 6003);
      R(w).issues[0].push({ id: 6007, user: OPERATOR, body: "@codex review", created_at: ago(5) });
    },
    state: "WAITING",
    codes: ["WAIT_REVIEW"],
  },
  "a review was requested 45 minutes ago and never answered": {
    mutate: (w) => {
      dropIssue(w, 6003);
      R(w).issues[0].find((c: Json) => c.id === 6002).created_at = ago(45);
    },
    state: "BLOCKED",
    codes: ["REVIEW_UNANSWERED"],
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
  "a reviewed head is no longer in the branch history": {
    mutate: (w) => R(w).issues[0].push({ id: 6005, user: CODEX, body: cleanVerdict(sha("rewritten")), created_at: ago(60) }),
    state: "BLOCKED",
    codes: ["HISTORY_REWRITTEN"],
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
  "merged": {
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
  "CI failed at three consecutive heads": {
    mutate: (w) => failLane(w, "all"),
    state: "ESCALATE",
    codes: ["CI_FAILURES_REPEATED"],
  },
  "CI failed and the run history cannot be read": {
    mutate: (w) => {
      failLane(w);
      delete R(w).branchRuns;
    },
    state: "BLOCKED",
    codes: ["CI_BUDGET_UNKNOWN"],
  },
  "CI failed and the newest page of runs never reaches a passing head": {
    mutate: (w) => {
      failLane(w);
      R(w).branchRuns = { total_count: 500, workflow_runs: [ciRun(3003, w.head, "failure")] };
    },
    state: "BLOCKED",
    codes: ["CI_BUDGET_UNKNOWN"],
  },
  "three red heads inside a partial page are already enough to stop": {
    mutate: (w) => {
      failLane(w, "all");
      R(w).branchRuns.total_count = 500;
    },
    state: "ESCALATE",
    codes: ["CI_FAILURES_REPEATED"],
  },
  "a fresh P1 when the commit history cannot be read": {
    mutate: (w) => {
      findingRoundAtHead(w, "P1");
      delete R(w).commits;
    },
    state: "BLOCKED",
    codes: ["REPAIR_BUDGET_UNKNOWN"],
  },
  "the pull request cannot be read": {
    mutate: (w) => {
      delete R(w).pull;
    },
    state: "BLOCKED",
    codes: ["UNREADABLE_PULL_REQUEST"],
  },
  "an operator posted a look-alike clean verdict for the head": {
    mutate: (w) => {
      dropIssue(w, 6002);
      dropIssue(w, 6003);
      R(w).issues[0].push({
        id: 6006,
        user: OPERATOR,
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${short(w.head)}\``,
        created_at: ago(5),
      });
    },
    state: "ACTION_REQUIRED",
    codes: ["REQUEST_REVIEW"],
  },
  "a trusted verdict names the head but states nothing": {
    mutate: (w) => {
      R(w).issues[0].find((c: Json) => c.id === 6003).body = `**Reviewed commit:** \`${short(w.head)}\`\n\nNotes.`;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_REVIEW"],
  },
  "the comparison with production cannot be read": {
    mutate: (w) => {
      delete R(w).comparison;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_BRANCH"],
  },
  "the closing head re-read returns nothing": {
    mutate: (w) => {
      R(w).pullAfter = null;
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_SNAPSHOT"],
  },
  // Exact-head binding. A well-formed answer about ANOTHER commit is not a
  // malformed one, so the corruption sweep cannot produce it; these can.
  "the check runs answered describe another commit": {
    mutate: (w) => {
      for (const c of R(w).checkRuns[0].check_runs) c.head_sha = sha("elsewhere");
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "the workflow runs answered describe another commit": {
    mutate: (w) => {
      R(w).workflowRuns[0].workflow_runs[0].head_sha = sha("elsewhere");
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "the commit statuses answered describe another commit": {
    mutate: (w) => {
      R(w).statuses[0].sha = sha("elsewhere");
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
  "a lane reports a status GitHub never documented": {
    mutate: (w) => {
      R(w).checkRuns[0].check_runs[0].status = "paused";
    },
    state: "BLOCKED",
    codes: ["NOT_PROVEN_CI"],
  },
};

/** Changes that must NOT block the gate - each one is a trap for a sloppy reader. */
const STILL_READY: Record<string, (w: World) => void> = {
  "a P3 at the head is not actionable": (w) => findingRoundAtHead(w, "P3"),
  "a P1 at the head that was resolved in its thread": (w) => findingRoundAtHead(w, "P1", true),
  "a neutral lane passes": (w) => {
    R(w).checkRuns[0].check_runs.push({ name: "advisory", status: "completed", conclusion: "neutral", head_sha: w.head });
    R(w).checkRuns[0].total_count = 6;
  },
  "the run history is unreadable, but the head itself is green": (w) => {
    delete R(w).branchRuns;
  },
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
// 2. the decision is total, and READY is one point
// ---------------------------------------------------------------------------

describe("the decision is a total function, and READY_FOR_HUMAN_MERGE is exactly one point", () => {
  const keys = Object.keys(DOMAINS) as string[];
  const values = keys.map((k) => DOMAINS[k] as string[]);
  const states = new Set(Object.values(STATE));

  it("DOMAINS and READY_POINT describe the same signals, and the ready value is in each domain", () => {
    expect(Object.keys(READY_POINT).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(DOMAINS[k]).toContain(READY_POINT[k]);
    for (const k of keys) expect(DOMAINS[k]).toContain("UNKNOWN");
  });

  it("holds every invariant over the whole product of every signal value", () => {
    const violations: string[] = [];
    const emitted = new Set<string>();
    const reached = new Set<string>();
    const readyAt = keys.map((k, i) => values[i].indexOf(READY_POINT[k]));
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
      let atReadyPoint = true;
      let anyUnknown = false;
      for (let j = 0; j < idx.length; j++) {
        if (idx[j] !== readyAt[j]) atReadyPoint = false;
        if (idx[j] === unknownAt[j]) anyUnknown = true;
      }
      let codes = 0;
      for (const group of [out.stops, out.blocks, out.actions, out.waits]) {
        codes += group.length;
        for (const c of group) emitted.add(c);
      }

      const live = s.pr !== "UNKNOWN" && s.pr !== "MERGED" && s.pr !== "CLOSED" && s.snapshot !== "TORN";
      if (!states.has(out.state)) flag("unknown state");
      if ((out.state === STATE.READY_FOR_HUMAN_MERGE) !== atReadyPoint) flag("READY off the ready point, or not at it");
      if ((out.state === STATE.CLOSED) !== (s.pr === "MERGED" || s.pr === "CLOSED")) flag("CLOSED mismatch");
      if ((out.state === STATE.ESCALATE) !== (live && (s.rounds === "EXCEEDED" || s.ciStreak === "EXCEEDED"))) {
        flag("ESCALATE does not track a confirmed stop law");
      }
      if (out.actions.includes("REPAIR_FINDINGS") && !(s.findings === "FRESH" && s.rounds === "WITHIN_CAP")) flag("repair outside budget");
      if (out.actions.includes("FIX_CI") && !(s.ci === "FAILED" && s.ciStreak === "WITHIN_CAP")) flag("CI fix outside budget");
      if (out.state !== STATE.READY_FOR_HUMAN_MERGE && codes === 0) flag("a state with no reason");
      if (out.state === STATE.READY_FOR_HUMAN_MERGE && codes !== 0) flag("READY with reasons attached");
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
    // Every emitted code has words, and every state is actually reachable.
    expect([...emitted].filter((c) => !CODES.includes(c))).toEqual([]);
    expect([...reached].sort()).toEqual([...states].sort());
  }, 60_000);

  it("is pure: the same input gives the same answer and is not modified", () => {
    const s = Object.freeze({ ...READY_POINT, ci: "FAILED" });
    expect(decide(s)).toEqual(decide({ ...s }));
  });
});

// ---------------------------------------------------------------------------
// 3. delivery situations, through the real collector
// ---------------------------------------------------------------------------

describe("delivery situations map to the state and step the rules require", () => {
  it("POSITIVE CONTROL: a PR at the gate is READY_FOR_HUMAN_MERGE, and says the human decides", () => {
    const r = run(readyWorld());
    expect(r.state).toBe(STATE.READY_FOR_HUMAN_MERGE);
    expect(r.exitCode).toBe(EXIT_CODE.READY_FOR_HUMAN_MERGE);
    expect(codesOf(r)).toEqual([]);
    expect(r.summary).toMatch(/merge decision is the operator's/);
    expect(r.summary).toMatch(/neither green CI nor this state is merge authorization/);
    expect(r.unavailable).toEqual([]);
    expect(r.signals).toEqual(READY_POINT);
  });

  for (const [name, sc] of Object.entries(SCENARIOS)) {
    it(`${name} -> ${sc.state} ${sc.codes.join(", ")}`, () => {
      const r = run(build(sc.mutate), { tier: sc.tier ?? null });
      expect({ state: r.state, codes: codesOf(r) }).toEqual({ state: sc.state, codes: sc.codes });
      expect(r.exitCode).toBe(EXIT_CODE[sc.state]);
    });
  }

  for (const [name, mutate] of Object.entries(STILL_READY)) {
    it(`${name}: still READY_FOR_HUMAN_MERGE`, () => {
      expect(run(build(mutate)).state).toBe(STATE.READY_FOR_HUMAN_MERGE);
    });
  }

  it("a resolved P1 at the head is shown to the human at the gate, not hidden", () => {
    const r = run(build(STILL_READY["a P1 at the head that was resolved in its thread"]));
    expect(r.detail.findings.resolvedAtHead).toBe(1);
    expect(renderShepherd(r)).toMatch(/resolved in its thread without a new commit/);
  });

  it("green CI alone never reaches the gate", () => {
    const w = build((x) => {
      dropIssue(x, 6002);
      dropIssue(x, 6003);
      R(x).reviews[0] = [];
      R(x).inline[0] = [];
      threadsOf(x).nodes = [];
      threadsOf(x).totalCount = 0;
    });
    const r = run(w);
    expect(r.signals.ci).toBe("GREEN");
    expect(r.state).not.toBe(STATE.READY_FOR_HUMAN_MERGE);
    expect(codesOf(r)).toEqual(["REQUEST_REVIEW"]);
  });

  it("a new commit invalidates the exact-head verdict, and the request names the new head", () => {
    const r = run(build(SCENARIOS["the only trusted verdict is for an older head"].mutate));
    expect(r.signals.review).toBe("STALE");
    expect(r.actions[0].text).toContain(`@codex review" naming \`${short(sha("head"))}\``);
    expect(r.actions[0].text).toContain(`last trusted verdict was for ${short(sha("c2"))}`);
  });

  it("a review asked for by opening the PR says so", () => {
    const r = run(build(SCENARIOS["a PR was just opened: Codex reviews it unasked, so the shepherd waits instead of re-asking"].mutate));
    expect(r.detail.review).toMatchObject({ askedByOpening: true, requestsAtHead: 0, latestRequestAgeMinutes: 10 });
    expect(r.waits[0].text).toContain("(by opening the PR) 10 min ago");
  });

  it("Codex's own comments are never counted as review requests", () => {
    const r = run(build((w) => dropIssue(w, 6002)));
    // 6003 (Codex) and 6000 (Codex summary) both say "@codex review"; neither asks.
    expect(r.detail.review.requestsAtHead).toBe(0);
  });

  it("two fresh findings: the root-cause family check is required before patching", () => {
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
    const unreadable = build((w) => {
      delete R(w).files;
    });
    expect(run(unreadable).detail.rounds).toMatchObject({ tier: "UNKNOWN", budget: 1 });
  });
});

// ---------------------------------------------------------------------------
// 4. the stop law on real history: #786
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
      created_at: fx.commits[0].commit.committer.date,
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
      checkRuns: [{ total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success", head_sha: head }] }],
      workflowRuns: [{ total_count: 1, workflow_runs: [ciRun(4000 + k, head, "success")] }],
      statuses: [{ sha: head, state: "pending", total_count: 0, statuses: [] }],
      branchRuns: { total_count: k + 1, workflow_runs: shas.slice(0, k + 1).map((s, i) => ciRun(4000 + i, s, "success")) },
    });
    return w;
  }

  it("the fixture is the recorded #786: T1, seven P0-P2 rounds, then clean at 1af828a3", () => {
    expect(shas.map((s) => s.slice(0, 8))).toEqual([
      "7d1e7dd4", "e9cd5d10", "0080ea7b", "2b6b28a2", "3644d2fb", "61c9496a", "2ba37643", "826eea45", "663f86a3", "1af828a3",
    ]);
    const r = run(asOf(9));
    expect(r.detail.rounds.baselineTier).toBe("T1");
  });

  it("repairs are proposed for rounds one and two, and the loop stops at the third - 3644d2fb", () => {
    const at = (k: number) => run(asOf(k));
    expect(codesOf(at(2))).toEqual(["REPAIR_FINDINGS"]);
    expect(codesOf(at(3))).toEqual(["REPAIR_FINDINGS"]);
    const third = at(4);
    expect(third.state).toBe(STATE.ESCALATE);
    expect(third.detail.rounds.heads.map((s: string) => s.slice(0, 8))).toEqual(["3644d2fb", "2b6b28a2", "0080ea7b"]);
    expect(third.stops[0].text).toMatch(/3 consecutive review rounds .* T1 repair budget of 2/);
  });

  it("every round the operator patched past the trigger stays ESCALATE", () => {
    for (const k of [5, 6, 7, 8]) expect(run(asOf(k)).state).toBe(STATE.ESCALATE);
  });

  it("a T2 budget stops one round earlier, at 2b6b28a2", () => {
    expect(run(asOf(2), { tier: "T2" }).state).toBe(STATE.ACTION_REQUIRED);
    expect(run(asOf(3), { tier: "T2" }).state).toBe(STATE.ESCALATE);
  });

  it("the clean head ends the streak, but sixteen unresolved findings still bar the gate", () => {
    const r = run(asOf(9));
    expect(r.detail.rounds.streak).toBe(0);
    expect(r.signals.review).toBe("VERDICT_AT_HEAD");
    expect(codesOf(r)).toEqual(["DISPOSITION_FINDINGS"]);
    expect(r.detail.findings.carried).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// 5. fault injection and corruption, derived from what was actually read
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

const NOT_READY = Object.entries(SCENARIOS).filter(([, sc]) => sc.state !== STATE.READY_FOR_HUMAN_MERGE);

/**
 * Surfaces READY does not depend on, each for a stated reason. Everything NOT
 * listed here must, when lost, take READY away - which the request sweep checks.
 */
const READY_INDEPENDENT: Record<string, string> = {
  files: "the file list only sets the repair budget; losing it applies the strictest budget, and a zero streak is within any budget",
  branchRuns: "the head's own green CI ends any failure streak, so run history is only consulted while the head is not green",
};

describe("fault injection and corruption: what was read is what is attacked", () => {
  it("every request the collector makes is answered by the synthetic GitHub (the attack surface is real)", () => {
    const record: Call[] = [];
    const w = readyWorld();
    interpret(collectShepherdFacts({ pr: w.pr, fetcher: fetcherFor(w, { record }), repo: REPO }), { now: NOW });
    expect(record.filter((c) => c.key === null)).toEqual([]);
    expect(new Set(record.map((c) => c.key))).toEqual(new Set([...Object.keys(w.responses)]));
  });

  it("losing ANY request takes READY away, except the two surfaces READY provably does not need", () => {
    const record: Call[] = [];
    const w = readyWorld();
    run({ ...w, responses: w.responses }, { fault: (c) => void record.push(c) });
    expect(record.length).toBeGreaterThan(10);
    const kept: string[] = [];
    for (const call of record) {
      const r = run(readyWorld(), { fault: (c) => (c.index === call.index ? { ok: false, reason: "injected" } : undefined) });
      if (r.state === STATE.READY_FOR_HUMAN_MERGE) kept.push(String(call.key));
    }
    expect(kept.sort()).toEqual(Object.keys(READY_INDEPENDENT).sort());
  });

  it("no lost request, from any situation that is not ready, ever produces READY", () => {
    const flips: string[] = [];
    for (const [name, sc] of NOT_READY) {
      const record: Call[] = [];
      run(build(sc.mutate), { tier: sc.tier ?? null, fault: (c) => void record.push(c) });
      for (const call of record) {
        const r = run(build(sc.mutate), { tier: sc.tier ?? null, fault: (c) => (c.index === call.index ? { ok: false, reason: "x" } : undefined) });
        if (r.state === STATE.READY_FOR_HUMAN_MERGE) flips.push(`${name} / ${call.key}`);
      }
    }
    expect(flips).toEqual([]);
  });

  it("a malformed answer is reported as that surface's failure, contained to it", () => {
    // Without this containment the lenient `status` projection throws on a null
    // pull request, and every surface - not just the broken one - goes UNKNOWN.
    const r = run(build((w) => void (R(w).pull = null)));
    expect(r.state).toBe(STATE.BLOCKED);
    expect(r.unavailable).toContainEqual({ surface: "pull_request", reason: "malformed: the answer is not a JSON object or array" });
    expect(r.unavailable.map((u: Json) => u.surface)).not.toContain("projection");
  });

  it("a projection that throws on a malformed answer degrades to UNKNOWN instead of ending the read", () => {
    // `status`'s projection iterates `check_runs`; an object there throws in it.
    const r = run(build((w) => void (R(w).checkRuns[0].check_runs = {})));
    expect(r.state).toBe(STATE.BLOCKED);
    expect(r.signals.ci).toBe("UNKNOWN");
    expect(r.unavailable.map((u: Json) => u.surface)).toContain("projection");
  });

  it("the collector never modifies an answer it reads (so a corruption sweep may reuse one world)", () => {
    const w = build();
    deepFreeze(w.responses);
    expect(run(w).state).toBe(STATE.READY_FOR_HUMAN_MERGE);
    for (const [, sc] of NOT_READY.slice(0, 8)) {
      const v = build(sc.mutate);
      deepFreeze(v.responses);
      expect(() => run(v, { tier: sc.tier ?? null })).not.toThrow();
    }
  });

  it("no malformed WHOLE answer, anywhere, ever produces READY from a situation that is not ready", () => {
    const shapes: unknown[] = [DELETE, null, {}, [], "x", 0, [[]], [{}], [null]];
    const flips: string[] = [];
    for (const [name, sc] of NOT_READY) {
      const base = build(sc.mutate);
      for (const key of Object.keys(base.responses)) {
        for (const value of shapes) {
          const r = withCorruption(base, [key], value, () => run(base, { tier: sc.tier ?? null }));
          if (r.state === STATE.READY_FOR_HUMAN_MERGE) flips.push(`${name} / ${key} = ${String(value)}`);
        }
      }
    }
    expect(flips).toEqual([]);
  });

  it("no single corrupted leaf, anywhere in any answer, ever produces READY from a situation that is not ready", () => {
    const flips: string[] = [];
    let attempts = 0;
    for (const [name, sc] of NOT_READY) {
      const base = build(sc.mutate);
      for (const node of [...nodesOf(base.responses)]) {
        for (const m of malformations(node)) {
          attempts += 1;
          const r = withCorruption(base, node.path, m.value, () => run(base, { tier: sc.tier ?? null }));
          if (r.state === STATE.READY_FOR_HUMAN_MERGE) flips.push(`${name} / ${node.path.join(".")} ${m.label}`);
        }
      }
    }
    expect(flips).toEqual([]);
    // Anti-vacuity: the sweep really ran at scale across every situation.
    expect(attempts).toBeGreaterThan(NOT_READY.length * 100);
  }, 120_000);

  it("no item dropped from a collection GitHub states the size of ever produces READY", () => {
    const flips: string[] = [];
    for (const [name, sc] of NOT_READY) {
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
          if (run(copy, { tier: sc.tier ?? null }).state === STATE.READY_FOR_HUMAN_MERGE) flips.push(`${name} / ${arrayPath.join(".")}[${i}]`);
        }
      }
    }
    expect(flips).toEqual([]);
  });

  it("from READY, dropping any stated-size item takes READY away unless READY does not depend on it", () => {
    const base = readyWorld();
    const kept: string[] = [];
    for (const arrayPath of totalledArrays(base)) {
      let target: Json = base.responses;
      for (const step of arrayPath) target = target[step];
      for (let i = 0; i < target.length; i++) {
        const copy = structuredClone(base);
        let arr: Json = copy.responses;
        for (const step of arrayPath) arr = arr[step];
        arr.splice(i, 1);
        if (run(copy).state === STATE.READY_FOR_HUMAN_MERGE) kept.push(String(arrayPath[0]));
      }
    }
    expect([...new Set(kept)].filter((k) => !(k in READY_INDEPENDENT))).toEqual([]);
  });

  it("corruption never crashes the shepherd: every leaf of the READY world, every malformation", () => {
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
// 6. read-only by construction
// ---------------------------------------------------------------------------

describe("the shepherd is read-only by construction", () => {
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

  it("no merge, history rewrite, GitHub write or local persistence exists in the eng sources", () => {
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

  it("no step the shepherd proposes rewrites history, merges the PR or forces a push", () => {
    const texts: string[] = [];
    for (const sc of Object.values(SCENARIOS)) {
      const r = run(build(sc.mutate), { tier: sc.tier ?? null });
      texts.push(...[...r.stops, ...r.blocks, ...r.actions, ...r.waits].map((x: Json) => x.text));
    }
    texts.push(run(readyWorld()).summary);
    expect(texts.length).toBeGreaterThan(Object.keys(SCENARIOS).length);
    for (const t of texts) {
      expect(t).not.toMatch(/\b(rebase|amend|squash|force)/i);
      expect(t).not.toMatch(/gh pr merge|merge (the|this) (pull request|PR)/i);
    }
    expect(LAW).toMatch(/never merges, rebases, amends, squashes or force-pushes/);
  });

  it("the required workflow the shepherd waits for is the repository's pull-request workflow", () => {
    const ci = readFileSync(path.resolve(__dirname, "../../", CI_WORKFLOW), "utf8");
    expect(ci).toMatch(/^on:\s*\n\s+pull_request:/m);
  });
});
