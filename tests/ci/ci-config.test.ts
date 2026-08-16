import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Workflow configuration + canonical migration-state guards. These replace the
// 18 hand-maintained migration-max pins that used to be scattered across
// tests/migrations, tests/docs and tests/scripts.

const CI = readFileSync(".github/workflows/ci.yml", "utf8");
const NIGHTLY = readFileSync(".github/workflows/nightly.yml", "utf8");

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
    expect((CI.match(/uses: actions\/cache@v4/g) ?? []).length).toBeGreaterThanOrEqual(4);
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
