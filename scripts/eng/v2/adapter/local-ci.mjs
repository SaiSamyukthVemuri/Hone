// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: the CI definition the shepherd itself executes.
//
// Required lanes come from production's classifier (SPEC-05A §3.3). The
// shepherd runs the classifier in ITS OWN checkout, so the collector proves
// that checkout's copy is production's: it hashes the local file exactly as git
// does and compares it with production's blob at K0.baseSha (`readFileBlob`).
// The same holds for ci.yml, which the required-job table is pinned to.
//
// Local filesystem reads only; no network.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify } from "../../../classify-changes.mjs";
import { REQUIRED_JOB_TABLE } from "./internal/bind/ci.mjs";
import { BLOB_PATHS } from "./internal/github/index.mjs";

/** This checkout's root: scripts/eng/v2/adapter/ is four levels down. */
export const LOCAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The git blob SHA-1 of a file's bytes: sha1("blob <size>\0" + bytes). */
export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Every required job name appears as a job `name:` in this ci.yml. */
export function tablePinnedTo(ciYml) {
  return REQUIRED_JOB_TABLE.every(({ name }) => ciYml.includes(`name: ${name}`));
}

/**
 * @param {{ root?: string, read?: (p: string) => Buffer }} [deps]
 * @returns {{ classify: Function, blobs: Record<string, string>, tablePinned: boolean }}
 */
export function loadLocalCi({ root = LOCAL_ROOT, read = (p) => readFileSync(p) } = {}) {
  const blobs = {};
  for (const p of BLOB_PATHS) blobs[p] = gitBlobSha(read(path.join(root, p)));
  const ciYml = read(path.join(root, ".github/workflows/ci.yml")).toString("utf8");
  return Object.freeze({ classify, blobs: Object.freeze(blobs), tablePinned: tablePinnedTo(ciYml) });
}
