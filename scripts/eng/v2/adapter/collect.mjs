// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: the collector. One coherent pass, then the confirming pass,
// then pure binding into Evidence (SPEC-05A §5).
//
//   pass 1:  K0 -> every body read keyed by K0 -> K1 == K0   (one retry if the key moved)
//   pass 2:  the same, once, with no retry; a different key is pr_key_moved and
//            different normalized evidence is unstable_snapshot
//   bind:    base, CI, reviews and external contexts, each a closed row result
//
// Body reads run in a FIXED order, and the first failure ends the pass with its
// reason: that order is the precedence among reader failures. A binder's
// closed failure is a ROW result, not a collection failure, so 05B can apply
// its own precedence (for example NEEDS_REFRESH before every CI rule, A9).
//
// The collector performs no I/O itself: readers, the local CI definition and
// the clock are injected. It never mutates GitHub — no reader can.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { canonicalJson, deepFreeze, fail } from "../contract/strict.mjs";
import { bindBase } from "./internal/bind/base.mjs";
import { bindCi, isApplicableRun, requiredJobs } from "./internal/bind/ci.mjs";
import { bindExternal } from "./internal/bind/external.mjs";
import { bindReviews } from "./internal/bind/review.mjs";
import { collectCoherent, confirmPass } from "./internal/coherence.mjs";
import { BLOB_PATHS, POLICY } from "./internal/github/index.mjs";

export const EVIDENCE_SCHEMA = "eng-loop-v1/evidence@1";

/** The body reads, in their fixed order. Each returns a parser result. */
const STEPS = Object.freeze([
  ["compare", (r, k) => r.readCompare(k.baseSha, k.headSha)],
  ["prContext", (r, k) => r.readPrContext(k.prNumber, k.headSha)],
  ["headBranchPrs", (r, k) => r.readHeadBranchPrs(k.headRef)],
  ["rules", (r) => r.readBranchRules()],
  ["forcePush", (r) => r.readActivity("force_push")],
  ["branchDeletion", (r) => r.readActivity("branch_deletion")],
  ["branchCreation", (r) => r.readActivity("branch_creation")],
  ["runs", (r, k) => r.readCandidateRuns(k.headSha)],
  ["reviewEvidence", (r, k) => r.readReviewEvidence(k.prNumber)],
  ["rollup", (r, k) => r.readCommitRollup(k.headSha)],
  ...BLOB_PATHS.map((p) => [`blob:${p}`, (r, k) => r.readFileBlob(p, k.baseSha)]),
]);

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Every normalized record the pass read for an OPEN K0, or the first failure. */
function readBody(readers, k0, policy) {
  const got = {};
  for (const [name, read] of STEPS) {
    const r = read(readers, k0);
    if (!r || r.ok !== true) return r;
    got[name] = r.record;
  }
  // Jobs for exactly the runs step 7 counts that succeeded: nothing else is ever consulted.
  const jobsByRunId = {};
  for (const run of got.runs.runs) {
    if (!isApplicableRun(run, k0, policy.workflowId) || run.status !== "completed" || run.conclusion !== "success") {
      continue;
    }
    const r = readers.readRunJobs(run.id);
    if (!r || r.ok !== true) return r;
    jobsByRunId[run.id] = r.record;
  }
  const productionBlobs = {};
  for (const p of BLOB_PATHS) productionBlobs[p] = got[`blob:${p}`].sha;
  return {
    ok: true,
    value: {
      compare: got.compare,
      prContext: got.prContext,
      headBranchPrs: got.headBranchPrs,
      rules: got.rules,
      activity: { forcePush: got.forcePush, branchDeletion: got.branchDeletion, branchCreation: got.branchCreation },
      runs: got.runs,
      jobsByRunId,
      reviewEvidence: got.reviewEvidence,
      rollup: got.rollup,
      productionBlobs,
    },
  };
}

/** The CI row: production's CI definitions, then bindCi (SPEC-05A §3.4, §5.2). */
function ciRow({ key, base, body, local, observedAt, policy }) {
  if (!base.ok) return base;
  for (const p of BLOB_PATHS) {
    if (local.blobs[p] !== body.productionBlobs[p]) {
      return fail("ci_definition_mismatch", `the shepherd's ${p} is not production's at ${key.baseSha.slice(0, 10)}`);
    }
  }
  if (local.tablePinned !== true) {
    return fail("ci_definition_mismatch", "the required-job table does not match the shepherd's ci.yml");
  }
  let requiredJobNames;
  try {
    requiredJobNames = requiredJobs(local.classify(base.value.files));
  } catch {
    return fail("ci_definition_mismatch", "production's classifier could not classify the changed files");
  }
  return bindCi({
    key,
    base: base.value,
    headBranchPrs: body.headBranchPrs,
    runs: body.runs,
    jobsByRunId: body.jobsByRunId,
    requiredJobNames,
    rules: body.rules,
    activity: body.activity,
    observedAt,
    workflowId: policy.workflowId,
    targetRepoId: policy.repoId,
  });
}

/** Top-level body fields whose normalized content differs between two passes. */
function changedFields(a, b) {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return ["body"];
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return fields.filter((f) => canonicalJson(a[f]) !== canonicalJson(b[f]));
}

/**
 * Collect one PR's evidence.
 *
 * @param {{ prNumber: number, readers: object, local: { classify: Function, blobs: object, tablePinned: boolean },
 *           now: () => number, policy?: object }} args
 * @returns {{ ok: true, evidence, evidenceHash, diagnostics } | { ok: false, reason, detail, stage, diagnostics }}
 */
export function collect({ prNumber, readers, local, now, policy = POLICY }) {
  const observedAt = isoSeconds(now());
  let lastFailure = null;
  let lastBody = null;
  const remember = (r) => {
    if (r && r.ok === false) lastFailure = r;
    return r;
  };
  const readKey = () => remember(readers.readPrKey(prNumber));
  const readBodyFor = (k0) => {
    const r = remember(readBody(readers, k0, policy));
    if (r && r.ok === true) lastBody = r.value;
    return r;
  };
  const detailFor = (reason, fallback) =>
    lastFailure && lastFailure.reason === reason && typeof lastFailure.detail === "string" ? lastFailure.detail : fallback;
  const unknown = (stage, reason, detail, diagnostics) =>
    deepFreeze({ ok: false, reason, detail, stage, diagnostics: { observedAt, ...diagnostics } });

  const first = collectCoherent({ readKey, readBody: readBodyFor });
  if (!first.ok) {
    const detail =
      first.reason === "pr_key_moved"
        ? "the pull request's key changed during the pass and again during its one retry"
        : detailFor(first.reason, "a read failed during the first pass");
    return unknown("collect", first.reason, detail, { attempts: first.attempts, confirmed: false });
  }

  lastFailure = null;
  const firstBody = first.body;
  const confirmed = confirmPass({
    first,
    readKey,
    readBody: readBodyFor,
    sameEvidence: (a, b) => canonicalJson(a) === canonicalJson(b),
  });
  if (!confirmed.ok) {
    const extra = {};
    let detail = detailFor(confirmed.reason, "a read failed during the confirming pass");
    if (confirmed.reason === "pr_key_moved") detail = "the pull request's key changed between the two passes";
    if (confirmed.reason === "unstable_snapshot") {
      extra.changedFields = changedFields(firstBody, lastBody);
      detail = `the evidence changed between the two passes: ${extra.changedFields.join(", ")}`;
    }
    return unknown("confirm", confirmed.reason, detail, { attempts: first.attempts, confirmed: false, ...extra });
  }

  const key = first.key;
  const terminal = key.state !== "OPEN";
  let rows = null;
  if (!terminal) {
    const body = firstBody;
    const base = bindBase({ key, productionRef: policy.productionRef, compare: body.compare, prContext: body.prContext });
    rows = {
      base,
      ci: ciRow({ key, base, body, local, observedAt, policy }),
      reviews: bindReviews({ key, evidence: body.reviewEvidence }),
      external: bindExternal(body.rollup),
    };
  }
  const evidence = { schema: EVIDENCE_SCHEMA, observedAt, key, terminal, rows };
  return deepFreeze({
    ok: true,
    evidence,
    // The hash names the normalized evidence itself, not the moment it was read.
    evidenceHash: sha256(canonicalJson({ schema: EVIDENCE_SCHEMA, key, body: terminal ? null : firstBody })),
    diagnostics: { observedAt, attempts: first.attempts, confirmed: true },
  });
}
