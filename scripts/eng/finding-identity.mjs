#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005 FOUNDATION: finding recognition and identity.
//
// Holds NO interpretation of COMPLETE / AUTHORIZED / UNKNOWN. It assembles the
// dimensions and hands them to `evidenceCertainty`, the single authority. A
// retired vehicle kept a second hand-written interpretation here and got it
// wrong once per dimension, one review round apart.
//
// A trusted finding requires ALL of: the trusted reviewer by immutable account
// id AND matching type; proven review-comment provenance; proven top-level
// status; and complete, stable identity. Anything unproven is UNKNOWN, which
// blocks a positive result rather than silently dropping the evidence.
//
// IDENTITY USES ONLY PROVENANCE GITHUB DOES NOT REWRITE. Measured on #610: a
// re-anchored finding reads line 552 while it was RAISED at 407, and 8 of 11
// have a null current line. So `line`, `position` and the display `commit_id`
// are unusable; the key is comment id + raised-at sha + path + ORIGINAL line.
// ---------------------------------------------------------------------------

import {
  actorAuthorityFrom, AUTHORIZED, COMPLETE, evidenceCertainty, POSITIVE,
  PROVEN_NEGATIVE, PROVEN_REPLY, PROVEN_TOP_LEVEL, UNKNOWN,
} from "./evidence.mjs";

export const TRUSTED_FINDING = "TRUSTED_FINDING";
export const RAW_EVIDENCE = "RAW_EVIDENCE";
export const ACKNOWLEDGEMENT = "ACKNOWLEDGEMENT";

const unproven = (v) => v === undefined || v === null || v === UNKNOWN;

/**
 * The stable identity of a finding, or UNKNOWN naming what is absent. Identity
 * is never INVENTED: a record that cannot be named cannot be tracked.
 */
export function findingIdentity(c) {
  const parts = { id: c?.id, raisedAt: c?.originalCommitId, path: c?.path, originalLine: c?.originalLine };
  const missing = Object.entries(parts).filter(([, v]) => unproven(v)).map(([k]) => k);
  if (missing.length > 0) {
    return { key: UNKNOWN, reason: `stable provenance is incomplete: missing ${missing.join(", ")}`, ...parts };
  }
  return {
    key: `gh:${parts.id}@${parts.raisedAt}:${parts.path}:${parts.originalLine}`,
    reason: "keyed on comment id, raised-at sha, path and original line",
    ...parts,
  };
}

/**
 * Classify one projected inline comment. Both dimensions feed ONE envelope and
 * one shared rule reads it - deliberately no per-dimension branch, which is
 * what produced repeated instances of the same defect previously.
 */
export function classifyEvidence(c) {
  const base = {
    id: c?.id ?? UNKNOWN, actor: c?.author ?? UNKNOWN, actorId: c?.authorId ?? UNKNOWN,
    severity: c?.severity ?? null, title: c?.title ?? null, path: c?.path ?? UNKNOWN,
    raisedAt: c?.originalCommitId ?? UNKNOWN, displayedAt: c?.commitId ?? UNKNOWN,
    replyStatus: c?.replyStatus ?? UNKNOWN, provenance: c?.provenance ?? UNKNOWN,
  };

  if (!c?.severity) {
    // Not finding-shaped, proven from a body we could read.
    return { ...base, kind: ACKNOWLEDGEMENT, certainty: PROVEN_NEGATIVE, identity: null, reason: "no severity markup" };
  }

  const { authority, reason: authorityReason } = actorAuthorityFrom(c.actor);
  const reply = base.replyStatus;
  const identity = findingIdentity(c);

  // Completeness = everything needed to NAME and PLACE this finding is proven.
  const completeness = identity.key === UNKNOWN || reply === UNKNOWN ? UNKNOWN : COMPLETE;
  const certainty = evidenceCertainty({ completeness, authority }, { provenNegative: reply === PROVEN_REPLY });

  const why = [];
  if (authority !== AUTHORIZED) why.push(authorityReason);
  if (reply === PROVEN_REPLY) why.push("the source proves this is a reply, not a finding");
  if (reply === UNKNOWN) why.push("reply status is unproven for this object");
  if (identity.key === UNKNOWN) why.push(identity.reason);

  if (certainty === POSITIVE) {
    return { ...base, kind: TRUSTED_FINDING, certainty, authority, identity,
             reason: "trusted reviewer, proven top-level, fully provenanced" };
  }
  return { ...base, kind: RAW_EVIDENCE, certainty, authority,
           identity: identity.key === UNKNOWN ? identity : null,
           reason: why.join("; ") || "not a trusted finding" };
}

/** Split a projected comment list by kind, preserving order. */
export function partitionEvidence(comments) {
  const all = (comments ?? []).map(classifyEvidence);
  return {
    findings: all.filter((c) => c.kind === TRUSTED_FINDING),
    rawEvidence: all.filter((c) => c.kind === RAW_EVIDENCE),
    acknowledgements: all.filter((c) => c.kind === ACKNOWLEDGEMENT),
    /** Anything UNKNOWN, whatever its kind. These block a positive fact. */
    blocking: all.filter((c) => c.certainty === UNKNOWN),
    all,
  };
}
