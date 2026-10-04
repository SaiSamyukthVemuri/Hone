// Shared fixtures for the WIKI-AUTO-01 runner tests: a throwaway "production"
// repository behind a local bare origin, built with real git. Every git call
// runs with an empty global config so an operator's ~/.gitconfig (signing,
// credential helpers, hooks) cannot change what the tests observe.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "../..");

const tmpDirs: string[] = [];

export function makeTmp(label: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `hone-${label}-`)));
  tmpDirs.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

let isolated: { global: string; prev: Record<string, string | undefined> } | undefined;

/** Point git at an empty global config for this test file's process. */
export function isolateGitConfig(): void {
  if (isolated) return;
  const dir = makeTmp("gitconfig");
  const global = path.join(dir, "gitconfig");
  writeFileSync(global, "");
  isolated = {
    global,
    prev: { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM },
  };
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

export function restoreGitConfig(): void {
  if (!isolated) return;
  for (const [key, value] of Object.entries(isolated.prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  isolated = undefined;
}

const AUTHOR = {
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...AUTHOR } }).replace(/\n$/u, "");
}

export function write(root: string, file: string, content: string): void {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function read(root: string, file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

export function writePrivate(file: string, content: string): string {
  writeFileSync(file, content);
  chmodSync(file, 0o600);
  return file;
}

export const AGENTS_AUTHORED = [
  "<!-- OPENWIKI:START -->",
  "",
  "## OpenWiki",
  "",
  "OpenWiki is currently updated on demand. A scheduled refresh workflow is not installed.",
  "",
  "<!-- OPENWIKI:END -->",
  "",
].join("\n");

export const AGENTS_TEMPLATE_REWRITE = [
  "<!-- OPENWIKI:START -->",
  "",
  "## OpenWiki",
  "",
  "The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki.",
  "",
  "<!-- OPENWIKI:END -->",
  "",
].join("\n");

export const CLAUDE_WITH_BLOCK = "# Rules\n\n<!-- OPENWIKI:START -->\n\n## OpenWiki\n\n@AGENTS.md\n\n<!-- OPENWIKI:END -->\n";

/** Shaped like the scaffold openwiki@0.6.1 writes on init (code-mode.js createCodeModeWorkflow). */
export const OPENWIKI_SCAFFOLD_WORKFLOW = [
  "name: OpenWiki Update",
  "on:",
  "  workflow_dispatch:",
  "permissions:",
  "  contents: write",
  "  pull-requests: write",
  "jobs:",
  "  update:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4",
  "      - run: openwiki code --update --print",
  "        env:",
  "          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
  "",
].join("\n");

export type Fixture = {
  root: string;
  origin: string;
  work: string;
  /** The first commit: source only. */
  source1: string;
  /** Generated-only commit adding the wiki run metadata, gitHead = source1. */
  wiki1: string;
  commit(files: Record<string, string | null>, message: string): string;
  push(ref?: string): void;
};

/**
 * main: source1 (source + wiki pages) -> wiki1 (openwiki/.last-update.json
 * recording source1). The wiki is therefore live at wiki1.
 */
export function createFixture(): Fixture {
  const root = makeTmp("wiki-fixture");
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", work]);
  git(work, ["remote", "add", "origin", origin]);

  const commit = (files: Record<string, string | null>, message: string): string => {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) rmSync(path.join(work, file), { force: true });
      else write(work, file, content);
    }
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", message]);
    return git(work, ["rev-parse", "HEAD"]);
  };
  const push = (ref = "main"): void => {
    git(work, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${ref}`]);
  };

  const source1 = commit(
    {
      ".openwikiignore": read(REPO_ROOT, ".openwikiignore"),
      ".gitignore": "/openwiki/.run.json\n",
      "AGENTS.md": AGENTS_AUTHORED,
      "CLAUDE.md": CLAUDE_WITH_BLOCK,
      "lib/feature.ts": "export const feature = 1;\n",
      "docs/production/current-state.md":
        "# State\n\n## 0. Tenant register\n\n| Studio | Class |\n|---|---|\n| synthetic-studio-one | fixture |\n\n## 1. Next\n",
      "openwiki/INSTRUCTIONS.md": "# Instructions\n\nAuthored.\n",
      "openwiki/quickstart.md": "# Quickstart\n\nSee [kept](topic/kept-page.md).\n",
      "openwiki/topic/kept-page.md": "# Kept page\n\nFeature is 1.\n",
      "openwiki/topic/old-page.md": "# Old page\n\nRetired topic.\n",
      "openwiki/.claims/topic/kept-page.json": JSON.stringify({
        claims: [{ id: "claim_1", statement: "Feature is 1.", evidence: [{ resource: "repo://lib/feature.ts#L1-L1", version: "eyJmaXh0dXJlIjoidmVyc2lvbiBtZXRhZGF0YSJ9" }] }],
      }),
      "openwiki/.page-manifest.json": JSON.stringify({ schemaVersion: 1, pages: {} }),
    },
    "source: initial",
  );
  const wiki1 = commit(
    {
      "openwiki/.last-update.json": `${JSON.stringify({ command: "update", gitHead: source1, status: "complete", language: "en" }, null, 2)}\n`,
    },
    "docs(openwiki): record run metadata",
  );
  push();
  return { root, origin, work, source1, wiki1, commit, push };
}
