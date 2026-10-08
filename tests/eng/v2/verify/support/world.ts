/* eslint-disable @typescript-eslint/no-explicit-any -- raw GitHub answers are untyped JSON on purpose */
// Independent verifier support: a small "GitHub world" description for one open
// PR, and builders that turn it into the RAW answers SPEC-05A's parsers receive.
//
// Every raw answer is cloned from a REAL recorded answer and then edited, so the
// strict parsers see GitHub's real shapes (including fields they must ignore,
// such as a workflow run's `pull_requests`). The real sources are:
//   tests/eng/v2/fixtures/base/compare-810.json, head-branch-prs-810.json   (builder, real)
//   tests/eng/v2/verify/fixtures/real/runs-810-pull-request.json            (verifier, real)
//   tests/eng/v2/verify/fixtures/real/runs-6cdd830b-push.json               (verifier, real)
//   tests/eng/v2/verify/fixtures/real/jobs-810-run-latest.json              (verifier, real)
//   tests/eng/v2/verify/fixtures/real/activity-pr-merge-week.json           (verifier, real)
//   tests/eng/v2/verify/fixtures/real/activity-branch-creation-year.json    (verifier, real)
//   tests/eng/v2/verify/fixtures/builder-real/review-*.json, rollup-*.json  (builder-recorded real answers,
//     copied from feat/eng-loop-v1-05a@203ed1f4; their `number` / `oid` echo is part of the amended query)

import { readFileSync } from "node:fs";
import path from "node:path";
import { clone } from "./deep";

// --- Policy (SPEC-05A §2, §3) ------------------------------------------------
export const PRODUCTION_REF = "claude/build-hone-saas-hOex7";
export const PROD_REF_FULL = `refs/heads/${PRODUCTION_REF}`;
export const TARGET_REPO_ID = 1240764106;
export const WORKFLOW_ID = 289443461;
export const CI_DEFINITION_FILES = [
  ".github/workflows/ci.yml",
  "scripts/classify-changes.mjs",
  "scripts/browser-groups.mjs",
] as const;
export const FAILED_CONCLUSIONS = [
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
] as const;
export const PENDING_STATUSES = ["queued", "in_progress", "waiting", "requested", "pending"] as const;

// --- Real values -------------------------------------------------------------
export const H810 = "958b9d536e055e746499262cdc1a740e13501bf2"; // #810 head at its compare/run (real)
export const P0 = "6cdd830b0bcc5e3532016bc612bd0298db3533fb"; // production tip at #810's compare (real)
export const HEAD_REF_810 = "feat/eng-loop-v1-05a"; // real
export const RUN_810 = 37680787947; // real run id, run_number 2855, created 2026-10-07T20:16:44Z
export const RUN_810_CREATED = "2026-10-07T20:16:44Z";
export const PUSH_RUN_6CDD = 37672136569; // real push run at production 6cdd830b, run_number 2853

export const JOB = {
  changes: "changed-path detection",
  validate: "typecheck / lint / build / test / safety gates",
  aggregator: "browser e2e (local stack)",
  db: "db integration (local supabase)",
  payment: "payment browser e2e (fake stripe)",
  mobile: "mobile completion e2e (chromium iphone-profile)",
  google: "google browser e2e (fake google)",
} as const;

const BASE_FIXTURES = path.join(__dirname, "..", "..", "fixtures", "base");
const PR_KEY_FIXTURES = path.join(__dirname, "..", "..", "fixtures", "pr-key");
const VERIFY_FIXTURES = path.join(__dirname, "..", "fixtures", "real");
const BUILDER_FIXTURES = path.join(__dirname, "..", "fixtures", "builder-real");
const load = (dir: string, f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));

export const REAL = {
  base: (f: string) => load(BASE_FIXTURES, f),
  prKey: (f: string) => load(PR_KEY_FIXTURES, f),
  verify: (f: string) => load(VERIFY_FIXTURES, f),
  builder: (f: string) => load(BUILDER_FIXTURES, f),
};

// --- The world ---------------------------------------------------------------
export interface RunSpec {
  id: number;
  runNumber: number;
  workflowId: number;
  event: string;
  headSha: string;
  headBranch: string | null;
  headRepoId: number | null;
  status: string;
  conclusion: string | null;
  runAttempt: number;
  createdAt: string;
  /** which real run answer this record is cloned from */
  template?: "pull_request" | "push";
}
export interface JobSpec {
  name: string;
  status: string;
  conclusion: string | null;
}
export type JobsSpec = JobSpec[] | { tooLarge: true };
export interface ActivityEvent {
  timestamp: string;
  before: string;
  after: string;
}
export interface World {
  pr: {
    number: number;
    isDraft: boolean;
    headSha: string;
    headRef: string;
    headRepoId: number;
    baseRef: string;
    baseRepoId: number;
    baseSha: string;
  };
  compare: {
    /** the base the compare answer reports; defaults to the key's live base tip */
    baseSha?: string;
    status: "ahead" | "behind" | "diverged" | "identical";
    behindBy: number;
    aheadBy: number;
    mergeBaseSha: string;
    files: string[];
  };
  prContext: {
    createdAt: string;
    changedFiles: number;
    /** BaseRefChangedEvent nodes returned on the one page */
    baseRefEvents: number;
    /**
     * Further base-change nodes after those, by __typename (SPEC §2.2 as amended at 4b0662a2):
     * "AutomaticBaseChangeSucceededEvent", "AutomaticBaseChangeFailedEvent", or any other type (malformed).
     */
    extraBaseEvents?: string[];
    baseRefHasNext: boolean;
    associated: number[];
    associatedHasNext: boolean;
    /**
     * The unfiltered timeline count GitHub reports as totalCount (SPEC §0 trap).
     * Never part of the spec-shaped answer; only a totalCount-reading mutant sees it.
     */
    timelineTotalCount?: number;
  };
  headBranchPrs: { number: number; state: "open" | "closed" }[];
  rules: string[];
  activity: {
    forcePush: ActivityEvent[];
    branchDeletion: ActivityEvent[];
    branchCreation: ActivityEvent[];
  };
  runs: RunSpec[];
  /** total_count override for the runs listing */
  runsTotalCount?: number;
  jobs: Record<number, JobsSpec>;
  classification: Record<string, boolean>;
  observedAt: string;
}

export const REAL_810_FILES: string[] = REAL.base("compare-810.json").files.map((f: any) => f.filename);

export const APPLICATION_ONLY: Record<string, boolean> = {
  docs_only: false,
  application: true,
  database: false,
  security: false,
  payment: false,
  google_calendar: false,
  browser_core: false,
  mobile: false,
  ci_workflows: false,
  full_matrix_required: false,
};

/** #810's real job names, every one completed/success (synthetic: the real validate job failed). */
export function allGreenJobs(): JobSpec[] {
  return REAL.verify("jobs-810-run-latest.json").jobs.map((j: any) => ({
    name: j.name,
    status: "completed",
    conclusion: j.name === JOB.validate ? "success" : j.conclusion,
  }));
}
/** #810's real job listing, unedited (validate failed; db/payment/mobile/google skipped). */
export function realJobs(): JobSpec[] {
  return REAL.verify("jobs-810-run-latest.json").jobs.map((j: any) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
  }));
}

/** Production's real creation event, as recorded for the year on 2026-10-07. */
export function realCreation(): ActivityEvent[] {
  return REAL.verify("activity-branch-creation-year.json").map((e: any) => ({ timestamp: e.timestamp, before: e.before, after: e.after }));
}

export function ownRun(over: Partial<RunSpec> = {}): RunSpec {
  return {
    id: RUN_810,
    runNumber: 2855,
    workflowId: WORKFLOW_ID,
    event: "pull_request",
    headSha: H810,
    headBranch: HEAD_REF_810,
    headRepoId: TARGET_REPO_ID,
    status: "completed",
    conclusion: "success",
    runAttempt: 1,
    createdAt: RUN_810_CREATED,
    template: "pull_request",
    ...over,
  };
}

/**
 * The golden world: #810 as recorded on 2026-10-07 (key values, compare, head-branch
 * listing, activity and job names are real), with three synthetic edits so every
 * rule passes: production rules present (real: none), the run concluded success
 * (real: failure) and the validate job succeeded (real: failure).
 * Required outcome: SUCCEEDED with the one applicable run.
 */
export function golden(): World {
  return {
    pr: {
      number: 810,
      isDraft: false,
      headSha: H810,
      headRef: HEAD_REF_810,
      headRepoId: TARGET_REPO_ID,
      baseRef: PRODUCTION_REF,
      baseRepoId: TARGET_REPO_ID,
      baseSha: P0,
    },
    compare: { status: "ahead", behindBy: 0, aheadBy: 2, mergeBaseSha: P0, files: [...REAL_810_FILES] },
    prContext: {
      createdAt: "2026-10-07T20:16:40Z",
      changedFiles: REAL_810_FILES.length,
      baseRefEvents: 0,
      baseRefHasNext: false,
      associated: [810],
      associatedHasNext: false,
      // Real: the recorded #810 context answer carries timelineItems totalCount 4.
      timelineTotalCount: 4,
    },
    headBranchPrs: [{ number: 810, state: "open" }],
    rules: ["deletion", "non_fast_forward"],
    // Real (2026-10-07): no force push, no deletion, and production's one creation (2026-05-16).
    activity: { forcePush: [], branchDeletion: [], branchCreation: realCreation() },
    runs: [ownRun()],
    jobs: { [RUN_810]: allGreenJobs() },
    classification: { ...APPLICATION_ONLY },
    observedAt: "2026-10-07T21:00:00Z",
  };
}

// --- Raw answers --------------------------------------------------------------
const hexFrom = (n: number) => n.toString(16).padStart(40, "0").slice(-40);

export function rawKeyFor(w: World): any {
  return {
    data: {
      repository: {
        pullRequest: {
          number: w.pr.number,
          state: "OPEN",
          isDraft: w.pr.isDraft,
          headRefOid: w.pr.headSha,
          headRefName: w.pr.headRef,
          headRepository: { databaseId: w.pr.headRepoId },
          baseRefName: w.pr.baseRef,
          baseRepository: { databaseId: w.pr.baseRepoId },
          baseRef: { target: { oid: w.pr.baseSha } },
        },
      },
    },
  };
}

export function rawCompareFor(w: World): any {
  const t = REAL.base("compare-810.json");
  const byName = new Map<string, any>(t.files.map((f: any) => [f.filename, f]));
  const template = t.files[0];
  t.status = w.compare.status;
  t.behind_by = w.compare.behindBy;
  t.ahead_by = w.compare.aheadBy;
  t.total_commits = w.compare.aheadBy;
  t.base_commit.sha = w.compare.baseSha ?? w.pr.baseSha;
  t.merge_base_commit.sha = w.compare.mergeBaseSha;
  t.files = w.compare.files.map((name, i) => {
    const f = clone(byName.get(name) ?? template);
    f.filename = name;
    if (!byName.has(name)) {
      f.sha = hexFrom(0xf11e0000 + i);
      f.status = "modified";
      delete f.previous_filename;
    }
    return f;
  });
  return t;
}

export function rawPrContextFor(w: World): any {
  return {
    data: {
      repository: {
        pullRequest: {
          number: w.pr.number,
          createdAt: w.prContext.createdAt,
          changedFiles: w.prContext.changedFiles,
          baseRefChanges: {
            pageInfo: { hasNextPage: w.prContext.baseRefHasNext },
            nodes: [
              ...Array.from({ length: w.prContext.baseRefEvents }, () => ({ __typename: "BaseRefChangedEvent" })),
              ...(w.prContext.extraBaseEvents ?? []).map((t) => ({ __typename: t })),
            ],
          },
        },
        object: {
          __typename: "Commit",
          associatedPullRequests: {
            pageInfo: { hasNextPage: w.prContext.associatedHasNext },
            nodes: w.prContext.associated.map((number) => ({ number })),
          },
        },
      },
    },
  };
}

export function rawHeadBranchPrsFor(w: World): any {
  const template = REAL.base("head-branch-prs-810.json")[0];
  return w.headBranchPrs.map((p) => {
    const e = clone(template);
    e.number = p.number;
    e.state = p.state;
    e.head.ref = w.pr.headRef;
    e.url = e.url.replace(/\/pulls\/\d+$/, `/pulls/${p.number}`);
    return e;
  });
}

export function rawRulesFor(types: string[]): any {
  return types.map((type, i) => ({
    type,
    ruleset_source_type: "Repository",
    ruleset_source: "SaiSamyukthVemuri/Hone",
    ruleset_id: 9000 + i,
  }));
}

export function rawActivityFor(type: string, events: ActivityEvent[]): any {
  const template = REAL.verify("activity-pr-merge-week.json")[0];
  return events.map((e, i) => {
    const a = clone(template);
    a.id = 50_000_000_000 + i;
    a.node_id = `PSH_verify_${type}_${i}`;
    a.before = e.before;
    a.after = e.after;
    a.ref = PROD_REF_FULL;
    a.timestamp = e.timestamp;
    a.activity_type = type;
    return a;
  });
}

export function rawRunsFor(w: World): any {
  const prTemplate = REAL.verify("runs-810-pull-request.json").workflow_runs[0];
  const pushTemplate = REAL.verify("runs-6cdd830b-push.json").workflow_runs[0];
  const workflow_runs = w.runs.map((r) => {
    const t = clone(r.template === "push" ? pushTemplate : prTemplate);
    t.id = r.id;
    t.run_number = r.runNumber;
    t.workflow_id = r.workflowId;
    t.event = r.event;
    t.head_sha = r.headSha;
    t.head_branch = r.headBranch;
    t.head_repository = r.headRepoId === null ? null : { ...t.head_repository, id: r.headRepoId };
    t.status = r.status;
    t.conclusion = r.conclusion;
    t.run_attempt = r.runAttempt;
    t.created_at = r.createdAt;
    // `pull_requests` keeps the real template's entry (#810 for PR runs): GitHub lists
    // open PRs whose head matches, not the triggering PR. Binding must never read it.
    return t;
  });
  return { total_count: w.runsTotalCount ?? workflow_runs.length, workflow_runs };
}

export function rawJobsFor(runId: number, spec: JobsSpec): any {
  const real = REAL.verify("jobs-810-run-latest.json").jobs;
  const byName = new Map<string, any>(real.map((j: any) => [j.name, j]));
  if (!Array.isArray(spec)) {
    const jobs = Array.from({ length: 100 }, (_, i) => ({ ...clone(real[0]), id: 120_000_000_000 + i, run_id: runId }));
    return { total_count: 101, jobs };
  }
  const jobs = spec.map((j, i) => {
    const t = clone(byName.get(j.name) ?? real[0]);
    t.id = 110_000_000_000 + i;
    t.run_id = runId;
    t.name = j.name;
    t.status = j.status;
    t.conclusion = j.conclusion;
    return t;
  });
  return { total_count: jobs.length, jobs };
}

export const hoursAfter = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString().replace(".000Z", "Z");
export const secondsAfter = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString().replace(".000Z", "Z");
export const daysBefore = (iso: string, d: number) => new Date(Date.parse(iso) - d * 86_400_000).toISOString().replace(".000Z", "Z");
export const sha40 = (n: number) => hexFrom(n);
