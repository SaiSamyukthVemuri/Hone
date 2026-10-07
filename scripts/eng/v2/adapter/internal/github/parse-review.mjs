// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, rows 4-5: review evidence — reviews, PR issue comments and
// review threads — from ONE GraphQL response (CAP-01 §17). Every connection,
// each thread's own comments included, is complete in this response or the
// whole evidence is `review_evidence_too_large`; a malformed answer is
// `malformed`, and malformed wins over incomplete so the reason never depends
// on which connection GitHub listed first. Logins are read only to validate
// the shape: identity is the numeric id plus the account type.
//
// The answer must echo the requested pull request number, so evidence can never
// be attributed to a PR it was not read for. Records come out in a canonical
// order (reviews and comments by id, threads by content), so any reordering of
// the same answer normalizes to the same evidence (CAP-01 L7). Nothing throws.
// ---------------------------------------------------------------------------

import {
  fail,
  graphqlData,
  hasExactly,
  isNonNegInt,
  isObject,
  isPosInt,
  isSha40,
  okRecord,
} from "../../../contract/strict.mjs";

const ACTOR = "author{__typename login ... on Bot{databaseId} ... on User{databaseId}}";
const LIMIT = 100;

/** Exactly the fields 05A reads, each connection at its largest page with its completeness fields. */
export const REVIEW_EVIDENCE_QUERY =
  "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){number " +
  `reviews(first:100){totalCount pageInfo{hasNextPage} nodes{databaseId state body commit{oid} ${ACTOR}}} ` +
  `comments(first:100){totalCount pageInfo{hasNextPage} nodes{databaseId body ${ACTOR}}} ` +
  "reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved isOutdated " +
  "resolvedBy{__typename login databaseId} " +
  `comments(first:100){totalCount pageInfo{hasNextPage} nodes{databaseId ${ACTOR}}}}}}}}`;

class Malformed extends Error {}

/** `{ nodes }` of a complete connection; marks `state.incomplete` when it cannot be. */
function connection(c, state) {
  if (!isObject(c) || !hasExactly(c, ["totalCount", "pageInfo", "nodes"])) throw new Malformed("connection");
  if (!isObject(c.pageInfo) || !hasExactly(c.pageInfo, ["hasNextPage"])) throw new Malformed("pageInfo");
  if (typeof c.pageInfo.hasNextPage !== "boolean" || !isNonNegInt(c.totalCount) || !Array.isArray(c.nodes)) {
    throw new Malformed("connection fields");
  }
  if (c.pageInfo.hasNextPage || c.totalCount > LIMIT || c.totalCount !== c.nodes.length) state.incomplete = true;
  return c.nodes;
}

/** `{ id, type }` for a User or Bot, `{ id: null, type }` for any other actor, `null` for a deleted one. */
function actorOf(a) {
  if (a === null) return null;
  if (!isObject(a) || typeof a.__typename !== "string" || typeof a.login !== "string") throw new Malformed("actor");
  if (a.__typename === "User" || a.__typename === "Bot") {
    if (!hasExactly(a, ["__typename", "login", "databaseId"]) || !isPosInt(a.databaseId)) throw new Malformed("actor id");
    return { id: a.databaseId, type: a.__typename };
  }
  if (!hasExactly(a, ["__typename", "login"])) throw new Malformed("actor fields");
  return { id: null, type: a.__typename };
}

const byId = (a, b) => a.id - b.id;
const canonical = (a, b) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Ids must be unique within a connection: a repeated id is not one artifact. */
function uniqueIds(records, what) {
  if (new Set(records.map((r) => r.id)).size !== records.length) throw new Malformed(`a ${what} id repeats`);
  return records;
}

/**
 * @param {unknown} raw the parsed GraphQL answer to REVIEW_EVIDENCE_QUERY
 * @param {{ expectedNumber: number }} opts the pull request that was asked for (required)
 */
export function parseReviewEvidence(raw, opts) {
  try {
    return parse(raw, opts);
  } catch {
    return fail("malformed", "review evidence could not be validated");
  }
}

function parse(raw, opts) {
  const expectedNumber = opts === null || opts === undefined ? undefined : opts.expectedNumber;
  if (!isPosInt(expectedNumber)) return fail("malformed", "the requested pull request number is required");
  const env = graphqlData(raw);
  if (env.failure) return env.failure;
  const data = env.data;
  if (!hasExactly(data, ["repository"])) return fail("malformed", "data is not exactly { repository }");
  if (data.repository === null) return fail("read_failed", "the repository is not visible to this credential");
  if (!isObject(data.repository) || !hasExactly(data.repository, ["pullRequest"])) {
    return fail("malformed", "repository is not exactly { pullRequest }");
  }
  const p = data.repository.pullRequest;
  if (p === null) return fail("read_failed", "no such pull request");

  const state = { incomplete: false };
  try {
    if (!isObject(p) || !hasExactly(p, ["number", "reviews", "comments", "reviewThreads"])) throw new Malformed("pull request");
    if (p.number !== expectedNumber) throw new Malformed(`the answer names pull request ${p.number}, not ${expectedNumber}`);

    const reviews = connection(p.reviews, state).map((r) => {
      if (!isObject(r) || !hasExactly(r, ["databaseId", "state", "body", "commit", "author"])) throw new Malformed("review");
      if (!isPosInt(r.databaseId) || typeof r.state !== "string" || typeof r.body !== "string") throw new Malformed("review");
      if (!(r.commit === null || (isObject(r.commit) && hasExactly(r.commit, ["oid"]) && isSha40(r.commit.oid)))) {
        throw new Malformed("review commit");
      }
      return {
        id: r.databaseId,
        state: r.state,
        body: r.body,
        commitOid: r.commit === null ? null : r.commit.oid,
        author: actorOf(r.author),
      };
    });

    const comments = connection(p.comments, state).map((c) => {
      if (!isObject(c) || !hasExactly(c, ["databaseId", "body", "author"])) throw new Malformed("comment");
      if (!isPosInt(c.databaseId) || typeof c.body !== "string") throw new Malformed("comment");
      return { id: c.databaseId, body: c.body, author: actorOf(c.author) };
    });

    const threads = connection(p.reviewThreads, state).map((t) => {
      if (!isObject(t) || !hasExactly(t, ["isResolved", "isOutdated", "resolvedBy", "comments"])) throw new Malformed("thread");
      if (typeof t.isResolved !== "boolean" || typeof t.isOutdated !== "boolean") throw new Malformed("thread");
      let resolver = null;
      if (t.resolvedBy !== null) {
        const r = t.resolvedBy;
        if (!isObject(r) || !hasExactly(r, ["__typename", "login", "databaseId"]) || typeof r.__typename !== "string") {
          throw new Malformed("resolver");
        }
        if (typeof r.login !== "string" || !isPosInt(r.databaseId)) throw new Malformed("resolver");
        resolver = { id: r.databaseId, type: r.__typename };
      }
      const nodes = connection(t.comments, state).map((c) => {
        if (!isObject(c) || !hasExactly(c, ["databaseId", "author"]) || !isPosInt(c.databaseId)) {
          throw new Malformed("thread comment");
        }
        return actorOf(c.author);
      });
      return { isResolved: t.isResolved, isOutdated: t.isOutdated, resolver, opener: nodes.length > 0 ? nodes[0] : null };
    });

    uniqueIds(reviews, "review");
    uniqueIds(comments, "comment");
    if (state.incomplete) {
      return fail("review_evidence_too_large", "review evidence does not fit one complete response");
    }
    return okRecord({ reviews: reviews.sort(byId), comments: comments.sort(byId), threads: threads.sort(canonical) });
  } catch (e) {
    if (e instanceof Malformed) return fail("malformed", `review evidence: ${e.message}`);
    return fail("malformed", "review evidence could not be validated");
  }
}
