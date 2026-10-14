/* eslint-disable @typescript-eslint/no-explicit-any -- recorded GitHub evidence and pipeline results are untyped on purpose */
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
import { evaluate, type Impl } from "./support/pipeline";
import { matches, show, type Expect } from "./support/scenarios";
import { REAL, RUN_810, TARGET_REPO_ID, allGreenJobs, golden, ownRun, type RunSpec, type World } from "./support/world";
import { budgetGuard } from "./support/budgets";

// ===========================================================================
// INDEPENDENT VERIFIER — R-STACK (SPEC-05A §7), operator gate of 2026-10-08.
// Question: with rule 5's associated-PR clause removed from §3.4, can a run that
// passes every remaining rule have been triggered by a pull request other than
// K0's? The written proof, its premises and its verdict are R-STACK-PROOF.md.
// Evidence: fixtures/real/rstack/*.json (read-only GETs and GraphQL queries,
// 2026-10-08) and the GitHub docs passages quoted in R-STACK-PROOF.md.
// ===========================================================================

const REAL_IMPL: Impl = { parsePrKey, parseCompare, parsePrContext, parseHeadBranchPrs, parseBranchRules, parseActivity, parseWorkflowRuns, parseRunJobs, bindBase, requiredJobs, bindCi };
/** §3.4 with rule 5's associated-PR clause removed: the clause can never fire. */
const NO_CLAUSE: Impl = { ...REAL_IMPL, bindCi: (a: any) => REAL_IMPL.bindCi({ ...a, base: { ...a.base, associatedPrNumbers: [a.key.prNumber] } }) };
/** Mutant: rule 5's head-branch clause removed as well (headBranchPrs always reads exactly [prNumber]). */
const NO_CLAUSE_NO_HEAD_LIST: Impl = {
  ...REAL_IMPL,
  bindCi: (a: any) => NO_CLAUSE.bindCi({ ...a, headBranchPrs: { numbers: [a.key.prNumber], capped: false } }),
};

const EV = (f: string) => REAL.verify(`rstack/${f}`);
const OTHER_PR = 702;
const FOREIGN = 37_900_000_001;
const FORK_ID = EV("public-run-identity.json").forkPullRequest.prHeadRepoId as number; // a real fork's repository id

/** A run triggered by another PR: green, at our head SHA, recorded with the given identity fields. */
const foreignRun = (over: Partial<RunSpec> = {}): RunSpec => ownRun({ id: FOREIGN, runNumber: 2900, createdAt: "2026-10-01T10:00:00Z", ...over });
const withRuns = (w: World, runs: RunSpec[]) => {
  w.runs = runs;
  w.jobs = Object.fromEntries(runs.filter((r) => r.status === "completed" && r.conclusion === "success").map((r) => [r.id, allGreenJobs()]));
  return w;
};
const world = (f: (w: World) => void) => () => {
  const w = golden();
  f(w);
  return w;
};
const OURS = () => ownRun();

interface Vector {
  id: string;
  vector: string;
  excludedBy: string;
  premise: string;
  world: () => World;
  expect: Expect;
  /** the remaining head-branch clause is what excludes this vector */
  headListLoadBearing?: boolean;
}

const SHARED: Expect = { reason: "shared_head" };
const OURS_ONLY: Expect = { outcome: "SUCCEEDED", runs: [RUN_810] };
const NONE: Expect = { outcome: "NO_RUN", runs: [] };

const VECTORS: Vector[] = [
  {
    id: "V1a",
    vector: "another OPEN PR on our head branch (another base), with a green run at our head SHA",
    excludedBy: "rule 5 head-branch list (state=all) → shared_head",
    premise: "P-RUN, P-LIST",
    world: world((w) => {
      w.headBranchPrs.push({ number: OTHER_PR, state: "open" });
      withRuns(w, [OURS(), foreignRun()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V1b",
    vector: "another CLOSED PR on our head branch, its old green run at our head SHA",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-LIST (closed PRs listed: live #601, #596)",
    world: world((w) => {
      w.headBranchPrs.push({ number: OTHER_PR, state: "closed" });
      withRuns(w, [OURS(), foreignRun()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V1c",
    vector: "another MERGED PR on our head branch (REST state 'closed')",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-LIST (merged PRs listed: live #809, #495)",
    world: world((w) => {
      w.headBranchPrs.push({ number: OTHER_PR, state: "closed" });
      withRuns(w, [foreignRun()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V1d",
    vector: "our head branch was deleted and recreated: the old PR on the same name is closed, its run predates ours",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-LIST (deleted head branch keeps the label: live #601, #596)",
    world: world((w) => {
      w.headBranchPrs.unshift({ number: OTHER_PR, state: "closed" });
      withRuns(w, [foreignRun({ createdAt: "2026-09-01T10:00:00Z" }), OURS()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V2a",
    vector: "a stacked or duplicate PR at our head SHA on its own branch (the live #815 shape), green",
    excludedBy: "rule 7 head_branch",
    premise: "P-RUN (a run records its own PR's head branch: live #810/#815 runs)",
    world: world((w) => {
      w.prContext.associated = [810, 815];
      withRuns(w, [OURS(), foreignRun({ headBranch: "feat/eng-loop-v1-05b" })]);
    }),
    expect: OURS_ONLY,
  },
  {
    id: "V2b",
    vector: "the same stacked PR's run at our head SHA FAILED",
    excludedBy: "rule 7 head_branch (it neither grants nor blocks)",
    premise: "P-RUN",
    world: world((w) => withRuns(w, [OURS(), foreignRun({ headBranch: "feat/eng-loop-v1-05b", conclusion: "failure" })])),
    expect: OURS_ONLY,
  },
  {
    id: "V2c",
    vector: "our own run is missing; only the stacked PR's green run exists at our head SHA",
    excludedBy: "rule 7 head_branch → NO_RUN, never SUCCEEDED",
    premise: "P-RUN",
    world: world((w) => withRuns(w, [foreignRun({ headBranch: "feat/eng-loop-v1-05b" })])),
    expect: NONE,
  },
  {
    id: "V3a",
    vector: "a fork PR with our branch name at our head SHA (our run missing)",
    excludedBy: "rule 7 head_repository.id (rule 1 fixes it to the target)",
    premise: "P-RUN (a fork PR's run records the fork: live cli/cli #14617)",
    world: world((w) => withRuns(w, [foreignRun({ headRepoId: FORK_ID })])),
    expect: NONE,
  },
  {
    id: "V3b",
    vector: "the same fork PR after its fork was deleted (the run keeps the fork's id)",
    excludedBy: "rule 7 head_repository.id",
    premise: "P-RUN (live cli/cli #14544…: PR head repo null, run head_repository still the fork)",
    world: world((w) => withRuns(w, [foreignRun({ headRepoId: FORK_ID })])),
    expect: NONE,
  },
  {
    id: "V3c",
    vector: "a run whose head repository reads null",
    excludedBy: "rule 7 head_repository.id",
    premise: "none (null never equals the target)",
    world: world((w) => withRuns(w, [foreignRun({ headRepoId: null })])),
    expect: NONE,
  },
  {
    id: "V4a",
    vector: "renamed OUT of our name: the old PR keeps its label (owner:our-name) and its old run is at our head SHA",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-LIST-RENAME — UNPROVEN (see B1)",
    world: world((w) => {
      w.headBranchPrs.unshift({ number: OTHER_PR, state: "closed" });
      withRuns(w, [foreignRun(), OURS()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V4b",
    vector: "renamed INTO our name: the other PR's runs were recorded under its old branch name",
    excludedBy: "rule 7 head_branch",
    premise: "P-RUN (runs keep the trigger-time head_branch: live deleted-branch runs #601, #596; re-runs keep it)",
    world: world((w) => withRuns(w, [OURS(), foreignRun({ headBranch: "feat/old-name" })])),
    expect: OURS_ONLY,
  },
  {
    id: "V5a",
    vector: "our own PR closed and reopened: its runs before and after are both ours",
    excludedBy: "not cross-PR (both runs are K0's)",
    premise: "P-RUN (a reopened PR's run records its head branch and repository: live cli/cli #14294)",
    world: world((w) => withRuns(w, [OURS(), ownRun({ id: 37_680_787_999, runNumber: 2870, createdAt: "2026-10-07T20:50:00Z" })])),
    expect: { outcome: "SUCCEEDED", runs: [RUN_810, 37_680_787_999] },
  },
  {
    id: "V5b",
    vector: "another PR on our head branch, closed and reopened",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-LIST",
    world: world((w) => {
      w.headBranchPrs.push({ number: OTHER_PR, state: "open" });
      withRuns(w, [OURS(), foreignRun()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V6",
    vector: "two open PRs from one head branch with different bases",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-LIST (several PRs per label, different bases, all listed: live nodejs/node, grafana/grafana)",
    world: world((w) => {
      w.headBranchPrs = [
        { number: 810, state: "open" },
        { number: OTHER_PR, state: "open" },
      ];
      withRuns(w, [OURS(), foreignRun()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V7",
    vector: "another PR's head branch (our name) deleted and restored",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-LIST (deleted and restored head branch keeps the label: live #495)",
    world: world((w) => {
      w.headBranchPrs.push({ number: OTHER_PR, state: "closed" });
      withRuns(w, [OURS(), foreignRun()]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V9a",
    vector: "re-run (attempt 2) of the stacked PR's run",
    excludedBy: "rule 7 head_branch (a re-run keeps the record's identity)",
    premise: "P-RERUN (live: attempts 1 and 2 share head_branch, head_sha, head_repository, created_at)",
    world: world((w) => withRuns(w, [OURS(), foreignRun({ headBranch: "feat/eng-loop-v1-05b", runAttempt: 2 })])),
    expect: OURS_ONLY,
  },
  {
    id: "V9b",
    vector: "re-run of the closed same-branch PR's run",
    excludedBy: "rule 5 head-branch list → shared_head",
    premise: "P-RERUN, P-LIST",
    world: world((w) => {
      w.headBranchPrs.push({ number: OTHER_PR, state: "closed" });
      withRuns(w, [OURS(), foreignRun({ runAttempt: 2 })]);
    }),
    expect: SHARED,
    headListLoadBearing: true,
  },
  {
    id: "V9c",
    vector: "re-run of a fork PR's run (our run missing)",
    excludedBy: "rule 7 head_repository.id",
    premise: "P-RERUN, P-RUN",
    world: world((w) => withRuns(w, [foreignRun({ headRepoId: FORK_ID, runAttempt: 2 })])),
    expect: NONE,
  },
  {
    id: "V10",
    vector: "push and pull_request_target runs at our head SHA on our branch",
    excludedBy: "rule 7 event === 'pull_request'",
    premise: "none",
    world: world((w) =>
      withRuns(w, [OURS(), foreignRun({ event: "push", template: "push" }), foreignRun({ id: FOREIGN + 1, runNumber: 2901, event: "pull_request_target" })]),
    ),
    expect: OURS_ONLY,
  },
];

describe("R-STACK proof rows: every vector with the associated-PR clause absent", () => {
  for (const v of VECTORS)
    it(`${v.id}: ${v.vector} — ${show(v.expect)} [${v.excludedBy}; ${v.premise}]`, () => {
      const r = evaluate(v.world(), NO_CLAUSE).result;
      expect(matches(r, v.expect), JSON.stringify(r)).toBe(true);
    });
});

describe("R-STACK mutant: drop rule 5's head-branch clause as well — it must be caught", () => {
  const loadBearing = VECTORS.filter((v) => v.headListLoadBearing);
  it("every row the head-branch clause excludes breaks, and each breaks into cross-PR attribution or a missed block", () => {
    expect(loadBearing.length).toBeGreaterThanOrEqual(8);
    for (const v of loadBearing) {
      const r: any = evaluate(v.world(), NO_CLAUSE_NO_HEAD_LIST).result;
      expect(matches(r, v.expect), `${v.id} not caught: ${JSON.stringify(r)}`).toBe(false);
      expect(r.ok, `${v.id}`).toBe(true);
    }
  });
  it("in particular, the foreign run then counts for K0 (cross-PR attribution)", () => {
    for (const id of ["V1a", "V1c", "V6", "V9b"]) {
      const r: any = evaluate(VECTORS.find((v) => v.id === id)!.world(), NO_CLAUSE_NO_HEAD_LIST).result;
      expect(r.runs, id).toContain(FOREIGN);
    }
  });
});

// ---------------------------------------------------------------------------
// The blockers (R-STACK-PROOF.md §5). Each is the same world: a run triggered by
// another PR, recorded with our head branch, repository and SHA, whose PR is NOT
// in the head-branch listing the read-only token sees. B1: GitHub rewrote the old
// PR's head label when its branch was renamed (UNPROVEN either way). B2: the PR
// was archived, which the docs say hides it from everyone but repository
// administrators (whether the read-only token sees it: UNPROVEN). B3: the PR was
// permanently deleted (UNPROVEN). These rows pin what §3.4 DOES there, with and
// without the clause: the clause does not exclude them either, because
// associatedPullRequests never returns a closed, unmerged PR (schema, live).
// ---------------------------------------------------------------------------
describe("R-STACK blockers B1-B3: what the rules do if the foreign PR is missing from the listing", () => {
  const hidden = (ours: RunSpec[]) =>
    world((w) => {
      w.headBranchPrs = [{ number: 810, state: "open" }];
      w.prContext.associated = [810]; // a closed, unmerged PR is never in associatedPullRequests
      withRuns(w, [foreignRun(), ...ours]);
    });
  for (const [label, impl] of [
    ["clause absent", NO_CLAUSE],
    ["clause present (today's §3.4)", REAL_IMPL],
  ] as const) {
    it(`${label}: our run missing — the foreign green run alone makes the CI row SUCCEEDED (cross-PR attribution)`, () => {
      expect(evaluate(hidden([])(), impl).result).toMatchObject({ ok: true, outcome: "SUCCEEDED", runs: [FOREIGN] });
    });
    it(`${label}: our run FAILED or still running — the foreign green run cannot mask it`, () => {
      expect(evaluate(hidden([ownRun({ conclusion: "failure" })])(), impl).result).toMatchObject({ ok: true, outcome: "FAILED" });
      expect(evaluate(hidden([ownRun({ status: "in_progress", conclusion: null })])(), impl).result).toMatchObject({ ok: true, outcome: "PENDING" });
    });
  }
});

describe("R-STACK on the live stack: #810 beneath #815 (recorded 2026-10-08)", () => {
  const live = EV("hone-810-815.json");
  const head810 = live.p810.head.sha as string;
  const run810 = live.runsAt810CurrentHead[0];

  it("evidence: every #810 run records feat/eng-loop-v1-05a and the target, every #815 run feat/eng-loop-v1-05b; no #815 run at an #810 head SHA", () => {
    for (const r of live.runs810) expect([r.event, r.head_branch, r.head_repository_id], String(r.id)).toEqual(["pull_request", live.p810.head.ref, TARGET_REPO_ID]);
    for (const r of live.runs815) expect([r.event, r.head_branch, r.head_repository_id], String(r.id)).toEqual(["pull_request", live.p815.head.ref, TARGET_REPO_ID]);
    expect(live.runs815AtA810HeadSha).toEqual([]);
    expect(live.p815.base.ref).toBe(live.p810.base.ref);
  });

  const stack = () => {
    const w = golden();
    w.pr.headSha = head810;
    w.prContext.associated = [810, 815]; // live: associatedPullRequests(H) while #815 is stacked
    // #810's real run at its head (conclusion set to success: synthetic), and #815's real runs re-pointed to #810's head SHA
    const ours = ownRun({ id: run810.id, headSha: head810, headBranch: live.p810.head.ref });
    const theirs = live.runs815.map((r: any, i: number) => ownRun({ id: r.id, runNumber: 3000 + i, headSha: head810, headBranch: r.head_branch, createdAt: r.created_at }));
    return withRuns(w, [ours, ...theirs]);
  };

  it("clause absent: #810 does not read shared_head because of #815, and none of #815's runs counts for #810", () => {
    expect(matches(evaluate(stack(), NO_CLAUSE).result, { outcome: "SUCCEEDED", runs: [run810.id] }), JSON.stringify(evaluate(stack(), NO_CLAUSE).result)).toBe(true);
  });
  it("clause present (today): #810 reads shared_head because of #815 (§7 R-STACK)", () => {
    expect(evaluate(stack(), REAL_IMPL).result).toMatchObject({ ok: false, reason: "shared_head" });
  });
});

describe("R-STACK evidence: the recorded observations say what the proof's premises claim", () => {
  const hone = EV("hone-head-listing.json");
  const pub = EV("public-run-identity.json");
  const schema = EV("graphql-schema.json");

  it("P-LIST: closed PRs whose head branch was deleted, a deleted-then-restored one and a merged one are all in their head listing", () => {
    for (const d of hone.deletedBranch) {
      expect(d.branchExists).toBe(false);
      expect(d.headListing).toEqual([d.pr]);
      for (const r of d.runs) expect([r.head_branch, r.head_repository_id]).toEqual([d.headRef, TARGET_REPO_ID]); // runs keep the name
    }
    expect(hone.deletedThenRestored.headListing).toEqual([495]);
    expect(hone.mergedStillListed.headListing).toEqual([809]);
  });

  it("P-LIST: several PRs on one head label with different bases are all returned by the head-filtered state=all listing", () => {
    for (const p of EV("public-shared-head-labels.json").pairs) {
      expect(p.headFilteredListing.length, p.label).toBeGreaterThanOrEqual(2);
      expect(new Set(p.headFilteredListing.map((x: any) => x.base)).size, p.label).toBeGreaterThanOrEqual(2);
    }
  });

  it("P-RUN: a fork PR's run records the fork (not the base) as head_repository; the base owner's label lists nothing", () => {
    const f = pub.forkPullRequest;
    expect(f.run.headRepositoryId).toBe(f.prHeadRepoId);
    expect(f.run.headRepositoryId).not.toBe(pub.baseRepoId);
    expect(f.run.repositoryId).toBe(pub.baseRepoId);
    expect(f.run.headRepositoryIsFork).toBe(true);
    expect(f.run.headBranchEqualsPrHeadRef).toBe(true);
    expect(f.sameBranchNameUnderBaseOwnerListing).toEqual([]);
  });

  it("P-RUN: after a fork is deleted its runs still record the fork's id, never the base's (and its PR leaves the head listing)", () => {
    for (const d of pub.deletedForkPullRequests) {
      expect(d.prHeadRepo).toBeNull();
      for (const r of d.runs) {
        expect(r.headRepositoryId).not.toBeNull();
        expect(r.headRepositoryIsBase).toBe(false);
      }
    }
    expect(pub.deletedForkPullRequests.filter((d: any) => Array.isArray(d.headFilteredListing)).every((d: any) => d.headFilteredListing.length === 0)).toBe(true);
  });

  it("P-RUN: a reopened PR's run records that PR's head branch and head repository", () => {
    const r = pub.reopenedForkPullRequest;
    expect(r.runsWithin2minOfReopen.length).toBeGreaterThan(0);
    for (const x of r.runsWithin2minOfReopen) {
      expect(x.headBranchEqualsPrHeadRef).toBe(true);
      expect(x.headRepositoryId).toBe(r.prHeadRepoId);
    }
  });

  it("P-RERUN: a re-run keeps head_branch, head_sha, head_repository and created_at; only run_started_at moves", () => {
    expect(hone.reruns.length).toBeGreaterThan(0);
    for (const r of hone.reruns) {
      expect(r.latest.attempt).toBeGreaterThan(1);
      for (const k of ["head_branch", "head_sha", "head_repository_id", "created_at"]) expect(r.latest[k], k).toBe(r.attempt1[k]);
      expect(r.latest.run_started_at).not.toBe(r.attempt1.run_started_at);
    }
  });

  it("schema: a PR's head cannot be edited, its head name survives deletion, and associatedPullRequests omits closed unmerged PRs", () => {
    expect(schema["UpdatePullRequestInput.fields"].some((f: string) => /head/i.test(f))).toBe(false);
    expect(schema["PullRequest.headRefName"]).toContain("even if the ref has been deleted");
    expect(schema["Commit.associatedPullRequests"]).toContain("additionally returns open Pull Requests");
    expect(schema["Mutation.archivePullRequest"]).toContain("Closes and marks the pull request as archived");
  });

  it("Hone itself: 814 PRs, 814 distinct head labels, no head repository but the target, no reopened PR, one restored head branch", () => {
    const w = hone.repositoryWide;
    expect(w.distinctHeadLabels).toBe(w.pullRequests);
    expect(w.headRepositories).toEqual([TARGET_REPO_ID]);
    expect(w.prsWithReopenedEvent).toBe(0);
    expect(w.prsWithHeadRefRestoredEvent).toBe(1);
  });

  it("runs come after their PR: no pull_request run created before its PR (40 recent Hone PRs)", () => {
    expect(hone.runsCreatedAfterTheirPr.checked).toBeGreaterThanOrEqual(30);
    expect(hone.runsCreatedAfterTheirPr.before).toEqual([]);
  });

  it("R-AUTOBASE (closed at 4b0662a2): an automatic base change is an AutomaticBaseChangeSucceededEvent, not a BaseRefChangedEvent", () => {
    const a = EV("public-automatic-base-change.json");
    const autoOnly = a.prs.filter((p: any) => p.events.every((e: any) => e.type === "AutomaticBaseChangeSucceededEvent"));
    expect(autoOnly.length).toBeGreaterThanOrEqual(4);
    for (const p of autoOnly) expect(p.baseRefNow).toBe("main");
  });

  it("R-AUTOBASE (closed at 4b0662a2): every recorded grafana event list, as an answer to the widened §2.2 query, binds base_ref_changed", () => {
    for (const p of EV("public-automatic-base-change.json").prs) {
      const w = golden();
      const types = p.events.map((e: any) => e.type);
      w.prContext.baseRefEvents = types.filter((t: string) => t === "BaseRefChangedEvent").length;
      w.prContext.extraBaseEvents = types.filter((t: string) => t !== "BaseRefChangedEvent");
      expect(evaluate(w, REAL_IMPL).result, `#${p.number}`).toMatchObject({ ok: false, reason: "base_ref_changed" });
    }
  });
});

budgetGuard("rstack.verify.test.ts");
