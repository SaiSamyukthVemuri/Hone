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
// what review evidence MEANT, and all six were retired. The boundary they
// located: automation is reliable at preserving identity, binding to an exact
// SHA, and counting transitions. Semantic judgement is the operator's - so
// `severity`, `rootCauseFamily` and `runtimeOrEvidence` are REQUIRED arguments,
// with no default and nothing parsed to supply them.
//
// CURRENCY IS A QUERY, NEVER A STORED FLAG. `VERIFIED@shaX` is a permanent
// historical fact. Asking whether that finding is verified at shaY returns
// UNKNOWN unless shaY is shaX. A changed head does not reopen findings and does
// not preserve verification: it makes currency unknown, and says so. That is
// the one lesson from the retired vehicles this module has to carry, and it is
// expressible without interpreting anything.
//
// IDENTITY USES ONLY PROVENANCE GITHUB DOES NOT REWRITE. Measured across
// #610/#617/#619/#622: 8 of 34 comments were re-anchored onto a later head and
// `original_commit_id` never moved; 20 of 34 have a NULL display line while
// `original_line` was null zero times. So the key is comment id + raised-at sha
// + path + original line - never the display line or the display commit.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
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
 * The documented semantic domains. The OPERATOR chooses the value; the tool
 * checks the value is one of the documented options. Validation is not
 * judgement - nothing here reads a badge or interprets prose.
 */
export const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
export const CLASSES = Object.freeze(["runtime", "evidence"]);

/** `rootCauseFamily` stays operator-defined text, per the documented contract. */
const fail = (why) => {
  throw new Error(`invalid ledger document: ${why}`);
};

/**
 * The stable identity of an enrolled finding. Every component must be PROVEN;
 * a record that cannot be named is never created, because a ledger keyed on a
 * guess is worse than no ledger.
 */
function identityOf(src, where) {
  try {
    return findingId(src);
  } catch (err) {
    return fail(`${where}: ${err.message}`);
  }
}

export function findingId({ commentId, raisedAtSha, path: filePath, originalLine } = {}) {
  const missing = Object.entries({
    commentId: isId(commentId), raisedAtSha: isSha(raisedAtSha),
    path: isText(filePath), originalLine: isId(originalLine),
  }).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length > 0) throw new Error(`stable identity is incomplete (missing ${missing.join(", ")})`);
  return `gh:${commentId}@${raisedAtSha}:${filePath}:${originalLine}`;
}

/** An empty ledger. Reading a missing file is NOT an error - it is empty. */
/**
 * THE ONE SCHEMA AUTHORITY. A ledger document is fully valid before it can be
 * read, transitioned or written - or it is refused.
 *
 * This exists because two findings on this PR were one missing mechanism: a
 * malformed `findings` property was coerced to `[]` (silently discarding the
 * durable record on the next write), and semantic fields were checked for
 * non-blankness rather than for membership of their documented domain. Both are
 * "present is not valid", the defect class that retired #620 - recurring here.
 *
 * There is deliberately NO coercion path. A malformed document never becomes an
 * empty one.
 */
export function validateLedgerDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("the document is not an object");
  if (raw.version !== LEDGER_VERSION) fail(`version ${JSON.stringify(raw.version)} is not supported (expected ${LEDGER_VERSION})`);
  if (!Array.isArray(raw.findings)) {
    fail(`findings is ${raw.findings === undefined ? "missing" : JSON.stringify(raw.findings)} - it must be an array, and a malformed document is NEVER read as empty`);
  }
  raw.findings.forEach(validateFinding);
  const ids = raw.findings.map((f) => f.id);
  if (new Set(ids).size !== ids.length) fail("two findings share an id");
  return { version: LEDGER_VERSION, findings: raw.findings };
}

/** Every transition in one record: shape, monotonicity and attribution. */
function validateHistory(history, where) {
  if (!Array.isArray(history) || history.length === 0) fail(`${where} has no transition history`);
  let prev = null;
  history.forEach((e, i) => {
    if (!e || !STATES.includes(e.state)) fail(`${where}.history[${i}] has unknown state ${JSON.stringify(e?.state)}`);
    if (!isSha(e.sha)) fail(`${where}.history[${i}] names no valid sha`);
    if (!isText(e.at) || !isText(e.by)) fail(`${where}.history[${i}] does not record who made it and when`);
    if (i === 0 && e.state !== OPEN) fail(`${where}.history must open with ${OPEN}`);
    if (prev && !NEXT[prev].includes(e.state)) fail(`${where}.history[${i}]: ${prev} -> ${e.state} is not a monotonic transition`);
    prev = e.state;
  });
  return prev;
}

/** One finding: identity, operator-supplied domains, and state invariants. */
function validateFinding(f, i) {
  const where = `findings[${i}]`;
  if (!f || typeof f !== "object") fail(`${where} is not a record`);
  const src = f.source;
  if (!src || typeof src !== "object") fail(`${where} has no source`);
  // Identity is re-derived and must match. It is never invented or repaired;
  // findingId throws when a component is missing, which is the right answer.
  if (f.id !== identityOf(src, where)) fail(`${where}.id does not match its own identity fields`);
  if (!SEVERITIES.includes(f.severity)) fail(`${where}.severity ${JSON.stringify(f.severity)} is not one of ${SEVERITIES.join(" | ")}`);
  if (!CLASSES.includes(f.runtimeOrEvidence)) fail(`${where}.runtimeOrEvidence ${JSON.stringify(f.runtimeOrEvidence)} is not one of ${CLASSES.join(" | ")}`);
  if (!isText(f.rootCauseFamily)) fail(`${where}.rootCauseFamily must be operator-supplied text`);
  if (!isText(f.enrolledBy) || !isText(f.enrolledAt)) fail(`${where} does not record who enrolled it and when`);

  const state = validateHistory(f.history, where);
  const verified = f.history.find((h) => h.state === VERIFIED);
  const risk = f.acceptedRisk;
  // State-dependent invariants. There is deliberately NO check that a VERIFIED
  // entry implies state VERIFIED: monotonicity already makes that impossible,
  // since VERIFIED is terminal and can only be last. A branch nothing can trip
  // reads like protection and is not, so it is not written.
  if (Boolean(risk) !== (state === ACCEPTED_RISK)) fail(`${where} has an accepted risk inconsistent with state ${state}`);
  if (state === VERIFIED && !isSha(verified.sha)) fail(`${where} is VERIFIED but names no verified sha`);
  if (state === ACCEPTED_RISK && !(isText(risk.by) && isText(risk.reason))) {
    fail(`${where} is ACCEPTED_RISK without an explicit operator and reason`);
  }
}

export const emptyLedger = () => ({ version: LEDGER_VERSION, findings: [] });

export function loadLedger(file = LEDGER_PATH) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A file that does not exist yet is genuinely empty. A file that EXISTS and
    // is malformed is a different fact entirely, and is refused below.
    return emptyLedger();
  }
  try {
    return validateLedgerDocument(JSON.parse(raw));
  } catch (err) {
    throw err instanceof SyntaxError ? new Error(`invalid ledger document: ${file} is not parseable JSON`) : err;
  }
}

/** Deterministic on disk: same content serializes byte-identically every time. */
export function serializeLedger(ledger) {
  const findings = [...ledger.findings].sort((a, b) => a.id.localeCompare(b.id));
  return `${JSON.stringify({ version: LEDGER_VERSION, findings }, null, 2)}\n`;
}

/**
 * Validate, then write ATOMICALLY. Never write a document we would refuse to
 * read, and never leave a half-written file: on any failure the existing file
 * is left byte-identical.
 */
export function saveLedger(ledger, file = LEDGER_PATH) {
  const valid = validateLedgerDocument(ledger);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializeLedger(valid));
  renameSync(tmp, file);
  return valid;
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
  const doc = validateLedgerDocument(ledger);
  const id = findingId(source);
  if (doc.findings.some((f) => f.id === id)) throw new Error(`already enrolled: ${id}`);
  const { pr, commentId, raisedAtSha, path: filePath, originalLine, actorId, inReplyToId } = source;
  const record = {
    id,
    // `actorId` and `inReplyToId` are observed, not judged: they travel with
    // the record so a reader can see them, and refuse nothing.
    source: { kind: "github_review_comment", pr, commentId, raisedAtSha, path: filePath, originalLine,
      actorId: actorId ?? UNKNOWN, inReplyToId: inReplyToId ?? null },
    enrolledBy: by,
    enrolledAt: at,
    severity,
    rootCauseFamily,
    runtimeOrEvidence,
    acceptedRisk: null,
    history: [{ state: OPEN, sha: source.raisedAtSha, at, by }],
  };
  // Validate the RESULTING document, not just the new record.
  return validateLedgerDocument({ ...doc, findings: [...doc.findings, record] });
}

/** The last recorded transition. State is never stored as a bare scalar. */
export const currentEntry = (finding) => finding.history[finding.history.length - 1];

/**
 * Append a transition. History is APPEND-ONLY: a mistaken entry is corrected by
 * appending, never by rewriting, so the record of what was believed and when
 * survives.
 */
export function mark(ledger, id, state, { sha, by, at, reason = null }) {
  const doc = validateLedgerDocument(ledger);
  const finding = doc.findings.find((f) => f.id === id);
  if (!finding) throw new Error(`not enrolled: ${id}`);
  const updated = {
    ...finding,
    acceptedRisk: state === ACCEPTED_RISK ? { by, at, reason, sha } : finding.acceptedRisk,
    history: [...finding.history, { state, sha, at, by, ...(reason ? { reason } : {}) }],
  };
  return validateLedgerDocument({ ...doc, findings: doc.findings.map((f) => (f.id === id ? updated : f)) });
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
