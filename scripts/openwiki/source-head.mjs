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
  throw Object.assign(new Error("no source change within the first-parent walk"), { commitsScanned: commits.length });
}

/**
 * The tree entry for `filePath` in `commit`, or null. Existence is read from
 * the tree alone, so it never depends on what the file holds. Any git failure
 * other than "no such path" throws.
 */
function committedEntry(cwd, commit, filePath) {
  const listed = git(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", filePath]).split("\0").filter(Boolean);
  for (const line of listed) {
    const tab = line.indexOf("\t");
    const [, type, object] = line.slice(0, tab).split(" ");
    if (line.slice(tab + 1) === filePath) return { type, object };
  }
  return null;
}

/** Whether anything (a file, a directory, a link) is committed at `filePath` in `commit`. */
export function committedPathExists(cwd, commit, filePath) {
  return committedEntry(cwd, commit, filePath) !== null;
}

/**
 * A JSON state file as committed in `commit`, in one of three states:
 *
 *   absent          - nothing is committed at that path
 *   present-valid   - a file whose content parses as JSON (`value`)
 *   present-invalid - something is committed there, but it is not a file
 *                     whose content parses as JSON
 *
 * Malformed content is never reported as absent.
 */
export function readCommittedState(cwd, commit, filePath) {
  const entry = committedEntry(cwd, commit, filePath);
  if (!entry) return { state: "absent" };
  if (entry.type !== "blob") return { state: "present-invalid" };
  try {
    return { state: "present-valid", value: JSON.parse(git(cwd, ["cat-file", "blob", entry.object])) };
  } catch {
    return { state: "present-invalid" };
  }
}

/** Why a committed .last-update.json cannot be assessed. */
export const LIVENESS_PROBLEMS = Object.freeze([
  "missing",
  "malformed",
  "not-an-object",
  "status-not-complete",
  "git-head-not-full-sha",
  "git-head-not-in-history",
]);

/**
 * Compare openwiki/.last-update.json, as `readCommittedState` read it at the
 * tip, with the source head.
 *
 *   live    - gitHead is the source head, or a descendant of it at or below
 *             the tip: no source changed after the wiki was generated
 *   stale   - gitHead is an ancestor of the source head: source changed since
 *   invalid - missing, malformed, unfinished, not a full SHA, or not in
 *             production history: the runner cannot reason about it and must
 *             not guess. `problem` says which, as a LIVENESS_PROBLEMS code.
 */
export function assessLiveness(cwd, { tip, sourceHead, lastUpdate }) {
  if (lastUpdate?.state === "absent") return { state: "invalid", problem: "missing" };
  if (lastUpdate?.state !== "present-valid") return { state: "invalid", problem: "malformed" };
  const metadata = lastUpdate.value;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return { state: "invalid", problem: "not-an-object" };
  if (metadata.status !== "complete") return { state: "invalid", problem: "status-not-complete" };
  const gitHead = metadata.gitHead;
  if (typeof gitHead !== "string" || !SHA.test(gitHead)) return { state: "invalid", problem: "git-head-not-full-sha" };
  if (!commitExists(cwd, gitHead) || !isAncestor(cwd, gitHead, tip)) {
    return { state: "invalid", problem: "git-head-not-in-history", gitHead };
  }
  if (gitHead === sourceHead) return { state: "live", gitHead };
  if (isAncestor(cwd, sourceHead, gitHead)) return { state: "live", gitHead, note: "recorded-after-source-change" };
  return { state: "stale", gitHead };
}
