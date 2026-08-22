#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005 NORMALIZED EVIDENCE MODEL — the one boundary between raw GitHub JSON
// and every engineering assertion this tool makes.
//
// WHY THIS SHAPE. Four vehicles were retired unmerged for a single root cause:
// UNKNOWN / invalid / incomplete evidence collapsing into a positive assertion.
// The last one (#620) failed on a trusted numeric actor id delivered with
// `user.type: null` — present, so it passed a presence check; invalid, so it
// should never have authorized anything; and the code turned it into a PROVEN
// negative, discarded a real current-head finding, and emitted COMPLETE_CLEAN.
//
// The lesson that produced this file: SOURCE PRESENCE AND SEMANTIC VALIDITY ARE
// DIFFERENT QUESTIONS. A generic presence matcher cannot answer the second one.
// So there is no generic matcher here. Each fact has ONE decoder that owns its
// own validity rules and returns a CANONICAL STATE. Consumers receive only
// states; they never see a raw field, a sentinel, or a nullable convenience
// copy, and they cannot reinterpret what they were not given.
//
// EVERY `UNKNOWN` CARRIES NO PAYLOAD. That is deliberate and load-bearing: with
// `checkJs` on (see ./tsconfig.json) a consumer that reads `.id` without first
// narrowing the state fails to compile. The #620 defect becomes a type error
// rather than a test that someone has to remember to write.
//
// NEVER TURN "PRESENT" INTO "VALID" AUTOMATICALLY.
// ---------------------------------------------------------------------------

// ── state tags ─────────────────────────────────────────────────────────────
// `const` string literals, so TypeScript narrows on them.

export const UNKNOWN = "UNKNOWN";
export const KNOWN_TRUSTED = "KNOWN_TRUSTED";
export const KNOWN_UNTRUSTED = "KNOWN_UNTRUSTED";
export const PROVEN = "PROVEN";
export const TOP_LEVEL = "TOP_LEVEL";
export const REPLY = "REPLY";
export const FINDING = "FINDING";
export const NOT_FINDING = "NOT_FINDING";
export const AUTHORIZED = "AUTHORIZED";
export const UNAUTHORIZED = "UNAUTHORIZED";
export const CLEAN = "CLEAN";
export const WITH_FINDINGS = "WITH_FINDINGS";
export const COMPLETE = "COMPLETE";
export const INCOMPLETE = "INCOMPLETE";

/**
 * @typedef {{ kind: "UNKNOWN", reason: string }} UnknownState
 *
 * @typedef {{ kind: "KNOWN_TRUSTED", id: number, login: string }} ActorTrusted
 * @typedef {{ kind: "KNOWN_UNTRUSTED", id: number, login: string }} ActorUntrusted
 * @typedef {ActorTrusted | ActorUntrusted | UnknownState} ActorIdentity
 *
 * @typedef {{ kind: "PROVEN", reviewId: number }} ProvenanceProven
 * @typedef {ProvenanceProven | UnknownState} ReviewProvenance
 *
 * @typedef {{ kind: "TOP_LEVEL" }} ReplyTopLevel
 * @typedef {{ kind: "REPLY", inReplyToId: number }} ReplyToComment
 * @typedef {ReplyTopLevel | ReplyToComment | UnknownState} ReplyStatus
 *
 * @typedef {{ kind: "PROVEN", key: string, id: number, raisedAt: string,
 *             path: string, originalLine: number }} IdentityProven
 * @typedef {IdentityProven | UnknownState} FindingIdentity
 *
 * @typedef {{ kind: "FINDING", severity: string, title: string }} ShapeFinding
 * @typedef {{ kind: "NOT_FINDING" }} ShapeNotFinding
 * @typedef {ShapeFinding | ShapeNotFinding} FindingShape
 *
 * @typedef {{ kind: "AUTHORIZED", id: number }} AuthorityAuthorized
 * @typedef {{ kind: "UNAUTHORIZED", id: number }} AuthorityUnauthorized
 * @typedef {AuthorityAuthorized | AuthorityUnauthorized | UnknownState} VerdictAuthority
 *
 * @typedef {{ kind: "CLEAN" }} OutcomeClean
 * @typedef {{ kind: "WITH_FINDINGS" }} OutcomeWithFindings
 * @typedef {OutcomeClean | OutcomeWithFindings | UnknownState} VerdictOutcome
 *
 * @typedef {{ kind: "COMPLETE", items: any[] }} CollectionComplete
 * @typedef {{ kind: "INCOMPLETE", items: any[], expected: number, got: number,
 *             reason: string }} CollectionIncomplete
 * @typedef {CollectionComplete | CollectionIncomplete | UnknownState} CheckCollection
 */

/** @param {string} reason @returns {UnknownState} */
export const unknown = (reason) => ({ kind: UNKNOWN, reason });

// ── validity primitives ────────────────────────────────────────────────────
// Each rejects absent, null AND malformed in one predicate. There is no
// separate "is it present" step, because presence was never the question.

/** @param {unknown} v @returns {v is number} */
const validId = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
/** @param {unknown} v @returns {v is string} */
const validText = (v) => typeof v === "string" && v.length > 0;
/** @param {unknown} v @returns {v is string} */
const validSha = (v) => typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v);

/** The trusted reviewer, by IMMUTABLE ACCOUNT ID. A login can be renamed and
 *  re-registered by anyone; an id cannot. `author_association` is not usable
 *  either — Codex reports NONE while the human repository owner reports OWNER. */
export const CODEX_ACTOR = Object.freeze({ id: 199175422, type: "Bot" });

// ── decoders: one per fact ─────────────────────────────────────────────────

/**
 * ActorIdentity. BOTH the id and the type must be valid; a trusted id arriving
 * with a null, absent or non-string type is UNKNOWN, never UNTRUSTED. Treating
 * it as UNTRUSTED is what let #620 discard a real finding and report CLEAN.
 *
 * @param {any} user
 * @param {{id: number, type: string}} [trusted]
 * @returns {ActorIdentity}
 */
export function decodeActorIdentity(user, trusted = CODEX_ACTOR) {
  if (user === null || typeof user !== "object") return unknown("actor object is absent from the payload");
  const { id, type, login } = user;
  if (!validId(id)) return unknown(`actor id ${JSON.stringify(id ?? null)} is not a valid account identifier`);
  if (!validText(type)) return unknown(`actor ${id} has no valid account type (got ${JSON.stringify(type ?? null)})`);
  const name = validText(login) ? login : `account ${id}`;
  if (id === trusted.id && type === trusted.type) return { kind: KNOWN_TRUSTED, id, login: name };
  return { kind: KNOWN_UNTRUSTED, id, login: name };
}

/**
 * ReviewProvenance — proof that a comment is a REVIEW comment at all. This is
 * the discriminator the reply contract below depends on.
 *
 * @param {any} comment @returns {ReviewProvenance}
 */
export function decodeReviewProvenance(comment) {
  const id = comment?.pull_request_review_id;
  if (!validId(id)) return unknown(`no valid review id (got ${JSON.stringify(id ?? null)})`);
  return { kind: PROVEN, reviewId: id };
}

/**
 * ReplyStatus. THE ONE FIELD WHERE ABSENCE IS THE SEMANTIC VALUE: GitHub OMITS
 * `in_reply_to_id` on top-level review comments and includes it only on
 * replies. Censused across 97 comments on five real PRs — 52 absent (all
 * top-level), 45 present (all real ids), ZERO present-null. So an omission
 * proves TOP_LEVEL, but a present-but-invalid value proves nothing.
 *
 * The exception is gated: it only applies once provenance is PROVEN, because
 * "this object has no in_reply_to_id" means nothing about an object that was
 * never a review comment.
 *
 * @param {any} comment @returns {ReplyStatus}
 */
export function decodeReplyStatus(comment) {
  if (decodeReviewProvenance(comment).kind !== PROVEN) {
    return unknown("reply status is undecidable without proven review-comment provenance");
  }
  if (!Object.prototype.hasOwnProperty.call(comment, "in_reply_to_id")) return { kind: TOP_LEVEL };
  const id = comment.in_reply_to_id;
  if (!validId(id)) return unknown(`in_reply_to_id is present but invalid (${JSON.stringify(id ?? null)})`);
  return { kind: REPLY, inReplyToId: id };
}

/**
 * FindingIdentity, built ONLY from provenance GitHub does not rewrite.
 *
 * Measured on PR #610: a re-anchored finding reads line 552 while it was RAISED
 * at 407, and 8 of 11 findings there have a null current line. So `line`,
 * `position` and the display `commit_id` are all unusable — keying on any of
 * them would give one finding several identities over its life.
 *
 * @param {any} comment @returns {FindingIdentity}
 */
export function decodeFindingIdentity(comment) {
  const id = comment?.id;
  const raisedAt = comment?.original_commit_id;
  const path = comment?.path;
  const originalLine = comment?.original_line;
  const missing = [];
  if (!validId(id)) missing.push("id");
  if (!validSha(raisedAt)) missing.push("original_commit_id");
  if (!validText(path)) missing.push("path");
  if (!validId(originalLine)) missing.push("original_line");
  if (missing.length > 0) return unknown(`stable provenance is incomplete: ${missing.join(", ")}`);
  // The id alone is unique; the rest is carried IN the key so a record is
  // self-describing and its provenance is checkable without a second lookup.
  return { kind: PROVEN, key: `gh:${id}@${raisedAt}:${path}:${originalLine}`, id, raisedAt, path, originalLine };
}

const SEVERITY_BADGE = /!\[(P[0-3]) Badge\]/;
// The title follows the badge's closing </sub></sub> and runs to the bold marker.
const FINDING_TITLE = /<\/sub><\/sub>\s+(.+?)\*\*/s;
const CLEAN_VERDICT = /Didn't find any major issues/i;

/**
 * FindingShape — is this body finding-SHAPED? Shape is not trust: anyone can
 * paste the badge markup, which is exactly what #616 F4 caught happening on
 * live data. Authority is decided separately by decodeActorIdentity.
 *
 * @param {any} body @returns {FindingShape}
 */
export function decodeFindingShape(body) {
  const text = validText(body) ? body : "";
  const severity = text.match(SEVERITY_BADGE)?.[1];
  if (!severity) return { kind: NOT_FINDING };
  const title = text.match(FINDING_TITLE)?.[1]?.trim().replace(/\*+$/, "");
  return { kind: FINDING, severity, title: validText(title) ? title : "(untitled)" };
}

/**
 * VerdictAuthority — may this actor's verdict authorize a positive assertion?
 * Derived from ActorIdentity so there is exactly one trust decision in the
 * system, not two that can disagree.
 *
 * @param {any} user @returns {VerdictAuthority}
 */
export function decodeVerdictAuthority(user) {
  const actor = decodeActorIdentity(user);
  if (actor.kind === KNOWN_TRUSTED) return { kind: AUTHORIZED, id: actor.id };
  if (actor.kind === KNOWN_UNTRUSTED) return { kind: UNAUTHORIZED, id: actor.id };
  if (actor.kind === UNKNOWN) return unknown(actor.reason);
  // Every state is handled above, so nothing reaches here. Written as an
  // if-chain ON PURPOSE: TypeScript narrows a JSDoc union correctly this way,
  // but a `switch` with a `default` collapses the residual to `never` on its
  // own and the check proves nothing. A vacuous guard is worse than none,
  // because it reads like protection. Deleting any branch above fails the
  // build - that is verified by a negative control, not assumed.
  /** @type {never} */ const exhaustive = actor;
  return exhaustive;
}

/**
 * VerdictOutcome — what did the review actually SAY? An empty body states
 * nothing; that is UNKNOWN, not clean. Kept separate from authority because
 * "who said it" and "what they said" are different facts, and production
 * previously fused them into a `clean: boolean | null` whose null silently
 * meant "there was no body".
 *
 * @param {any} body @returns {VerdictOutcome}
 */
export function decodeVerdictOutcome(body) {
  const text = typeof body === "string" ? body.trim() : "";
  if (text.length === 0) return unknown("the review states no outcome: its body is empty");
  return CLEAN_VERDICT.test(text) ? { kind: CLEAN } : { kind: WITH_FINDINGS };
}

/**
 * CheckCollection — was the whole collection read? A short page set is
 * INCOMPLETE, and INCOMPLETE can never support GREEN: "we did not see a
 * failure" is not "there was no failure".
 *
 * @param {any} items
 * @param {{ totalCount?: number|null, error?: string|null }} [meta]
 * @returns {CheckCollection}
 */
export function decodeCheckCollection(items, { totalCount = null, error = null } = {}) {
  if (error) return unknown(`collection could not be read: ${error}`);
  if (!Array.isArray(items)) return unknown("collection is absent or not a list");
  if (validId(totalCount) || totalCount === 0) {
    if (items.length !== totalCount) {
      return {
        kind: INCOMPLETE,
        items,
        expected: totalCount,
        got: items.length,
        reason: `read ${items.length} of ${totalCount} item(s)`,
      };
    }
  }
  return { kind: COMPLETE, items };
}

// ── the single positive-assertion gate ─────────────────────────────────────

/**
 * A positive engineering assertion (CLEAN / GREEN / TRUSTED) requires a
 * COMPLETE collection AND an AUTHORIZED speaker. Anything else is UNKNOWN.
 *
 * This is a function over canonical states, never a cached boolean stored
 * beside them — a stored copy is a second truth that can drift from its input,
 * which is the defect class this whole file exists to remove.
 *
 * @param {...any} states
 * @returns {boolean}
 */
export function mayAssertPositive(...states) {
  return states.length > 0 && states.every((s) => s && typeof s.kind === "string" && s.kind !== UNKNOWN);
}

/** @param {{ kind: string }} state @returns {boolean} */
export const isUnknown = (state) => state?.kind === UNKNOWN;

/**
 * Human-readable one-liner for any canonical state. Presentation only.
 * @param {any} state @returns {string}
 */
export function describeState(state) {
  if (!state || typeof state.kind !== "string") return UNKNOWN;
  return state.kind === UNKNOWN ? `${UNKNOWN} (${state.reason})` : state.kind;
}
