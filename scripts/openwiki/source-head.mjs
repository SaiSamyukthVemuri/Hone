// ---------------------------------------------------------------------------
// WIKI-AUTO-01: which production commit is the wiki supposed to describe, and
// does openwiki/.last-update.json already describe it?
//
// The production tip is often NOT the answer. Once a nightly wiki PR merges,
// the tip is a merge commit that changed only generated files. Documenting
// "the tip" would stamp a wiki-only commit into gitHead, and the next night
// would see a new tip and regenerate for nothing. So the runner documents
// the SOURCE HEAD: the newest first-parent production commit whose own change
// touched at least one source path (scripts/openwiki/paths.mjs). Everything
// after it on the first-parent chain is generated, authored-wiki or
// .openwikiignore'd, and changes nothing OpenWiki reads.
//
// Liveness: the wiki is live when its recorded gitHead is the source head, or
// sits between the source head and the tip. In both cases no source changed
// after it. A run this runner publishes records the source head itself, so
// equality is the normal state.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { classifyPath } from "./paths.mjs";

const SHA = /^[0-9a-f]{40}$/u;

/** Run one git command in `cwd` and return stdout without its trailing newline. */
export function git(cwd, args, options = {}) {
  return execFileSync("git", ["--no-pager", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).replace(/\n$/u, "");
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

/** True when `ancestor` is reachable from `descendant`. Any other git failure throws. */
export function isAncestor(cwd, ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

export function commitExists(cwd, sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Paths one commit changed relative to its FIRST parent (all paths for a
 * root commit). Renames are split into delete + add so a move from source
 * into openwiki/ still counts its source side.
 */
export function changedPathsOfCommit(cwd, sha) {
  const parents = git(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
  if (parents.length === 0) return lines(git(cwd, ["ls-tree", "-r", "--name-only", sha]));
  return lines(git(cwd, ["diff", "--name-only", "--no-renames", parents[0], sha]));
}

/**
 * The newest first-parent commit at or below `tip` whose own change touched a
 * source path. Throws when none exists within `maxCommits`: an unbounded walk
 * is not a decision the runner may make silently.
 */
export function discoverSourceHead(cwd, tip, ignore, { maxCommits = 5000 } = {}) {
  const commits = lines(git(cwd, ["rev-list", "--first-parent", `--max-count=${maxCommits}`, tip]));
  for (let index = 0; index < commits.length; index += 1) {
    const sha = commits[index];
    const sourcePaths = changedPathsOfCommit(cwd, sha).filter((p) => classifyPath(p, ignore) === "source");
    if (sourcePaths.length > 0) {
      return { sourceHead: sha, skippedCommits: commits.slice(0, index), sourcePaths };
    }
  }
  throw new Error(`no source change within ${commits.length} first-parent commits of ${tip}`);
}

/** Parse a JSON file as it exists in `commit`; undefined when absent or unparseable. */
export function readJsonAtCommit(cwd, commit, filePath) {
  try {
    return JSON.parse(git(cwd, ["show", `${commit}:${filePath}`]));
  } catch {
    return undefined;
  }
}

/**
 * Compare openwiki/.last-update.json with the source head.
 *
 *   live    - gitHead is the source head, or a descendant of it at or below
 *             the tip: no source changed after the wiki was generated
 *   stale   - gitHead is an ancestor of the source head: source changed since
 *   invalid - missing, unfinished, not a full SHA, or not in production
 *             history: the runner cannot reason about it and must not guess
 */
export function assessLiveness(cwd, { tip, sourceHead, lastUpdate }) {
  if (!lastUpdate || typeof lastUpdate !== "object") {
    return { state: "invalid", reason: "openwiki/.last-update.json is missing or unreadable" };
  }
  if (lastUpdate.status !== "complete") {
    return { state: "invalid", reason: `previous OpenWiki run status is ${JSON.stringify(lastUpdate.status)}, not "complete"` };
  }
  const gitHead = lastUpdate.gitHead;
  if (typeof gitHead !== "string" || !SHA.test(gitHead)) {
    return { state: "invalid", reason: "recorded gitHead is not a full commit SHA" };
  }
  if (!commitExists(cwd, gitHead) || !isAncestor(cwd, gitHead, tip)) {
    return { state: "invalid", reason: "recorded gitHead is not in production history", gitHead };
  }
  if (gitHead === sourceHead) return { state: "live", gitHead };
  if (isAncestor(cwd, sourceHead, gitHead)) {
    return { state: "live", gitHead, note: "recorded after the latest source change" };
  }
  return { state: "stale", gitHead };
}
