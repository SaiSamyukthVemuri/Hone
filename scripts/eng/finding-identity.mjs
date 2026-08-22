#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005b-1: what counts as a TRUSTED FINDING, and what is its stable identity.
//
// This module answers one question and stores nothing. It has no OPEN /
// REPAIRED / VERIFIED transitions, no ACCEPTED_RISK persistence, no repair
// round, no release readiness and no stop law - those belong to CP-005b-2 and
// CP-005c. A bug in identity must not be able to hide inside ledger behaviour,
// which is why the two live in separate vehicles.
//
// WHY IT EXISTS (finding F4 on PR #616, accepted as a known limitation there
// and carried here as the mandatory first contract). Inline findings were
// classified from body markup alone, so ANY actor posting the severity badge
// was counted as a finding. It reproduced on live data during the disposition
// of that very finding: a reply written to RECORD the spoof scenario quoted the
// badge markup and was itself counted as a P1 authored by a human.
//
// TWO INDEPENDENT GUARDS, because either alone is insufficient:
//   * AUTHORITY - the comment must come from the trusted reviewer. A stranger
//     copying the markup is not a finding.
//   * REPLY STATUS - a comment answering another comment is structurally a
//     reply, not a finding, EVEN FROM THE TRUSTED ACTOR. That is what the
//     live F4 instance actually was.
// Neither guard is load-bearing on its own and the tests prove each
// independently.
//
// EVIDENCE IS NEVER DISCARDED. A rejected comment becomes RAW_EVIDENCE,
// retained and attributed to its real author, so a look-alike stays visible
// without ever creating a finding.
//
// IDENTITY USES ONLY STABLE PROVENANCE. GitHub rewrites a comment's displayed
// position as the head moves: on PR #610 a re-anchored finding reads line 552
// while it was raised at line 407, and 8 of 11 findings there have a null
// current line. So `line`, `position` and the display `commit_id` are all
// unusable as identity. The key is built from the comment id, the sha it was
// RAISED at, the path, and the ORIGINAL line.
// ---------------------------------------------------------------------------

import { actorAuthority, AUTHORIZED, UNKNOWN } from "./evidence.mjs";

/** A comment that is genuinely a reviewer's finding. */
export const TRUSTED_FINDING = "TRUSTED_FINDING";

/**
 * Anything carrying finding-shaped markup that is not a trusted finding. Kept
 * and attributed rather than dropped: invisible evidence is its own defect.
 */
export const RAW_EVIDENCE = "RAW_EVIDENCE";

/** A comment with no severity markup at all: an ordinary reply or note. */
export const ACKNOWLEDGEMENT = "ACKNOWLEDGEMENT";

/**
 * A reply is structurally not a finding, whoever wrote it. GitHub sets
 * `in_reply_to_id` on any comment answering another, which is exactly what the
 * live F4 instance was.
 */
export function isReply(c) {
  return c?.inReplyToId !== null && c?.inReplyToId !== undefined;
}

/**
 * The stable identity of a finding, or UNKNOWN when the provenance needed to
 * name it is absent.
 *
 * DELIBERATELY EXCLUDED from the key: `line` and `position` (GitHub rewrites
 * both as the head moves, and nulls `line` once the comment goes outdated) and
 * the display `commit_id` (re-anchoring moves it onto later heads). Keying on
 * any of them would give one finding several identities over its life, which is
 * the opposite of what a monotonic ledger needs.
 *
 * Identity is never INVENTED. Missing provenance yields UNKNOWN so a caller
 * cannot silently mint a record for something it cannot name.
 */
export function findingIdentity(c) {
  const id = c?.id;
  const raisedAt = c?.originalCommitId;
  const path = c?.path;
  const originalLine = c?.originalLine;

  const missing = [];
  if (id === undefined || id === null) missing.push("id");
  if (!raisedAt) missing.push("originalCommitId");
  if (!path) missing.push("path");
  if (originalLine === undefined || originalLine === null) missing.push("originalLine");

  if (missing.length > 0) {
    return {
      key: UNKNOWN,
      reason: `stable provenance is incomplete: missing ${missing.join(", ")}`,
      id: id ?? null,
      raisedAt: raisedAt ?? null,
      path: path ?? null,
      originalLine: originalLine ?? null,
    };
  }

  return {
    // The object id alone is already unique; the remaining fields are carried
    // IN the key so a record is self-describing and its provenance can be
    // checked without a second lookup.
    key: `gh:${id}@${raisedAt}:${path}:${originalLine}`,
    reason: "keyed on comment id, raised-at sha, path and original line",
    id,
    raisedAt,
    path,
    originalLine,
  };
}

/**
 * Classify one projected inline comment.
 *
 * Order matters and is deliberate: a comment with no severity markup is an
 * acknowledgement and never reaches the guards; a comment WITH markup must pass
 * BOTH guards to become a finding, and is otherwise retained as raw evidence
 * with the reason it was rejected and the actor who really wrote it.
 */
export function classifyEvidence(c) {
  const actor = { id: c?.authorId ?? null, login: c?.author ?? null, type: c?.authorType ?? "Bot" };
  const base = {
    id: c?.id ?? null,
    actor: c?.author ?? UNKNOWN,
    actorId: c?.authorId ?? null,
    severity: c?.severity ?? null,
    title: c?.title ?? null,
    path: c?.path ?? null,
    raisedAt: c?.originalCommitId ?? null,
    displayedAt: c?.commitId ?? null,
    isReply: isReply(c),
  };

  if (!c?.severity) {
    return { ...base, kind: ACKNOWLEDGEMENT, identity: null, reason: "no severity markup" };
  }

  // GUARD 1: authority. `authorType` is not always carried by a projection, so
  // an absent type is treated as the bot shape only when the id already matches
  // the trusted reviewer; a wrong id fails regardless.
  const { authority, reason: authorityReason } = actorAuthority(actor);

  // GUARD 2: reply status.
  const reply = isReply(c);

  if (authority !== AUTHORIZED || reply) {
    const why = [];
    if (authority !== AUTHORIZED) why.push(authorityReason);
    if (reply) why.push(`answers comment ${c.inReplyToId}, so it is a reply rather than a finding`);
    return {
      ...base,
      kind: RAW_EVIDENCE,
      authority,
      identity: null,
      // Retained and attributed: visible, never a finding.
      reason: why.join("; "),
    };
  }

  const identity = findingIdentity(c);
  if (identity.key === UNKNOWN) {
    // Trusted, top-level, finding-shaped - but unnameable, so it cannot become
    // a tracked record. It must NOT therefore vanish: this is a real reviewer's
    // finding, and silently dropping it would let a clean verdict for the same
    // head report CLEAN over the top of it. Flagged so callers can refuse to
    // assert clean while it is present. A file-level comment (no original_line)
    // is exactly this shape.
    return {
      ...base,
      kind: RAW_EVIDENCE,
      authority,
      identity,
      trustedButUnidentified: true,
      reason: identity.reason,
    };
  }

  return { ...base, kind: TRUSTED_FINDING, authority, identity, reason: "trusted reviewer, not a reply, fully provenanced" };
}

/** Split a projected comment list into the three kinds, preserving order. */
export function partitionEvidence(comments) {
  const classified = (comments ?? []).map(classifyEvidence);
  return {
    findings: classified.filter((c) => c.kind === TRUSTED_FINDING),
    rawEvidence: classified.filter((c) => c.kind === RAW_EVIDENCE),
    acknowledgements: classified.filter((c) => c.kind === ACKNOWLEDGEMENT),
    all: classified,
  };
}
