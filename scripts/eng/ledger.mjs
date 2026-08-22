#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005b: the OPERATOR-ENROLLED monotonic finding ledger.
//
// THE DESIGN LAW: a finding enters durable state ONLY through explicit operator
// enrollment. This module records identity and tracks state. It never decides
// what counts as a finding, never reads severity off a badge, never infers a
// root-cause family, and never concludes anything about release readiness.
//
// WHY THE LAW EXISTS. Six vehicles (#617-#622) tried to let the machine decide
// what review evidence MEANT. Every one was retired: unknown or invalid evidence
// became a positive assertion, and when the positive assertions were removed
// entirely, ambiguous prose was still assigned an outcome it had not
// established. The boundary those six located is this: automation is reliable at
// preserving identity, binding to an exact SHA, and counting state transitions.
// Semantic judgement is the operator's.
//
// So `severity`, `rootCauseFamily` and `runtimeOrEvidence` are REQUIRED
// arguments. There is no default and nothing is parsed to supply them - a
// missing one is an error, never a guess.
//
// CURRENCY IS A QUERY, NEVER A STORED FLAG. `VERIFIED@shaX` is a permanent
// historical fact. Asking whether that finding is verified at shaY returns
// UNKNOWN unless shaY is shaX. A changed head does not reopen findings and does
// not preserve verification: it makes currency unknown, and says so. That is
// the one lesson from the retired vehicles this module has to carry, and it is
// expressible without interpreting anything.
//
// IDENTITY USES ONLY PROVENANCE GITHUB DOES NOT REWRITE. Measured across
// #610/#617/#619/#622: 8 of 34 comments were re-anchored onto a later head, and
// `original_commit_id` never moved for any of them. 20 of 34 have a NULL display
// line while `original_line` was null zero times. So the key is comment id +
// raised-at sha + path + original line, and never the display line or the
// display commit.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { UNKNOWN } from "./evidence.mjs";

export const LEDGER_PATH = "docs/engineering/findings-ledger.json";
export const LEDGER_VERSION = 1;

export const OPEN = "OPEN";
export const REPAIRED = "REPAIRED";
export const VERIFIED = "VERIFIED";
export const ACCEPTED_RISK = "ACCEPTED_RISK";

/**
 * Monotonic transitions. A state never moves backwards, and both terminals
 * accept nothing further.
 *
 * REPAIRED -> REPAIRED is deliberate: that is a second repair round, and
 * counting those rounds is precisely what CP-007 needs. VERIFIED is terminal
 * because a finding that reappears at a later head is a DIFFERENT record - it
 * has a different raised-at sha, so it has a different identity.
 */
const NEXT = Object.freeze({
  [OPEN]: [REPAIRED, ACCEPTED_RISK],
  [REPAIRED]: [REPAIRED, VERIFIED, ACCEPTED_RISK],
  [VERIFIED]: [],
  [ACCEPTED_RISK]: [],
});

export const STATES = Object.keys(NEXT);

const isSha = (v) => typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v);
const isText = (v) => typeof v === "string" && v.trim().length > 0;
const isId = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * The stable identity of an enrolled finding. Every component must be PROVEN;
 * a record that cannot be named is never created, because a ledger keyed on a
 * guess is worse than no ledger.
 */
export function findingId({ commentId, raisedAtSha, filePath, originalLine }) {
  const missing = Object.entries({
    commentId: isId(commentId), raisedAtSha: isSha(raisedAtSha),
    path: isText(filePath), originalLine: isId(originalLine),
  }).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length > 0) throw new Error(`cannot enrol: stable identity is incomplete (missing ${missing.join(", ")})`);
  return `gh:${commentId}@${raisedAtSha}:${filePath}:${originalLine}`;
}

/** An empty ledger. Reading a missing file is NOT an error - it is empty. */
export const emptyLedger = () => ({ version: LEDGER_VERSION, findings: [] });

export function loadLedger(file = LEDGER_PATH) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return emptyLedger();
  }
  const parsed = JSON.parse(raw);
  if (parsed?.version !== LEDGER_VERSION) {
    throw new Error(`ledger version ${parsed?.version} is not supported (expected ${LEDGER_VERSION})`);
  }
  return { version: LEDGER_VERSION, findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
}

/** Deterministic on disk: same content serializes byte-identically every time. */
export function serializeLedger(ledger) {
  const findings = [...ledger.findings].sort((a, b) => a.id.localeCompare(b.id));
  return `${JSON.stringify({ version: LEDGER_VERSION, findings }, null, 2)}\n`;
}

export function saveLedger(ledger, file = LEDGER_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeLedger(ledger));
}

/**
 * Enrol a finding. Every semantic field is supplied by the operator; the only
 * things derived here are identity and the opening history entry.
 *
 * Observed structural facts about the source comment (its actor, whether it was
 * a reply) are RECORDED rather than used to refuse. Refusing would put the
 * machine's judgement above the operator's, which is the inversion this whole
 * design exists to prevent - but hiding those facts would be its own defect, so
 * they travel with the record.
 */
export function enrol(ledger, { source, severity, rootCauseFamily, runtimeOrEvidence, by, at }) {
  const fields = { severity, rootCauseFamily, runtimeOrEvidence, by, at };
  for (const [name, value] of Object.entries(fields)) {
    if (!isText(value)) throw new Error(`cannot enrol: ${name} must be supplied explicitly by the operator`);
  }
  const id = findingId({
    commentId: source?.commentId,
    raisedAtSha: source?.raisedAtSha,
    filePath: source?.path,
    originalLine: source?.originalLine,
  });
  if (ledger.findings.some((f) => f.id === id)) {
    throw new Error(`already enrolled: ${id}`);
  }
  const record = {
    id,
    source: {
      kind: "github_review_comment",
      pr: source.pr,
      commentId: source.commentId,
      raisedAtSha: source.raisedAtSha,
      path: source.path,
      originalLine: source.originalLine,
      // Observed, not judged.
      actorId: source.actorId ?? UNKNOWN,
      inReplyToId: source.inReplyToId ?? null,
    },
    enrolledBy: by,
    enrolledAt: at,
    severity,
    rootCauseFamily,
    runtimeOrEvidence,
    acceptedRisk: null,
    history: [{ state: OPEN, sha: source.raisedAtSha, at, by }],
  };
  return { ...ledger, findings: [...ledger.findings, record] };
}

/** The last recorded transition. State is never stored as a bare scalar. */
export const currentEntry = (finding) => finding.history[finding.history.length - 1];

/**
 * Append a transition. History is APPEND-ONLY: a mistaken entry is corrected by
 * appending, never by rewriting, so the record of what was believed and when
 * survives.
 */
export function mark(ledger, id, state, { sha, by, at, reason = null }) {
  const finding = ledger.findings.find((f) => f.id === id);
  if (!finding) throw new Error(`not enrolled: ${id}`);
  if (!STATES.includes(state)) throw new Error(`unknown state ${state}`);
  if (!isSha(sha)) throw new Error(`a transition must name the sha it happened at (got ${JSON.stringify(sha)})`);
  if (!isText(by) || !isText(at)) throw new Error("a transition must record who made it and when");
  if (state === ACCEPTED_RISK && !isText(reason)) {
    throw new Error("ACCEPTED_RISK requires an explicit operator reason");
  }

  const from = currentEntry(finding).state;
  if (!NEXT[from].includes(state)) {
    throw new Error(`${from} -> ${state} is not a monotonic transition (allowed: ${NEXT[from].join(", ") || "none, terminal"})`);
  }

  const updated = {
    ...finding,
    acceptedRisk: state === ACCEPTED_RISK ? { by, at, reason, sha } : finding.acceptedRisk,
    history: [...finding.history, { state, sha, at, by, ...(reason ? { reason } : {}) }],
  };
  return { ...ledger, findings: ledger.findings.map((f) => (f.id === id ? updated : f)) };
}

/**
 * THE CURRENCY QUERY. What is this finding's state AT a given head?
 *
 * A state recorded at another sha says nothing about this one. That answer is
 * UNKNOWN - not OPEN, which would invent a regression, and not the stored state,
 * which would silently carry a proof across a head change it was never bound to.
 */
export function stateAt(finding, sha) {
  const entry = currentEntry(finding);
  // Terminal on the operator's authority rather than on any head, so it holds
  // everywhere: an accepted risk was accepted for the finding, not for a build.
  if (entry.state === ACCEPTED_RISK) return { state: ACCEPTED_RISK, sha: entry.sha, boundToHead: false };
  if (!isSha(sha)) return { state: UNKNOWN, sha: entry.sha, reason: "no head sha to bind against" };
  if (entry.sha.toLowerCase().startsWith(sha.toLowerCase()) || sha.toLowerCase().startsWith(entry.sha.toLowerCase())) {
    return { state: entry.state, sha: entry.sha, boundToHead: true };
  }
  return {
    state: UNKNOWN,
    sha: entry.sha,
    boundToHead: false,
    reason: `last recorded ${entry.state} at ${entry.sha.slice(0, 10)}, which is not this head`,
  };
}

/** How many repair rounds this finding has had. Deterministic counting. */
export const repairRound = (finding) => finding.history.filter((h) => h.state === REPAIRED).length;

/**
 * Everything CP-007 needs, and nothing it does not. Every field here is either
 * operator-confirmed or a count; none is parsed from prose.
 */
export function forStopLaws(ledger, sha) {
  return ledger.findings.map((f) => ({
    id: f.id,
    state: stateAt(f, sha),
    recordedState: currentEntry(f).state,
    severity: f.severity,
    rootCauseFamily: f.rootCauseFamily,
    runtimeOrEvidence: f.runtimeOrEvidence,
    raisedAtSha: f.source.raisedAtSha,
    repairedShas: f.history.filter((h) => h.state === REPAIRED).map((h) => h.sha),
    verifiedSha: f.history.find((h) => h.state === VERIFIED)?.sha ?? null,
    repairRound: repairRound(f),
    acceptedRiskBy: f.acceptedRisk?.by ?? null,
    pr: f.source.pr,
  }));
}
