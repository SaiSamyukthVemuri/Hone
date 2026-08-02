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
      "browser-e2e",
      "payment-browser-e2e",
      "mobile-completion-e2e",
      "google-browser-e2e",
    ]) {
      expect(jobs, `${job} must still exist`).toContain(job);
    }
    // Six gated lanes, each declaring `needs: changes` and an `if:`.
    expect((CI.match(/^ {4}needs: changes$/gm) ?? []).length).toBe(6);
    expect((CI.match(/^ {4}if: \$\{\{ needs\.changes\.outputs\./gm) ?? []).length).toBe(6);
  });

  it("docs-only skips the build/unit lane", () => {
    expect(CI).toMatch(/if: \$\{\{ needs\.changes\.outputs\.docs_only != 'true' \}\}/);
  });

  it("full_matrix_required can still force every lane", () => {
    const forced = CI.match(/needs\.changes\.outputs\.full_matrix_required == 'true'/g) ?? [];
    expect(forced.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps concurrency cancellation for superseded PR runs", () => {
    expect(CI).toMatch(/concurrency:/);
    expect(CI).toMatch(/cancel-in-progress: true/);
  });

  it("every job declares an explicit timeout", () => {
    const jobCount = jobNames(CI).length;
    const timeouts = (CI.match(/^ {4}timeout-minutes:/gm) ?? []).length;
    expect(timeouts).toBe(jobCount);
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
