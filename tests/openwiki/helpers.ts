// Shared fixtures for the WIKI-AUTO-01 runner tests: a throwaway "production"
// repository behind a local bare origin, built with real git. Every git call
// runs with an empty global config so an operator's ~/.gitconfig (signing,
// credential helpers, hooks) cannot change what the tests observe.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Evidence versions copied verbatim from this repository's own Claim sidecars
 * (openwiki/.claims/architecture/production-truth-and-lifecycle-states.json and
 * a whole-file one), as openwiki@0.6.1 wrote them. Tests use these rather than
 * a test-only grammar, so the validator cannot drift from the real format.
 */
export const PRODUCTION_RANGE_EVIDENCE_VERSION =
  "repo-lines-v1:sha256:c2bd16f9232fcbd0cf8855aea4ef30d7a3947eab36dba2288f0a94c53cd1c4b0:eyJzZWxlY3RlZExpbmVDb3VudCI6MjMsImZpcnN0U2VsZWN0ZWRMaW5lSGFzaCI6ImVlNWRmZjJhOThmYTVhMDE3ZTE3NjhiOGVmNGZmZDg0ZjM4YTM0YjdmMDJhMWFjYTk3YzU4MGFjM2EwN2E2MTUiLCJsYXN0U2VsZWN0ZWRMaW5lSGFzaCI6IjdjMzIyZjk1Y2M4ZjkzMTY2YWU4ZWFjMjE2MDMwNjQ4OGUzZDUzNTk0MWQ1YTgyMzlmNWRmNDRhOTc5NTNkNWMiLCJwcmVjZWRpbmdDb250ZXh0TGluZUNvdW50IjozLCJwcmVjZWRpbmdDb250ZXh0SGFzaCI6IjAwMWYyZWMxNzU5M2MxMDU0ZWI0NjM2N2Q4NDUzZWYyNGExNzNjZTk2YjcxMTdkOTFmOWE2OGQ0NGZlZjhiMDEiLCJmb2xsb3dpbmdDb250ZXh0TGluZUNvdW50IjozLCJmb2xsb3dpbmdDb250ZXh0SGFzaCI6IjdiOWVmNWZmOGI4MjRmNGE4YzA3MjAzMDM0ZTA0NDYwZTNjYmU1YjM3N2QyMTgzYzMwMjUzOWQyNTY3YWZkMTQifQ";
export const PRODUCTION_FILE_EVIDENCE_VERSION = "repo-file-v1:sha256:39f54fced2e1b323ed3022b3ea3576e98496d6d30063a273533931d2122db1a0";

/** OpenWiki's pageVersion: sha256 of the page bytes. */
export function pageVersion(root: string, page: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path.join(root, page))).digest("hex")}`;
}

const sidecarOf = (page: string) => `openwiki/.claims/${page.slice("openwiki/".length, -".md".length)}.json`;

/**
 * What OpenWiki's finish step does for the pages a run touched: a live page's
 * sidecar (created with one Claim if missing) and manifest entry carry its
 * pageVersion; a deleted page loses both.
 */
export function stampProvenance(root: string, livePages: string[], deletedPages: string[] = []): void {
  const manifestFile = "openwiki/.page-manifest.json";
  const manifest = JSON.parse(read(root, manifestFile));
  manifest.pages ??= {};
  for (const page of livePages) {
    const sidecar = sidecarOf(page);
    const claims = existsSync(path.join(root, sidecar))
      ? JSON.parse(read(root, sidecar))
      : { schemaVersion: 1, claims: [{ id: `claim_${page.length}`, statement: `About ${page}.`, evidence: [{ resource: "repo://lib/feature.ts#L1-L1" }] }] };
    claims.pageVersion = pageVersion(root, page);
    write(root, sidecar, `${JSON.stringify(claims, null, 2)}\n`);
    manifest.pages[`/${page}`] = { pageVersion: claims.pageVersion };
  }
  for (const page of deletedPages) {
    rmSync(path.join(root, sidecarOf(page)), { force: true });
    delete manifest.pages[`/${page}`];
  }
  write(root, manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

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

  commit(
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
        schemaVersion: 1,
        claims: [{ id: "claim_1", statement: "Feature is 1.", evidence: [{ resource: "repo://lib/feature.ts#L1-L1", version: PRODUCTION_RANGE_EVIDENCE_VERSION }] }],
      }),
      "openwiki/.page-manifest.json": JSON.stringify({ schemaVersion: 1, pages: {} }),
    },
    "source: initial",
  );
  // The committed wiki is provenance-consistent, as OpenWiki leaves it.
  stampProvenance(work, ["openwiki/quickstart.md", "openwiki/topic/kept-page.md", "openwiki/topic/old-page.md"]);
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "--amend", "--no-edit"]);
  const stamped = git(work, ["rev-parse", "HEAD"]);
  const wiki1 = commit(
    {
      "openwiki/.last-update.json": `${JSON.stringify({ command: "update", gitHead: stamped, status: "complete", language: "en" }, null, 2)}\n`,
    },
    "docs(openwiki): record run metadata",
  );
  push();
  return { root, origin, work, source1: stamped, wiki1, commit, push };
}
