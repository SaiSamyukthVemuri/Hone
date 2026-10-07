// The verifier's own oracle for 05B, written from SPEC-05B §0-§3, README "V1 rules" 8-9, ARCH-01 §7, §17-§24 and
// the operator's V1 directive. Nothing here is imported from, or read from, scripts/eng/v2/decision/.
//
// Representation choices the spec leaves open are marked SPEC-SILENT; tests treat them as probes, not as law.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const CODEX = Object.freeze({ id: 199175422, type: "Bot" }); // ARCH-01 §20, SPEC-05B §3
export const HUMAN = Object.freeze({ id: 26781116, type: "User" }); // ARCH-01 §20, SPEC-05B §3
export const SPEC_POLICY = Object.freeze({ codex: [CODEX], humanResolvers: [HUMAN] });

// ARCH-01 §40's closed set, as V1 changes it: README rule 3 renames wrong_base → base_ref and adds base_ref_changed,
// shared_head, base_history_unverified; SPEC-05A §6 adds fork_head, diff_too_large, ci_definition_changed,
// ci_definition_mismatch; README rules 1-2: V1 reads no attestation, so ci_attestation_* are not V1 reasons.
export const CLOSED_REASONS = Object.freeze([
  "read_failed",
  "malformed",
  "pr_key_moved",
  "unstable_snapshot",
  "ci_candidate_listing_too_large",
  "review_evidence_too_large",
  "external_contexts_too_large",
  "unrecognized_ci_status",
  "unrecognized_ci_conclusion",
  "unrecognized_context_state",
  "base_ref",
  "base_ref_changed",
  "shared_head",
  "base_history_unverified",
  "fork_head",
  "diff_too_large",
  "ci_definition_changed",
  "ci_definition_mismatch",
]);
export const NOT_V1_REASONS = Object.freeze(["wrong_base", "ci_attestation_invalid", "ci_attestation_untrusted"]);

// SPEC-05B §2 table order, then UNKNOWN.
export const ROW_DECISIONS = Object.freeze([
  "NOT_OPEN", // 1
  "DRAFT_HOLD", // 2
  "NEEDS_REFRESH", // 3
  "CI_FAILED", // 4
  "EXTERNAL_BLOCKED", // 5
  "CI_NOT_STARTED", // 6 (NO_RUN)
  "CI_INCOMPLETE", // 6 (INCOMPLETE)
  "CI_PENDING", // 7
  "EXTERNAL_PENDING", // 8
  "REVIEW_MISSING", // 9
  "FINDINGS_OPEN", // 10
  "CANDIDATE_READY_FOR_HUMAN_REVIEW", // 11
]);
export const ALL_DECISIONS = Object.freeze([...ROW_DECISIONS, "UNKNOWN"]);

export const CI_OUTCOMES = Object.freeze(["SUCCEEDED", "FAILED", "PENDING", "NO_RUN", "INCOMPLETE"]);
export const EXTERNAL_STATES = Object.freeze(["success", "pending", "failure"]);
export const PR_REVIEW_TRUST_VERDICTS = Object.freeze(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]);
export const ALL_VERDICTS = Object.freeze(["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED", "PENDING", "CLEAN"]);
export const CHANNELS = Object.freeze(["PR_REVIEW", "CLEAN_COMMENT"]);
export const KEY_STATES = Object.freeze(["OPEN", "CLOSED", "MERGED"]);

const isObj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: any) => typeof v === "number" && Number.isInteger(v);
const isActor = (a: any) =>
  a === null || (isObj(a) && (a.id === null || isInt(a.id)) && typeof a.type === "string");

/** SPEC-05B §3: numeric id AND type equal; a null actor or a null id matches nothing. */
export function actorIn(actor: any, list: any[]): boolean {
  if (actor === null || actor === undefined || actor.id === null || actor.id === undefined) return false;
  return list.some((p) => p && p.id !== null && p.id === actor.id && p.type === actor.type);
}

export function trustedReviewAtHead(reviews: any[], policy: any = SPEC_POLICY): boolean {
  return reviews.some(
    (r) =>
      r.qualifiesAtHead === true &&
      actorIn(r.actor, policy.codex) &&
      ((r.channel === "PR_REVIEW" && PR_REVIEW_TRUST_VERDICTS.includes(r.verdict)) ||
        (r.channel === "CLEAN_COMMENT" && r.verdict === "CLEAN")),
  );
}

export function changesRequestedAtHead(reviews: any[], policy: any = SPEC_POLICY): boolean {
  return reviews.some(
    (r) => r.channel === "PR_REVIEW" && r.verdict === "CHANGES_REQUESTED" && r.qualifiesAtHead === true && actorIn(r.actor, policy.codex),
  );
}

export function openTrustedThreads(threads: any[], policy: any = SPEC_POLICY): any[] {
  return threads.filter(
    (t) => actorIn(t.opener, policy.codex) && (t.resolved !== true || !actorIn(t.resolver, policy.humanResolvers)),
  );
}

export type OracleResult = {
  decision: string;
  reasonCodes: string[];
  /** The precedence row that decided: 1..11, "collection", or "malformed". */
  row: number | string;
  /** Expected `blocking`. SPEC-05B §2 names its fields; their representation is partly SPEC-SILENT (see tests). */
  blocking: any;
  /** Every §2 condition that holds for this input (labels), for precedence-pair coverage. */
  holds: string[];
};

const MALFORMED = (holds: string[] = []): OracleResult => ({
  decision: "UNKNOWN",
  reasonCodes: ["malformed"],
  row: "malformed",
  blocking: undefined,
  holds,
});
const unknownAt = (row: number | string, rowName: string, reason: any, detail: any, holds: string[]): OracleResult =>
  CLOSED_REASONS.includes(reason) && typeof reason === "string"
    ? { decision: "UNKNOWN", reasonCodes: [reason], row, blocking: { row: rowName, detail }, holds }
    : { ...MALFORMED(holds), row };

function rowResultShape(r: any): "ok" | "fail" | "bad" {
  if (!isObj(r)) return "bad";
  if (r.ok === true) return isObj(r.value) ? "ok" : "bad";
  if (r.ok === false) return "fail";
  return "bad";
}

/** Validates the parts of a row value that 05B reads (SPEC-05B §1). Returns false for a wrong type. */
function baseOk(v: any) {
  return isObj(v.drift) && isInt(v.drift.behindBy) && v.drift.behindBy >= 0;
}
function ciOk(v: any) {
  return CI_OUTCOMES.includes(v.outcome) && typeof v.outcome === "string";
}
function externalOk(v: any) {
  return (
    Array.isArray(v.external) &&
    v.external.every((c: any) => isObj(c) && typeof c.source === "string" && EXTERNAL_STATES.includes(c.state) && typeof c.state === "string")
  );
}
function reviewsOk(v: any) {
  return (
    Array.isArray(v.reviews) &&
    Array.isArray(v.threads) &&
    v.reviews.every(
      (r: any) =>
        isObj(r) &&
        typeof r.channel === "string" &&
        typeof r.verdict === "string" &&
        typeof r.qualifiesAtHead === "boolean" &&
        isActor(r.actor),
    ) &&
    v.threads.every((t: any) => isObj(t) && typeof t.resolved === "boolean" && isActor(t.opener) && isActor(t.resolver))
  );
}

/**
 * The oracle. `collected` is SPEC-05A §5.4's collector result. Inputs here are expected to be inside the contract,
 * or malformed only in a field 05B reads; hostile-object totality is tested separately.
 */
export function oracle(collected: any, policy: any = SPEC_POLICY): OracleResult {
  if (!isObj(collected)) return MALFORMED();
  if (collected.ok === false) return unknownAt("collection", "collection", collected.reason, collected.detail, ["COLLECTION"]);
  if (collected.ok !== true) return MALFORMED();
  const e = collected.evidence;
  if (!isObj(e) || !isObj(e.key)) return MALFORMED();
  const k = e.key;
  if (!KEY_STATES.includes(k.state) || typeof k.isDraft !== "boolean" || typeof k.headSha !== "string") return MALFORMED();
  if (typeof e.terminal !== "boolean" || e.terminal !== (k.state !== "OPEN")) return MALFORMED();

  const holds: string[] = [];
  if (e.terminal) holds.push("R1");
  if (k.isDraft) holds.push("R2");
  if (e.terminal) return { decision: "NOT_OPEN", reasonCodes: ["NOT_OPEN"], row: 1, blocking: { state: k.state }, holds };

  if (!isObj(e.rows)) {
    // SPEC-SILENT: an open key whose rows are not an object. Row 2 needs only the key, so a draft may read
    // DRAFT_HOLD (row-scoped) or UNKNOWN(malformed) (§0 "outside the contract"); tests accept either.
    return k.isDraft ? { decision: "DRAFT_HOLD", reasonCodes: ["DRAFT_HOLD"], row: 2, blocking: { headSha: k.headSha }, holds } : MALFORMED(holds);
  }
  const { base, ci, external, reviews } = e.rows;
  const shapes = [base, ci, external, reviews].map(rowResultShape);

  // Record which conditions hold (for pair coverage) before deciding. A malformed row records nothing.
  const baseS = shapes[0], ciS = shapes[1], extS = shapes[2], revS = shapes[3];
  if (baseS === "fail") holds.push("U3");
  else if (baseS === "ok" && baseOk(base.value) && base.value.drift.behindBy > 0) holds.push("R3");
  if (ciS === "fail") holds.push("U4");
  else if (ciS === "ok" && ciOk(ci.value)) {
    const o = ci.value.outcome;
    if (o === "FAILED") holds.push("R4");
    if (o === "NO_RUN") holds.push("R6a");
    if (o === "INCOMPLETE") holds.push("R6b");
    if (o === "PENDING") holds.push("R7");
  }
  if (extS === "fail") holds.push("U5");
  else if (extS === "ok" && externalOk(external.value)) {
    if (external.value.external.some((c: any) => c.state === "failure")) holds.push("R5");
    if (external.value.external.some((c: any) => c.state === "pending")) holds.push("R8");
  }
  if (revS === "fail") holds.push("U9");
  else if (revS === "ok" && reviewsOk(reviews.value)) {
    if (!trustedReviewAtHead(reviews.value.reviews, policy)) holds.push("R9");
    if (changesRequestedAtHead(reviews.value.reviews, policy) || openTrustedThreads(reviews.value.threads, policy).length > 0) holds.push("R10");
  }

  if (k.isDraft) return { decision: "DRAFT_HOLD", reasonCodes: ["DRAFT_HOLD"], row: 2, blocking: { headSha: k.headSha }, holds };

  // Row 3
  if (baseS === "bad") return { ...MALFORMED(holds), row: 3 };
  if (baseS === "fail") return unknownAt(3, "base", base.reason, base.detail, holds);
  if (!baseOk(base.value)) return { ...MALFORMED(holds), row: 3 };
  if (base.value.drift.behindBy > 0) {
    return {
      decision: "NEEDS_REFRESH",
      reasonCodes: ["NEEDS_REFRESH"],
      row: 3,
      blocking: { behindBy: base.value.drift.behindBy, baseSha: k.baseSha },
      holds,
    };
  }
  // Row 4
  if (ciS === "bad") return { ...MALFORMED(holds), row: 4 };
  if (ciS === "fail") return unknownAt(4, "ci", ci.reason, ci.detail, holds);
  if (!ciOk(ci.value)) return { ...MALFORMED(holds), row: 4 };
  const outcome = ci.value.outcome;
  const runIds = ci.value.applicableRunIds;
  if (outcome === "FAILED") return { decision: "CI_FAILED", reasonCodes: ["CI_FAILED"], row: 4, blocking: { runIds }, holds };
  // Row 5
  if (extS === "bad") return { ...MALFORMED(holds), row: 5 };
  if (extS === "fail") return unknownAt(5, "external", external.reason, external.detail, holds);
  if (!externalOk(external.value)) return { ...MALFORMED(holds), row: 5 };
  const ctx = external.value.external;
  const failing = ctx.filter((c: any) => c.state === "failure").map((c: any) => c.source);
  if (failing.length > 0) {
    return { decision: "EXTERNAL_BLOCKED", reasonCodes: ["EXTERNAL_BLOCKED"], row: 5, blocking: { sources: [...failing].sort() }, holds };
  }
  // Row 6
  if (outcome === "NO_RUN") return { decision: "CI_NOT_STARTED", reasonCodes: ["CI_NOT_STARTED"], row: 6, blocking: { headSha: k.headSha }, holds };
  if (outcome === "INCOMPLETE") {
    return { decision: "CI_INCOMPLETE", reasonCodes: ["CI_INCOMPLETE"], row: 6, blocking: { runIds, missingJob: ci.value.missingJob }, holds };
  }
  // Row 7
  if (outcome === "PENDING") return { decision: "CI_PENDING", reasonCodes: ["CI_PENDING"], row: 7, blocking: { runIds }, holds };
  // Row 8
  const pending = ctx.filter((c: any) => c.state === "pending").map((c: any) => c.source);
  if (pending.length > 0) {
    return { decision: "EXTERNAL_PENDING", reasonCodes: ["EXTERNAL_PENDING"], row: 8, blocking: { sources: [...pending].sort() }, holds };
  }
  // Row 9
  if (revS === "bad") return { ...MALFORMED(holds), row: 9 };
  if (revS === "fail") return unknownAt(9, "reviews", reviews.reason, reviews.detail, holds);
  if (!reviewsOk(reviews.value)) return { ...MALFORMED(holds), row: 9 };
  if (!trustedReviewAtHead(reviews.value.reviews, policy)) {
    return { decision: "REVIEW_MISSING", reasonCodes: ["REVIEW_MISSING"], row: 9, blocking: { headSha10: k.headSha.slice(0, 10) }, holds };
  }
  // Row 10
  const cr = changesRequestedAtHead(reviews.value.reviews, policy);
  const open = openTrustedThreads(reviews.value.threads, policy);
  if (cr || open.length > 0) {
    return { decision: "FINDINGS_OPEN", reasonCodes: ["FINDINGS_OPEN"], row: 10, blocking: { changesRequested: cr, openThreads: open.length }, holds };
  }
  // Row 11
  return { decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW", reasonCodes: ["CANDIDATE_READY_FOR_HUMAN_REVIEW"], row: 11, blocking: { headSha: k.headSha }, holds };
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence builders: SPEC-05A shapes (§2.6 base value, §3.4 ci value, §4.2 reviews value, §4.4 external value,
// §5.4 Evidence). Inputs may come from anywhere; only expected outcomes must come from the spec.

export const H = "fe62f51f0fd95fc97d2e21eef71d179e2e701358";
export const B = "6cdd830b0bcc5e3532016bc612bd0298db3533fb";
export const PRODUCTION_REF = "claude/build-hone-saas-hOex7";
export const REPO_ID = 1240764106;

export function key(state = "OPEN", isDraft = false, over: any = {}) {
  return {
    prNumber: 800,
    state,
    isDraft,
    headSha: H,
    headRef: "docs/arch-01-eng-loop-v2",
    headRepoId: REPO_ID,
    baseRef: PRODUCTION_REF,
    baseRepoId: REPO_ID,
    baseSha: state === "OPEN" ? B : null,
    ...over,
  };
}

export const ok = (value: any) => ({ ok: true, value });
export const fail = (reason: any, detail: any = `${reason} detail`) => ({ ok: false, reason, detail });

export function baseValue(behindBy: any = 0) {
  return {
    drift: { behindBy, aheadBy: 3 },
    mergeBaseSha: B,
    files: ["docs/decisions/arch-01-eng-loop-v2.md"],
    filesCapped: false,
    changedFiles: 1,
    createdAt: "2026-10-06T00:37:54Z",
    baseRefChanges: 0,
    associatedPrNumbers: [800],
  };
}

export function ciValue(outcome: any, extra: any = {}) {
  const runIds = outcome === "NO_RUN" ? [] : outcome === "INCOMPLETE" ? [37673706298] : [37673706298, 37673706299];
  return { outcome, applicableRunIds: runIds, ...(outcome === "INCOMPLETE" ? { missingJob: "browser e2e (local stack)" } : {}), ...extra };
}

export const ext = (source: string, state: string) => ({ source, state });

let reviewSeq = 5400000000;
export function review(channel: string, actor: any, verdict: string, qualifiesAtHead: boolean) {
  reviewSeq += 1;
  return { id: reviewSeq, channel, actor, verdict, qualifiesAtHead };
}
export function thread(opener: any, resolved: boolean, resolver: any, outdated = false) {
  return { opener, resolved, resolver, outdated };
}

export function evidence(k: any, rows: any) {
  return {
    schema: "eng-loop-v1/evidence@1",
    observedAt: "2026-10-07T20:00:00Z",
    key: k,
    terminal: k.state !== "OPEN",
    rows: k.state === "OPEN" ? rows : null,
  };
}

export function collected(ev: any) {
  return {
    ok: true,
    evidence: ev,
    evidenceHash: "a47b5c9b49166c617dba56d768a414dff15fc79e012692e77f1b77d30a3d18d2",
    diagnostics: { observedAt: ev.observedAt, attempts: 1, confirmed: true },
  };
}

export function openRows({ base = ok(baseValue(0)), ci = ok(ciValue("SUCCEEDED")), external = ok({ external: [] }), reviews = ok({ reviews: [review("CLEAN_COMMENT", CODEX, "CLEAN", true)], threads: [] }) }: any = {}) {
  return { base, ci, external, reviews };
}

/** A complete CANDIDATE input; every other input in the suite is a perturbation of this or of the table. */
export function candidate(over: any = {}) {
  return collected(evidence(key("OPEN", false), openRows(over)));
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Deterministic PRNG (mulberry32) for shuffles. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled<T>(xs: T[], r: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
