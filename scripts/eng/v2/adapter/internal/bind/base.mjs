// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, row 2: bind the production base and drift to K0
// (SPEC-05A §2.6). Pure. Called for OPEN keys only.
// ---------------------------------------------------------------------------

import { fail, okValue } from "../../../contract/strict.mjs";

export function bindBase({ key, productionRef, compare, prContext }) {
  try {
    if (!key || key.state !== "OPEN") return fail("malformed", "bindBase binds open pull requests only");
    if (key.baseRef !== productionRef) {
      return fail("base_ref", `the pull request targets ${key.baseRef}, not the production ref`);
    }
    if (compare.baseSha !== key.baseSha) return fail("malformed", "the compare is not bound to K0's live base tip");
    return okValue({
      drift: { behindBy: compare.behindBy, aheadBy: compare.aheadBy },
      mergeBaseSha: compare.mergeBaseSha,
      files: [...compare.files],
      filesCapped: compare.filesCapped,
      changedFiles: prContext.changedFiles,
      createdAt: prContext.createdAt,
      baseRefChanges: prContext.baseRefChanges,
      associatedPrNumbers: Array.isArray(prContext.associatedPrNumbers)
        ? [...prContext.associatedPrNumbers]
        : prContext.associatedPrNumbers,
    });
  } catch {
    return fail("malformed", "bindBase received an input outside its contract");
  }
}
