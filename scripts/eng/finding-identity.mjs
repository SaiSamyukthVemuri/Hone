#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005 FOUNDATION: finding recognition and identity, on the shared authority.
//
// This module holds NO interpretation of COMPLETE / AUTHORIZED / UNKNOWN. It
// assembles the two dimensions and hands them to `evidenceCertainty` in
// evidence.mjs, which is the only place that decides POSITIVE vs
// PROVEN_NEGATIVE vs UNKNOWN. A retired vehicle kept a second, hand-written
// interpretation here and got it wrong once per dimension, one review round
// apart; deleting that duplication is the point of this design.
//
// TWO GUARDS, both PROVEN or the answer is UNKNOWN:
//   * AUTHORITY - the trusted reviewer, by immutable account id. A login can be
//     renamed and re-registered; an id cannot.
//   * REPLY STATUS - decided by the projection's declared field contract, not
//     here. GitHub OMITS `in_reply_to_id` on top-level review comments and
//     includes it only on replies, so for THIS field omission is the semantic
//     value - censused at 97 comments across five real PRs. That exception is
//     owned by github-facts.mjs and gated on a discriminator; everywhere else
//     an absent property remains UNKNOWN.
//
// EVIDENCE IS NEVER DISCARDED. A comment that is not a trusted finding is
// retained and attributed to whoever wrote it, with the reason. Whether it
// BLOCKS a clean verdict depends on its certainty, not on its kind: a proven
// spoof or a proven reply is nonblocking, while anything UNKNOWN blocks.
//
// IDENTITY USES ONLY PROVENANCE GITHUB DOES NOT REWRITE. Measured on PR #610: a
// re-anchored finding reads line 552 while it was RAISED at 407, and 8 of 11
// findings there have a null current line. So `line`, `position` and the
// display `commit_id` are unusable. The key is comment id + raised-at sha +
// path + ORIGINAL line.
// ---------------------------------------------------------------------------

import {
  actorAuthority,
  COMPLETE,
  evidenceCertainty,
  isUnknown,
  POSITIVE,
  PROVEN_NEGATIVE,
  PROVEN_REPLY,
  PROVEN_TOP_LEVEL,
  UNKNOWN,
} from "./evidence.mjs";

export { PROVEN_REPLY, PROVEN_TOP_LEVEL };

export const TRUSTED_FINDING = "TRUSTED_FINDING";
export const RAW_EVIDENCE = "RAW_EVIDENCE";
export const ACKNOWLEDGEMENT = "ACKNOWLEDGEMENT";

/**
 * Reply status has THREE states. The projection preserves source presence, so
 * this reads it rather than reconstructing it: UNKNOWN means the raw object
 * never carried `in_reply_to_id`, and that is not evidence of anything.
 */
export function replyCertainty(c) {
  // The projection owns this: it applies GitHub's declared field contract and
  // its discriminator. Consumers read the answer, they do not re-derive it.
  return c?.replyStatus ?? UNKNOWN;
}

/**
 * The stable identity of a finding, or UNKNOWN naming what is absent. Identity
 * is never INVENTED: a record that cannot be named cannot be tracked.
 */
export function findingIdentity(c) {
  const parts = {
    id: c?.id,
    raisedAt: c?.originalCommitId,
    path: c?.path,
    originalLine: c?.originalLine,
  };
  const missing = Object.entries(parts)
    .filter(([, v]) => v === undefined || v === null || isUnknown(v))
    .map(([k]) => k);

  if (missing.length > 0) {
    return { key: UNKNOWN, reason: `stable provenance is incomplete: missing ${missing.join(", ")}`, ...parts };
  }
  // The id alone is unique; the rest is carried IN the key so a record is
  // self-describing and its provenance is checkable without a second lookup.
  return {
    key: `gh:${parts.id}@${parts.raisedAt}:${parts.path}:${parts.originalLine}`,
    reason: "keyed on comment id, raised-at sha, path and original line",
    ...parts,
  };
}

/**
 * Classify one projected inline comment.
 *
 * Both dimensions feed ONE envelope and one shared rule reads it. There is
 * deliberately no per-dimension branch: that is what produced repeated
 * instances of the same defect in the retired vehicle.
 */
export function classifyEvidence(c) {
  const base = {
    id: c?.id ?? UNKNOWN,
    actor: c?.author ?? UNKNOWN,
    actorId: c?.authorId ?? UNKNOWN,
    severity: c?.severity ?? null,
    title: c?.title ?? null,
    path: c?.path ?? UNKNOWN,
    raisedAt: c?.originalCommitId ?? UNKNOWN,
    displayedAt: c?.commitId ?? UNKNOWN,
  };

  if (!c?.severity) {
    // Not finding-shaped at all. That is PROVEN from a body we could read.
    return { ...base, kind: ACKNOWLEDGEMENT, certainty: PROVEN_NEGATIVE, identity: null, reason: "no severity markup" };
  }

  const { authority, reason: authorityReason } = actorAuthority(
    isUnknown(c.authorId) ? UNKNOWN : { id: c.authorId, login: c.author, type: "Bot" },
  );
  const reply = replyCertainty(c);
  const identity = findingIdentity(c);

  // Completeness = everything needed to NAME and PLACE this finding is proven.
  const completeness = identity.key === UNKNOWN || reply === UNKNOWN ? UNKNOWN : COMPLETE;
  const certainty = evidenceCertainty(
    { completeness, authority },
    { provenNegative: reply === PROVEN_REPLY },
  );

  const why = [];
  if (authority !== "AUTHORIZED") why.push(authorityReason);
  if (reply === PROVEN_REPLY) why.push(`answers comment ${c.inReplyToId}, so it is a reply rather than a finding`);
  if (reply === UNKNOWN) why.push("reply status is unknown: the source object never carried in_reply_to_id");
  if (identity.key === UNKNOWN) why.push(identity.reason);

  if (certainty === POSITIVE) {
    return { ...base, kind: TRUSTED_FINDING, certainty, authority, identity, reason: "trusted reviewer, proven top-level, fully provenanced" };
  }
  return {
    ...base,
    kind: RAW_EVIDENCE,
    certainty,
    authority,
    identity: identity.key === UNKNOWN ? identity : null,
    reason: why.join("; ") || "not a trusted finding",
  };
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
