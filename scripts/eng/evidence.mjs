#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005a: the evidence envelope.
//
// THE INVARIANT, in one place:
//
//   A POSITIVE fact - CI GREEN, REVIEW CLEAN - may be emitted ONLY when the
//   evidence behind it is both sufficiently COMPLETE and sufficiently
//   AUTHORIZED. Anything else is UNKNOWN, or the raw non-clean state.
//
// WHY IT IS CENTRAL RATHER THAN PER-CALL-SITE. The first version of this module
// stated that invariant in prose and enforced it ad hoc at each surface. It
// then broke it twice, independently, at its first review:
//
//   * check runs were read UNPAGINATED, so with the page forced to 5 the module
//     reported GREEN from 5 checks while the same response said total_count=12.
//     Seven checks were never read, and the proof of incompleteness was sitting
//     in the response it had already parsed.
//   * ANY comment containing the verdict marker was accepted as a Codex
//     verdict, so any actor could produce COMPLETE_CLEAN.
//
// Both are one family: a positive fact asserted on insufficient evidence. Two
// independent violations of a stated invariant is a missing mechanism, not two
// slips, so the mechanism now exists exactly once and every positive fact must
// pass through `mayAssertPositive`.
// ---------------------------------------------------------------------------

export const UNKNOWN = "UNKNOWN";

/** Is the evidence all of what exists? */
export const COMPLETE = "COMPLETE";
export const INCOMPLETE = "INCOMPLETE";

/** Does the evidence come from an actor entitled to assert it? */
export const AUTHORIZED = "AUTHORIZED";
export const UNAUTHORIZED = "UNAUTHORIZED";

/** One envelope shape for every fact that can contribute to a positive state. */
export function evidence(value, { completeness, authority, reason }) {
  return Object.freeze({ value, completeness, authority, reason });
}

/**
 * THE GATE. The only place a positive fact is permitted. Both dimensions are
 * load-bearing and neither substitutes for the other: a check-run collection is
 * authorized (GitHub reported it about itself) but may be incomplete, while a
 * verdict may be complete (the whole comment was read) but unauthorized
 * (someone else wrote it).
 */
export function mayAssertPositive(env) {
  return env?.completeness === COMPLETE && env?.authority === AUTHORIZED;
}

/** Certainty outcomes. UNKNOWN, declared above, is the third. */
export const POSITIVE = "POSITIVE";
export const PROVEN_NEGATIVE = "PROVEN_NEGATIVE";

/**
 * Read a property from a RAW payload, preserving the difference between
 * ABSENT and PRESENT-WITH-NULL.
 *
 * This is the foundation of the whole pipeline. `raw.x ?? null` destroys that
 * difference at the ingestion boundary, and once destroyed it cannot be
 * recovered downstream however careful the consumer is. A retired vehicle
 * learned this twice: an absent `in_reply_to_id` became `null`, `null` means
 * PROVEN top-level, and a comment of unknown reply status became a positive
 * trusted finding.
 *
 * ABSENCE IS UNKNOWN BY DEFAULT. A field may pass `absentMeans` to declare that
 * its UPSTREAM API CONTRACT defines omission as a semantic value - but only
 * where that contract is pinned by real evidence. This is an explicit,
 * per-field, evidenced exception, never a general licence to read missing
 * properties as meaningful.
 *
 * UNKNOWN is a STRING sentinel, not `undefined`, because these projections are
 * serialized to JSON fixtures and `JSON.stringify` erases `undefined` outright.
 * A representation that cannot survive its own fixtures would reintroduce the
 * defect the moment a test round-tripped.
 */
export function sourceField(raw, key, { absentMeans = UNKNOWN } = {}) {
  if (!raw || typeof raw !== "object") return UNKNOWN;
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return absentMeans;
  return raw[key];
}

/**
 * Reply vocabulary. It lives here rather than in a consumer because it is
 * certainty vocabulary: a proven reply is a PROVEN_NEGATIVE for findings.
 */
export const PROVEN_TOP_LEVEL = "PROVEN_TOP_LEVEL";
export const PROVEN_REPLY = "PROVEN_REPLY";

/** True when a projected field carries no source information at all. */
export const isUnknown = (v) => v === UNKNOWN;

/**
 * THE ONE SEMANTIC AUTHORITY for evidence certainty. Every positive delivery
 * fact - CLEAN, GREEN, TRUSTED_FINDING - routes through here.
 *
 * THE LAW:
 *   UNKNOWN never proves a negative, and never permits a positive.
 *   A negative must be PROVEN, never inferred from absence.
 *
 * It extends `mayAssertPositive` with the distinction that gate cannot make on
 * its own: NOT-POSITIVE splits into PROVEN_NEGATIVE and UNKNOWN. Verified, not
 * assumed - `mayAssertPositive` returns false for BOTH `UNAUTHORIZED` and
 * `UNKNOWN` authority, while those two require opposite outcomes.
 *
 * `provenNegative` carries negatives that are not expressible on the two
 * dimensions - a comment PROVEN to be a reply is one. It is never used for
 * absence.
 */
export function evidenceCertainty(env, { provenNegative = false } = {}) {
  if (provenNegative) return PROVEN_NEGATIVE;
  // UNAUTHORIZED is PROVEN: we know who wrote it and it is not the reviewer.
  // UNKNOWN authority is not, and falls through.
  if (env?.authority === UNAUTHORIZED) return PROVEN_NEGATIVE;
  if (mayAssertPositive(env)) return POSITIVE;
  return UNKNOWN;
}

/**
 * The reviewer whose verdict counts.
 *
 * `id` is the load-bearing field: a numeric account id is immutable, while a
 * login can be renamed and later re-registered by someone else. `login` is kept
 * for human output only and is never the basis of a trust decision.
 *
 * DELIBERATELY NOT USED as authority:
 *   * `author_association` - measured on real objects, Codex reports NONE while
 *     a human repository owner reports OWNER, so it grades the wrong thing;
 *   * `performed_via_github_app` - present on issue comments but absent from
 *     reviews and inline comments, so it cannot be applied uniformly;
 *   * the verdict wording itself - which is exactly what anyone can copy.
 */
export const CODEX_ACTOR = Object.freeze({
  id: 199175422,
  type: "Bot",
  login: "chatgpt-codex-connector[bot]",
});

/**
 * Authority of the actor behind one object. A missing identity is UNKNOWN, not
 * UNAUTHORIZED: "we could not tell who wrote this" and "someone untrusted wrote
 * this" are different facts, and neither may produce a positive one.
 */
export function actorAuthority(user, trusted = CODEX_ACTOR) {
  // An ABSENT actor and an actor whose id we could not read are both UNKNOWN -
  // never UNAUTHORIZED. "We cannot tell who wrote this" is not "someone
  // untrusted wrote this", and only the latter is a proven negative.
  if (user === UNKNOWN || !user || user.id === undefined || user.id === null || user.id === UNKNOWN) {
    return { authority: UNKNOWN, reason: "actor identity is missing from the object" };
  }
  if (user.id === trusted.id && user.type === trusted.type) {
    return { authority: AUTHORIZED, reason: `actor id ${user.id} is the trusted reviewer` };
  }
  return {
    authority: UNAUTHORIZED,
    reason: `actor id ${user.id} (${user.login ?? "unknown login"}) is not the trusted reviewer`,
  };
}

/**
 * Completeness of a paginated collection.
 *
 * GitHub is the authority for its own resources, so a successfully collected
 * list is AUTHORIZED; what varies is whether all of it was read. Three ways it
 * is not:
 *   * the request failed, or failed part-way through pagination;
 *   * the response advertises a `total_count` larger than what was collected;
 *   * nothing came back at all, which the caller may treat as UNKNOWN rather
 *     than as "there are none".
 *
 * No page size is special-cased. The count comparison holds for any pagination.
 */
export function collectionEvidence(items, { totalCount = null, error = null, pages = null } = {}) {
  if (error) {
    return evidence(UNKNOWN, {
      completeness: UNKNOWN,
      authority: UNKNOWN,
      reason: `collection could not be read: ${error}`,
    });
  }
  const collected = Array.isArray(items) ? items.length : 0;
  if (totalCount !== null && totalCount !== undefined && collected < totalCount) {
    return evidence(items, {
      completeness: INCOMPLETE,
      authority: AUTHORIZED,
      reason: `collected ${collected} of ${totalCount} reported by the API${pages ? ` across ${pages} page(s)` : ""}`,
    });
  }
  return evidence(items, {
    completeness: COMPLETE,
    authority: AUTHORIZED,
    reason:
      totalCount === null || totalCount === undefined
        ? `collected ${collected} item(s); the API reported no total to check against`
        : `collected ${collected} of ${totalCount} reported by the API`,
  });
}

/**
 * One normalized verdict, whichever surface it came from.
 *
 * An issue comment and a submitted review body are two places the same claim can
 * appear. Giving them separate truth logic is what made a verdict readable from
 * one surface and invisible from the other, so they normalize to this shape and
 * one rule is applied to both.
 */
export function verdictEvidence({ sourceType, sourceId, user, reviewedCommit, clean, hasBody = true }) {
  const { authority, reason } = actorAuthority(user);
  // A body that says nothing states no verdict, however trusted its author.
  const completeness = hasBody && reviewedCommit ? COMPLETE : INCOMPLETE;
  const completenessReason = !hasBody
    ? "the review object carries no body, so it states no verdict"
    : !reviewedCommit
      ? "no reviewed commit is declared, so the verdict names no head"
      : "verdict text and reviewed commit are both present";
  return Object.freeze({
    sourceType,
    sourceId,
    actor: user?.login ?? UNKNOWN,
    actorId: user?.id ?? null,
    reviewedCommit: reviewedCommit ?? null,
    clean: clean ?? null,
    completeness,
    authority,
    reason: `${completenessReason}; ${reason}`,
  });
}
