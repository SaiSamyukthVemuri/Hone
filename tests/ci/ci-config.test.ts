import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Workflow configuration + canonical migration-state guards. These replace the
// 18 hand-maintained migration-max pins that used to be scattered across
// tests/migrations, tests/docs and tests/scripts.

const CI = readFileSync(".github/workflows/ci.yml", "utf8");
const NIGHTLY = readFileSync(".github/workflows/nightly.yml", "utf8");

const WORKFLOW_DIR = ".github/workflows";

/** A workflow as the supply-chain guards see it: its file name, and its text. */
type Workflow = readonly [name: string, body: string];

/**
 * The workflow universe, ENUMERATED from the directory rather than named here.
 *
 * A hand-written list is the wrong shape for a repo-wide supply-chain guard.
 * With `[ci.yml, nightly.yml]` written into this file, a future
 * `.github/workflows/security.yaml` carrying a floating `actions/checkout@v4`,
 * `persist-credentials: true` and a write scope would simply never be loaded —
 * and every guard below would report GREEN while the exact thing they exist to
 * prevent sat in the repository. Enrolling a workflow must not depend on
 * somebody remembering to edit a test.
 *
 * Membership is by EXTENSION ONLY — `.yml` / `.yaml`, which is what GitHub
 * Actions itself reads — so a new workflow is enrolled by existing. Sorted, so
 * failures report in a stable order.
 *
 * `statSync` rather than `Dirent.isFile()`: it resolves symlinks, so a
 * symlinked workflow is enrolled instead of skipped. For a guard, inclusive is
 * the safe direction.
 */
function readWorkflowDir(dir: string = WORKFLOW_DIR): Workflow[] {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name): Workflow => [name, readFileSync(path.join(dir, name), "utf8")]);
}

/** Minimal structural check — job keys are two-space indented under `jobs:`. */
function jobNames(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  if (start === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && l.trim()) break;
    const m = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Parse the browser shard's conditional `timeout-minutes` into its two
 * branches. Parsing beats matching a literal expression: the guard then
 * survives whitespace and formatting changes, and states the two budgets as
 * NUMBERS rather than as one brittle regex.
 *
 *   timeout-minutes: ${{ ... browser_extended == 'true' && <extended> || <targeted> }}
 */
function shardTimeoutBudgets(): { extended: number; targeted: number } {
  const m =
    /timeout-minutes:\s*\$\{\{\s*needs\.changes\.outputs\.browser_extended\s*==\s*'true'\s*&&\s*(\d+)\s*\|\|\s*(\d+)\s*\}\}/.exec(
      CI,
    );
  if (!m) throw new Error("browser shard timeout-minutes expression not found in ci.yml");
  return { extended: Number(m[1]), targeted: Number(m[2]) };
}

describe("PR CI — path-aware lane selection", () => {
  const jobs = jobNames(CI);

  it("has a changed-path detection job that runs first", () => {
    expect(jobs).toContain("changes");
    expect(CI).toMatch(/id: classify/);
    expect(CI).toMatch(/scripts\/classify-changes\.mjs/);
  });

  it("diffs against the PR merge base, not merely the previous commit", () => {
    expect(CI).toMatch(/pull_request\.base\.sha/);
    expect(CI).toMatch(/git merge-base/);
    expect(CI).toMatch(/fetch-depth: 0/);
  });

  it("emits every documented boolean output", () => {
    for (const k of [
      "docs_only",
      "application",
      "database",
      "security",
      "payment",
      "google_calendar",
      "browser_core",
      "mobile",
      "ci_workflows",
      "full_matrix_required",
    ]) {
      expect(CI, `${k} must be a job output`).toMatch(
        new RegExp(`${k}: \\$\\{\\{ steps\\.classify\\.outputs\\.${k} \\}\\}`),
      );
    }
  });

  it("preserves the existing required-check names", () => {
    for (const name of [
      "typecheck / lint / build / test / safety gates",
      "db integration (local supabase)",
      "browser e2e (local stack)",
      "payment browser e2e (fake stripe)",
      "mobile completion e2e (chromium iphone-profile)",
      "google browser e2e (fake google)",
    ]) {
      expect(CI, `required check "${name}" must still exist`).toContain(name);
    }
  });

  it("every expensive lane is gated on the classifier", () => {
    for (const job of [
      "validate",
      "db-integration",
      "browser-e2e-shard",
      "browser-e2e",
      "payment-browser-e2e",
      "mobile-completion-e2e",
      "google-browser-e2e",
    ]) {
      expect(jobs, `${job} must still exist`).toContain(job);
    }
    // Six gated lanes declare `needs: changes` + an `if:` on classifier output.
    expect((CI.match(/^ {4}needs: changes$/gm) ?? []).length).toBe(6);
    expect((CI.match(/^ {4}if: \$\{\{ needs\.changes\.outputs\./gm) ?? []).length).toBe(6);
  });

  it("the required browser check is a STABLE aggregator, not a dynamic shard name", () => {
    // Branch protection must never depend on "browser shard 1 (extended)".
    expect(CI).toMatch(/ {2}browser-e2e:\n {4}name: browser e2e \(local stack\)/);
    expect(CI).toMatch(/needs: \[changes, browser-e2e-shard\]/);
    expect(CI).toMatch(/if: always\(\)/);
  });

  it("the aggregator fails on a failed or cancelled shard and passes on a legitimate skip", () => {
    expect(CI).toMatch(/needs\.browser-e2e-shard\.result/);
    expect(CI).toMatch(/skipped\)/);
    expect(CI).toMatch(/browser_run.*= "true".*exit 1|exit 1/s);
    expect(CI).toMatch(/browser shard\(s\) passed/);
  });

  it("extended coverage creates exactly FOUR shards", () => {
    // Run 30767725631 cancelled both 2-shard jobs at the 10-minute hard
    // timeout with ZERO test failures (shard 2 reached 72/90). Four shards
    // halve the per-shard load to ~45 tests.
    expect(CI).toMatch(/browser_shards=\$\{r\.extended \? "\[1,2,3,4\]" : "\[1\]"\}/);
    expect(CI).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/4/);
    expect(CI).toMatch(/fromJson\(needs\.changes\.outputs\.browser_shards\)/);
  });

  it("targeted coverage remains a SINGLE browser job", () => {
    expect(CI).toMatch(/: "\[1\]"/);
  });

  it("the aggregator requires all four extended shards", () => {
    expect(CI).toMatch(/EXPECTED=\$\(node -e/);
    expect(CI).toMatch(/must run exactly 4 shards/);
  });

  it("a CANCELLED shard fails the aggregator", () => {
    expect(CI).toMatch(/cancelled\)/);
    expect(CI).toMatch(/were CANCELLED[\s\S]{0,80}treated as failure/);
    // The cancelled branch must exit non-zero.
    const seg = CI.slice(CI.indexOf("cancelled)"), CI.indexOf("cancelled)") + 400);
    expect(seg).toMatch(/exit 1/);
  });

  it("a MISSING shard result fails the aggregator when coverage was required", () => {
    expect(CI).toMatch(/shard result is MISSING while browser coverage was required/);
    expect(CI).toMatch(/if \[ -z "\$\{SHARD_RESULT:-\}" \]/);
  });

  it("the shard hard timeouts EXCEED their performance targets", () => {
    // A hard timeout is a FAILURE CEILING, not a target. A job whose ceiling
    // equals its target gets cancelled for being merely slow — how run
    // 30767725631 (extended) and later run 30814919019 (targeted) were both
    // misreported as test failures.
    const b = shardTimeoutBudgets();
    expect(b.targeted, "targeted hard timeout").toBe(15);
    expect(b.extended, "extended hard timeout").toBe(18);
    expect(CI).toMatch(/hard timeout 15 min/i);
    expect(CI).toMatch(/hard timeout 18 min/i);
    expect(CI).toMatch(/target <10 min per shard/i);
    expect(CI).toMatch(/FAILURE CEILING, not a performance target/i);
  });

  it("the ceiling clears SETUP plus tests, not just tests", () => {
    // The reason 12 was not survivable had nothing to do with test health, and
    // it is not a fixed cost either - the job STRADDLED the ceiling. The same
    // 81 tests took 508s before the first test on one runner and 266s on
    // another; per-test speed barely moved (3.8s vs 3.6s). So the lane passed
    // or was cancelled depending on which runner it drew.
    //
    // Both halves have to stay in the file: a ceiling justified only by test
    // duration will keep cancelling healthy shards, and one justified by a
    // single observation invites shaving it back to just above that number.
    expect(CI).toMatch(/before the first test executes/i);
    expect(CI).toMatch(/508s/);
    expect(CI).toMatch(/266s/);
    expect(CI).toMatch(/straddled the ceiling/i);
  });

  it("records the evidence for the extended-ceiling correction", () => {
    // Run 31852791688 cancelled shard 3 at 12m15s having run 60 of its 81
    // assigned tests with every one of them passing. The same shard passed in
    // 9m11s on the prior head with 60 tests assigned: the extended suite grew
    // and Playwright redistributed, handing that shard +35% work.
    expect(CI).toMatch(/31852791688/);
    expect(CI).toMatch(/60 of 81/);
    expect(CI).toMatch(/ALL 60 passed/);
    expect(CI).toMatch(/9m11s/);
  });

  it("records the evidence for the targeted-ceiling correction", () => {
    // Run 30814919019 hit the old 10-minute targeted ceiling TWICE on one
    // unchanged head, both times with zero recorded test failures.
    expect(CI).toMatch(/30814919019/);
    expect(CI).toMatch(/101\/105/);
    expect(CI).toMatch(/95\/105/);
    expect(CI).toMatch(/ZERO recorded test failures/i);
  });

  it("shard traces are uploaded independently", () => {
    expect(CI).toMatch(/playwright-traces-shard-\$\{\{ matrix\.shard \}\}/);
  });

  it("EVERY browser-driving job caches Playwright browsers", () => {
    // The previous head claimed caching but wired it only into nightly.yml, so
    // all four PR browser jobs re-downloaded Chromium + FFmpeg + headless shell
    // on every run.
    const caches = CI.match(/path: ~\/\.cache\/ms-playwright/g) ?? [];
    expect(caches.length, "all four browser jobs must cache").toBe(4);
    // CI-HARDEN-01B pinned every action to a commit SHA, so this counts the
    // ACTION rather than a version tag. The claim under test is "every browser
    // job caches", which a ref should never have been able to falsify.
    expect((CI.match(/uses: actions\/cache@/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("the cache key is bound to runner OS and the exact Playwright version", () => {
    expect(CI).toMatch(
      /key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ steps\.pw\.outputs\.version \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/,
    );
    expect(CI).toMatch(/require\('@playwright\/test\/package\.json'\)\.version/);
  });

  it("a cache HIT skips the browser download and installs only system deps", () => {
    expect((CI.match(/if: steps\.pw-cache\.outputs\.cache-hit != 'true'/g) ?? []).length).toBe(4);
    expect((CI.match(/if: steps\.pw-cache\.outputs\.cache-hit == 'true'/g) ?? []).length).toBe(4);
    expect((CI.match(/playwright install-deps chromium/g) ?? []).length).toBe(4);
  });

  it("no browser download runs unconditionally", () => {
    const lines = CI.split("\n");
    const unguarded: number[] = [];
    lines.forEach((l, i) => {
      if (l.includes("playwright install --with-deps chromium")) {
        const ctx = lines.slice(Math.max(0, i - 4), i).join("\n");
        if (!ctx.includes("cache-hit != 'true'")) unguarded.push(i + 1);
      }
    });
    expect(unguarded, "every browser download must be behind a cache-miss guard").toEqual([]);
  });

  it("emits timing diagnostics including a timeout hint", () => {
    expect(CI).toMatch(/Timing diagnostics/);
    expect(CI).toMatch(/test duration \(s\)/);
    expect(CI).toMatch(/exceeded its timeout budget/);
  });

  it("docs-only skips the build/unit lane", () => {
    expect(CI).toMatch(/if: \$\{\{ needs\.changes\.outputs\.docs_only != 'true' \}\}/);
  });

  it("full_matrix_required can still force every lane", () => {
    const forced = CI.match(/needs\.changes\.outputs\.full_matrix_required == 'true'/g) ?? [];
    expect(forced.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps PR-scoped concurrency cancellation for superseded runs", () => {
    expect(CI).toMatch(
      /group: hone-pr-ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
    );
    expect(CI).toMatch(/cancel-in-progress: true/);
  });

  it("honours the documented latency budgets", () => {
    const budget = (job: string): number => {
      const m = new RegExp(`  ${job}:\\n(?:.*\\n)*?    timeout-minutes: (\\d+)`).exec(CI);
      return m ? Number(m[1]) : -1;
    };
    expect(budget("changes")).toBeLessThanOrEqual(2);
    expect(budget("validate")).toBeLessThanOrEqual(8);
    expect(budget("db-integration")).toBeLessThanOrEqual(8);
    // payment-browser-e2e: TARGET ~10 min, HARD TIMEOUT 18. It carried a single
    // 10 that served as both, which is precisely the shape the comment below
    // warns about. F-PAY-002 measured the lane at 9.6-10.4 min locally across
    // repeated runs of 57 serial specs — i.e. the ceiling and the observed run
    // time were the same number, with nothing left for a slow runner.
    //
    // The lower bound is 14, not 11, for the same reason the extended shards
    // clear their target by ~8: setup is not a fixed cost, and the measured
    // runner spread before the first test executes is ~4 minutes (266s vs 508s
    // for the same work). A ceiling of 12 would sit inside that spread and the
    // lane would pass or be cancelled according to which runner it drew.
    expect(budget("payment-browser-e2e")).toBeGreaterThan(14);
    expect(budget("payment-browser-e2e")).toBeLessThanOrEqual(18);
    expect(budget("google-browser-e2e")).toBeLessThanOrEqual(10);
    expect(budget("mobile-completion-e2e")).toBeLessThanOrEqual(10);
    // Targeted hard timeout 15, extended shard hard timeout 18 — both above
    // their <10 min targets. Parsed, not line-matched, so reformatting the
    // workflow cannot silently break this guard.
    //
    // The extended ceiling exceeds the targeted one because setup is NOT a
    // fixed cost. Everything before the first test - Supabase stack, full
    // migration chain from scratch, Playwright, and the `next build` inside
    // Playwright's webServer - was measured at 266s on one runner and 508s on
    // another for the SAME 81 tests, while per-test execution barely moved
    // (3.6s vs 3.8s). A ceiling has to clear that observed runner spread PLUS
    // test execution, or the lane passes or is cancelled according to which
    // runner it drew rather than according to test health.
    //
    // The upper bounds here are a brake on ceilings drifting upward instead of
    // slow lanes being investigated, so they stay tight enough to notice: a
    // shard that needs more than 18 minutes is a problem to fix, not a number
    // to raise again.
    const b = shardTimeoutBudgets();
    expect(b.targeted).toBeGreaterThan(10);
    expect(b.extended).toBeGreaterThan(10);
    expect(b.targeted).toBeLessThanOrEqual(15);
    expect(b.extended).toBeLessThanOrEqual(18);
  });

  it("every job declares an explicit timeout", () => {
    const jobCount = jobNames(CI).length;
    const timeouts = (CI.match(/^ {4}timeout-minutes:/gm) ?? []).length;
    expect(timeouts).toBe(jobCount);
  });

  it("exposes the browser selection as job outputs", () => {
    for (const k of ["browser_run", "browser_extended", "browser_specs", "browser_shards", "browser_reason"]) {
      expect(CI, `${k} must be a job output`).toMatch(new RegExp(`${k}: \\$\\{\\{ steps\\.browser\\.outputs\\.${k} \\}\\}`));
    }
  });
});

describe("nightly / manual full matrix", () => {
  it("runs on a schedule and on demand", () => {
    expect(NIGHTLY).toMatch(/schedule:/);
    expect(NIGHTLY).toMatch(/cron: "0 7 \* \* \*"/);
    expect(NIGHTLY).toMatch(/workflow_dispatch:/);
  });

  it("covers every lane PR CI may skip", () => {
    for (const lane of [
      "typecheck / lint / build / unit / safety gates",
      "full migration chain + db/rls integration",
      "core browser e2e",
      "payment e2e (fake stripe)",
      "mobile completion e2e",
      "google e2e (fake google)",
    ]) {
      expect(NIGHTLY, `nightly must cover: ${lane}`).toContain(lane);
    }
  });

  it("does not fail fast — one broken lane must not hide the others", () => {
    expect(NIGHTLY).toMatch(/fail-fast: false/);
  });

  it("cancels superseded nightly runs", () => {
    expect(NIGHTLY).toMatch(/cancel-in-progress: true/);
  });

  it("only starts Supabase and browsers for lanes that need them", () => {
    expect(NIGHTLY).toMatch(/if: matrix\.needs_supabase/);
    expect(NIGHTLY).toMatch(/if: matrix\.needs_browsers/);
    expect(NIGHTLY).toMatch(/needs_supabase: false/);
  });

  it("caches Playwright browsers and uploads traces only on failure", () => {
    expect(NIGHTLY).toMatch(/Cache Playwright browsers/);
    expect(NIGHTLY).toMatch(/if: failure\(\) && matrix\.needs_browsers/);
  });

  it("pins the Supabase CLI to the grants-parity version", () => {
    expect(NIGHTLY).toMatch(/version: 2\.102\.0/);
  });
});

describe("canonical migration state", () => {
  const state = JSON.parse(
    execFileSync("node", ["scripts/migration-state.mjs", "--json"], { encoding: "utf8" }),
  );

  it("derives the repository max from filenames", () => {
    expect(state.repo_migration_max).toMatch(/^\d{4}$/);
    expect(state.repo_migration_max_number).toBe(Number(state.repo_migration_max));
  });

  it("derives the next free number, skipping permanently-skipped slots", () => {
    expect(state.next_free_migration_number).toBe(state.repo_migration_max_number + 1);
    expect(state.permanently_skipped).toContain("0158");
    expect(state.versions).not.toContain("0158");
  });

  it("declares hosted state in exactly one canonical record", () => {
    expect(existsSync("docs/production/migration-state.json")).toBe(true);
    const rec = JSON.parse(readFileSync("docs/production/migration-state.json", "utf8"));
    expect(rec.hosted_migration_max).toMatch(/^\d{4}$/);
    expect(state.hosted_migration_max).toBe(rec.hosted_migration_max);
  });

  it("no test hard-codes a repository migration max any more", () => {
    // The pins this PR removed. If one comes back, it will drift again.
    const offenders = execFileSync(
      "bash",
      [
        "-lc",
        String.raw`grep -rlE 'expect\((nums\[nums\.length - 1\]|maxNum)\)\.toBe\(' tests/ 2>/dev/null | grep -v 'tests/ci/ci-config.test.ts' || true`,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(
      offenders,
      "import isRepoMax/versionsAbove from tests/migrations/helpers/migration-state instead",
    ).toEqual([]);
  });

  it("no test carries a hand-maintained 'trip on the next migration' regex", () => {
    const offenders = execFileSync(
      "bash",
      [
        "-lc",
        // Exclude this guard file itself — it necessarily contains the pattern
        // it forbids, and a self-match would make the check permanently red.
        String.raw`grep -rlE '\^01\(6\[[0-9]-9\]' tests/ 2>/dev/null | grep -v 'tests/ci/ci-config.test.ts' || true`,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(offenders).toEqual([]);
  });
});

describe("pre-push verification", () => {
  const SCRIPT = readFileSync("scripts/verify-prepush.mjs", "utf8");

  it("is wired as an npm script", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["verify:prepush"]).toBe("node scripts/verify-prepush.mjs");
  });

  it("checks every required condition", () => {
    expect(SCRIPT).toMatch(/status", "--porcelain/);
    expect(SCRIPT).toMatch(/diff", "HEAD"/);
    expect(SCRIPT).toMatch(/diff", "--check"/);
    expect(SCRIPT).toMatch(/conflict markers/i);
    expect(SCRIPT).toMatch(/NOT in the commit/);
  });

  it("installs no global Git hook", () => {
    expect(SCRIPT).not.toMatch(/core\.hooksPath|\.git\/hooks|husky/);
  });

  it("is documented in the contributor instructions", () => {
    const claude = readFileSync("CLAUDE.md", "utf8");
    expect(claude).toMatch(/verify:prepush/);
    expect(claude).toMatch(/git diff HEAD --exit-code/);
    expect(claude).toMatch(/git add -A/);
  });
});

// ---------------------------------------------------------------------------
// CI-HARDEN-01B — supply chain and least privilege
// ---------------------------------------------------------------------------
// Closes the pinning half of HNE-CI-001 (P2, docs/audits/2026-07-30/
// MASTER_FINDINGS_REGISTER.csv, recorded UNMAPPED_HISTORICAL /
// NOT_INDIVIDUALLY_RE_VERIFIED). That row is a frozen historical artifact and is
// referenced here, never rewritten: every source_* cell of the register is
// SHA-256 digest-pinned by tests/audits/findings-register-consistency.test.ts.
//
// Guards 1-4 were each verified to read FALSE against the pre-hardening
// workflows at base 32dfd329 before the workflows were touched, so none of them
// is a guard that passes no matter what. Guards 5-7 are invariants: they were
// green before this change and must stay green, which is the point of them.
//
// Every guard is a PURE FUNCTION of an injected workflow collection, and the
// collection is read from the directory (readWorkflowDir). Two things follow,
// and both are asserted below: a new workflow is enrolled merely by existing,
// and the discrimination controls can hand the same guards a synthetic third
// workflow without writing a hostile file into this repository.
describe("CI-HARDEN-01B — supply chain and least privilege", () => {
  /**
   * The universe under guard — READ FROM DISK, deliberately not listed here.
   * "the guarded universe IS the workflow directory" below is the tripwire
   * against anyone re-hardcoding it.
   */
  const WORKFLOWS: readonly Workflow[] = readWorkflowDir();

  /**
   * A workflow's own comments are not what it executes. The permissions block
   * added by this change explains itself by NAMING GITHUB_TOKEN, so a
   * whole-file match for that token reports the exact opposite of the truth —
   * which is what the first version of guard 5 caught, in its own rationale.
   */
  const steps = (body: string) =>
    body
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

  const actionRefs = (sources: readonly Workflow[]) =>
    sources.flatMap(([, body]) => body.match(/uses: \S+/g) ?? []);

  const checkoutCount = (sources: readonly Workflow[]) =>
    sources.reduce((n, [, body]) => n + (body.match(/uses: actions\/checkout@/g) ?? []).length, 0);

  // 1. A mutable ref means the code a job runs can change without a commit
  //    here. `supabase/setup-cli@v1` was the sharpest case: it resolves to a
  //    BRANCH (refs/heads/v1), not a tag — that repository's tags run
  //    v1.7.1 -> v2.0.0 -> v3 — so anyone with push access to it could alter
  //    what every database-touching job in this file executed.
  function unpinnedRefViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const [file, body] of sources) {
      for (const ref of body.match(/uses: \S+/g) ?? []) {
        if (!/^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(ref)) {
          bad.push(`${file}: ${ref} is not pinned to a 40-character SHA`);
        }
      }
    }
    return bad;
  }

  it("every action reference is pinned to a commit SHA", () => {
    // Anti-vacuity moved to the COLLECTION. Per file it would have forced every
    // future workflow to declare an action, which is not the contract: a
    // workflow of pure `run:` steps is compliant, and demanding otherwise is
    // how a guard gets weakened later.
    expect(actionRefs(WORKFLOWS).length, "no workflow declares an action at all").toBeGreaterThan(0);
    expect(unpinnedRefViolations(WORKFLOWS)).toEqual([]);
  });

  // 2. A bare 40-character SHA is unreadable. The trailing tag comment is how a
  //    reviewer knows WHICH version was vetted without leaving the diff.
  function missingAnnotationViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const [file, body] of sources) {
      for (const l of body.split("\n").filter((l) => /uses: \S+@[0-9a-f]{40}/.test(l))) {
        if (!/@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/.test(l)) {
          bad.push(`${file}: ${l.trim()} has no # vX.Y.Z comment`);
        }
      }
    }
    return bad;
  }

  it("every pinned ref carries a trailing version comment", () => {
    const pinned = actionRefs(WORKFLOWS).filter((r) => /@[0-9a-f]{40}/.test(r));
    expect(pinned.length, "no workflow declares a pinned action").toBeGreaterThan(0);
    expect(missingAnnotationViolations(WORKFLOWS)).toEqual([]);
  });

  // 3. Counted, not merely present. A `.includes()` check would pass with one
  //    opt-out among eight checkouts, which is the shape this guard exists to
  //    refuse. Safe precisely because no job needs the credential afterwards:
  //    every git call in these workflows is local to the history checkout
  //    already fetched, and guard 5 keeps that true.
  //
  //    NOT redundant with the action default: persist-credentials still
  //    defaults to TRUE in actions/checkout v7.0.1, verified in its action.yml
  //    at the exact SHA pinned here.
  //
  //    The property belongs to the CHECKOUT STEP, not to the workflow. This
  //    guard used to require every file to declare a checkout, which is the
  //    wrong contract for a directory universe — a future workflow that
  //    legitimately has none would have failed, and the pressure would then be
  //    to weaken the guard. A workflow with zero checkouts is vacuously
  //    compliant here; guard 7 pins the TOTAL, so a checkout cannot be quietly
  //    dropped to satisfy this one instead.
  function persistCredentialViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const [file, body] of sources) {
      const checkouts = (body.match(/uses: actions\/checkout@/g) ?? []).length;
      const optOuts = (body.match(/persist-credentials: false/g) ?? []).length;
      if (checkouts !== optOuts) {
        bad.push(`${file}: ${checkouts} checkouts but ${optOuts} persist-credentials: false opt-outs`);
      }
      // Stated as well as counted: an opt-IN is refused by name, so a workflow
      // that writes `persist-credentials: true` without a checkout — or beside
      // a balancing `false` elsewhere — cannot slip through on arithmetic.
      for (const l of steps(body).split("\n")) {
        if (/persist-credentials:\s*true\b/.test(l)) {
          bad.push(`${file}: declares ${l.trim()}`);
        }
      }
    }
    return bad;
  }

  it("every checkout refuses to persist the token", () => {
    expect(persistCredentialViolations(WORKFLOWS)).toEqual([]);
  });

  // 4. A workflow with no `permissions:` block inherits the REPOSITORY default,
  //    which is not necessarily read-only — so this is required per file, of
  //    every file, and a new workflow that simply omits the block is refused.
  function permissionViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const [file, body] of sources) {
      if (!/^permissions:\n  contents: read$/m.test(body)) {
        bad.push(`${file}: does not declare the least-privilege block \`permissions:\` / \`contents: read\``);
      }
      // Comment-stripped, for the reason guard 5 documents: a comment cannot
      // grant a scope, and prose about write access must not read as a grant.
      for (const l of steps(body).split("\n")) {
        if (/:\s*write\b/.test(l)) bad.push(`${file}: grants a write scope — ${l.trim()}`);
      }
    }
    return bad;
  }

  it("every workflow declares contents: read and grants nothing wider", () => {
    expect(permissionViolations(WORKFLOWS)).toEqual([]);
  });

  // 5. The credential opt-out and the read-only token are only safe while this
  //    stays true, so the claim is pinned rather than left as a comment: a
  //    future `git push`, `gh` write or secret read would have to confront this
  //    test. It is also what keeps Codex exact-head review OUT of CI —
  //    scripts/eng/* reads GitHub with the operator's credential and must stay
  //    operator-side.
  function writeCredentialViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const [file, body] of sources) {
      const code = steps(body);
      if (/GITHUB_TOKEN/.test(code)) bad.push(`${file}: uses GITHUB_TOKEN`);
      if (/secrets\.[A-Z_]/.test(code)) bad.push(`${file}: reads a secret`);
      if (/\bgit (push|tag)\b/.test(code)) bad.push(`${file}: pushes`);
      if (/\bgh (pr|release|issue|api)\b/.test(code)) bad.push(`${file}: calls a gh write`);
    }
    return bad;
  }

  it("no workflow writes to GitHub, which is what makes the opt-out safe", () => {
    expect(writeCredentialViolations(WORKFLOWS)).toEqual([]);
  });

  // 6. The Supabase CLI pin is a DB-SAFETY invariant, not a preference: a newer
  //    CLI's `db reset` strips Data-API grants and every authenticated query
  //    then fails at the privilege layer, which looks exactly like an
  //    application bug (CLAUDE.md §3). The action was pinned to a commit but
  //    deliberately NOT bumped past the v1 line — v3 is a composite action that
  //    installs the CLI from npm via Bun with different `version` semantics.
  //
  //    Stated as the APPROVED POSTURE, not as the absence of a forbidden
  //    string. The previous form of this guard asserted
  //    `not.toMatch(/supabase\/setup-cli@v[23]/)`, which guard 1 had already
  //    made unreachable: once every ref must be a 40-character SHA, the literal
  //    `@v2` / `@v3` can never appear in these files, so that limb could not
  //    fire for any diff. Replacing all six refs with a v3 commit and
  //    relabelling the comments `# v3.0.0` — while keeping `version: 2.102.0` —
  //    would have kept it green.
  //
  //    The SHA is the supply-chain authority; the annotation is the
  //    human-readable consistency check, believed only after the SHA agrees;
  //    the CLI version is the grants-parity invariant. All three are pinned,
  //    plus the number of uses, so a seventh unreviewed site is not silent.
  const SETUP_CLI_SHA = "ab058987d8d6c725971f6cf9d0b5c98467e30bd1";
  const SETUP_CLI_TAG = "v1.7.1";
  const SETUP_CLI_VERSION = "2.102.0";
  const SETUP_CLI_USES = 6; // 5 in ci.yml + 1 in nightly.yml

  type SetupCliUse = {
    where: string;
    sha: string;
    annotation: string | null;
    versions: string[];
  };

  /**
   * Every `supabase/setup-cli` step, read from its own `uses:` line to the end
   * of that step. Deliberately NOT filtered to the approved SHA — the point is
   * to see the unapproved ones.
   *
   * The `version:` input is read out of the step that declares it rather than
   * counted across the whole file: a file-wide count of `version: 2.102.0` is
   * satisfiable by an unrelated action's input, so it would stay green while a
   * setup-cli step ran a different CLI.
   */
  function setupCliUses(file: string, body: string): SetupCliUse[] {
    const lines = body.split("\n");
    const out: SetupCliUse[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^[\s-]*uses:\s*supabase\/setup-cli@(\S+)(?:\s*#\s*(\S+))?\s*$/.exec(lines[i]);
      if (!m) continue;
      // The COLUMN of `uses:` is the step's body indent in both YAML shapes:
      // `- uses:` as the step's first key, and `uses:` under a `- name:`.
      const indent = lines[i].indexOf("uses:");
      const versions: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === "") continue;
        if (line.length - line.trimStart().length < indent) break; // next step
        if (/^\s*#/.test(line)) continue; // a comment is not an input
        const v = /^\s*version:\s*(\S+)\s*$/.exec(line);
        if (v) versions.push(v[1]);
      }
      out.push({ where: `${file}:${i + 1}`, sha: m[1], annotation: m[2] ?? null, versions });
    }
    return out;
  }

  /** Every way the observed posture departs from the approved one. */
  function setupCliViolations(sources: readonly (readonly [string, string])[]): string[] {
    const uses = sources.flatMap(([file, body]) => setupCliUses(file, body));
    const bad: string[] = [];
    if (uses.length !== SETUP_CLI_USES) {
      bad.push(`${uses.length} setup-cli uses, expected ${SETUP_CLI_USES}`);
    }
    for (const u of uses) {
      if (u.sha !== SETUP_CLI_SHA) {
        bad.push(`${u.where}: ref ${u.sha} is not the vetted ${SETUP_CLI_TAG} commit`);
      }
      if (u.annotation !== SETUP_CLI_TAG) {
        bad.push(
          `${u.where}: annotation "${u.annotation ?? "(none)"}" does not report ${SETUP_CLI_TAG}`,
        );
      }
      if (u.versions.length !== 1) {
        bad.push(`${u.where}: ${u.versions.length} version inputs, expected exactly one`);
      }
      for (const v of u.versions) {
        if (v !== SETUP_CLI_VERSION) {
          bad.push(`${u.where}: CLI version ${v} is not the grants-parity pin ${SETUP_CLI_VERSION}`);
        }
      }
    }
    return bad;
  }

  it("every supabase/setup-cli use is the vetted v1.7.1 commit on the grants-parity CLI", () => {
    expect(setupCliViolations(WORKFLOWS)).toEqual([]);
  });

  // A guard that cannot fail is not a guard — which is exactly what the removed
  // `@v[23]` limb was. These three drive the substitutions the pin exists to
  // refuse THROUGH THE REAL WORKFLOW TEXT and require each to be reported, so
  // the check is proved reachable rather than assumed to be. No network is
  // involved: the vetted SHA is a constant here and the test is string equality
  // against it.
  //
  // Each control asserts the substitution actually landed before judging the
  // result, so a stale `from` string cannot turn a control into a no-op that
  // "passes" against unmutated text.
  const withMutatedCi = (from: string, to: string): Workflow[] => {
    // Replaces the FIRST occurrence only: one of the six uses departs, which is
    // the realistic shape of the change and proves the guard is per-site. The
    // mutation is applied to the ENUMERATED universe, so these controls and the
    // guard they exercise read the same collection.
    const out = WORKFLOWS.map(([name, body]): Workflow =>
      name === "ci.yml" ? [name, body.replace(from, to)] : [name, body],
    );
    expect(
      out.map(([, body]) => body).join("\n"),
      `negative control needs "${from}" in ci.yml`,
    ).not.toEqual(WORKFLOWS.map(([, body]) => body).join("\n"));
    return out;
  };

  // A synthetic 40-hex value, NOT a published supabase/setup-cli commit. That
  // makes the control stronger than "a v3 commit is refused": the posture is
  // equality with the vetted v1.7.1 commit, so a v3 commit, a re-tagged v1 and
  // an attacker's commit are all refused by the same assertion — and the test
  // carries no unverifiable claim about which SHA v3 actually is.
  const UNAPPROVED_SHA = "0123456789abcdef0123456789abcdef01234567";

  it("RED: a setup-cli ref moved off the vetted commit is refused", () => {
    const violations = setupCliViolations(
      withMutatedCi(`setup-cli@${SETUP_CLI_SHA}`, `setup-cli@${UNAPPROVED_SHA}`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/is not the vetted v1\.7\.1 commit/);
  });

  it("RED: a setup-cli annotation claiming another major is refused", () => {
    const violations = setupCliViolations(
      withMutatedCi(`${SETUP_CLI_SHA} # ${SETUP_CLI_TAG}`, `${SETUP_CLI_SHA} # v3.0.0`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/annotation "v3\.0\.0" does not report v1\.7\.1/);
  });

  it("RED: a setup-cli step on another CLI version is refused", () => {
    const violations = setupCliViolations(
      withMutatedCi(`version: ${SETUP_CLI_VERSION}`, "version: 2.103.0"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/CLI version 2\.103\.0 is not the grants-parity pin/);
  });

  // 7. The browser-e2e aggregator has NO checkout — it is shell arithmetic over
  //    needs.*.result and is covered by the top-level permissions block alone.
  //    Counting the checkouts stops guard 3 from silently assuming nine, and is
  //    what lets guard 3 treat a checkout-free workflow as compliant: a
  //    checkout cannot be DELETED to dodge the opt-out without moving this
  //    number. Counted over the whole directory, so a checkout added by a new
  //    workflow lands here too.
  it("the checkout count across the workflow directory is the reviewed one", () => {
    expect(
      checkoutCount(WORKFLOWS),
      "7 in ci.yml (the aggregator has none) + 1 in nightly.yml",
    ).toBe(8);
  });

  // -------------------------------------------------------------------------
  // The directory-universe contract
  // -------------------------------------------------------------------------
  // The guards above are repo-wide only if the COLLECTION is. These controls
  // prove the enumeration itself — that a workflow becomes subject to every
  // guard merely by existing under .github/workflows, with no edit to this
  // file — because a guard whose universe is hand-written reports on the
  // workflows somebody remembered, not on the ones the repository runs.
  //
  // No hostile workflow is written into .github/workflows to prove this. The
  // synthetic workflows live in memory, or in a temporary directory handed to
  // the real enumerator.

  /** Every CI-HARDEN supply-chain / least-privilege violation, in one call. */
  function supplyChainViolations(sources: readonly Workflow[]): string[] {
    return [
      ...unpinnedRefViolations(sources),
      ...missingAnnotationViolations(sources),
      ...persistCredentialViolations(sources),
      ...permissionViolations(sources),
      ...writeCredentialViolations(sources),
      ...setupCliViolations(sources),
    ];
  }

  /**
   * A COMPLIANT future workflow. Each control below varies exactly one property
   * of it, so a RED is attributable to that property and not to the scaffold —
   * which "the compliant baseline is GREEN" is here to establish first.
   */
  const COMPLIANT = [
    "name: Future",
    "on: push",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  scan:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
  ];

  const synthetic = (name: string, lines: string[]): Workflow => [name, lines.join("\n") + "\n"];

  /** Vary one line of the baseline, asserting the substitution actually landed. */
  const variant = (name: string, from: string, to: string): Workflow => {
    const lines = COMPLIANT.map((l) => l.replace(from, to));
    expect(lines, `control needs "${from}" in the compliant baseline`).not.toEqual(COMPLIANT);
    return synthetic(name, lines);
  };

  it("control 4: the real workflow directory alone is GREEN", () => {
    expect(supplyChainViolations(WORKFLOWS)).toEqual([]);
  });

  it("the compliant baseline is GREEN, so each RED below is attributable", () => {
    expect(supplyChainViolations([...WORKFLOWS, synthetic("future.yaml", COMPLIANT)])).toEqual([]);
  });

  it("control 1 RED: a future security.yaml with a floating actions/checkout@v4", () => {
    const hostile = variant(
      "security.yaml",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "actions/checkout@v4",
    );
    expect(supplyChainViolations([...WORKFLOWS, hostile])).toContain(
      "security.yaml: uses: actions/checkout@v4 is not pinned to a 40-character SHA",
    );
  });

  it("control 2 RED: a future .yaml file with persist-credentials: true", () => {
    const hostile = variant("future.yaml", "persist-credentials: false", "persist-credentials: true");
    expect(supplyChainViolations([...WORKFLOWS, hostile])).toContain(
      "future.yaml: declares persist-credentials: true",
    );
  });

  it("control 3 RED: a future workflow granting contents: write", () => {
    const hostile = variant("wide.yml", "  contents: read", "  contents: write");
    const violations = supplyChainViolations([...WORKFLOWS, hostile]);
    expect(violations).toContain("wide.yml: grants a write scope — contents: write");
    expect(violations.join("\n")).toMatch(/wide\.yml: does not declare the least-privilege block/);
  });

  it("controls 5 and 6: the enumeration takes every .yml and .yaml, and nothing else", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-workflow-universe-"));
    try {
      writeFileSync(path.join(dir, "b.yml"), "name: B\n", "utf8");
      writeFileSync(path.join(dir, "a.yaml"), "name: A\n", "utf8");
      writeFileSync(path.join(dir, "README.md"), "# not a workflow\n", "utf8");
      writeFileSync(path.join(dir, "notes.txt"), "not a workflow\n", "utf8");
      writeFileSync(path.join(dir, "ci.yml.bak"), "name: stale\n", "utf8");
      mkdirSync(path.join(dir, "nested.yml")); // a DIRECTORY named like a workflow
      const found = readWorkflowDir(dir);
      // Both extensions, sorted, and the file BODIES — so this proves the
      // enumerator reads the workflow, not merely that it lists a name.
      expect(found).toEqual([
        ["a.yaml", "name: A\n"],
        ["b.yml", "name: B\n"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The one that matters most: the path from "a file exists in the directory"
  // to "every guard judges it", driven end to end through the REAL enumerator.
  // Nothing in this file names security.yaml as a member of the universe — it
  // is enrolled by existing, which is the whole contract.
  it("a workflow is enrolled in every guard merely by existing in the directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-workflow-enrol-"));
    try {
      for (const [name, body] of WORKFLOWS) writeFileSync(path.join(dir, name), body, "utf8");
      expect(supplyChainViolations(readWorkflowDir(dir)), "the copy must start GREEN").toEqual([]);

      writeFileSync(
        path.join(dir, "security.yaml"),
        [
          "name: Security",
          "on: push",
          "permissions:",
          "  contents: write",
          "jobs:",
          "  scan:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "        with:",
          "          persist-credentials: true",
          "      - run: git push origin HEAD",
        ].join("\n") + "\n",
        "utf8",
      );

      const enrolled = readWorkflowDir(dir);
      expect(enrolled.map(([name]) => name)).toContain("security.yaml");

      const violations = supplyChainViolations(enrolled);
      const reported = violations.filter((v) => v.startsWith("security.yaml:"));
      // Not merely "something failed": each guard must name the new file.
      expect(reported.join("\n")).toMatch(/is not pinned to a 40-character SHA/);
      expect(reported.join("\n")).toMatch(/persist-credentials: true/);
      expect(reported.join("\n")).toMatch(/grants a write scope/);
      expect(reported.join("\n")).toMatch(/does not declare the least-privilege block/);
      expect(reported.join("\n")).toMatch(/pushes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Tripwire against a future re-hardcoding: if somebody replaces the
  // enumeration with a list again, WORKFLOWS stops matching the directory.
  // ci.yml and nightly.yml are asserted PRESENT, not asserted to be the whole
  // universe — presence is a fact about today, membership is the directory's.
  it("the guarded universe IS the workflow directory, not a list in this file", () => {
    const onDisk = readdirSync(WORKFLOW_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
    expect(onDisk.length, "the workflow directory is empty").toBeGreaterThan(0);
    expect(WORKFLOWS.map(([name]) => name)).toEqual(onDisk);
    expect(onDisk).toEqual(expect.arrayContaining(["ci.yml", "nightly.yml"]));
  });
});
