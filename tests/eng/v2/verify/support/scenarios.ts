// Independent verifier support: the CI-binding scenario table (SPEC-05A §2.6, §3.3,
// §3.4, §3.5). Every expectation here was derived by hand from the spec text; the
// executable model in spec-model.ts only cross-checks the table's consistency.
//
// Each row is data, so the SAME table runs against the real pipeline
// (row3-ci.verify.test.ts), the unmutated model (self-check) and every unsafe
// mutant (mutants*.verify.test.ts).

import { clone } from "./deep";
import { rng } from "./prng";
import type { Outcome, Result } from "./spec-model";
import {
  FAILED_CONCLUSIONS,
  JOB,
  PENDING_STATUSES,
  P0,
  PRODUCTION_REF,
  RUN_810,
  RUN_810_CREATED,
  WORKFLOW_ID,
  allGreenJobs,
  daysBefore,
  golden,
  hoursAfter,
  ownRun,
  realJobs,
  secondsAfter,
  sha40,
  type ActivityEvent,
  type JobSpec,
  type RunSpec,
  type World,
} from "./world";

export type Expect = { outcome: Outcome; runs: number[] } | { reason: string } | { anyOf: Expect[] };

export interface Scenario {
  id: string;
  title: string;
  /** provenance of the inputs: which parts are real recorded GitHub data and which are synthetic */
  source: string;
  nc?: "NC1" | "NC2" | "NC3" | "NC4" | "NC5" | "NC6";
  rule?: number;
  world: () => World;
  expect: Expect;
  /** where the expectation rests on a reading of the spec rather than its literal text */
  note?: string;
}

export function matches(a: Result, e: Expect): boolean {
  if ("anyOf" in e) return e.anyOf.some((x) => matches(a, x));
  if ("reason" in e) return !a.ok && a.reason === e.reason;
  return (
    a.ok &&
    a.outcome === e.outcome &&
    a.runs.length === e.runs.length &&
    [...a.runs].sort((x, y) => x - y).every((id, i) => id === [...e.runs].sort((x, y) => x - y)[i])
  );
}

export const show = (e: Expect): string =>
  "anyOf" in e ? `one of [${e.anyOf.map(show).join(" | ")}]` : "reason" in e ? `UNKNOWN(${e.reason})` : `${e.outcome} ${JSON.stringify(e.runs)}`;

const edit =
  (f: (w: World) => void): (() => World) =>
  () => {
    const w = golden();
    f(w);
    return w;
  };

const SUCCEEDED_OWN: Expect = { outcome: "SUCCEEDED", runs: [RUN_810] };
const reason = (r: string): Expect => ({ reason: r });
const fp = (timestamp: string): ActivityEvent => ({ timestamp, before: sha40(0xdead0001), after: P0 });
const OTHER_PR_RUN = 37_500_000_702;
const FORK_REPO = 777_000_111;

// ---------------------------------------------------------------------------
// The main table
// ---------------------------------------------------------------------------
export const SCENARIOS: Scenario[] = [
  // --- golden and all-real ---------------------------------------------------
  {
    id: "G-golden",
    title: "#810 as recorded, with production rules present and a green run: SUCCEEDED",
    source: "real key/compare/head-branch listing/activity/job names; synthetic: rules present, run and validate job success",
    world: golden,
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R-real-810",
    title: "every input exactly as recorded for #810 (production has no rules): rule 6 decides",
    source: "real: run 37680787947 (failure), its jobs, rules/branches [] and activity [] as recorded 2026-10-07",
    rule: 6,
    world: edit((w) => {
      w.rules = [];
      w.runs = [ownRun({ conclusion: "failure" })];
      w.jobs = { [RUN_810]: realJobs() };
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R-real-810-with-rules",
    title: "the recorded run failed: FAILED",
    source: "real run/jobs; synthetic rules",
    rule: 10,
    world: edit((w) => {
      w.runs = [ownRun({ conclusion: "failure" })];
      w.jobs = { [RUN_810]: realJobs() };
    }),
    expect: { outcome: "FAILED", runs: [RUN_810] },
  },

  // --- §2.6 bindBase ---------------------------------------------------------
  {
    id: "B-base-ref",
    title: "a non-production base ref is base_ref (#776's real base)",
    source: "real: #776 targets feat/ux02-slice2-settings-sectionlabel at 6a4cff35",
    world: edit((w) => {
      w.pr.baseRef = "feat/ux02-slice2-settings-sectionlabel";
      w.pr.baseSha = "6a4cff35f050411a9e63c5a23128d862dd5a9e7c";
      w.compare.mergeBaseSha = "6a4cff35f050411a9e63c5a23128d862dd5a9e7c";
    }),
    expect: reason("base_ref"),
  },
  {
    id: "B-compare-base",
    title: "a compare whose base is not the key's live base tip is malformed (#800's stale compare base)",
    source: "real: #800's recorded compare base c26bbdec vs the live tip 6cdd830b",
    world: edit((w) => {
      w.compare.baseSha = "c26bbdec96c3fb6cde0845e2d75ef012daa09755";
    }),
    expect: reason("malformed"),
  },
  {
    id: "B-parse-before-bind",
    title: "a compare answered for another base fails in parseCompare (§2.1) before bindBase can apply base_ref",
    source: "synthetic",
    world: edit((w) => {
      w.pr.baseRef = "release/2026-10";
      w.compare.baseSha = "c26bbdec96c3fb6cde0845e2d75ef012daa09755";
    }),
    expect: reason("malformed"),
    note: "bindBase only ever sees a parsed record; its own base_ref-before-step-2 order is checked directly in row2-base.",
  },

  // --- rule 1 ------------------------------------------------------------------
  {
    id: "R1-fork",
    title: "a head repository other than the target is fork_head",
    source: "synthetic",
    rule: 1,
    world: edit((w) => {
      w.pr.headRepoId = FORK_REPO;
    }),
    expect: reason("fork_head"),
  },

  // --- rule 2 ------------------------------------------------------------------
  {
    id: "R2-cap-300",
    title: "a 300-file compare is capped by GitHub, so the diff cannot be proven complete",
    source: "synthetic",
    rule: 2,
    world: edit((w) => {
      w.compare.files = Array.from({ length: 300 }, (_, i) => `app/generated/f${i}.ts`);
      w.prContext.changedFiles = 300;
    }),
    expect: reason("diff_too_large"),
  },
  {
    id: "R2-more-files",
    title: "the compare lists more files than the PR reports",
    source: "synthetic",
    rule: 2,
    world: edit((w) => {
      w.compare.files.push("docs/extra.md");
    }),
    expect: reason("diff_too_large"),
  },
  {
    id: "R2-fewer-files",
    title: "the PR reports more files than the compare lists",
    source: "synthetic",
    rule: 2,
    world: edit((w) => {
      w.prContext.changedFiles += 1;
    }),
    expect: reason("diff_too_large"),
  },
  {
    id: "R2-299",
    title: "299 files, all accounted for, is complete (the cap starts at 300)",
    source: "synthetic",
    rule: 2,
    world: edit((w) => {
      w.compare.files = Array.from({ length: 299 }, (_, i) => `app/generated/f${i}.ts`);
      w.prContext.changedFiles = 299;
    }),
    expect: SUCCEEDED_OWN,
  },

  // --- rule 3 ------------------------------------------------------------------
  ...CI_DEFINITION_ROWS(),
  {
    id: "R3-near-misses",
    title: "paths that only resemble CI's definition do not fire rule 3 (exact paths; liveness)",
    source: "synthetic",
    rule: 3,
    world: edit((w) => {
      const near = [
        ".github/workflows/nightly.yml",
        ".github/workflows/ci.yml.bak",
        "docs/.github/workflows/ci.yml",
        "scripts/classify-changes.test.mjs",
        "tests/ci/classify-changes.test.ts",
        "scripts/browser-groups.mjs.orig",
      ];
      near.forEach((f, i) => (w.compare.files[i] = f));
    }),
    expect: SUCCEEDED_OWN,
    note: "SPEC §3.4 rule 3 names three exact paths; matching by substring would over-block (liveness, not safety).",
  },

  // --- rule 4 (NC4) ------------------------------------------------------------
  {
    id: "NC4-one-event",
    title: "the PR was retargeted without a fresh run: one BaseRefChangedEvent is base_ref_changed",
    source:
      "real fact: #720 has exactly one base change (SPEC §0; a read-only REST timeline GET on 2026-10-07 shows 45 items with one base_ref_changed); synthetic spec-shaped answer",
    nc: "NC4",
    rule: 4,
    world: edit((w) => {
      w.prContext.baseRefEvents = 1;
      w.prContext.timelineTotalCount = 36;
    }),
    expect: reason("base_ref_changed"),
  },
  {
    id: "NC4-too-many",
    title: "more base-change events than one page holds is base_ref_changed",
    source: "synthetic",
    nc: "NC4",
    rule: 4,
    world: edit((w) => {
      w.prContext.baseRefHasNext = true;
    }),
    expect: reason("base_ref_changed"),
  },
  {
    id: "R4-totalcount-trap",
    title: "a large unfiltered totalCount with no BaseRefChangedEvent nodes is ZERO base changes",
    source: "real figure: #720 reports totalCount 36 for one event (SPEC §0); synthetic pairing with zero events",
    rule: 4,
    world: edit((w) => {
      w.prContext.timelineTotalCount = 36;
    }),
    expect: SUCCEEDED_OWN,
  },

  // --- rule 5 (NC1) ------------------------------------------------------------
  {
    id: "NC1-same-branch",
    title: "an older same-SHA run belonged to another, now closed, PR on the same head branch: shared_head",
    source: "synthetic (no Hone head branch has had two PRs in the last 400); real run shape",
    nc: "NC1",
    rule: 5,
    world: edit((w) => {
      w.headBranchPrs = [
        { number: 810, state: "open" },
        { number: 702, state: "closed" },
      ];
      w.runs.unshift(ownRun({ id: OTHER_PR_RUN, runNumber: 2700, createdAt: "2026-10-01T10:00:00Z" }));
      w.jobs[OTHER_PR_RUN] = allGreenJobs();
    }),
    expect: reason("shared_head"),
  },
  {
    id: "NC1-other-branch",
    title: "an older same-SHA success from another PR on another branch is ignored: NO_RUN",
    source: "synthetic pairing; real run shape (its pull_requests still names #810, as GitHub reports)",
    nc: "NC1",
    rule: 7,
    world: edit((w) => {
      w.runs = [ownRun({ id: OTHER_PR_RUN, runNumber: 2700, headBranch: "feat/older-pr-702", createdAt: "2026-10-01T10:00:00Z" })];
      w.jobs = { [OTHER_PR_RUN]: allGreenJobs() };
    }),
    expect: { outcome: "NO_RUN", runs: [] },
  },
  {
    id: "NC1-other-branch-own-failed",
    title: "another branch's success cannot outvote this PR's own failure",
    source: "synthetic pairing; real run shape",
    nc: "NC1",
    rule: 7,
    world: edit((w) => {
      w.runs = [
        ownRun({ id: OTHER_PR_RUN, runNumber: 2700, headBranch: "feat/older-pr-702", createdAt: "2026-10-01T10:00:00Z" }),
        ownRun({ conclusion: "failure" }),
      ];
      w.jobs = { [OTHER_PR_RUN]: allGreenJobs(), [RUN_810]: realJobs() };
    }),
    expect: { outcome: "FAILED", runs: [RUN_810] },
  },
  ...SHARED_HEAD_ROWS(),

  // --- rule 6 ------------------------------------------------------------------
  {
    id: "R6-real-none",
    title: "production as it really is today (no rules) is base_history_unverified",
    source: "real: rules/branches/claude/build-hone-saas-hOex7 answers []",
    rule: 6,
    world: edit((w) => {
      w.rules = [];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R6-nff-only",
    title: "non_fast_forward without deletion is not prevention",
    source: "synthetic",
    rule: 6,
    world: edit((w) => {
      w.rules = ["non_fast_forward"];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R6-deletion-only",
    title: "deletion without non_fast_forward is not prevention",
    source: "synthetic",
    rule: 6,
    world: edit((w) => {
      w.rules = ["deletion"];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R6-extra-rules",
    title: "other rules alongside both prevention rules are fine",
    source: "synthetic",
    rule: 6,
    world: edit((w) => {
      w.rules = ["pull_request", "deletion", "required_linear_history", "non_fast_forward"];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R6-case",
    title: "a rule type is matched exactly: Non_Fast_Forward is not non_fast_forward",
    source: "synthetic",
    rule: 6,
    world: edit((w) => {
      w.rules = ["Non_Fast_Forward", "deletion"];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R6-before-runs",
    title: "rule 6 decides before rule 7, even with no run at all",
    source: "real rules []; synthetic: no runs",
    rule: 6,
    world: edit((w) => {
      w.rules = [];
      w.runs = [];
      w.jobs = {};
    }),
    expect: reason("base_history_unverified"),
  },

  // --- rule 7 (NC3, NC6) -------------------------------------------------------
  {
    id: "NC3-push-run",
    title: "a successful push run at the head SHA did not run PR validation: NO_RUN",
    source: "real run shape (push run 37672136569 at production 6cdd830b); synthetic pairing with #810's head",
    nc: "NC3",
    rule: 7,
    world: edit((w) => {
      w.runs = [
        ownRun({
          id: 37672136569,
          runNumber: 2853,
          event: "push",
          headBranch: PRODUCTION_REF,
          createdAt: "2026-10-07T19:07:49Z",
          template: "push",
        }),
      ];
      w.jobs = { 37672136569: allGreenJobs() };
    }),
    expect: { outcome: "NO_RUN", runs: [] },
  },
  {
    id: "NC3-push-run-on-pr-branch",
    title: "a push run on the PR's own branch and head is still not a pull_request run: NO_RUN",
    source: "real run shape (push); synthetic pairing",
    nc: "NC3",
    rule: 7,
    world: edit((w) => {
      w.runs = [ownRun({ id: 37672136569, runNumber: 2853, event: "push", createdAt: "2026-10-07T19:07:49Z", template: "push" })];
      w.jobs = { 37672136569: allGreenJobs() };
    }),
    expect: { outcome: "NO_RUN", runs: [] },
  },
  {
    id: "NC3-push-success-own-failure",
    title: "a green push run does not override the PR's own failed run",
    source: "real run shapes; synthetic pairing",
    nc: "NC3",
    rule: 7,
    world: edit((w) => {
      w.runs = [
        ownRun({ id: 37672136569, runNumber: 2853, event: "push", createdAt: "2026-10-07T19:07:49Z", template: "push" }),
        ownRun({ conclusion: "failure" }),
      ];
      w.jobs = { 37672136569: allGreenJobs(), [RUN_810]: realJobs() };
    }),
    expect: { outcome: "FAILED", runs: [RUN_810] },
  },
  ...UNRELATED_RUN_ROWS(),

  // --- rule 8 (NC2) ------------------------------------------------------------
  {
    id: "NC2-force-push-after",
    title: "production was force-pushed after the run while current rules look fine",
    source: "synthetic activity; real activity shows 0 force pushes and 0 deletions",
    nc: "NC2",
    rule: 8,
    world: edit((w) => {
      w.activity.forcePush = [fp(hoursAfter(RUN_810_CREATED, 1))];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "NC2-deletion-after",
    title: "production was deleted (and recreated) after the run",
    source: "synthetic activity",
    nc: "NC2",
    rule: 8,
    world: edit((w) => {
      w.activity.branchDeletion = [{ timestamp: hoursAfter(RUN_810_CREATED, 1), before: P0, after: "0".repeat(40) }];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R8-equal-instant",
    title: "a rewrite at exactly the run's created_at counts (>=)",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.activity.forcePush = [fp(RUN_810_CREATED)];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R8-one-second-before",
    title: "a rewrite one second before the earliest applicable run is irrelevant",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.activity.forcePush = [fp(secondsAfter(RUN_810_CREATED, -1))];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R8-long-before",
    title: "rewrites a month before the run are irrelevant",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.activity.forcePush = [fp(daysBefore(RUN_810_CREATED, 30))];
      w.activity.branchDeletion = [{ timestamp: daysBefore(RUN_810_CREATED, 31), before: P0, after: "0".repeat(40) }];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R8-between-own-runs",
    title: "a rewrite after the EARLIEST applicable run fires, even if before a later one",
    source: "synthetic (a close/reopen gives a second pull_request run at the same head)",
    rule: 8,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37_600_002_840, runNumber: 2840, createdAt: "2026-10-06T10:00:00Z" }));
      w.jobs[37_600_002_840] = allGreenJobs();
      w.activity.forcePush = [fp("2026-10-07T00:00:00Z")];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R8-ignored-run-is-no-anchor",
    title: "only applicable runs anchor history: a rewrite after an ignored push run but before the PR run is fine",
    source: "real run shapes; synthetic activity",
    rule: 8,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37672136569, runNumber: 2853, event: "push", headBranch: PRODUCTION_REF, createdAt: "2026-10-07T19:07:49Z", template: "push" }));
      w.activity.forcePush = [fp("2026-10-07T19:30:00Z")];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R8-force-push-capped",
    title: "a force-push listing that hit 100 cannot prove the history",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.activity.forcePush = Array.from({ length: 100 }, (_, i) => fp(daysBefore(RUN_810_CREATED, 200 - i)));
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R8-deletion-capped",
    title: "a deletion listing that hit 100 cannot prove the history",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.activity.branchDeletion = Array.from({ length: 100 }, (_, i) => ({
        timestamp: daysBefore(RUN_810_CREATED, 200 - i),
        before: P0,
        after: "0".repeat(40),
      }));
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R8-window-360",
    title: "an earliest applicable run exactly 360 days old is inside the window",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ createdAt: daysBefore(w.observedAt, 360) })];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R8-window-360-plus-1s",
    title: "one second beyond 360 days is outside the window",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ createdAt: secondsAfter(daysBefore(w.observedAt, 360), -1) })];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R8-window-earliest-governs",
    title: "a 400-day-old applicable run puts the whole set outside the window",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37_000_000_001, runNumber: 1200, createdAt: daysBefore(w.observedAt, 400) }));
      w.jobs[37_000_000_001] = allGreenJobs();
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "R8-window-ignored-old-run",
    title: "a 400-day-old IGNORED run does not matter",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37_000_000_001, runNumber: 1200, event: "push", createdAt: daysBefore(w.observedAt, 400), template: "push" }));
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R8-tz-offset-event",
    title: "a force push written with a -01:00 offset is AFTER the run in time, though earlier as a string",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.observedAt = "2026-10-07T22:00:00Z";
      w.activity.forcePush = [fp("2026-10-07T20:00:00-01:00")];
    }),
    expect: { anyOf: [reason("base_history_unverified"), reason("malformed")] },
    note: "ISO-8601 (§2.5) admits offsets; time must be compared as instants. A parser that rejects offsets is also safe.",
  },
  {
    id: "R8-fractional-event",
    title: "a force push half a second after created_at is after it",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.activity.forcePush = [fp("2026-10-07T20:16:44.500Z")];
    }),
    expect: { anyOf: [reason("base_history_unverified"), reason("malformed")] },
    note: "Fractional seconds are ISO-8601; string comparison would put '.500Z' before 'Z'.",
  },
  {
    id: "R8-tz-offset-run",
    title: "a run created_at written with +01:00 is compared as an instant",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ createdAt: "2026-10-07T21:16:44+01:00" })];
      w.activity.forcePush = [fp("2026-10-07T20:30:00Z")];
    }),
    expect: { anyOf: [reason("base_history_unverified"), reason("malformed")] },
    note: "20:30Z is after 21:16:44+01:00 (= 20:16:44Z), though earlier as a string.",
  },
  {
    id: "R8-leap-second-event",
    title: "a force push stamped 23:59:60Z (valid ISO-8601, but NaN to Date.parse) must not be silently ordered before the run",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.observedAt = "2026-10-08T01:00:00Z";
      w.activity.forcePush = [fp("2026-10-07T23:59:60Z")];
    }),
    expect: { anyOf: [reason("base_history_unverified"), reason("malformed")] },
    note: "NaN >= t is false: a parser that accepts it and a binder that compares with >= would ignore a real rewrite.",
  },
  {
    id: "R8-invalid-created-at",
    title: "a run created_at that is not a real instant cannot anchor the history window",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ createdAt: "2026-13-07T20:16:44Z" })];
      w.activity.forcePush = [fp(hoursAfter(RUN_810_CREATED, 1))];
    }),
    expect: { anyOf: [reason("base_history_unverified"), reason("malformed")] },
  },
  {
    id: "R8-no-run-capped",
    title: "with no applicable run, rule 7 decides NO_RUN before history is consulted",
    source: "synthetic",
    rule: 7,
    world: edit((w) => {
      w.runs = [];
      w.jobs = {};
      w.activity.forcePush = Array.from({ length: 100 }, (_, i) => fp(daysBefore(RUN_810_CREATED, 100 - i)));
    }),
    expect: { outcome: "NO_RUN", runs: [] },
  },
  {
    id: "R8-before-states",
    title: "history (rule 8) decides before an unrecognized run status (rule 9)",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ status: "exploded", conclusion: null })];
      w.activity.forcePush = [fp(hoursAfter(RUN_810_CREATED, 1))];
    }),
    expect: reason("base_history_unverified"),
  },

  // --- rule 9 ------------------------------------------------------------------
  ...RUN_STATE_ROWS(),

  // --- rule 10 -----------------------------------------------------------------
  {
    id: "R10-failed-and-succeeded",
    title: "an older FAILED run of the same PR and head fails the set (every applicable run)",
    source: "synthetic (close/reopen pair)",
    rule: 10,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37_600_002_840, runNumber: 2840, createdAt: "2026-10-07T18:00:00Z", conclusion: "failure" }));
      w.jobs[37_600_002_840] = realJobs();
    }),
    expect: { outcome: "FAILED", runs: [37_600_002_840, RUN_810] },
  },
  {
    id: "R10-newer-failed",
    title: "a newer FAILED run over an older SUCCEEDED one is FAILED",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.runs = [
        ownRun({ id: 37_600_002_840, runNumber: 2840, createdAt: "2026-10-07T18:00:00Z" }),
        ownRun({ conclusion: "failure" }),
      ];
      w.jobs = { 37_600_002_840: allGreenJobs(), [RUN_810]: realJobs() };
    }),
    expect: { outcome: "FAILED", runs: [37_600_002_840, RUN_810] },
  },
  {
    id: "R10-pending-and-succeeded",
    title: "any PENDING run (no FAILED) is PENDING",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.runs.push(ownRun({ id: 37_600_002_860, runNumber: 2860, createdAt: "2026-10-07T20:40:00Z", status: "queued", conclusion: null }));
    }),
    expect: { outcome: "PENDING", runs: [RUN_810, 37_600_002_860] },
  },
  {
    id: "R10-failed-and-pending",
    title: "FAILED wins over PENDING",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.runs = [
        ownRun({ conclusion: "failure" }),
        ownRun({ id: 37_600_002_860, runNumber: 2860, createdAt: "2026-10-07T20:40:00Z", status: "in_progress", conclusion: null }),
      ];
    }),
    expect: { outcome: "FAILED", runs: [RUN_810, 37_600_002_860] },
  },
  {
    id: "R10-two-succeeded",
    title: "two green applicable runs, each with every required job: SUCCEEDED",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37_600_002_840, runNumber: 2840, createdAt: "2026-10-07T18:00:00Z" }));
      w.jobs[37_600_002_840] = allGreenJobs();
    }),
    expect: { outcome: "SUCCEEDED", runs: [37_600_002_840, RUN_810] },
  },
  {
    id: "R10-two-succeeded-one-incomplete",
    title: "EVERY succeeded run must carry the required jobs",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37_600_002_840, runNumber: 2840, createdAt: "2026-10-07T18:00:00Z" }));
      w.jobs[37_600_002_840] = allGreenJobs().filter((j) => j.name !== JOB.validate);
    }),
    expect: { outcome: "INCOMPLETE", runs: [37_600_002_840, RUN_810] },
  },
  {
    id: "R10-rule9-first",
    title: "rule 9 classifies every applicable run before rule 10 aggregates: an unrecognized status beats a FAILED sibling",
    source: "synthetic",
    rule: 9,
    world: edit((w) => {
      w.runs = [
        ownRun({ id: 37_600_002_840, runNumber: 2840, createdAt: "2026-10-07T18:00:00Z", conclusion: "failure" }),
        ownRun({ status: "exploded", conclusion: null }),
      ];
    }),
    expect: reason("unrecognized_ci_status"),
    note: "Reading: 'Rules apply in this order. The first that fires decides.' Rule 9 fires on any applicable run whose state is outside the closed table.",
  },
  {
    id: "R10-rerun-attempt",
    title: "a re-run (run_attempt 3) that ended green is judged by its latest attempt",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.runs = [ownRun({ runAttempt: 3 })];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "R10-failed-before-jobs",
    title: "a FAILED run decides before any job listing is consulted (even one that is too large)",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.runs.unshift(ownRun({ id: 37_600_002_840, runNumber: 2840, createdAt: "2026-10-07T18:00:00Z", conclusion: "failure" }));
      w.jobs[RUN_810] = { tooLarge: true };
    }),
    expect: { outcome: "FAILED", runs: [37_600_002_840, RUN_810] },
  },

  // --- NC5 -------------------------------------------------------------------
  ...REQUIRED_JOB_ROWS(),
];

// ---------------------------------------------------------------------------
// Row families
// ---------------------------------------------------------------------------
function CI_DEFINITION_ROWS(): Scenario[] {
  return [".github/workflows/ci.yml", "scripts/classify-changes.mjs", "scripts/browser-groups.mjs"].map((file) => ({
    id: `R3-${file.split("/").pop()}`,
    title: `the PR changes ${file}: required lanes would come from code the PR controls`,
    source: "synthetic (one real filename replaced)",
    rule: 3,
    world: edit((w) => {
      w.compare.files[0] = file;
    }),
    expect: reason("ci_definition_changed"),
  }));
}

function SHARED_HEAD_ROWS(): Scenario[] {
  const rows: Array<[string, string, (w: World) => void]> = [
    ["R5-listing-empty", "no PR at all on the head branch listing is not exactly [810]", (w) => (w.headBranchPrs = [])],
    [
      "R5-listing-duplicate",
      "a listing of [810, 810] is not exactly [810]",
      (w) =>
        (w.headBranchPrs = [
          { number: 810, state: "open" },
          { number: 810, state: "open" },
        ]),
    ],
    [
      "R5-listing-capped",
      "a 100-entry head-branch listing is capped",
      (w) =>
        (w.headBranchPrs = [
          { number: 810, state: "open" },
          ...Array.from({ length: 99 }, (_, i) => ({ number: 100 + i, state: "closed" as const })),
        ]),
    ],
    ["R5-assoc-two", "a second open PR associated with the head commit", (w) => (w.prContext.associated = [810, 811])],
    ["R5-assoc-empty", "no PR associated with the head commit", (w) => (w.prContext.associated = [])],
    ["R5-assoc-other", "only another PR associated with the head commit", (w) => (w.prContext.associated = [811])],
    ["R5-assoc-too-many", "associated PRs beyond one page", (w) => (w.prContext.associatedHasNext = true)],
  ];
  return rows.map(([id, title, f]) => ({ id, title, source: "synthetic", rule: 5, world: edit(f), expect: reason("shared_head") }));
}

function UNRELATED_RUN_ROWS(): Scenario[] {
  const id = 37_700_000_000;
  const kinds: Array<[string, string, Partial<RunSpec>]> = [
    ["other-workflow", "another workflow (e.g. nightly) at the same head", { workflowId: WORKFLOW_ID + 1 }],
    ["pull_request_target", "a pull_request_target run", { event: "pull_request_target" }],
    ["merge_group", "a merge_group run", { event: "merge_group" }],
    ["workflow_dispatch", "a workflow_dispatch run on the head branch", { event: "workflow_dispatch" }],
    ["fork-repo", "a fork's run of the same commit on a same-named branch", { headRepoId: FORK_REPO }],
    ["null-repo", "a run whose head repository is gone (null)", { headRepoId: null }],
    ["null-branch", "a run whose head_branch is null", { headBranch: null }],
    ["other-branch", "a run on another head branch", { headBranch: "feat/someone-else" }],
    ["other-sha", "a run at another head SHA returned by the listing", { headSha: sha40(0xbadc0de) }],
  ];
  const rows: Scenario[] = kinds.map(([k, title, over]) => ({
    id: `NC6-${k}`,
    title: `${title} grants nothing: NO_RUN`,
    source: "synthetic; real run shape",
    nc: "NC6",
    rule: 7,
    world: edit((w) => {
      w.runs = [ownRun({ id, runNumber: 2860, ...over })];
      w.jobs = { [id]: allGreenJobs() };
    }),
    expect: { outcome: "NO_RUN", runs: [] },
  }));
  rows.push({
    id: "NC6-ignored-failures-do-not-block",
    title: "failed unrelated runs of every kind neither grant nor block",
    source: "synthetic; real run shapes",
    nc: "NC6",
    rule: 7,
    world: edit((w) => {
      kinds.forEach(([, , over], i) => w.runs.push(ownRun({ id: id + i, runNumber: 2860 + i, conclusion: "failure", ...over })));
    }),
    expect: SUCCEEDED_OWN,
  });
  rows.push({
    id: "NC6-ignored-states-not-classified",
    title: "unrelated runs with unrecognized states are not classified (rule 9 covers applicable runs only)",
    source: "synthetic",
    nc: "NC6",
    rule: 7,
    world: edit((w) => {
      kinds.forEach(([, , over], i) =>
        w.runs.push(ownRun({ id: id + i, runNumber: 2860 + i, status: i % 2 ? "exploded" : "completed", conclusion: i % 2 ? "success" : null, ...over })),
      );
    }),
    expect: SUCCEEDED_OWN,
  });
  return rows;
}

function RUN_STATE_ROWS(): Scenario[] {
  const rows: Scenario[] = [];
  for (const c of FAILED_CONCLUSIONS)
    rows.push({
      id: `R9-failed-${c}`,
      title: `completed/${c} is FAILED`,
      source: "synthetic",
      rule: 9,
      world: edit((w) => (w.runs = [ownRun({ conclusion: c })])),
      expect: { outcome: "FAILED", runs: [RUN_810] },
    });
  for (const c of ["Success", "SUCCESS", "succeeded", "", "some_future_conclusion"])
    rows.push({
      id: `R9-unrecognized-conclusion-${JSON.stringify(c)}`,
      title: `completed/${JSON.stringify(c)} is unrecognized_ci_conclusion`,
      source: "synthetic",
      rule: 9,
      world: edit((w) => (w.runs = [ownRun({ conclusion: c })])),
      expect: reason("unrecognized_ci_conclusion"),
    });
  rows.push({
    id: "R9-completed-null",
    title: "completed with a null conclusion is malformed",
    source: "synthetic",
    rule: 9,
    world: edit((w) => (w.runs = [ownRun({ conclusion: null })])),
    expect: reason("malformed"),
  });
  for (const s of PENDING_STATUSES)
    rows.push({
      id: `R9-pending-${s}`,
      title: `${s} is PENDING`,
      source: "synthetic",
      rule: 9,
      world: edit((w) => (w.runs = [ownRun({ status: s, conclusion: null })])),
      expect: { outcome: "PENDING", runs: [RUN_810] },
    });
  rows.push({
    id: "R9-pending-stale-conclusion",
    title: "an in_progress re-run whose previous conclusion lingers is PENDING",
    source: "synthetic",
    rule: 9,
    world: edit((w) => (w.runs = [ownRun({ status: "in_progress", conclusion: "success", runAttempt: 2 })])),
    expect: { outcome: "PENDING", runs: [RUN_810] },
  });
  for (const s of ["Completed", "COMPLETED", "done", "", "completed "])
    rows.push({
      id: `R9-unrecognized-status-${JSON.stringify(s)}`,
      title: `status ${JSON.stringify(s)} is unrecognized_ci_status`,
      source: "synthetic",
      rule: 9,
      world: edit((w) => (w.runs = [ownRun({ status: s, conclusion: "success" })])),
      expect: reason("unrecognized_ci_status"),
    });
  return rows;
}

function REQUIRED_JOB_ROWS(): Scenario[] {
  const jobs = (f: (js: JobSpec[]) => JobSpec[]) => (w: World) => {
    w.jobs[RUN_810] = f(allGreenJobs());
  };
  const set = (name: string, status: string, conclusion: string | null) => (js: JobSpec[]) =>
    js.map((j) => (j.name === name ? { name, status, conclusion } : j));
  const src = "real job shapes from #810's run 37680787947; synthetic edits";
  const rows: Array<[string, string, (w: World) => void, Expect, string?]> = [
    ["NC5-validate-skipped", "a required job was skipped", jobs(set(JOB.validate, "completed", "skipped")), { outcome: "INCOMPLETE", runs: [RUN_810] }],
    ["NC5-validate-missing", "a required job is missing", jobs((js) => js.filter((j) => j.name !== JOB.validate)), { outcome: "INCOMPLETE", runs: [RUN_810] }],
    ["NC5-validate-in-progress", "a required job never completed", jobs(set(JOB.validate, "in_progress", null)), { outcome: "INCOMPLETE", runs: [RUN_810] }],
    ["NC5-validate-failure", "a required job failed inside a green run (continue-on-error)", jobs(set(JOB.validate, "completed", "failure")), { outcome: "INCOMPLETE", runs: [RUN_810] }],
    ["NC5-validate-neutral", "a required job ended neutral", jobs(set(JOB.validate, "completed", "neutral")), { outcome: "INCOMPLETE", runs: [RUN_810] }],
    ["NC5-aggregator-skipped", "the browser aggregator did not succeed", jobs(set(JOB.aggregator, "completed", "skipped")), { outcome: "INCOMPLETE", runs: [RUN_810] }],
    ["NC5-changes-missing", "changed-path detection is missing", jobs((js) => js.filter((j) => j.name !== JOB.changes)), { outcome: "INCOMPLETE", runs: [RUN_810] }],
    [
      "NC5-near-miss-name",
      "a job whose name only resembles a required one does not count",
      jobs((js) => js.map((j) => (j.name === JOB.changes ? { ...j, name: `${JOB.changes} ` } : j))),
      { outcome: "INCOMPLETE", runs: [RUN_810] },
    ],
    [
      "NC5-duplicate-required",
      "a required job listed twice, once failing",
      jobs((js) => [...js, { name: JOB.validate, status: "completed", conclusion: "failure" }]),
      { outcome: "INCOMPLETE", runs: [RUN_810] },
      "Reading: 'A missing or non-success required job → INCOMPLETE' covers a non-success duplicate.",
    ],
    ["NC5-too-large", "the run's job listing cannot be complete", (w) => (w.jobs[RUN_810] = { tooLarge: true }), reason("ci_candidate_listing_too_large")],
    [
      "NC5-no-listing",
      "no job listing at all for the succeeded run",
      (w) => delete w.jobs[RUN_810],
      { anyOf: [{ outcome: "INCOMPLETE", runs: [RUN_810] }, reason("malformed"), reason("ci_candidate_listing_too_large")] },
      "The spec does not name the reason for an absent listing; it must not be SUCCEEDED.",
    ],
    [
      "NC5-unrequired-failure",
      "a failing job that is not required does not matter",
      jobs(set(JOB.payment, "completed", "failure")),
      SUCCEEDED_OWN,
    ],
    [
      "NC5-docs-only",
      "a docs-only classification requires only changed-path detection and the aggregator",
      (w) => {
        w.classification = { ...w.classification, docs_only: true, application: false };
        w.jobs[RUN_810] = set(JOB.validate, "completed", "skipped")(allGreenJobs());
      },
      SUCCEEDED_OWN,
    ],
  ];
  const lane: Array<[string, string, string]> = [
    ["database", JOB.db, "database"],
    ["security", JOB.db, "security"],
    ["payment", JOB.payment, "payment"],
    ["mobile", JOB.mobile, "mobile"],
    ["google_calendar", JOB.google, "google"],
    ["full_matrix_required", JOB.db, "full matrix"],
  ];
  for (const [flag, job, label] of lane) {
    rows.push([
      `NC5-${label.replace(" ", "-")}-required-skipped`,
      `${flag} requires ${job}, which the real listing shows skipped`,
      (w) => {
        w.classification = { ...w.classification, [flag]: true };
      },
      { outcome: "INCOMPLETE", runs: [RUN_810] },
    ]);
    rows.push([
      `NC5-${label.replace(" ", "-")}-required-green`,
      `${flag} with every lane it requires green`,
      (w) => {
        w.classification = { ...w.classification, [flag]: true };
        w.jobs[RUN_810] = allGreenJobs().map((j) =>
          [JOB.db, JOB.payment, JOB.mobile, JOB.google].includes(j.name as never) ? { ...j, conclusion: "success" } : j,
        );
      },
      SUCCEEDED_OWN,
    ]);
  }
  return rows.map(([id, title, f, expect, note]) => ({ id, title, source: src, nc: "NC5" as const, rule: 10, world: edit(f), expect, note }));
}

// ---------------------------------------------------------------------------
// Rule ordering: eleven independent fault injectors, one per rule (0 = bindBase).
// Any combination must be decided by its lowest-numbered rule ("the first that
// fires decides").
// ---------------------------------------------------------------------------
export interface Injector {
  rule: number;
  apply: (w: World) => void;
  expect: Expect;
}
export const INJECTORS: Injector[] = [
  { rule: 0, apply: (w) => (w.pr.baseRef = "release/2026-10"), expect: reason("base_ref") },
  { rule: 1, apply: (w) => (w.pr.headRepoId = FORK_REPO), expect: reason("fork_head") },
  { rule: 2, apply: (w) => (w.prContext.changedFiles = w.compare.files.length + 1), expect: reason("diff_too_large") },
  { rule: 3, apply: (w) => (w.compare.files[0] = ".github/workflows/ci.yml"), expect: reason("ci_definition_changed") },
  { rule: 4, apply: (w) => (w.prContext.baseRefEvents = 1), expect: reason("base_ref_changed") },
  { rule: 5, apply: (w) => w.headBranchPrs.push({ number: 702, state: "closed" }), expect: reason("shared_head") },
  { rule: 6, apply: (w) => (w.rules = []), expect: reason("base_history_unverified") },
  { rule: 7, apply: (w) => (w.runs[0].event = "push"), expect: { outcome: "NO_RUN", runs: [] } },
  { rule: 8, apply: (w) => (w.activity.forcePush = [fp(hoursAfter(RUN_810_CREATED, 1))]), expect: reason("base_history_unverified") },
  { rule: 9, apply: (w) => (w.runs[0].status = "exploded"), expect: reason("unrecognized_ci_status") },
  {
    rule: 10,
    apply: (w) => {
      const js = w.jobs[RUN_810];
      if (Array.isArray(js)) w.jobs[RUN_810] = js.filter((j) => j.name !== JOB.validate);
    },
    expect: { outcome: "INCOMPLETE", runs: [RUN_810] },
  },
];

export function orderScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const combos: number[][] = [];
  for (let i = 0; i < INJECTORS.length; i++) for (let j = i + 1; j < INJECTORS.length; j++) combos.push([i, j]);
  const r = rng(0x05a0_0de7);
  for (let k = 0; k < 40; k++) {
    const size = 3 + r.int(3);
    combos.push(r.shuffle(INJECTORS.map((_, i) => i)).slice(0, size));
  }
  for (const combo of combos) {
    const sorted = [...combo].sort((a, b) => a - b);
    const first = INJECTORS[sorted[0]];
    out.push({
      id: `ORDER-${sorted.join("+")}`,
      title: `rules ${sorted.join(", ")} all fire: rule ${first.rule} decides`,
      source: "synthetic fault injection over the golden world",
      rule: first.rule,
      world: () => {
        const w = golden();
        // apply in a shuffled order: injectors touch disjoint fields
        for (const i of combo) INJECTORS[i].apply(w);
        return w;
      },
      expect: first.expect,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adversarial sequences against SPEC §3.4 "Why this binds the execution context".
// `verdict` is the verifier's classification. For a CONFIRMED HOLE the expectation
// is what the spec MANDATES for an unsafe sequence: such a row passing is the
// demonstration, and closing the hole must flip it.
// ---------------------------------------------------------------------------
export interface Adversarial extends Scenario {
  verdict: "CONFIRMED HOLE" | "SPEC AMBIGUITY" | "NO HOLE";
  sequence: string;
}

export const ADVERSARIAL: Adversarial[] = [
  {
    id: "A1-merge-before-created-at",
    verdict: "CONFIRMED HOLE",
    title: "a production rewrite between GitHub computing the test merge and creating the run record is invisible",
    sequence:
      "push to the PR head at t0; GitHub computes refs/pull/N/merge = merge(P_old, H) (GITHUB_SHA is fixed then, and a conflicting PR gets no run at all, so the merge precedes the run); an admin force-pushes production from P_old to P_new (an ancestor of H, dropping commit X) at t0+5s; the run record is created at t0+7s and tests merge(P_old, H), which contains X; behind_by(P_new...H) = 0; rule 8 only looks at events >= created_at, so the rewrite 2s before created_at is ignored. The tested tree is not H's tree.",
    source: "synthetic timing; real #810 shapes",
    rule: 8,
    world: edit((w) => {
      w.activity.forcePush = [{ timestamp: secondsAfter(RUN_810_CREATED, -2), before: sha40(0x0001d), after: P0 }];
    }),
    expect: SUCCEEDED_OWN,
    note: "SPEC §3.4 rule 8: 'A rewrite before the earliest run is irrelevant: that run tested a base taken after it.' The base is taken when the merge is computed, which is BEFORE created_at.",
  },
  {
    id: "A1b-reopen-on-a-stale-merge-ref",
    verdict: "SPEC AMBIGUITY",
    title: "a reopen days after a production rewrite, if GitHub replays the merge ref it computed before the close",
    sequence:
      "#810 is closed at t0 with refs/pull/810/merge = merge(P_old, H); production is force-pushed to P_new (an ancestor of H) at t0+1d while the PR is closed; the PR is reopened at t0+2d. If the 'reopened' run's GITHUB_SHA is the pre-close merge (undocumented either way), it tests merge(P_old, H); its created_at is after the rewrite, so rule 8 calls the rewrite irrelevant. Same premise as A1, with an unbounded window.",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ createdAt: "2026-10-07T20:16:44Z" })];
      w.activity.forcePush = [{ timestamp: "2026-10-06T12:00:00Z", before: sha40(0x0001d), after: P0 }];
    }),
    expect: SUCCEEDED_OWN,
    note: "Unsafe exactly when GitHub does not recompute the test merge commit before a 'reopened' run.",
  },
  {
    id: "A2-head-rename-closes-pr",
    verdict: "NO HOLE",
    title: "renaming a PR's head branch closes that PR, and the closed PR keeps its head ref in the listing",
    sequence:
      "PR 702 (base: a writer-controlled branch) ran green at H on feat/eng-loop-v1-05a; its head branch is renamed, which CLOSES 702 (GitHub docs: 'If the renamed branch is the head branch of an open pull request, this pull request is closed'); the name is reused for #810 at H. 702's run is applicable by branch, but pulls?head=…&state=all still lists 702.",
    source: "synthetic; GitHub docs 'Renaming a branch' (read 2026-10-07)",
    rule: 5,
    world: edit((w) => {
      w.headBranchPrs = [
        { number: 810, state: "open" },
        { number: 702, state: "closed" },
      ];
      w.runs = [ownRun({ id: OTHER_PR_RUN, runNumber: 2700, createdAt: "2026-10-01T10:00:00Z" })];
      w.jobs = { [OTHER_PR_RUN]: allGreenJobs() };
    }),
    expect: reason("shared_head"),
  },
  {
    id: "A3-branch-deleted-and-recreated",
    verdict: "NO HOLE",
    title: "deleting and recreating the head branch for a new PR at the same SHA",
    sequence:
      "closed PR 650 used feat/eng-loop-v1-05a at H (green run); the branch was deleted, recreated at H, and #810 opened without a run of its own yet. 650 stays in the state=all listing.",
    source: "synthetic",
    rule: 5,
    world: edit((w) => {
      w.headBranchPrs = [
        { number: 650, state: "closed" },
        { number: 810, state: "open" },
      ];
      w.runs = [ownRun({ id: OTHER_PR_RUN, runNumber: 2500, createdAt: "2026-09-20T10:00:00Z" })];
      w.jobs = { [OTHER_PR_RUN]: allGreenJobs() };
    }),
    expect: reason("shared_head"),
  },
  {
    id: "A4-cancelled-duplicate",
    verdict: "NO HOLE",
    title: "two runs created in the same second, the higher one cancelled by cancel-in-progress (CI-ATTEST-01 E14, #686)",
    sequence: "ci.yml's PR-scoped concurrency cancels one of two same-second runs; 'every applicable run' counts the cancelled one as FAILED.",
    source: "real pattern (E14: #686 runs 1896/1897); synthetic ids",
    rule: 10,
    world: edit((w) => {
      w.runs.push(ownRun({ id: 37_600_002_856, runNumber: 2856, conclusion: "cancelled" }));
    }),
    expect: { outcome: "FAILED", runs: [RUN_810, 37_600_002_856] },
    note: "Safe, but a liveness cost: such a head stays FAILED until the cancelled run is re-run.",
  },
  {
    id: "A5-rerun-after-rewrite",
    verdict: "NO HOLE",
    title: "re-running a run after production was rewritten",
    sequence:
      "run created at t1 failed; production force-pushed at t2 > t1; the run is re-run at t3 (attempt 2, green). A re-run replays the original GITHUB_SHA (E3), i.e. the pre-rewrite merge; created_at stays t1, so rule 8 fires.",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ runAttempt: 2 })];
      w.activity.forcePush = [fp(hoursAfter(RUN_810_CREATED, 1))];
    }),
    expect: reason("base_history_unverified"),
  },
  {
    id: "A6-window-361-days",
    verdict: "NO HOLE",
    title: "a run older than 360 days is outside the provable window",
    sequence: "activity is read with time_period=year; the 360-day window keeps every applicable run inside it.",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.runs = [ownRun({ createdAt: daysBefore(w.observedAt, 361) })];
    }),
    expect: reason("base_history_unverified"),
    note: "Whether GitHub retains a full year of activity, and what 'year' spans, is unverified (reported as an ambiguity).",
  },
  {
    id: "A7-merge-conflict-no-own-run",
    verdict: "NO HOLE",
    title: "a PR opened with a merge conflict gets no pull_request run; another branch's run at the same SHA is ignored",
    sequence: "GitHub docs: 'Workflows will not run on pull_request activity if the pull request has a merge conflict.' Closed PR 702 on another branch has a green run at H.",
    source: "synthetic; GitHub docs (events that trigger workflows)",
    rule: 7,
    world: edit((w) => {
      w.runs = [ownRun({ id: OTHER_PR_RUN, runNumber: 2700, headBranch: "feat/older-pr-702", createdAt: "2026-10-01T10:00:00Z" })];
      w.jobs = { [OTHER_PR_RUN]: allGreenJobs() };
    }),
    expect: { outcome: "NO_RUN", runs: [] },
  },
  {
    id: "A8-branch-creation-unread",
    verdict: "SPEC AMBIGUITY",
    title: "production was (re)created after the run with no recorded deletion or force push",
    sequence:
      "e.g. the production branch renamed away and another branch renamed to its name: whether GitHub records a rename as branch_deletion/force_push on refs/heads/<productionRef> is undocumented. bindCi's activity input carries only force_push and branch_deletion, so a recorded branch_creation after the run cannot even be expressed.",
    source: "synthetic",
    rule: 8,
    world: edit((w) => {
      w.activity.branchCreation = [{ timestamp: hoursAfter(RUN_810_CREATED, 1), before: "0".repeat(40), after: P0 }];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "A9-behind-is-05B",
    verdict: "NO HOLE",
    title: "bindCi does not itself require behind_by == 0",
    sequence: "the PR is 3 behind production; SPEC §2.6 leaves NEEDS_REFRESH to 05B's precedence, ahead of every CI rule. bindCi's SUCCEEDED alone is not readiness.",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.compare.status = "diverged";
      w.compare.behindBy = 3;
      w.compare.mergeBaseSha = sha40(0x3e1);
    }),
    expect: SUCCEEDED_OWN,
    note: "Cross-layer obligation: the binding claim's last step (behindBy == 0) is enforced in 05B, not 05A.",
  },
  {
    id: "A10-partial-rerun-carried-jobs",
    verdict: "NO HOLE",
    title: "a partial re-run: latest-attempt jobs include carried-over successes (E6)",
    sequence: "attempt 2 re-ran only the failed validate job; filter=latest lists the carried jobs with attempt-1 timestamps. Every attempt tests the same merge commit (E3).",
    source: "synthetic; real job names",
    rule: 10,
    world: edit((w) => {
      w.runs = [ownRun({ runAttempt: 2 })];
    }),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "A11-rerun-between-reads",
    verdict: "NO HOLE",
    title: "a re-run starts between the runs listing and the jobs listing",
    sequence: "the runs answer shows attempt 1 completed/success; the later filter=latest jobs answer already shows attempt 2's validate queued.",
    source: "synthetic",
    rule: 10,
    world: edit((w) => {
      w.jobs[RUN_810] = allGreenJobs().map((j) => (j.name === JOB.validate ? { ...j, status: "queued", conclusion: null } : j));
    }),
    expect: { outcome: "INCOMPLETE", runs: [RUN_810] },
  },
  {
    id: "A12-deleted-failed-run",
    verdict: "NO HOLE",
    title: "a writer deletes the PR's failed run, leaving a green one",
    sequence: "both runs tested H's tree on a production base; deleting one is equivalent to a green re-run. It removes conservatism, not provenance.",
    source: "synthetic",
    rule: 10,
    world: edit(() => {}),
    expect: SUCCEEDED_OWN,
  },
  {
    id: "A13-ci-yml-renamed-away",
    verdict: "NO HOLE",
    title: "a PR renames .github/workflows/ci.yml away: rule 3 sees only the new filename",
    sequence:
      "the compare lists the rename under its NEW filename (the record keeps no previous_filename), so rule 3 does not fire; but the merge commit then has no ci.yml, so no run of workflow 289443461 exists at H — the renamed file is a new workflow id.",
    source: "synthetic",
    rule: 7,
    world: edit((w) => {
      w.compare.files[0] = ".github/workflows/ci-renamed.yml";
      w.runs = [ownRun({ workflowId: 299_000_001 })];
    }),
    expect: { outcome: "NO_RUN", runs: [] },
  },
  {
    id: "A14-fork-same-branch-same-sha",
    verdict: "NO HOLE",
    title: "a fork PR from a same-named branch at the same SHA",
    sequence: "the fork's green run has head_repository = the fork; the PR's own run failed.",
    source: "synthetic",
    rule: 7,
    world: edit((w) => {
      w.runs = [ownRun({ id: 37_800_000_001, runNumber: 2858, headRepoId: FORK_REPO }), ownRun({ conclusion: "failure" })];
      w.jobs = { 37_800_000_001: allGreenJobs(), [RUN_810]: realJobs() };
    }),
    expect: { outcome: "FAILED", runs: [RUN_810] },
  },
];

/** A fresh deep copy, so a consumer can never leak edits between rows. */
export const freshWorld = (s: Scenario): World => clone(s.world());
