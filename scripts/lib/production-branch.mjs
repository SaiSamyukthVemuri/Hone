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
