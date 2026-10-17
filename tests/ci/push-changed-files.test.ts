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
  it("CONTROL: the old command (git show --name-only on the merge) lists only the shared doc", () => {
    const { dir, sha } = repoWithMerge();
    const combined = git(dir, "show", "--name-only", "--no-renames", "--pretty=format:", sha)
      .split("\n")
      .filter(Boolean);
    expect(combined).toEqual(["docs/03_SECURITY_AND_PRIVACY.md"]);
  });

  it("with `before` = the previous production tip: the merge's full first-parent diff, classified as application", () => {
    const { dir, before, sha } = repoWithMerge();
    expect(runStep(dir, { event: "push", sha, before })).toEqual(SHIPPED);
    const c = classify(dir);
    expect(c.docs_only).toBe("false");
    expect(c.application).toBe("true");
  });

  for (const [label, before] of [
    ["empty", ""],
    ["all zeros (a new branch)", "0000000000000000000000000000000000000000"],
    ["not in this clone", "1111111111111111111111111111111111111111"],
  ] as const) {
    it(`with \`before\` ${label}: falls back to the first parent, the same set`, () => {
      const { dir, sha } = repoWithMerge();
      expect(runStep(dir, { event: "push", sha, before })).toEqual(SHIPPED);
    });
  }

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

  it("the pull_request branch is unchanged (merge-base..head), and no executable line uses git show", () => {
    const step = stepScript("Collect changed files");
    expect(step).toContain('MB="$(git merge-base "$BASE" "$HEAD_SHA" 2>/dev/null || echo "$BASE")"');
    expect(step).toContain('git diff --name-only --no-renames "$MB" "$HEAD_SHA" > changed.txt || true');
    const executable = CI_YML.split("\n").filter((l) => !l.trim().startsWith("#"));
    expect(executable.join("\n")).not.toMatch(/git show --name-only/);
  });
});
