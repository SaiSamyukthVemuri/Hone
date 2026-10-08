// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: one file's git blob SHA at one commit (CAP-01 §4
// `readFileBlob`), from REST `contents/{path}?ref={sha}`. It lets the
// collector prove that the CI definition files the shepherd EXECUTES locally —
// the classifier, and the ci.yml the required-job table is pinned to — are
// production's, byte for byte. The answer must be a file and must echo the
// requested path. Pure; nothing throws.
// ---------------------------------------------------------------------------

import { fail, guarded, isNonEmptyString, isObject, isSha40, okRecord, requested } from "../../../contract/strict.mjs";

export const parseFileBlob = guarded((raw, opts) => {
  const filePath = requested(opts, "path", isNonEmptyString);
  if (filePath === undefined) return fail("malformed", "the requested path is required");
  if (!isObject(raw)) return fail("malformed", "the contents answer is not an object (a directory is a list)");
  if (raw.type !== "file") return fail("malformed", "the path is not a file");
  if (raw.path !== filePath) return fail("malformed", "the answer names another path");
  if (!isSha40(raw.sha)) return fail("malformed", "the blob sha is not 40 hex");
  return okRecord({ path: raw.path, sha: raw.sha });
});
