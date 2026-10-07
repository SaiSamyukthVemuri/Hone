// ---------------------------------------------------------------------------
// ENG-LOOP V1 05C: the shepherd. One PR, read at its exact head, read-only,
// decided once.
//
//   transport (dedicated token) -> 05A collect -> 05B decide -> report
//
// It performs no GitHub mutation: the only transport it builds is the
// read-only primitive, and no reader writes. A successful read is not READY:
// the exit code says which kind of answer this is, and only
// CANDIDATE_READY_FOR_HUMAN_REVIEW exits 0 — which is still advice to a human,
// never merge permission.
//
// Exit codes:
//   0  CANDIDATE_READY_FOR_HUMAN_REVIEW (advisory; a human decides the merge)
//   4  a definite non-candidate decision (NOT_OPEN, DRAFT_HOLD, NEEDS_REFRESH,
//      CI_*, EXTERNAL_*, REVIEW_MISSING, FINDINGS_OPEN)
//   3  UNKNOWN: the evidence could not be established; never treat it as green
//   2  usage error
//   1  internal error
// ---------------------------------------------------------------------------

import { collect } from "./adapter/collect.mjs";
import { POLICY, createReaders } from "./adapter/internal/github/index.mjs";
import { createPrimitive } from "./adapter/internal/github/primitive.mjs";
import { decide } from "./decision/decide.mjs";

export const REPORT_SCHEMA = "eng-loop-v1/shepherd@1";
export const EXIT = Object.freeze({ CANDIDATE: 0, INTERNAL: 1, USAGE: 2, UNKNOWN: 3, NOT_CANDIDATE: 4 });
export const ADVISORY =
  "Advisory only. CANDIDATE_READY_FOR_HUMAN_REVIEW is not merge permission: a human authorizes every merge at an exact head.";

export function exitCodeFor(decision) {
  if (decision === "CANDIDATE_READY_FOR_HUMAN_REVIEW") return EXIT.CANDIDATE;
  if (decision === "UNKNOWN") return EXIT.UNKNOWN;
  return EXIT.NOT_CANDIDATE;
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Links built only from normalized ids and SHAs, never from anything GitHub returned as a URL. */
function sourceReferences(prNumber, collected, decision, policy) {
  const repo = `https://github.com/${policy.owner}/${policy.name}`;
  const refs = [`${repo}/pull/${prNumber}`];
  if (!collected.ok) return refs;
  const { key, rows } = collected.evidence;
  refs.push(`${repo}/commit/${key.headSha}`);
  if (key.baseSha) refs.push(`${repo}/compare/${key.baseSha}...${key.headSha}`);
  const runIds = new Set();
  if (rows?.ci?.ok && Array.isArray(rows.ci.value.applicableRunIds)) for (const id of rows.ci.value.applicableRunIds) runIds.add(id);
  if (Array.isArray(decision.blocking?.runIds)) for (const id of decision.blocking.runIds) runIds.add(id);
  for (const id of [...runIds].sort((a, b) => a - b)) refs.push(`${repo}/actions/runs/${id}`);
  return refs;
}

function instrumentation(stats, collected) {
  const requests = stats.length;
  const latencyMs = stats.reduce((sum, s) => sum + s.ms, 0);
  const failedRequests = stats.filter((s) => !s.ok).length;
  const d = collected.diagnostics ?? {};
  return {
    requests,
    failedRequests,
    latencyMs,
    attempts: Number.isInteger(d.attempts) ? d.attempts : null,
    confirmed: d.confirmed === true,
    stage: collected.ok ? "decided" : (collected.stage ?? "transport"),
    changedFields: Array.isArray(d.changedFields) ? d.changedFields : undefined,
  };
}

/** The report: every field the directive requires, plus instrumentation. */
export function buildReport({ prNumber, collected, decision, stats, toolVersion, observedAt, policy = POLICY }) {
  const key = collected.ok ? collected.evidence.key : null;
  const onProduction = key !== null && key.baseRef === policy.productionRef;
  return {
    schema: REPORT_SCHEMA,
    pr: prNumber,
    headSha: key ? key.headSha : null,
    baseRef: key ? key.baseRef : null,
    production: { ref: policy.productionRef, tip: onProduction ? key.baseSha : null },
    observedAt: collected.ok ? collected.evidence.observedAt : (collected.diagnostics?.observedAt ?? observedAt),
    toolVersion,
    evidenceHash: collected.ok ? collected.evidenceHash : null,
    decision: decision.decision,
    reasonCodes: [...decision.reasonCodes],
    blocking: decision.blocking,
    sourceReferences: sourceReferences(prNumber, collected, decision, policy),
    nextAction: decision.nextAction,
    humanMergeRequired: true,
    advisory: ADVISORY,
    instrumentation: instrumentation(stats, collected),
  };
}

/**
 * Run the shepherd for one PR. No GitHub mutation; the only side effects are the
 * read-only `gh api` calls the primitive makes.
 *
 * @returns {{ exitCode: number, report: object }}
 */
export function runShepherd({ prNumber, env, now = Date.now, spawn, local, toolVersion, policy = POLICY }) {
  const observedAt = isoSeconds(now());
  const primitive = createPrimitive({ env, ...(spawn ? { spawn } : {}), now });
  let collected;
  let stats = [];
  if (!primitive.ok) {
    collected = { ok: false, reason: primitive.reason, detail: primitive.detail, stage: "transport", diagnostics: { observedAt } };
  } else {
    try {
      collected = collect({ prNumber, readers: createReaders({ request: primitive.request, policy }), local, now, policy });
      stats = primitive.stats();
    } finally {
      primitive.close();
    }
  }
  const decision = decide(collected);
  const report = buildReport({ prNumber, collected, decision, stats, toolVersion, observedAt, policy });
  return { exitCode: exitCodeFor(decision.decision), report };
}

const pad = (s) => s.padEnd(10);

/** Readable text: the same facts as the JSON, one per line. */
export function renderText(r) {
  const lines = [];
  lines.push(`ENG-LOOP shepherd - PR #${r.pr} - ${r.advisory}`);
  lines.push(`  ${pad("decision")}${r.decision}${r.decision === "UNKNOWN" ? ` (${r.reasonCodes.join(", ")})` : ""}`);
  lines.push(`  ${pad("next")}${r.nextAction}`);
  lines.push(`  ${pad("head")}${r.headSha ?? "unknown"}`);
  lines.push(`  ${pad("base")}${r.baseRef ?? "unknown"}`);
  lines.push(`  ${pad("production")}${r.production.ref} at ${r.production.tip ?? "unknown"}`);
  lines.push(`  ${pad("blocking")}${JSON.stringify(r.blocking)}`);
  lines.push(`  ${pad("evidence")}${r.evidenceHash ?? "none"}`);
  lines.push(`  ${pad("observed")}${r.observedAt}   tool ${r.toolVersion}`);
  const i = r.instrumentation;
  lines.push(
    `  ${pad("reads")}${i.requests} requests, ${i.failedRequests} failed, ${(i.latencyMs / 1000).toFixed(1)} s` +
      `${i.attempts ? `, ${i.attempts} attempt(s)` : ""}${i.confirmed ? ", confirmed" : ""}`,
  );
  for (const ref of r.sourceReferences) lines.push(`  ${pad("source")}${ref}`);
  lines.push(`  ${pad("merge")}a human authorizes it; this command never merges and never writes to GitHub`);
  return `${lines.join("\n")}\n`;
}
