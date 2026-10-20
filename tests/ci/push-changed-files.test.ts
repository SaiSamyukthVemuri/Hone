import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The PUSH branch of ci.yml's "Collect changed files" step must list what a
// production MERGE shipped, not the merge's combined diff.
//
// `git show --name-only <merge>` prints a COMBINED diff: only files whose
// merged content differs from BOTH parents. A production merge that shipped
// route handlers but also shared one doc with production therefore listed ONE
// doc, classified docs-only, and skipped validate, db, the browser shards and
// the canonical lane while the run said success (6acea261 #912, 62ff27b2 #891).
//
// This runs the REAL step body from ci.yml against a REAL merge commit of that
// exact shape, then the REAL classifier on its output.

const ROOT = path.resolve(__dirname, "../..");
const CI_YML = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The literal shell body of a named step (same extraction as browser-shard-coverage). */
function stepScript(name: string): string {
  const start = CI_YML.indexOf(`- name: ${name}`);
  expect(start, `step "${name}" not found in ci.yml`).toBeGreaterThan(-1);
  const body = CI_YML.slice(start);
  const after = body.slice(body.indexOf("run: |") + "run: |".length);
  const kept: string[] = [];
  for (const line of after.split("\n").slice(1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    kept.push(line.startsWith(" ".repeat(10)) ? line.slice(10) : line);
  }
  return kept.join("\n");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

function write(dir: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

/**
 * production: base, then a docs edit (another PR that landed first).
 * PR: edits the SAME doc (a different line) AND ships an app route.
 * Merge commit M = production tip + PR, first parent = the production tip.
 */
function repoWithMerge() {
  const dir = mkdtempSync(path.join(tmpdir(), "hone-push-diff-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "prod");
  write(dir, "docs/03_SECURITY_AND_PRIVACY.md", "line 1\nline 2\nline 3\nline 4\nline 5\n");
  write(dir, "app/ingest/route.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "pr");
  write(dir, "app/ingest/route.ts", "export const a = 2;\n");
  write(dir, "docs/03_SECURITY_AND_PRIVACY.md", "line 1 PR\nline 2\nline 3\nline 4\nline 5\n");
  git(dir, "commit", "-q", "-am", "pr: route + doc");
  git(dir, "checkout", "-q", "prod");
  write(dir, "docs/03_SECURITY_AND_PRIVACY.md", "line 1\nline 2\nline 3\nline 4\nline 5 PROD\n");
  git(dir, "commit", "-q", "-am", "prod: doc");
  const before = git(dir, "rev-parse", "HEAD");
  git(dir, "merge", "-q", "--no-ff", "pr", "-m", "Merge pull request #1");
  const sha = git(dir, "rev-parse", "HEAD");
  return { dir, before, sha };
}

function runStep(dir: string, vars: { event: string; sha: string; before: string }): string[] {
  const script = stepScript("Collect changed files")
    .split("${{ github.event_name }}").join(vars.event)
    .split("${{ github.sha }}").join(vars.sha)
    .split("${{ github.event.before }}").join(vars.before)
    .split("${{ github.event.pull_request.base.sha }}").join("")
    .split("${{ github.event.pull_request.head.sha }}").join("");
  expect(script, "every expression was substituted").not.toMatch(/\$\{\{/);
  execFileSync("bash", ["-c", script], { cwd: dir, stdio: "pipe" });
  return readFileSync(path.join(dir, "changed.txt"), "utf8").split("\n").filter(Boolean).sort();
}

function classify(dir: string): Record<string, string> {
  const outFile = path.join(dir, "github-output.txt");
  writeFileSync(outFile, "");
  execFileSync(
    "node",
    [path.join(ROOT, "scripts/classify-changes.mjs"), "--files-from", path.join(dir, "changed.txt"), "--github-output"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outFile } },
  );
  const out = readFileSync(outFile, "utf8");
  return Object.fromEntries(
    out
      .split("\n")
      .filter((l) => /^[a-z_A-Z]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

const SHIPPED = ["app/ingest/route.ts", "docs/03_SECURITY_AND_PRIVACY.md"];

describe("push: a production merge lists what it SHIPPED", () => {
  it("CONTROL: the old command lists only the shared doc, which the classifier calls DOCS-ONLY (lanes skipped)", () => {
    const { dir, sha } = repoWithMerge();
    // A real two-parent merge: both sides touched the doc, only one shipped app code.
    expect(git(dir, "rev-list", "--parents", "-n", "1", sha).split(" ")).toHaveLength(3);
    const combined = git(dir, "show", "--name-only", "--no-renames", "--pretty=format:", sha)
      .split("\n")
      .filter(Boolean);
    expect(combined).toEqual(["docs/03_SECURITY_AND_PRIVACY.md"]);
    writeFileSync(path.join(dir, "changed.txt"), combined.join("\n") + "\n");
    const c = classify(dir);
    expect(c.docs_only).toBe("true");
    expect(c.full_matrix_required).toBe("false");
  });

  it("with `before` = the previous production tip: the merge's full first-parent diff, classified as application", () => {
    const { dir, before, sha } = repoWithMerge();
    expect(runStep(dir, { event: "push", sha, before })).toEqual(SHIPPED);
    const c = classify(dir);
    // application=true runs validate (typecheck/lint/build/unit) and the
    // application browser lanes; docs-only would have skipped them all.
    expect(c.docs_only).toBe("false");
    expect(c.application).toBe("true");
  });

  for (const [label, before] of [
    ["empty (a non-push event)", ""],
    ["all zeros (a new or recreated branch)", "0000000000000000000000000000000000000000"],
    ["not in this clone", "1111111111111111111111111111111111111111"],
  ] as const) {
    it(`with \`before\` ${label}: FAILS CLOSED to an empty list, so the full matrix runs`, () => {
      const { dir, sha } = repoWithMerge();
      expect(runStep(dir, { event: "push", sha, before })).toEqual([]);
      expect(classify(dir).full_matrix_required).toBe("true");
    });
  }

  it("a NEW-BRANCH push of several commits (app code first, docs-only tip) runs the FULL matrix (Codex P2 4305052075)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-push-diff-newbranch-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "feature");
    write(dir, "README.md", "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    write(dir, "app/ingest/route.ts", "export const a = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "app code");
    write(dir, "docs/03_SECURITY_AND_PRIVACY.md", "doc\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "docs-only tip");
    const sha = git(dir, "rev-parse", "HEAD");
    // CONTROL: the dropped ^1 fallback would have seen only the docs-only tip.
    expect(git(dir, "diff", "--name-only", "--no-renames", `${sha}^1`, sha)).toBe("docs/03_SECURITY_AND_PRIVACY.md");
    expect(runStep(dir, { event: "push", sha, before: "0000000000000000000000000000000000000000" })).toEqual([]);
    expect(classify(dir).full_matrix_required).toBe("true");
  });

  it("a FORCE-PUSH (`before` is a real commit but NOT an ancestor of the pushed sha) runs the FULL matrix", () => {
    const { dir, sha } = repoWithMerge();
    git(dir, "checkout", "-q", "-b", "abandoned", `${sha}^1^1`);
    write(dir, "app/other.ts", "export const b = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "rewritten history");
    const before = git(dir, "rev-parse", "HEAD");
    expect(() => git(dir, "merge-base", "--is-ancestor", before, sha)).toThrow();
    expect(runStep(dir, { event: "push", sha, before })).toEqual([]);
    expect(classify(dir).full_matrix_required).toBe("true");
  });

  it("a root commit (no parent) yields an EMPTY list, which the classifier fails SAFE to the full matrix", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-push-diff-root-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "prod");
    write(dir, "README.md", "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "root");
    const sha = git(dir, "rev-parse", "HEAD");
    expect(runStep(dir, { event: "push", sha, before: "" })).toEqual([]);
    expect(classify(dir).full_matrix_required).toBe("true");
  });

  // (b) PRODUCTION'S REAL HISTORY. #912's merge 6acea261 shipped 5 app files
  // and shared docs/03 with #913; its push run 39064516027 skipped validate.
  // validate checks out with fetch-depth: 0, so these commits are reachable in
  // CI; a shallow local clone skips, and says so.
  const REAL_MERGES = [
    // #912 also touched next.config.ts (shared infra), so it is FULL matrix;
    // #891 is application-only, which still runs validate.
    { sha: "6acea261a8840b4b7ae026f4f181f31b6dc976e6", pr: "#912", shipping: "app/monitoring/route.ts", full: "true" },
    { sha: "62ff27b286ea335605342e57067b0c6a05a1a8e5", pr: "#891", shipping: "lib/observability/sentry-scrub.ts", full: "false" },
  ];
  for (const m of REAL_MERGES) {
    const reachable = (() => {
      try {
        execFileSync("git", ["cat-file", "-e", `${m.sha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    it.skipIf(!reachable)(`REAL production merge ${m.pr} (${m.sha.slice(0, 8)}): old = docs-only, new = application (validate runs)`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), "hone-push-diff-real-"));
      dirs.push(dir);
      const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
      const before = execFileSync("git", ["rev-parse", `${m.sha}^1`], { cwd: ROOT, encoding: "utf8" }).trim();
      // OLD: the combined diff, as the push step used to compute it.
      const old = execFileSync("git", ["--git-dir", gitDir, "show", "--name-only", "--no-renames", "--pretty=format:", m.sha], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
      expect(old).toEqual(["docs/03_SECURITY_AND_PRIVACY.md"]);
      writeFileSync(path.join(dir, "changed.txt"), old.join("\n") + "\n");
      expect(classify(dir).docs_only).toBe("true");
      // NEW: the real step body, against the real repository's objects.
      const script = stepScript("Collect changed files")
        .split("${{ github.event_name }}").join("push")
        .split("${{ github.sha }}").join(m.sha)
        .split("${{ github.event.before }}").join(before)
        .split("${{ github.event.pull_request.base.sha }}").join("")
        .split("${{ github.event.pull_request.head.sha }}").join("");
      execFileSync("bash", ["-c", script], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_DIR: gitDir } });
      const shipped = readFileSync(path.join(dir, "changed.txt"), "utf8").split("\n").filter(Boolean);
      expect(shipped).toContain(m.shipping);
      expect(shipped).toContain("docs/03_SECURITY_AND_PRIVACY.md");
      const c = classify(dir);
      expect(c.docs_only).toBe("false");
      expect(c.application).toBe("true");
      expect(c.full_matrix_required).toBe(m.full);
    });
  }

  it("(d) required checks are preserved: every job id and stable name is still present", () => {
    for (const [id, name] of [
      ["changes", "changed-path detection"],
      ["validate", "typecheck / lint / build / test / safety gates"],
      ["canonical-record", "canonical production record (docs-only)"],
      ["db-integration", "db integration (local supabase)"],
      ["browser-e2e", "browser e2e (local stack)"],
      ["payment-browser-e2e", "payment browser e2e (fake stripe)"],
      ["mobile-completion-e2e", "mobile completion e2e (chromium iphone-profile)"],
      ["google-browser-e2e", "google browser e2e (fake google)"],
    ]) {
      expect(CI_YML, `job ${id}`).toMatch(new RegExp(`\\n  ${id}:\\n`));
      expect(CI_YML, `name ${name}`).toContain(`    name: ${name}\n`);
    }
  });

  it("the pull_request branch is unchanged (merge-base..head), and no executable line uses git show", () => {
    const step = stepScript("Collect changed files");
    expect(step).toContain('MB="$(git merge-base "$BASE" "$HEAD_SHA" 2>/dev/null || echo "$BASE")"');
    expect(step).toContain('git diff --name-only --no-renames "$MB" "$HEAD_SHA" > changed.txt || true');
    const executable = CI_YML.split("\n").filter((l) => !l.trim().startsWith("#"));
    expect(executable.join("\n")).not.toMatch(/git show --name-only/);
  });
});
