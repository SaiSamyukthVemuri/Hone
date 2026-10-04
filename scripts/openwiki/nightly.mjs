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
//     overlay onto an older wiki. A run that changed only run metadata is
//     published too: repository state is the cursor, so the processed source
//     head must become durable. It opens one pull request. It never merges.
//   * Every failure publishes nothing and resets the subject checkout.
//
// TRUST BOUNDARY. This runner holds the GitHub App key and the model key, and
// anything it starts runs as the same user: such a process can read
// /proc/$PPID/environ and the key files named there. So the runner NEVER
// executes code from the subject repository. That rules out package scripts,
// repository scripts and `npm run verify:prepush`. It reads the subject only as
// data, through git and the filesystem. CLAUDE.md's delivery steps 1-6 and 8
// run as written. Step 7 is replaced by trusted structural checks on that data
// (publish below). Repository-controlled verification (the test suites,
// verify:prepush, migration state) runs in PR CI, where these credentials are
// absent.
//
// REPORTING BOUNDARY. Nothing here writes text to a report, the CLI or GitHub.
// A pass ends with reason CODES from report.mjs's closed catalog, plus details
// that are counts, flags and validated identifiers. report.mjs renders every
// sentence and is the only sink. Pathnames reach it only after the path gate
// (guards.mjs gateChangedPaths) cleared every path the run changed. An error
// with no catalog code is reported by the step it happened in, never by its
// message.
//
// Outcomes and exit codes: SKIP, NOOP, DRY_RUN and PUBLISHED exit 0; FAILED
// exits 1; PRECONDITION exits 2 because a human has to change something.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KNOWN_ENV_NAMES, MAX_TIMER_MS, REQUIRED_ENV, checkEnvironment, runLimits } from "./environment.mjs";
import { createGitHubClient, createInstallationToken } from "./github-app.mjs";
import {
  PRIVACY_CATEGORIES,
  PROVENANCE_PROBLEMS,
  checkCommitAuthors,
  checkLastUpdate,
  checkManagedBlockMarkers,
  checkPageManifest,
  checkProvenance,
  diffTrees,
  discardChanges,
  findBrokenLinkStamps,
  findConflictMarkers,
  gateChangedPaths,
  inspectWorkflow,
  metadataPrivacyItems,
  parseDenylist,
  parseTenantRegister,
  privacyItemsFor,
  readWorktreeFile,
  readWorktreeState,
  scanPrivacy,
  snapshotWorktree,
  sortRunChanges,
  worktreePathExists,
} from "./guards.mjs";
import { OPENWIKI_VERSION, OPENWIKI_WORKFLOW_PATH, RUN_METADATA_PATHS, classifyPath, loadOpenWikiIgnore } from "./paths.mjs";
import {
  CodedError,
  NIGHTLY_BRANCH,
  NIGHTLY_BRANCH_PREFIX,
  TOKEN_CAUSES,
  nightlyBranchName,
  persistableReport,
  renderPublishText,
  renderReviewRequest,
} from "./report.mjs";
import { assessLiveness, commitExists, committedPathExists, discoverSourceHead, git, isAncestor, readCommittedState } from "./source-head.mjs";

export { FORBIDDEN_ENV, FORBIDDEN_ENV_PREFIXES, OPTIONAL_ENV, REQUIRED_ENV, checkEnvironment } from "./environment.mjs";
export { NIGHTLY_BRANCH_PREFIX, OPENWIKI_VERSION };
export const EXIT_CODE = Object.freeze({ SKIP: 0, NOOP: 0, DRY_RUN: 0, PUBLISHED: 0, FAILED: 1, PRECONDITION: 2 });

const SHA = /^[0-9a-f]{40}$/u;

/** One catalog reason (report.mjs REASONS). */
const reason = (code, details = {}) => ({ code, details });

// ---------------------------------------------------------------- small helpers

/** Where this runner's own code lives. It must never be inside the subject clone. */
const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));

function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The run lock holds the owning pid. A lock whose owner is gone is taken over.
 * A lock that holds no pid is not treated as absent: it is reported, and a
 * human removes it.
 */
function acquireLock(stateDir) {
  const file = path.join(stateDir, "run.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return { file };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const lock = readWorktreeFile(stateDir, "run.lock");
    if (lock.state === "absent") continue; // released between the two calls
    const pid = lock.state === "present-valid" && /^\d{1,10}$/u.test(lock.text.trim()) ? Number(lock.text.trim()) : 0;
    if (pid <= 0) return { held: "LOCK_UNREADABLE" };
    if (processAlive(pid)) return { held: "LOCK_HELD" };
    rmSync(file, { force: true });
  }
  return { held: "LOCK_HELD" };
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
  if (!privateFile(filePath)) {
    throw Object.assign(new Error(`${name} must exist and be readable by its owner only`), { tokenCause: "key-file-not-owner-only", envName: name });
  }
  return readFileSync(filePath, "utf8");
}

/** The runner's private HOME: OpenWiki's config dir and an empty git config live here. */
function runnerHome(config) {
  const home = path.join(config.stateDir, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * The base environment for the one child the runner starts besides git: the
 * pinned OpenWiki CLI, from the runner's tools directory, never from the
 * subject. It holds no GitHub credential, no credential path and no App
 * identifier. This is hygiene, not the trust boundary: a same-user child can
 * still read /proc/$PPID/environ, which is why no subject code is ever started
 * (see the header).
 */
export function isolatedChildEnv(config) {
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

// ---------------------------------------------------------------- the generator

/** The only OpenWiki invocation the runner makes. There is no mode parameter: init is unreachable. */
export function buildGeneratorInvocation(config) {
  const base = isolatedChildEnv(config);
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

/**
 * Runs OpenWiki and drains its stdout/stderr without keeping them. That output
 * is untrusted repository and model text (it can carry names, tenant slugs,
 * contact details or credential-shaped strings), so only its size and SHA-256
 * leave this function. Nothing is forwarded to the runner's own stdout either.
 */
export function runOpenWikiProcess({ cwd, invocation, timeoutMs }) {
  return new Promise((resolve) => {
    const digest = createHash("sha256");
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const child = spawn(invocation.command, invocation.args, { cwd, env: invocation.env, stdio: ["ignore", "pipe", "pipe"] });
    const absorb = (chunk) => {
      outputBytes += chunk.length;
      digest.update(chunk);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    const done = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, outputBytes, outputSha256: digest.digest("hex") });
    };
    child.on("error", () => done(1));
    child.on("close", (code) => done(code ?? 1));
  });
}

/**
 * The only facts about a generator run that are persisted: exit code, timeout,
 * and the size and SHA-256 of its output. The output itself never reaches a
 * report or the CLI result.
 */
export function generatorDiagnostics(result) {
  const output = typeof result.output === "string" ? result.output : undefined;
  const hashOf = (text) => createHash("sha256").update(text).digest("hex");
  return {
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : 1,
    timedOut: Boolean(result.timedOut),
    outputBytes: output !== undefined ? Buffer.byteLength(output) : (result.outputBytes ?? 0),
    outputSha256: output !== undefined ? hashOf(output) : (result.outputSha256 ?? hashOf("")),
  };
}

// ---------------------------------------------------------------- run steps

function syncSubject(config, token) {
  const subject = config.subjectDir;
  if (!existsSync(path.join(subject, ".git"))) {
    mkdirSync(path.dirname(subject), { recursive: true });
    remoteGit(path.dirname(subject), ["clone", "--quiet", "--no-checkout", "--no-tags", config.remoteUrl, subject], token);
  }
  if (git(subject, ["remote", "get-url", "origin"]) !== config.remoteUrl) throw new CodedError("SUBJECT_ORIGIN_MISMATCH");
  const base = config.baseBranch;
  remoteGit(subject, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], token);
  const tip = git(subject, ["rev-parse", `refs/remotes/origin/${base}^{commit}`]);
  git(subject, ["checkout", "--quiet", "--detach", "--force", tip]);
  git(subject, ["reset", "--quiet", "--hard", tip]);
  git(subject, ["clean", "-ffdxq"]);
  if (git(subject, ["status", "--porcelain", "--untracked-files=all"]) !== "") throw new CodedError("SUBJECT_NOT_CLEAN");
  return tip;
}

/**
 * Committed state OpenWiki would choke on, or that must never be committed.
 * openwiki/.run.json is transient: committed at all, parseable or not, it
 * stops the pass. Its existence is read from the tree, never by parsing it.
 */
function baselineProblems(subject, tip) {
  const reasons = [];
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const read = readWorktreeFile(subject, file);
    if (read.state === "present-valid") reasons.push(...checkManagedBlockMarkers(file, read.text));
  }
  if (committedPathExists(subject, tip, OPENWIKI_WORKFLOW_PATH)) reasons.push(reason("WORKFLOW_SCAFFOLD_COMMITTED"));
  if (committedPathExists(subject, tip, "openwiki/.run.json")) reasons.push(reason("COMMITTED_RUN_STATE_PRESENT"));
  return reasons;
}

/**
 * Nightly branches on the remote that production does not contain: at most
 * one run in flight. A branch counts whatever its name. Only a name in the
 * runner's own format is reported; any other `openwiki/nightly-*` name is
 * remote state the runner does not own, so it is only counted.
 */
function unmergedNightlyBranches(subject, tip, token) {
  // List every head and filter here: ls-remote patterns match ref-name tails,
  // which is not the same thing as a prefix.
  const prefix = `refs/heads/${NIGHTLY_BRANCH_PREFIX}`;
  const branches = [];
  let unrecognized = 0;
  for (const line of remoteGit(subject, ["ls-remote", "--heads", "origin"], token).split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    if (typeof ref !== "string" || !ref.startsWith(prefix)) continue;
    const branch = ref.slice("refs/heads/".length);
    if (!SHA.test(sha)) {
      unrecognized += 1; // cannot be shown to be merged, so it is in flight
      continue;
    }
    if (!commitExists(subject, sha)) {
      remoteGit(subject, ["fetch", "--quiet", "--no-tags", "origin", `+${ref}:refs/remotes/origin/${branch}`], token);
    }
    if (isAncestor(subject, sha, tip)) continue;
    if (NIGHTLY_BRANCH.test(branch)) branches.push(branch);
    else unrecognized += 1;
  }
  return { branches, unrecognized };
}

/**
 * What a run needs before it may start, and the privacy terms every scan uses.
 * An empty denylist or an unreadable tenant register would silently turn a
 * privacy scan into a no-op, so each stops the pass instead.
 */
function runPrerequisites(config, subject) {
  const reasons = [];
  const pkg = readWorktreeState(config.openwikiDir, "package.json");
  if (pkg.state === "absent") reasons.push(reason("OPENWIKI_INSTALL_MISSING"));
  else if (pkg.state === "present-invalid") reasons.push(reason("OPENWIKI_INSTALL_MALFORMED"));
  else if (pkg.value?.name !== "openwiki" || pkg.value?.version !== OPENWIKI_VERSION) reasons.push(reason("OPENWIKI_VERSION_MISMATCH"));
  if (!existsSync(path.join(config.openwikiDir, "dist", "cli", "cli.js"))) reasons.push(reason("OPENWIKI_CLI_MISSING"));
  // The OpenWiki child runs on this same node (buildGeneratorInvocation uses
  // process.execPath). `config.nodeVersion` exists so tests on another node can
  // exercise the rule; the CLI never sets it.
  const [major, minor] = String(config.nodeVersion ?? process.versions.node).split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 22)) reasons.push(reason("NODE_TOO_OLD"));
  if (!privateFile(config.anthropicKeyFile)) reasons.push(reason("MODEL_KEY_FILE_NOT_OWNER_ONLY"));
  else if (!readFileSync(config.anthropicKeyFile, "utf8").trim()) reasons.push(reason("MODEL_KEY_FILE_EMPTY"));
  let denylistTerms = [];
  if (!privateFile(config.denylistFile)) reasons.push(reason("DENYLIST_FILE_NOT_OWNER_ONLY"));
  else {
    denylistTerms = parseDenylist(readFileSync(config.denylistFile, "utf8"));
    if (denylistTerms.length === 0) reasons.push(reason("DENYLIST_EMPTY"));
  }
  const registerFile = readWorktreeFile(subject, "docs/production/current-state.md");
  const register = registerFile.state === "present-valid" ? parseTenantRegister(registerFile.text) : { found: false, slugs: [] };
  if (!register.found || register.slugs.length === 0) reasons.push(reason("TENANT_REGISTER_UNREADABLE"));
  if (!String(config.modelId ?? "").trim()) reasons.push(reason("MODEL_ID_EMPTY"));
  // The limits again, as the config carries them: a NaN floor would make the
  // disk comparison always pass, and a bad timeout would end the run at once.
  if (!(Number.isFinite(config.minFreeBytes) && config.minFreeBytes > 0)) reasons.push(reason("RUN_LIMIT_INVALID", { name: "HONE_WIKI_MIN_FREE_GB" }));
  else {
    const fs = statfsSync(config.stateDir);
    if (fs.bavail * fs.bsize < config.minFreeBytes) reasons.push(reason("LOW_DISK"));
  }
  if (!(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 && config.timeoutMs <= MAX_TIMER_MS)) {
    reasons.push(reason("RUN_LIMIT_INVALID", { name: "HONE_WIKI_RUN_TIMEOUT_MIN" }));
  }
  return { reasons, terms: { denylistTerms, tenantSlugs: register.slugs } };
}

/**
 * Split the run's GATED changes by owner, discard everything outside the
 * generated scope, and record what was discarded and why. Every path here has
 * already been cleared by the path gate. Returns the post-discard snapshot
 * tree.
 */
function enforceScope(subject, tip, changes, ignore, report) {
  const sorted = sortRunChanges(changes, ignore);
  for (const change of sorted.sideEffects) {
    const entry = { path: change.path, status: change.status, kind: change.kind, reasonCode: "KNOWN_SIDE_EFFECT" };
    if (change.path === OPENWIKI_WORKFLOW_PATH && change.status !== "D") {
      const violations = inspectWorkflow(readFileSync(path.join(subject, change.path), "utf8"));
      entry.reasonCode = violations.length > 0 ? "WORKFLOW_SCAFFOLD_FAILS_INSPECTION" : "WORKFLOW_SCAFFOLD";
      entry.workflowInspection = violations;
    }
    report.discarded.push(entry);
  }
  for (const change of sorted.unexpected) {
    report.discarded.push({ path: change.path, status: change.status, kind: change.kind, reasonCode: "UNEXPECTED_WRITE" });
  }
  discardChanges(subject, tip, [...sorted.sideEffects, ...sorted.unexpected]);
  const tree = snapshotWorktree(subject, tip);
  // What survives the discard must be exactly the generated changes the gate saw.
  const expected = new Set(sorted.generated.map((c) => `${c.status}\0${c.path}`));
  const after = diffTrees(subject, tip, tree);
  if (after.length !== expected.size || after.some((c) => !expected.has(`${c.status}\0${c.path}`))) throw new CodedError("SCOPE_DISCARD_INCOMPLETE");
  return { tree, generated: sorted.generated, unexpected: sorted.unexpected };
}

/**
 * The checks on what the run generated, in order: run metadata, the page
 * manifest as a state invariant (present, parseable, OpenWiki's schema; on
 * every run, a metadata-only one included), page content, page/Claim
 * provenance for changed pages and deleted-page leftovers, then the content
 * privacy scan. Every finding is a code with a cleared path at most.
 */
function validateGenerated(subject, generated, sourceHead, terms) {
  const reasons = [];
  const checks = { lastUpdate: [], manifest: [], brokenLinkStamps: [], conflictMarkers: [], provenance: [], privacyHits: [] };

  const lastUpdate = readWorktreeState(subject, "openwiki/.last-update.json");
  checks.lastUpdate = checkLastUpdate(lastUpdate, sourceHead);
  if (checks.lastUpdate.length > 0) reasons.push(reason("LAST_UPDATE_INVALID", { problems: checks.lastUpdate }));

  const manifest = readWorktreeState(subject, "openwiki/.page-manifest.json");
  checks.manifest = checkPageManifest(manifest);
  if (checks.manifest.length > 0) reasons.push(reason("MANIFEST_INVALID", { problems: checks.manifest }));

  const items = [];
  const unreadableSidecars = [];
  for (const change of generated) {
    if (change.status === "D") continue;
    const content = readFileSync(path.join(subject, change.path), "utf8");
    if (change.path.endsWith(".md")) {
      for (const line of findBrokenLinkStamps(content)) checks.brokenLinkStamps.push({ file: change.path, line });
    }
    for (const line of findConflictMarkers(content)) checks.conflictMarkers.push({ file: change.path, line });
    try {
      items.push(...privacyItemsFor(change.path, content));
    } catch {
      unreadableSidecars.push({ file: change.path, problem: "sidecar-not-json" });
    }
  }
  if (checks.brokenLinkStamps.length > 0) reasons.push(reason("BROKEN_LINK_STAMPS", { count: checks.brokenLinkStamps.length }));
  if (checks.conflictMarkers.length > 0) reasons.push(reason("CONFLICT_MARKERS", { count: checks.conflictMarkers.length }));

  // Provenance reads the validated manifest; a manifest that failed its schema has already failed the run.
  const provenance = checks.manifest.length === 0 ? checkProvenance(subject, generated, manifest.value.pages) : [];
  const seen = new Set();
  for (const finding of [...unreadableSidecars, ...provenance]) {
    const key = `${finding.file}\0${finding.problem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checks.provenance.push(finding);
  }
  if (checks.provenance.length > 0) {
    const problems = PROVENANCE_PROBLEMS.filter((code) => checks.provenance.some((p) => p.problem === code));
    reasons.push(reason("PROVENANCE_INVALID", { count: checks.provenance.length, problems }));
  }

  // Run metadata is published too: its free-text values go through the same scan.
  items.push(...metadataPrivacyItems(lastUpdate, manifest));
  checks.privacyHits = scanPrivacy(items, terms);
  if (checks.privacyHits.length > 0) {
    const categories = PRIVACY_CATEGORIES.filter((category) => checks.privacyHits.some((hit) => hit.category === category));
    reasons.push(reason("CONTENT_PRIVACY_HITS", { hits: checks.privacyHits.length, categories }));
  }
  return { reasons, checks };
}

function summarize(generated) {
  const count = (s) => generated.filter((c) => c.status === s).length;
  return { changed: generated.length, added: count("A"), modified: count("M"), deleted: count("D") };
}

/** A trusted structural check on the publish commit: a coded failure, never a git message. */
function trusted(check, holds) {
  if (!holds) throw new CodedError("PUBLISH_CHECK_FAILED", { check });
}

function gitCheck(subject, args, check) {
  try {
    git(subject, args);
  } catch {
    throw new CodedError("PUBLISH_CHECK_FAILED", { check });
  }
}

async function publish({ subject, tip, sourceHead, previousGitHead, tree, generated, metadataOnly, ignore, config, deps, token, report, clearedPaths, at }) {
  at("publish-commit");
  const branch = nightlyBranchName(deps.now ? deps.now() : Date.now(), sourceHead);
  // Rendered before anything is committed: every word comes from validated values (report.mjs).
  const text = renderPublishText(
    { sourceHead, tip, previousGitHead, generated: summarize(generated), metadataOnly, discarded: report.discarded },
    { clearedPaths },
  );
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

  // CLAUDE.md "Follow this sequence before every push": steps 1-6, in order.
  git(subject, ["add", "-A"]);
  gitCheck(subject, ["diff", "--cached", "--check"], "diff-check");
  const staged = git(subject, ["status", "--porcelain", "--untracked-files=all"]);
  trusted("untracked-not-staged", !staged.split("\n").some((line) => line.startsWith("??")));
  git(subject, ["commit", "--quiet", "--no-verify", "-m", text.title, "-m", text.commitBody], { env });
  trusted("worktree-not-clean", git(subject, ["status", "--porcelain", "--untracked-files=all"]) === "");
  gitCheck(subject, ["diff", "HEAD", "--exit-code"], "worktree-not-head");

  // Step 7 is NOT `npm run verify:prepush`: that is subject code, and the
  // runner never executes subject code (see the header). These are trusted
  // structural checks over the commit as data. The repository's own
  // verification runs in PR CI, without these credentials.
  const head = git(subject, ["rev-parse", "HEAD"]);
  gitCheck(subject, ["diff", "--cached", "--exit-code"], "index-not-head"); // index == HEAD (with the step above: worktree == index == HEAD)
  gitCheck(subject, ["diff", "--check", tip, head], "diff-check"); // whitespace errors and conflict markers, as git defines them
  const parents = git(subject, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
  trusted("not-single-child-of-tip", parents.length === 1 && parents[0] === tip);
  trusted("leaves-generated-scope", diffTrees(subject, tip, head).every((c) => classifyPath(c.path, ignore) === "generated"));
  trusted("not-replace-exact", git(subject, ["rev-parse", `${head}:openwiki`]) === git(subject, ["rev-parse", `${tree}:openwiki`]));
  const authors = checkCommitAuthors(subject, `${tip}..${head}`, identity);
  trusted("author-mismatch", authors.commits === 1 && authors.mismatched === 0);

  // Production must still be exactly the tip this run was pinned to. A run can
  // take an hour or more; publishing a stale run would open a clean-looking PR
  // that omits commits already on production.
  at("publish-push");
  const baseRef = `refs/heads/${config.baseBranch}`;
  const remote = remoteGit(subject, ["ls-remote", "origin", baseRef], token)
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, ref]) => ref === baseRef)?.[0];
  if (remote !== tip) throw new CodedError("BASE_MOVED", { pinnedTip: tip, remoteTip: SHA.test(remote ?? "") ? remote : undefined });
  // --no-verify: no hook runs either (the clone's hooks are git's inactive samples).
  remoteGit(subject, ["push", "--quiet", "--no-verify", "origin", `${head}:refs/heads/${branch}`], token);
  report.publish = { branch, head };

  at("pull-request");
  const github = deps.github(token);
  let pr;
  try {
    pr = await github.createPullRequest({ head: branch, base: config.baseBranch, title: text.title, body: text.body });
  } catch (error) {
    // A pushed branch without a pull request would hold the in-flight slot forever.
    // If the delete fails (or the branch moved), the next run's in-flight check counts it.
    const branchState = deleteOwnBranch(subject, branch, head, token);
    throw new CodedError("PULL_REQUEST_CREATE_FAILED", { httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : undefined, branchState });
  }
  if (!Number.isSafeInteger(pr?.number) || pr.number <= 0) {
    throw new CodedError("PULL_REQUEST_CREATE_FAILED", { invalidResponse: true, branchState: deleteOwnBranch(subject, branch, head, token) });
  }
  report.publish.pr = { number: pr.number };

  // From here a pull request exists. It counts as published only when its
  // head is exactly the verified commit AND its exact-head review request was
  // posted. Any failure before that closes it and deletes its branch, or it
  // would hold the single-flight slot and could be merged without that review.
  at("review-request");
  let failure = "head-mismatch";
  try {
    if (pr.headSha !== head) throw new Error("pull request head is not the commit the runner verified");
    failure = "review-request-failed";
    await github.comment(pr.number, renderReviewRequest(head));
  } catch {
    at("cleanup");
    const cleanup = await cleanUpCreatedPullRequest({ github, number: pr.number, subject, branch, head, token });
    Object.assign(report.publish, { failure, cleanup });
    throw new CodedError(failure === "head-mismatch" ? "PULL_REQUEST_HEAD_MISMATCH" : "REVIEW_REQUEST_FAILED", {
      number: pr.number,
      branch,
      pullRequest: cleanup.pullRequest,
      branchState: cleanup.branch,
    });
  }
  return report.publish;
}

/**
 * Best-effort cleanup of a pull request that could not be completed. Both
 * steps are always attempted, whatever the other does, and each reports a
 * state only, never an error text.
 */
async function cleanUpCreatedPullRequest({ github, number, subject, branch, head, token }) {
  const cleanup = { pullRequest: "closed", branch: "deleted" };
  try {
    await github.closePullRequest(number);
  } catch {
    cleanup.pullRequest = "close-failed";
  }
  cleanup.branch = deleteOwnBranch(subject, branch, head, token);
  return cleanup;
}

/**
 * Delete the runner's nightly branch only while it still points at the commit
 * this pass pushed. `--force-with-lease=<ref>:<head>` makes the push fail if
 * the remote ref moved, so a newer commit someone else added is never deleted.
 */
function deleteOwnBranch(subject, branch, head, token) {
  try {
    remoteGit(subject, ["push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${branch}:${head}`, "origin", `:refs/heads/${branch}`], token);
    return "deleted";
  } catch {
    return "delete-failed";
  }
}

/** A failure to mint an installation token, by cause. The error's message is never read. */
function tokenFailure(phase, error) {
  const cause = TOKEN_CAUSES.includes(error?.tokenCause) ? error.tokenCause : "unknown";
  return reason("APP_TOKEN_UNAVAILABLE", {
    phase,
    cause,
    httpStatus: cause === "http-status" && Number.isSafeInteger(error.httpStatus) ? error.httpStatus : undefined,
    name: cause === "key-file-not-owner-only" && KNOWN_ENV_NAMES.includes(error.envName) ? error.envName : undefined,
  });
}

/** An error with no catalog code: the step it ended, a system error code and an exit status at most. */
function unexpectedError(step, error) {
  return reason("UNEXPECTED_ERROR", {
    step,
    errorCode: typeof error?.code === "string" && /^E[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : undefined,
    exitStatus: Number.isSafeInteger(error?.status) ? error.status : undefined,
  });
}

/** The single line the CLI prints, from the report as the sink renders it: never generator output or error text. */
export function cliSummary(result) {
  const report = persistableReport(result?.report ?? {});
  const { outcome, reasonCode, reason: text, runId, tip, sourceHead, publish: published } = report;
  return JSON.stringify({ outcome, reasonCode, reason: text, runId, tip, sourceHead, publish: published });
}

/**
 * One runner pass. `deps`: { generator({cwd}) -> {exitCode, timedOut?, output? | outputBytes?, outputSha256?},
 * getGitToken?() -> token, github(token) -> client, now?() }.
 */
export async function runNightly(config, deps) {
  const report = { runId: randomUUID(), startedAt: new Date().toISOString(), discarded: [] };
  let clearedPaths = new Set();
  let step = "start";
  const at = (name) => {
    step = name;
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  /** Accepts catalog reasons only. The persisted and returned report is the sink's (report.mjs). */
  const finish = (reasons) => {
    const persisted = persistableReport({ ...report, reasons, finishedAt: new Date().toISOString() }, { clearedPaths });
    const runs = path.join(config.stateDir, "runs");
    mkdirSync(runs, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(persisted, null, 2)}\n`;
    writeFileSync(path.join(runs, `${report.startedAt.replace(/[:.]/gu, "-")}-${report.runId}.json`), text, { mode: 0o600 });
    writeFileSync(path.join(config.stateDir, "last-run.json"), text, { mode: 0o600 });
    return { outcome: persisted.outcome, reasonCode: persisted.reasonCode, reason: persisted.reason, report: persisted };
  };

  if (!config.enabled) return finish(reason("NIGHTLY_DISABLED"));
  if (existsSync(path.join(config.stateDir, "DISABLED"))) return finish(reason("KILL_SWITCH"));
  const lock = acquireLock(config.stateDir);
  if (lock.held) return finish(reason(lock.held));

  const subject = config.subjectDir;
  let tip;
  try {
    at("environment");
    const envProblems = checkEnvironment(config.env ?? {}, config.requiredEnv ?? REQUIRED_ENV);
    if (envProblems.length > 0) return finish(envProblems);
    // The runner's code must come from a pinned checkout, never from the
    // subject it resets and documents (config.runnerDir exists for tests).
    if (isInside(realOrResolved(config.runnerDir ?? RUNNER_DIR), realOrResolved(subject))) return finish(reason("RUNNER_INSIDE_SUBJECT"));

    at("token");
    let token = null;
    if (deps.getGitToken) {
      try {
        token = await deps.getGitToken();
      } catch (error) {
        return finish(tokenFailure("start", error));
      }
    }

    at("sync");
    tip = syncSubject(config, token);
    report.tip = tip;
    at("baseline");
    const baseline = baselineProblems(subject, tip);
    if (baseline.length > 0) return finish(baseline);

    // Startup no-op: decide from git alone, before any model credential is touched.
    at("source-head");
    const ignore = loadOpenWikiIgnore(subject);
    let head;
    try {
      head = discoverSourceHead(subject, tip, ignore);
    } catch (error) {
      if (Number.isSafeInteger(error?.commitsScanned)) return finish(reason("SOURCE_HEAD_NOT_FOUND", { commitsScanned: error.commitsScanned }));
      throw error;
    }
    report.sourceHead = head.sourceHead;
    report.skippedGeneratedCommits = head.skippedCommits.length;
    at("liveness");
    const liveness = assessLiveness(subject, { tip, sourceHead: head.sourceHead, lastUpdate: readCommittedState(subject, tip, "openwiki/.last-update.json") });
    report.liveness = liveness;
    if (liveness.state === "invalid") return finish(reason("LIVENESS_INVALID", { problem: liveness.problem }));
    if (liveness.state === "live") return finish(reason("WIKI_LIVE", { gitHead: liveness.gitHead }));

    at("in-flight");
    const inFlight = unmergedNightlyBranches(subject, tip, token);
    if (inFlight.branches.length > 0 || inFlight.unrecognized > 0) return finish(reason("IN_FLIGHT_RUN_EXISTS", inFlight));

    at("prerequisites");
    const prerequisites = runPrerequisites(config, subject);
    if (prerequisites.reasons.length > 0) return finish(prerequisites.reasons);

    // HEAD = source head (OpenWiki records it as gitHead); tree = production tip.
    at("generate");
    git(subject, ["reset", "--quiet", "--soft", head.sourceHead]);
    const result = await deps.generator({ cwd: subject });
    report.generator = generatorDiagnostics(result);
    if (result.exitCode !== 0) {
      resetSubject(subject, tip);
      return finish(reason("GENERATOR_EXIT_NONZERO", { exitCode: report.generator.exitCode, timedOut: report.generator.timedOut }));
    }
    if (worktreePathExists(subject, "openwiki/.run.json")) {
      resetSubject(subject, tip);
      return finish(reason("RUN_STATE_LEFT_BEHIND"));
    }

    // THE PATH GATE, before any changed path is recorded, reported or
    // interpolated: every path the run changed, whatever its owner or status.
    at("scope");
    const changes = diffTrees(subject, tip, snapshotWorktree(subject, tip));
    const gate = gateChangedPaths(changes, prerequisites.terms);
    report.pathGate = { scanned: gate.scanned, rejected: gate.rejected, categories: gate.categories };
    if (gate.rejected > 0) {
      resetSubject(subject, tip);
      return finish(reason("PATH_PRIVACY_REJECTED", { paths: gate.rejected, categories: gate.categories }));
    }
    clearedPaths = gate.cleared;
    const scope = enforceScope(subject, tip, changes, ignore, report);
    if (scope.unexpected.length > 0) {
      resetSubject(subject, tip);
      return finish(reason("UNEXPECTED_GENERATOR_WRITE", { paths: scope.unexpected.length }));
    }
    report.generated = summarize(scope.generated);
    // A run that changed only run metadata still processed a new source head.
    // Repository state is the cursor, so it is validated and published like any
    // other run; discarding it would make every later pass regenerate the same
    // source. (No output at all fails the gitHead equality check below.)
    const metadataOnly = scope.generated.every((c) => RUN_METADATA_PATHS.has(c.path));
    report.metadataOnly = metadataOnly;

    at("validate");
    const checks = validateGenerated(subject, scope.generated, head.sourceHead, prerequisites.terms);
    report.checks = checks.checks;
    if (checks.reasons.length > 0) {
      resetSubject(subject, tip);
      return finish(checks.reasons);
    }

    if (!config.publish) {
      resetSubject(subject, tip);
      return finish(reason("PUBLISHING_OFF", { metadataOnly }));
    }
    // Installation tokens expire one hour after minting, and a run may take
    // longer (HONE_WIKI_RUN_TIMEOUT_MIN defaults to 90): publish with a fresh one.
    at("publish-token");
    let publishToken = null;
    if (deps.getGitToken) {
      try {
        publishToken = await deps.getGitToken();
      } catch (error) {
        resetSubject(subject, tip);
        return finish(tokenFailure("publish", error));
      }
    }
    await publish({
      subject,
      tip,
      sourceHead: head.sourceHead,
      previousGitHead: liveness.gitHead,
      tree: scope.tree,
      generated: scope.generated,
      metadataOnly,
      ignore,
      config,
      deps,
      token: publishToken,
      report,
      clearedPaths,
      at,
    });
    resetSubject(subject, tip);
    return finish(reason("PULL_REQUEST_OPENED", { number: report.publish.pr.number, metadataOnly }));
  } catch (error) {
    if (tip) resetSubject(subject, tip);
    return finish(error instanceof CodedError ? reason(error.reasonCode, error.safeDetails) : unexpectedError(step, error));
  } finally {
    rmSync(lock.file, { force: true });
  }
}

// ---------------------------------------------------------------- CLI

export function configFromEnv(env, argv = []) {
  const repository = env.HONE_WIKI_REPOSITORY;
  // Validated before any conversion; an invalid limit is null here and
  // PRECONDITION in checkEnvironment, by name only.
  const limits = runLimits(env);
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
    minFreeBytes: limits.minFreeBytes,
    timeoutMs: limits.timeoutMs,
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
  const result = config.stateDir ? await runNightly(config, deps) : { report: persistableReport({ reasons: reason("STATE_DIR_MISSING") }) };
  const summary = persistableReport(result.report);
  process.stdout.write(`${cliSummary(result)}\n`);
  process.exitCode = EXIT_CODE[summary.outcome];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // Outside a pass there is no report to write; the line printed is still the sink's.
    process.stdout.write(`${cliSummary({ report: persistableReport({ reasons: unexpectedError("start", error) }) })}\n`);
    process.exitCode = EXIT_CODE.FAILED;
  });
}
