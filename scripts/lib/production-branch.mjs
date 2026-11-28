// The production branch is being renamed claude/build-hone-saas-hOex7 -> main (cutover plan: 01-ops/cleanup-20261127/RENAME-TO-MAIN-PLAN.md).
// Tooling that must work BEFORE and AFTER the rename asks this module which name to use, so the dual-name change can merge first.
// PURE: the caller supplies the one fact it can read (does this remote-tracking ref exist?). PR C (a few days after the rename) deletes the old name and this fallback.

export const OLD_PRODUCTION_BRANCH = "claude/build-hone-saas-hOex7";
export const NEW_PRODUCTION_BRANCH = "main";

/**
 * An explicit override (HONE_BASE_BRANCH) always wins. Otherwise `main` once it exists as a remote branch, else the old name.
 * Before the rename `origin/main` does not exist, so the answer is the old name; after it (and before a `git fetch --prune`) both exist and `main` is the live one.
 * @param {{ override?: string | null, remoteBranchExists: (name: string) => boolean }} p
 */
export function resolveProductionBranch({ override, remoteBranchExists }) {
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return remoteBranchExists(NEW_PRODUCTION_BRANCH) ? NEW_PRODUCTION_BRANCH : OLD_PRODUCTION_BRANCH;
}

/**
 * Does `origin` have this branch? Asks the remote (`git ls-remote --exit-code --heads`), so a stale local ref cannot answer.
 * Exit code 2 is git's "no matching ref": the branch is ABSENT. Any other failure (network down, auth, a missing remote: 128 and the rest) tells us nothing about the branch,
 * so it THROWS rather than reading as "absent" and silently falling back to the old name.
 * @param {(args: string[]) => unknown} run runs `git <args>` and throws the child's error (with `.status`) on a non-zero exit
 * @param {string} name
 */
export function remoteBranchExistsViaLsRemote(run, name) {
  try {
    run(["ls-remote", "--exit-code", "--heads", "origin", name]);
    return true;
  } catch (e) {
    if (e && typeof e === "object" && e.status === 2) return false;
    const why = e && typeof e === "object" && "status" in e ? `git exited ${e.status}` : e instanceof Error ? e.message : String(e);
    throw new Error(`cannot tell whether origin has ${name} (${why}): refusing to guess the production branch`);
  }
}
