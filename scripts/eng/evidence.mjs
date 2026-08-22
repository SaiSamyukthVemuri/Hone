#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005: the evidence envelope.
//
// THIS MODULE NO LONGER GATES A POSITIVE ASSERTION, BECAUSE THE TOOL NO LONGER
// MAKES ONE.
//
// Five vehicles (#617-#621) tried to decide when evidence was good enough to
// emit CI GREEN or REVIEW CLEAN. Every one was retired for the same defect:
// unknown, invalid or incomplete evidence producing a positive conclusion. The
// last of them broke twice in code written specifically to prevent it - a
// verdict with unknown actor authority was silently outvoted by a valid one,
// and a check collection whose advertised total was absent or malformed was
// labelled COMPLETE.
//
// The lesson is not that the gate needed another guard. It is that the CLAIM was
// the liability. So the claim is gone: this envelope now carries observations,
// and the operator decides readiness.
//
// What survives is everything that reads GitHub honestly - completeness
// evidence, actor authority, UNKNOWN as a first-class value. Those are facts.
// `mayAssertPositive` is deliberately absent: there is no positive assertion
// left for it to guard, and reintroducing it would reintroduce the family.
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
  if (!user || user.id === undefined || user.id === null) {
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
