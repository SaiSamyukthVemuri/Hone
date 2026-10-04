#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WIKI-AUTO-01: the unattended OpenWiki update runner.
//
//   node scripts/openwiki/nightly.mjs [--no-publish]
//
// Contract (docs/runbooks/openwiki-nightly.md has the operator view):
//
//   * It documents the SOURCE HEAD, the newest production commit whose own
//     change touched a source path (source-head.mjs), and stops before doing
//     anything when openwiki/.last-update.json already describes it.
//   * It runs `openwiki code --update --print` and nothing else. Never init.
//     HEAD is pinned to the source head so OpenWiki records it as gitHead,
//     while the working tree is the production tip, so the wiki it updates
//     is the newest one.
//   * Only the generated scope (paths.mjs) is ever published. OpenWiki's known
//     writes outside it (the AGENTS.md/CLAUDE.md managed blocks, and on init
//     the workflow scaffold) are discarded and recorded. Any other write
//     outside it fails the run.
//   * Publishing REPLACES the generated scope with what the run produced,
//     deletions included, on top of the production tip. It is never an
//     overlay onto an older wiki. It goes through CLAUDE.md's eight-step
//     delivery sequence, then opens one pull request. It never merges.
//   * Every failure publishes nothing and resets the subject checkout.
//
// Outcomes and exit codes: SKIP, NOOP, DRY_RUN and PUBLISHED exit 0; FAILED
// exits 1; PRECONDITION exits 2 because a human has to change something.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGitHubClient, createInstallationToken } from "./github-app.mjs";
import {
  checkCommitAuthors,
  checkLastUpdate,
  checkManagedBlockMarkers,
  diffTrees,
  discardChanges,
  findBrokenLinkStamps,
  inspectWorkflow,
  loadTenantSlugs,
  parseDenylist,
  privacyItemsFor,
  scanPrivacy,
  snapshotWorktree,
  sortRunChanges,
} from "./guards.mjs";
import { OPENWIKI_WORKFLOW_PATH, RUN_METADATA_PATHS, classifyPath, loadOpenWikiIgnore } from "./paths.mjs";
import { assessLiveness, commitExists, discoverSourceHead, git, isAncestor, readJsonAtCommit } from "./source-head.mjs";

export const OPENWIKI_VERSION = "0.6.1";
export const NIGHTLY_BRANCH_PREFIX = "openwiki/nightly-";
export const EXIT_CODE = Object.freeze({ SKIP: 0, NOOP: 0, DRY_RUN: 0, PUBLISHED: 0, FAILED: 1, PRECONDITION: 2 });

/** Names the host must set (values live in the host env file; secrets only as *_FILE paths). */
export const REQUIRED_ENV = Object.freeze([
  "HONE_WIKI_NIGHTLY",
  "HONE_WIKI_REPOSITORY",
  "HONE_WIKI_BASE_BRANCH",
  "HONE_WIKI_SUBJECT_DIR",
  "HONE_WIKI_STATE_DIR",
  "HONE_WIKI_APP_ID",
  "HONE_WIKI_APP_INSTALLATION_ID",
  "HONE_WIKI_APP_PRIVATE_KEY_FILE",
  "HONE_WIKI_GIT_AUTHOR_NAME",
  "HONE_WIKI_GIT_AUTHOR_EMAIL",
  "HONE_WIKI_OPENWIKI_DIR",
  "HONE_WIKI_ANTHROPIC_API_KEY_FILE",
  "HONE_WIKI_DENYLIST_FILE",
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "OPENWIKI_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
]);
export const OPTIONAL_ENV = Object.freeze(["HONE_WIKI_PUBLISH", "HONE_WIKI_MIN_FREE_GB", "HONE_WIKI_RUN_TIMEOUT_MIN"]);

/**
 * Must be absent from the runner's environment. Operator GitHub tokens would
 * bypass the App's narrowed permissions. A raw provider key in the runner's
 * own environment would reach every child, not only OpenWiki; it arrives as a
 * file. Tracing would ship repository content to LangSmith. The runner holds
 * no production credential.
 */
export const FORBIDDEN_ENV = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGCHAIN_TRACING_V2",
  "OPENWIKI_LANGSMITH_API_KEY",
]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(["SUPABASE_", "STRIPE_", "TWILIO_", "VERCEL_", "SENTRY_"]);

/** Problems with the runner environment, by NAME only. Values are never read into a message. */
export function checkEnvironment(env, required = REQUIRED_ENV) {
  const problems = [];
  for (const name of required) {
    if (!String(env[name] ?? "").trim()) problems.push(`required ${name} is not set`);
  }
  for (const name of Object.keys(env)) {
    if (FORBIDDEN_ENV.includes(name) || FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      problems.push(`forbidden ${name} is set`);
    }
  }
  if (required.includes("OPENWIKI_PROVIDER") && env.OPENWIKI_PROVIDER && env.OPENWIKI_PROVIDER !== "anthropic") {
    problems.push("OPENWIKI_PROVIDER must be anthropic");
  }
  for (const name of ["OPENWIKI_TELEMETRY_DISABLED", "DO_NOT_TRACK"]) {
    if (required.includes(name) && env[name] && env[name] !== "1") problems.push(`${name} must be 1`);
  }
  return problems;
}

// ---------------------------------------------------------------- small helpers

function acquireLock(stateDir) {
  const file = path.join(stateDir, "run.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return file;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8").trim());
      if (pid > 0 && processAlive(pid)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function privateFile(filePath) {
  return Boolean(filePath) && existsSync(filePath) && (statSync(filePath).mode & 0o077) === 0;
}

/**
 * Read a secret file only if no other local account can read it. A key that
 * another account could read is already compromised, so it is refused.
 */
export function readOwnerOnlySecret(filePath, name) {
  if (!privateFile(filePath)) throw new Error(`${name} must exist and be readable by its owner only`);
  return readFileSync(filePath, "utf8");
}

/** The runner's private HOME: OpenWiki's config dir and an empty git config live here. */
function runnerHome(config) {
  const home = path.join(config.stateDir, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * The environment for repository code the runner executes (the CLAUDE.md
 * pre-push check). That code comes from the production checkout, so it gets
 * no credential, no credential path and no App identifier: only what a node
 * script and git need, with the runner's private HOME.
 */
export function repositoryScriptEnv(config) {
  const home = runnerHome(config);
  return {
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
  };
}

/** Git env for one remote operation. A token reaches git only via GIT_ASKPASS reading an env var. */
function remoteGitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!token) return { env, cleanup() {} };
  const dir = mkdtempSync(path.join(os.tmpdir(), "hone-wiki-askpass-"));
  const script = path.join(dir, "askpass.sh");
  writeFileSync(
    script,
    '#!/bin/sh\ncase "$1" in\n  *sername*) printf \'%s\\n\' x-access-token ;;\n  *) printf \'%s\\n\' "$HONE_WIKI_GIT_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  return {
    env: { ...env, GIT_ASKPASS: script, HONE_WIKI_GIT_TOKEN: token },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** `-c credential.helper=` empties the helper list, so no operator credential helper can answer. */
function remoteGit(cwd, args, token) {
  const auth = remoteGitEnv(token);
  try {
    return git(cwd, ["-c", "credential.helper=", ...args], { env: auth.env });
  } finally {
    auth.cleanup();
  }
}

function resetSubject(subject, tip) {
  try {
    git(subject, ["checkout", "--quiet", "--detach", "--force", tip]);
    git(subject, ["reset", "--quiet", "--hard", tip]);
    git(subject, ["clean", "-ffdxq"]);
  } catch {
    // The next run starts with a hard reset anyway; the outcome already says FAILED.
  }
}

const SECRET_SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\beyJ[A-Za-z0-9_-]{15,}/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

export function redactSecrets(text) {
  return SECRET_SHAPES.reduce((out, re) => out.replace(re, "[redacted]"), String(text));
}

// ---------------------------------------------------------------- the generator

/** The only OpenWiki invocation the runner makes. There is no mode parameter: init is unreachable. */
export function buildGeneratorInvocation(config) {
  const base = repositoryScriptEnv(config);
  return {
    command: process.execPath,
    args: [path.join(config.openwikiDir, "dist", "cli", "cli.js"), "code", "--update", "--print"],
    env: {
      ...base,
      OPENWIKI_CONFIG_DIR: path.join(base.HOME, ".openwiki"),
      OPENWIKI_PROVIDER: "anthropic",
      OPENWIKI_MODEL_ID: config.modelId,
      OPENWIKI_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      ANTHROPIC_API_KEY: readOwnerOnlySecret(config.anthropicKeyFile, "HONE_WIKI_ANTHROPIC_API_KEY_FILE").trim(),
    },
  };
}

export function runOpenWikiProcess({ cwd, invocation, timeoutMs }) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(invocation.command, invocation.args, { cwd, env: invocation.env, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk) => {
      output = (output + chunk).slice(-65_536);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, timedOut, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, timedOut, output });
    });
  });
}

// ---------------------------------------------------------------- run steps

function syncSubject(config, token) {
  const subject = config.subjectDir;
  if (!existsSync(path.join(subject, ".git"))) {
    mkdirSync(path.dirname(subject), { recursive: true });
    remoteGit(path.dirname(subject), ["clone", "--quiet", "--no-checkout", "--no-tags", config.remoteUrl, subject], token);
  }
  if (git(subject, ["remote", "get-url", "origin"]) !== config.remoteUrl) {
    throw new PreconditionError("subject checkout's origin is not the configured repository");
  }
  const base = config.baseBranch;
  remoteGit(subject, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], token);
  const tip = git(subject, ["rev-parse", `refs/remotes/origin/${base}^{commit}`]);
  git(subject, ["checkout", "--quiet", "--detach", "--force", tip]);
  git(subject, ["reset", "--quiet", "--hard", tip]);
  git(subject, ["clean", "-ffdxq"]);
  if (git(subject, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new PreconditionError("subject checkout is not clean after reset");
  }
  return tip;
}

class PreconditionError extends Error {}

function baselineProblems(subject, tip) {
  const read = (file) => {
    const full = path.join(subject, file);
    return existsSync(full) ? readFileSync(full, "utf8") : undefined;
  };
  const problems = [
    ...checkManagedBlockMarkers("AGENTS.md", read("AGENTS.md")),
    ...checkManagedBlockMarkers("CLAUDE.md", read("CLAUDE.md")),
  ];
  if (existsSync(path.join(subject, OPENWIKI_WORKFLOW_PATH))) {
    problems.push(`${OPENWIKI_WORKFLOW_PATH} is committed at the production tip`);
  }
  if (readJsonAtCommit(subject, tip, "openwiki/.run.json") !== undefined) {
    problems.push("openwiki/.run.json is committed at the production tip");
  }
  return problems;
}

/** Nightly branches on the remote that production does not contain: at most one run in flight. */
function unmergedNightlyBranches(subject, tip, token) {
  // List every head and filter here: ls-remote patterns match ref-name tails,
  // which is not the same thing as a prefix.
  const listed = remoteGit(subject, ["ls-remote", "--heads", "origin"], token)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split("\t");
      return { sha, branch: ref.replace(/^refs\/heads\//u, "") };
    })
    .filter(({ branch }) => branch.startsWith(NIGHTLY_BRANCH_PREFIX));
  const unmerged = [];
  for (const { sha, branch } of listed) {
    if (!commitExists(subject, sha)) {
      remoteGit(subject, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], token);
    }
    if (!isAncestor(subject, sha, tip)) unmerged.push(branch);
  }
  return unmerged;
}

function runPrerequisiteProblems(config) {
  const problems = [];
  const pkgFile = path.join(config.openwikiDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  } catch {
    problems.push("pinned OpenWiki install is missing (HONE_WIKI_OPENWIKI_DIR)");
  }
  if (pkg && (pkg.name !== "openwiki" || pkg.version !== OPENWIKI_VERSION)) {
    problems.push(`pinned OpenWiki must be openwiki@${OPENWIKI_VERSION}`);
  }
  if (!existsSync(path.join(config.openwikiDir, "dist", "cli", "cli.js"))) problems.push("OpenWiki CLI entry point is missing");
  // The OpenWiki child runs on this same node (buildGeneratorInvocation uses
  // process.execPath). `config.nodeVersion` exists so tests on another node can
  // exercise the rule; the CLI never sets it.
  const [major, minor] = String(config.nodeVersion ?? process.versions.node).split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 22)) problems.push("node >= 22.22.0 is required by openwiki@0.6.1");
  if (!privateFile(config.anthropicKeyFile)) problems.push("HONE_WIKI_ANTHROPIC_API_KEY_FILE must exist and be readable by its owner only");
  else if (!readFileSync(config.anthropicKeyFile, "utf8").trim()) problems.push("HONE_WIKI_ANTHROPIC_API_KEY_FILE is empty");
  if (!privateFile(config.denylistFile)) problems.push("HONE_WIKI_DENYLIST_FILE must exist and be readable by its owner only");
  if (!String(config.modelId ?? "").trim()) problems.push("OPENWIKI_MODEL_ID is empty");
  const fs = statfsSync(config.stateDir);
  if (fs.bavail * fs.bsize < config.minFreeBytes) problems.push("free disk space is below HONE_WIKI_MIN_FREE_GB");
  return problems;
}

/**
 * Split the run's changes by owner, discard everything outside the generated
 * scope, and record what was discarded and why. Returns the post-discard
 * snapshot tree.
 */
function enforceScope(subject, tip, ignore, report) {
  const before = sortRunChanges(diffTrees(subject, tip, snapshotWorktree(subject)), ignore);
  for (const change of before.sideEffects) {
    const entry = { path: change.path, status: change.status, reason: "known OpenWiki side effect outside the generated scope" };
    if (change.path === OPENWIKI_WORKFLOW_PATH) {
      const violations = inspectWorkflow(readFileSync(path.join(subject, change.path), "utf8"));
      entry.reason = violations.length
        ? "A3: OpenWiki's workflow scaffold would fail CI-workflow inspection; never published"
        : "A3: OpenWiki's workflow scaffold is outside the generated scope; never published";
      entry.workflowInspection = violations;
    }
    report.discarded.push(entry);
  }
  for (const change of before.unexpected) {
    report.discarded.push({ path: change.path, status: change.status, reason: `unexpected generator write (${change.kind})` });
  }
  discardChanges(subject, tip, [...before.sideEffects, ...before.unexpected]);
  const tree = snapshotWorktree(subject);
  const after = sortRunChanges(diffTrees(subject, tip, tree), ignore);
  if (after.sideEffects.length > 0 || after.unexpected.length > 0) {
    throw new Error("writes outside the generated scope survived the discard");
  }
  return { tree, generated: after.generated, unexpected: before.unexpected };
}

function validateGenerated(subject, generated, sourceHead, config) {
  const problems = [];
  let lastUpdate;
  try {
    lastUpdate = JSON.parse(readFileSync(path.join(subject, "openwiki/.last-update.json"), "utf8"));
  } catch {
    lastUpdate = undefined;
  }
  problems.push(...checkLastUpdate(lastUpdate, sourceHead).map((p) => `openwiki/.last-update.json: ${p}`));
  const stateFile = path.join(subject, "docs/production/current-state.md");
  const tenantSlugs = loadTenantSlugs(existsSync(stateFile) ? readFileSync(stateFile, "utf8") : "");
  const denylistTerms = parseDenylist(readFileSync(config.denylistFile, "utf8"));
  const stamps = [];
  const items = [];
  for (const change of generated) {
    if (change.status === "D") continue;
    const content = readFileSync(path.join(subject, change.path), "utf8");
    if (change.path.endsWith(".md")) {
      for (const line of findBrokenLinkStamps(content)) stamps.push({ file: change.path, line });
    }
    try {
      items.push(...privacyItemsFor(change.path, content));
    } catch {
      problems.push(`${change.path}: Claim sidecar is not valid JSON`);
    }
  }
  if (stamps.length > 0) problems.push(`${stamps.length} broken-link stamp(s) left by OpenWiki`);
  const privacyHits = scanPrivacy(items, { denylistTerms, tenantSlugs });
  if (privacyHits.length > 0) problems.push(`${privacyHits.length} privacy/secret denylist hit(s)`);
  return { problems, stamps, privacyHits };
}

function summarize(generated) {
  const count = (s) => generated.filter((c) => c.status === s).length;
  return { changed: generated.length, added: count("A"), modified: count("M"), deleted: count("D") };
}

async function publish({ subject, tip, sourceHead, previousGitHead, tree, generated, ignore, config, deps, token, report }) {
  const stamp = new Date(deps.now ? deps.now() : Date.now()).toISOString().slice(0, 10).replace(/-/gu, "");
  const branch = `${NIGHTLY_BRANCH_PREFIX}${stamp}-${sourceHead.slice(0, 7)}`;
  const identity = config.identity;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  // The working tree already holds tip + the generated changes; move HEAD back to the tip.
  git(subject, ["reset", "--quiet", "--soft", tip]);
  git(subject, ["switch", "--quiet", "--force-create", branch]);

  // CLAUDE.md "Follow this sequence before every push", in order.
  git(subject, ["add", "-A"]);
  git(subject, ["diff", "--cached", "--check"]);
  const staged = git(subject, ["status", "--porcelain"]);
  if (staged.split("\n").some((line) => line.startsWith("??"))) throw new Error("an untracked file was not staged");
  const title = `docs(openwiki): nightly update at source ${sourceHead.slice(0, 7)}`;
  git(subject, ["commit", "--quiet", "-m", title, "-m", `Generated by the WIKI-AUTO-01 runner from production source ${sourceHead} (production tip ${tip}). Only generated openwiki/ files change.`], { env });
  if (git(subject, ["status", "--porcelain"]) !== "") throw new Error("working tree is not clean after commit");
  git(subject, ["diff", "HEAD", "--exit-code"]);

  // Verify the commit before it leaves the machine.
  const head = git(subject, ["rev-parse", "HEAD"]);
  const parents = git(subject, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== tip) throw new Error("publish commit is not a single-parent child of the production tip");
  const published = diffTrees(subject, tip, head);
  if (published.some((c) => classifyPath(c.path, ignore) !== "generated")) throw new Error("publish commit leaves the generated scope");
  if (git(subject, ["rev-parse", `${head}:openwiki`]) !== git(subject, ["rev-parse", `${tree}:openwiki`])) {
    throw new Error("published openwiki/ is not exactly the run's output (replace, not overlay)");
  }
  const authorProblems = checkCommitAuthors(subject, `${tip}..${head}`, identity);
  if (authorProblems.length > 0) throw new Error(authorProblems.join("; "));

  // Repository code: allowlisted environment only (no credentials, paths to them or App ids).
  const [command, ...args] = config.prepushCommand;
  const prepush = spawnSync(command, args, { cwd: subject, stdio: "ignore", env: repositoryScriptEnv(config) });
  if (prepush.status !== 0) throw new Error("verify:prepush failed");
  remoteGit(subject, ["push", "--quiet", "origin", `${head}:refs/heads/${branch}`], token);
  report.publish = { branch, head };

  const github = deps.github(token);
  const s = summarize(generated);
  const discardedList = report.discarded.map((d) => `\`${d.path}\` (${d.reason})`).join("; ") || "none";
  const body = [
    "Automated OpenWiki update (WIKI-AUTO-01). Generated `openwiki/` files only; no product, runtime, test or workflow change.",
    "",
    `- Source head documented: \`${sourceHead}\` (newest production commit with a source change)`,
    `- Production tip: \`${tip}\``,
    `- Previous wiki gitHead: \`${previousGitHead}\``,
    `- Generated files: ${s.changed} (${s.added} added, ${s.modified} modified, ${s.deleted} deleted)`,
    `- Discarded generator writes: ${discardedList}`,
    "- Checks passed: generated scope, replace-not-overlay, runner authorship, `.last-update.json` gitHead equality, broken-link stamps, privacy/secret denylist, `npm run verify:prepush`",
    "",
    "The runner never merges. Merge authority stays with a human.",
  ].join("\n");
  let pr;
  try {
    pr = await github.createPullRequest({ head: branch, base: config.baseBranch, title, body });
  } catch (error) {
    // A pushed branch without a pull request would hold the in-flight slot forever.
    try {
      remoteGit(subject, ["push", "--quiet", "origin", "--delete", branch], token);
    } catch {
      // Reported below; the next run's in-flight check names the branch.
    }
    throw error;
  }
  report.publish.pr = { number: pr.number, url: pr.url };
  if (pr.headSha !== head) throw new Error("pull request head is not the commit the runner verified");
  await github.comment(pr.number, `@codex review\n\nExact head \`${head}\`.`);
  return report.publish;
}

/**
 * One runner pass. `deps`: { generator({cwd}) -> {exitCode, timedOut?, output?},
 * getGitToken?() -> token, github(token) -> client, now?() }.
 */
export async function runNightly(config, deps) {
  const report = { runId: randomUUID(), startedAt: new Date().toISOString(), discarded: [] };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const finish = (outcome, reason) => {
    Object.assign(report, { outcome, reason, finishedAt: new Date().toISOString() });
    const runs = path.join(config.stateDir, "runs");
    mkdirSync(runs, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(path.join(runs, `${report.startedAt.replace(/[:.]/gu, "-")}-${report.runId}.json`), text, { mode: 0o600 });
    writeFileSync(path.join(config.stateDir, "last-run.json"), text, { mode: 0o600 });
    return { outcome, reason, report };
  };

  if (!config.enabled) return finish("SKIP", 'HONE_WIKI_NIGHTLY is not "on"');
  if (existsSync(path.join(config.stateDir, "DISABLED"))) return finish("SKIP", "kill switch: DISABLED file is present");
  const lock = acquireLock(config.stateDir);
  if (!lock) return finish("SKIP", "another runner pass holds the lock");

  const subject = config.subjectDir;
  let tip;
  try {
    const envProblems = checkEnvironment(config.env ?? {}, config.requiredEnv ?? REQUIRED_ENV);
    if (envProblems.length > 0) return finish("PRECONDITION", envProblems.join("; "));

    let token = null;
    if (deps.getGitToken) {
      try {
        token = await deps.getGitToken();
      } catch (error) {
        return finish("PRECONDITION", `GitHub App token: ${error.message}`);
      }
    }

    tip = syncSubject(config, token);
    report.tip = tip;
    const baseline = baselineProblems(subject, tip);
    if (baseline.length > 0) return finish("PRECONDITION", baseline.join("; "));

    // Startup no-op: decide from git alone, before any model credential is touched.
    const ignore = loadOpenWikiIgnore(subject);
    let head;
    try {
      head = discoverSourceHead(subject, tip, ignore);
    } catch (error) {
      throw new PreconditionError(error.message);
    }
    report.sourceHead = head.sourceHead;
    report.skippedGeneratedCommits = head.skippedCommits.length;
    const liveness = assessLiveness(subject, {
      tip,
      sourceHead: head.sourceHead,
      lastUpdate: readJsonAtCommit(subject, tip, "openwiki/.last-update.json"),
    });
    report.liveness = liveness;
    if (liveness.state === "invalid") return finish("PRECONDITION", liveness.reason);
    if (liveness.state === "live") return finish("NOOP", "wiki is live: no source change after its recorded gitHead");

    const inFlight = unmergedNightlyBranches(subject, tip, token);
    if (inFlight.length > 0) return finish("SKIP", `unmerged nightly branch awaits a human: ${inFlight.join(", ")}`);

    const prerequisites = runPrerequisiteProblems(config);
    if (prerequisites.length > 0) return finish("PRECONDITION", prerequisites.join("; "));

    // HEAD = source head (OpenWiki records it as gitHead); tree = production tip.
    git(subject, ["reset", "--quiet", "--soft", head.sourceHead]);
    const result = await deps.generator({ cwd: subject });
    report.generator = { exitCode: result.exitCode, timedOut: Boolean(result.timedOut), outputTail: redactSecrets(result.output ?? "").slice(-4_000) };
    if (result.exitCode !== 0) {
      resetSubject(subject, tip);
      return finish("FAILED", `OpenWiki exited ${result.exitCode}${result.timedOut ? " after the run timeout" : ""}`);
    }

    if (existsSync(path.join(subject, "openwiki/.run.json"))) {
      resetSubject(subject, tip);
      return finish("FAILED", "OpenWiki left openwiki/.run.json: the run did not complete");
    }
    const scope = enforceScope(subject, tip, ignore, report);
    if (scope.unexpected.length > 0) {
      resetSubject(subject, tip);
      return finish("FAILED", `generator wrote outside the generated scope: ${scope.unexpected.map((c) => c.path).join(", ")}`);
    }
    report.generated = summarize(scope.generated);
    if (scope.generated.every((c) => RUN_METADATA_PATHS.has(c.path))) {
      resetSubject(subject, tip);
      return finish("NOOP", "OpenWiki changed only run metadata");
    }

    const checks = validateGenerated(subject, scope.generated, head.sourceHead, config);
    report.checks = { brokenLinkStamps: checks.stamps, privacyHits: checks.privacyHits };
    if (checks.problems.length > 0) {
      resetSubject(subject, tip);
      return finish("FAILED", checks.problems.join("; "));
    }

    if (!config.publish) {
      resetSubject(subject, tip);
      return finish("DRY_RUN", "checks passed; publishing is off");
    }
    // Installation tokens expire one hour after minting, and a run may take
    // longer (HONE_WIKI_RUN_TIMEOUT_MIN defaults to 90): publish with a fresh one.
    let publishToken = null;
    if (deps.getGitToken) {
      try {
        publishToken = await deps.getGitToken();
      } catch (error) {
        resetSubject(subject, tip);
        return finish("PRECONDITION", `GitHub App token before publishing: ${error.message}`);
      }
    }
    await publish({
      subject,
      tip,
      sourceHead: head.sourceHead,
      previousGitHead: liveness.gitHead,
      tree: scope.tree,
      generated: scope.generated,
      ignore,
      config,
      deps,
      token: publishToken,
      report,
    });
    resetSubject(subject, tip);
    return finish("PUBLISHED", `pull request #${report.publish.pr.number}`);
  } catch (error) {
    if (tip) resetSubject(subject, tip);
    return finish(error instanceof PreconditionError ? "PRECONDITION" : "FAILED", redactSecrets(error.message));
  } finally {
    rmSync(lock, { force: true });
  }
}

// ---------------------------------------------------------------- CLI

export function configFromEnv(env, argv = []) {
  const repository = env.HONE_WIKI_REPOSITORY;
  return {
    enabled: env.HONE_WIKI_NIGHTLY === "on",
    publish: env.HONE_WIKI_PUBLISH === "on" && !argv.includes("--no-publish"),
    repository,
    remoteUrl: `https://github.com/${repository}.git`,
    baseBranch: env.HONE_WIKI_BASE_BRANCH,
    subjectDir: env.HONE_WIKI_SUBJECT_DIR,
    stateDir: env.HONE_WIKI_STATE_DIR,
    openwikiDir: env.HONE_WIKI_OPENWIKI_DIR,
    anthropicKeyFile: env.HONE_WIKI_ANTHROPIC_API_KEY_FILE,
    denylistFile: env.HONE_WIKI_DENYLIST_FILE,
    modelId: env.OPENWIKI_MODEL_ID,
    identity: { name: env.HONE_WIKI_GIT_AUTHOR_NAME, email: env.HONE_WIKI_GIT_AUTHOR_EMAIL },
    minFreeBytes: Number(env.HONE_WIKI_MIN_FREE_GB ?? 10) * 2 ** 30,
    timeoutMs: Number(env.HONE_WIKI_RUN_TIMEOUT_MIN ?? 90) * 60_000,
    prepushCommand: ["npm", "run", "verify:prepush"],
    env,
  };
}

/**
 * Mints one installation token per call. The App private key is read on every
 * call, and refused unless only its owner can read it: a key file another
 * local account can read already lets that account mint its own tokens.
 */
export function createAppTokenSource(env, fetchImpl = fetch) {
  return async () => {
    const privateKeyPem = readOwnerOnlySecret(env.HONE_WIKI_APP_PRIVATE_KEY_FILE, "HONE_WIKI_APP_PRIVATE_KEY_FILE");
    const { token } = await createInstallationToken({
      appId: env.HONE_WIKI_APP_ID,
      installationId: env.HONE_WIKI_APP_INSTALLATION_ID,
      privateKeyPem,
      repository: env.HONE_WIKI_REPOSITORY,
      fetchImpl,
    });
    return token;
  };
}

async function main(argv) {
  const config = configFromEnv(process.env, argv);
  if (config.stateDir) {
    // Isolate every git call from the operator's global and system config,
    // in particular any credential helper that would answer with a personal token.
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const gitconfig = path.join(config.stateDir, "gitconfig");
    if (!existsSync(gitconfig)) writeFileSync(gitconfig, "", { mode: 0o600 });
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  }
  const deps = {
    getGitToken: createAppTokenSource(process.env),
    generator: ({ cwd }) => runOpenWikiProcess({ cwd, invocation: buildGeneratorInvocation(config), timeoutMs: config.timeoutMs }),
    github: (token) => createGitHubClient({ token, repository: config.repository }),
  };
  const result = config.stateDir
    ? await runNightly(config, deps)
    : { outcome: "PRECONDITION", reason: "required HONE_WIKI_STATE_DIR is not set", report: {} };
  process.stdout.write(
    `${JSON.stringify({ outcome: result.outcome, reason: result.reason, runId: result.report.runId, tip: result.report.tip, sourceHead: result.report.sourceHead, publish: result.report.publish })}\n`,
  );
  process.exitCode = EXIT_CODE[result.outcome];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${redactSecrets(error.message)}\n`);
    process.exitCode = EXIT_CODE.FAILED;
  });
}
