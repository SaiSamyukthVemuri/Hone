// ---------------------------------------------------------------------------
// ENG-LOOP V1 05B: the pure decision engine (ARCH-01 §6, §7, §17-§20, §24).
//
// `decide(collected, policy)` is total and deterministic. It reads only the
// collector's normalized result and policy: no GitHub, no clock, no I/O, and
// nothing from adapter/. The FIRST row of §7 that holds is the decision.
//
// V1 rules that differ from ARCH-01 (README differences 8-9):
//   * a binder's closed failure is ROW-SCOPED: it decides — as UNKNOWN(reason) —
//     only when §7 reaches that row. Every row is consulted before candidacy,
//     so an UNKNOWN row can never be skipped on the way to
//     CANDIDATE_READY_FOR_HUMAN_REVIEW; a collection failure is UNKNOWN outright;
//   * V1's CI model has two "missing required CI" outcomes, both at the
//     operator's row 6: NO_RUN (ARCH-01's NO_FRONTIER) is CI_NOT_STARTED, and
//     INCOMPLETE (a required job did not succeed in a successful run) is
//     CI_INCOMPLETE.
//
// CANDIDATE_READY_FOR_HUMAN_REVIEW is advisory only. It is not merge permission:
// every decision carries humanMergeRequired: true.
// ---------------------------------------------------------------------------

import { isUnknownReason } from "../contract/reasons.mjs";
import { nextActionFor } from "./next-action.mjs";
import { TRUST_POLICY } from "./policy.mjs";

export const DECISIONS = Object.freeze([
  "NOT_OPEN",
  "DRAFT_HOLD",
  "NEEDS_REFRESH",
  "CI_FAILED",
  "CI_INCOMPLETE",
  "EXTERNAL_BLOCKED",
  "CI_NOT_STARTED",
  "CI_PENDING",
  "EXTERNAL_PENDING",
  "REVIEW_MISSING",
  "FINDINGS_OPEN",
  "CANDIDATE_READY_FOR_HUMAN_REVIEW",
  "UNKNOWN",
]);

const CI_OUTCOMES = ["SUCCEEDED", "FAILED", "PENDING", "NO_RUN", "INCOMPLETE"];
const EXTERNAL_STATES = ["success", "pending", "failure"];
const TRUSTED_VERDICTS = Object.freeze({ PR_REVIEW: ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"], CLEAN_COMMENT: ["CLEAN"] });

class Invalid extends Error {}
const need = (ok, what) => {
  if (!ok) throw new Invalid(what);
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isActor = (a) => a === null || (isObj(a) && (a.id === null || Number.isSafeInteger(a.id)) && typeof a.type === "string");
const sameActor = (a, b) => a !== null && a.id !== null && a.id === b.id && a.type === b.type;
const inList = (actor, list) => list.some((t) => sameActor(actor, t));

function result(decision, reasonCodes, blocking) {
  return Object.freeze({
    decision,
    reasonCodes: Object.freeze([...reasonCodes]),
    blocking: Object.freeze(blocking),
    nextAction: nextActionFor(decision, reasonCodes),
    humanMergeRequired: true,
  });
}
const unknown = (reason, row, detail) =>
  result("UNKNOWN", [isUnknownReason(reason) ? reason : "malformed"], { row, detail: typeof detail === "string" ? detail : null });

/** A row's closed failure, or its validated value. */
function rowValue(row, name) {
  need(isObj(row) && typeof row.ok === "boolean", `${name} row`);
  if (row.ok) {
    need(isObj(row.value), `${name} value`);
    return { value: row.value };
  }
  return { failure: unknown(row.reason, name, row.detail) };
}

/** ARCH-01 §24: TRUSTED_REVIEW_AT_HEAD. */
function trustedReviewAtHead(reviews, policy) {
  return reviews.some(
    (r) => r.qualifiesAtHead === true && inList(r.actor, policy.codex) && (TRUSTED_VERDICTS[r.channel] ?? []).includes(r.verdict),
  );
}

/** ARCH-01 §18-§19: FINDINGS_OPEN. Severity, outdatedness and the head that raised a thread never matter. */
function findingsOpen(reviews, threads, policy) {
  const changesRequested = reviews.some(
    (r) =>
      r.channel === "PR_REVIEW" && r.verdict === "CHANGES_REQUESTED" && r.qualifiesAtHead === true && inList(r.actor, policy.codex),
  );
  const open = threads.filter(
    (t) => inList(t.opener, policy.codex) && (t.resolved !== true || !inList(t.resolver, policy.humanResolvers)),
  );
  return { changesRequested, openThreads: open.length };
}

function decideOpen(e, policy) {
  const { key, rows } = e;
  need(isObj(rows), "rows");

  // 2. The coherent key's draft flag.
  if (key.isDraft) return result("DRAFT_HOLD", ["DRAFT_HOLD"], { headSha: key.headSha });

  // 3. Drift: behind production is never a candidate, whatever CI says (A9).
  const base = rowValue(rows.base, "base");
  if (base.failure) return base.failure;
  const drift = base.value.drift;
  need(isObj(drift) && Number.isSafeInteger(drift.behindBy) && drift.behindBy >= 0, "drift");
  if (drift.behindBy > 0) {
    return result("NEEDS_REFRESH", ["NEEDS_REFRESH"], { behindBy: drift.behindBy, baseSha: key.baseSha });
  }

  // 4. CI failure.
  const ci = rowValue(rows.ci, "ci");
  if (ci.failure) return ci.failure;
  need(CI_OUTCOMES.includes(ci.value.outcome), "ci outcome");
  const runIds = Array.isArray(ci.value.applicableRunIds) ? [...ci.value.applicableRunIds] : [];
  if (ci.value.outcome === "FAILED") return result("CI_FAILED", ["CI_FAILED"], { runIds });

  // 5. External failure.
  const ext = rowValue(rows.external, "external");
  if (ext.failure) return ext.failure;
  need(Array.isArray(ext.value.external), "external contexts");
  for (const c of ext.value.external) need(isObj(c) && typeof c.source === "string" && EXTERNAL_STATES.includes(c.state), "external context");
  const failing = ext.value.external.filter((c) => c.state === "failure").map((c) => c.source).sort();
  if (failing.length > 0) return result("EXTERNAL_BLOCKED", ["EXTERNAL_BLOCKED"], { sources: failing });

  // 6. Missing required CI: no applicable run, or a required job that did not succeed.
  if (ci.value.outcome === "NO_RUN") return result("CI_NOT_STARTED", ["CI_NOT_STARTED"], { headSha: key.headSha });
  if (ci.value.outcome === "INCOMPLETE") {
    return result("CI_INCOMPLETE", ["CI_INCOMPLETE"], { runIds, missingJob: ci.value.missingJob ?? null });
  }

  // 7. CI pending.
  if (ci.value.outcome === "PENDING") return result("CI_PENDING", ["CI_PENDING"], { runIds });

  // 8. External pending.
  const pending = ext.value.external.filter((c) => c.state === "pending").map((c) => c.source).sort();
  if (pending.length > 0) return result("EXTERNAL_PENDING", ["EXTERNAL_PENDING"], { sources: pending });

  // 9-10. Review at the exact head, then open findings.
  const rv = rowValue(rows.reviews, "reviews");
  if (rv.failure) return rv.failure;
  const { reviews, threads } = rv.value;
  need(Array.isArray(reviews) && Array.isArray(threads), "reviews and threads");
  for (const r of reviews) {
    need(isObj(r) && typeof r.channel === "string" && typeof r.verdict === "string" && isActor(r.actor), "review");
    need(typeof r.qualifiesAtHead === "boolean", "review head binding");
  }
  for (const t of threads) {
    need(isObj(t) && isActor(t.opener) && isActor(t.resolver) && typeof t.resolved === "boolean", "thread");
  }
  if (!trustedReviewAtHead(reviews, policy)) {
    return result("REVIEW_MISSING", ["REVIEW_MISSING"], { headSha10: key.headSha.slice(0, 10) });
  }
  const findings = findingsOpen(reviews, threads, policy);
  if (findings.changesRequested || findings.openThreads > 0) return result("FINDINGS_OPEN", ["FINDINGS_OPEN"], findings);

  // 11. Advisory only.
  return result("CANDIDATE_READY_FOR_HUMAN_REVIEW", ["CANDIDATE_READY_FOR_HUMAN_REVIEW"], { headSha: key.headSha });
}

/**
 * @param {{ ok: true, evidence: object } | { ok: false, reason: string, detail?: string }} collected the collector's result
 * @param {{ codex: Array<{id,type}>, humanResolvers: Array<{id,type}> }} [policy]
 */
export function decide(collected, policy = TRUST_POLICY) {
  try {
    need(isObj(collected) && typeof collected.ok === "boolean", "collection result");
    if (!collected.ok) return unknown(collected.reason, "collection", collected.detail);
    const e = collected.evidence;
    need(isObj(e) && isObj(e.key) && typeof e.terminal === "boolean", "evidence");
    // 1. Terminal: the key's state decides, and nothing else is read.
    need(["OPEN", "CLOSED", "MERGED"].includes(e.key.state) && e.terminal === (e.key.state !== "OPEN"), "key state");
    if (e.terminal) return result("NOT_OPEN", ["NOT_OPEN"], { state: e.key.state });
    need(typeof e.key.isDraft === "boolean" && typeof e.key.headSha === "string", "key");
    return decideOpen(e, policy);
  } catch {
    return unknown("malformed", "evidence", "the evidence is outside the 05A contract");
  }
}
