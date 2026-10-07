// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, row 2: strict parsers for the production base and the PR's
// context (SPEC-05A §2.1–§2.5). Pure; every result is a closed, frozen record
// or a closed failure, and nothing throws.
//
// Live trap (2026-10-07): a filtered `timelineItems(itemTypes:[...])` reports a
// `totalCount` of EVERY timeline item — #720 says 36 for its one base change.
// So the base-change count is the number of filtered NODES, with
// `pageInfo.hasNextPage` proving the page is the whole set.
// ---------------------------------------------------------------------------

import {
  fail,
  graphqlData,
  hasExactly,
  isIsoUtc,
  isNonEmptyString,
  isNonNegInt,
  isObject,
  isPosInt,
  isSha40,
  okRecord,
} from "../../../contract/strict.mjs";

const COMPARE_STATUSES = ["ahead", "behind", "diverged", "identical"];
/** GitHub truncates a compare's file list at 300 files. */
const COMPARE_FILE_CAP = 300;
/** One REST page; a full page cannot prove it is the whole list. */
const PAGE = 100;

/** The PR-context request (SPEC-05A §2.2). Exactly these fields. */
export const PR_CONTEXT_QUERY =
  "query($owner:String!,$name:String!,$n:Int!,$h:GitObjectID!){repository(owner:$owner,name:$name){" +
  "pullRequest(number:$n){number createdAt changedFiles " +
  "baseRefChanges:timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT],first:100){pageInfo{hasNextPage} nodes{__typename}}} " +
  "object(oid:$h){__typename ... on Commit{associatedPullRequests(first:100){pageInfo{hasNextPage} nodes{number}}}}}}";

/** REST compare/{baseSha}...{headSha}: drift, merge base and changed files. */
export function parseCompare(raw, { baseSha } = {}) {
  if (!isObject(raw)) return fail("malformed", "the compare is not an object");
  if (!COMPARE_STATUSES.includes(raw.status)) return fail("malformed", "status is not a known compare status");
  if (!isNonNegInt(raw.behind_by) || !isNonNegInt(raw.ahead_by)) {
    return fail("malformed", "behind_by and ahead_by must be non-negative integers");
  }
  if (!isObject(raw.base_commit) || !isSha40(raw.base_commit.sha)) return fail("malformed", "base_commit.sha");
  if (baseSha !== undefined && raw.base_commit.sha !== baseSha) {
    return fail("malformed", "the compare is for another base than the one requested");
  }
  if (!isObject(raw.merge_base_commit) || !isSha40(raw.merge_base_commit.sha)) {
    return fail("malformed", "merge_base_commit.sha");
  }
  if (!Array.isArray(raw.files)) return fail("malformed", "files is not a list");
  const files = [];
  for (const f of raw.files) {
    if (!isObject(f) || !isNonEmptyString(f.filename)) return fail("malformed", "a changed file has no filename");
    files.push(f.filename);
  }
  return okRecord({
    status: raw.status,
    behindBy: raw.behind_by,
    aheadBy: raw.ahead_by,
    baseSha: raw.base_commit.sha,
    mergeBaseSha: raw.merge_base_commit.sha,
    files,
    filesCapped: files.length >= COMPARE_FILE_CAP,
  });
}

function connection(conn, nodeOk) {
  if (!isObject(conn) || !hasExactly(conn, ["pageInfo", "nodes"])) return null;
  if (!isObject(conn.pageInfo) || !hasExactly(conn.pageInfo, ["hasNextPage"])) return null;
  if (typeof conn.pageInfo.hasNextPage !== "boolean" || !Array.isArray(conn.nodes)) return null;
  if (!conn.nodes.every(nodeOk)) return null;
  return conn;
}

/** GraphQL PR context: creation time, file count, base changes, associated PRs. */
export function parsePrContext(raw, { expectedNumber } = {}) {
  const env = graphqlData(raw);
  if (env.failure) return env.failure;
  const data = env.data;
  if (!hasExactly(data, ["repository"])) return fail("malformed", "data is not exactly { repository }");
  if (data.repository === null) return fail("read_failed", "the repository is not visible to this credential");
  const repo = data.repository;
  if (!isObject(repo) || !hasExactly(repo, ["pullRequest", "object"])) {
    return fail("malformed", "repository is not exactly { pullRequest, object }");
  }
  if (repo.pullRequest === null) return fail("read_failed", "no such pull request");
  if (repo.object === null) return fail("read_failed", "the head commit is not readable");

  const p = repo.pullRequest;
  if (!isObject(p) || !hasExactly(p, ["number", "createdAt", "changedFiles", "baseRefChanges"])) {
    return fail("malformed", "the pull request does not carry exactly the requested fields");
  }
  if (!isPosInt(p.number) || (expectedNumber !== undefined && p.number !== expectedNumber)) {
    return fail("malformed", "the answer names another pull request");
  }
  if (!isIsoUtc(p.createdAt)) return fail("malformed", "createdAt is not an ISO-8601 UTC timestamp");
  if (!isNonNegInt(p.changedFiles)) return fail("malformed", "changedFiles is not a non-negative integer");
  const changes = connection(
    p.baseRefChanges,
    (n) => isObject(n) && hasExactly(n, ["__typename"]) && n.__typename === "BaseRefChangedEvent",
  );
  if (!changes) return fail("malformed", "baseRefChanges is not a page of BaseRefChangedEvent nodes");

  const o = repo.object;
  if (!isObject(o) || !hasExactly(o, ["__typename", "associatedPullRequests"]) || o.__typename !== "Commit") {
    return fail("malformed", "the head object is not a Commit with associated pull requests");
  }
  const assoc = connection(o.associatedPullRequests, (n) => isObject(n) && hasExactly(n, ["number"]) && isPosInt(n.number));
  if (!assoc) return fail("malformed", "associatedPullRequests is not a page of { number } nodes");

  return okRecord({
    createdAt: p.createdAt,
    changedFiles: p.changedFiles,
    baseRefChanges: changes.pageInfo.hasNextPage ? "too_many" : changes.nodes.length,
    associatedPrNumbers: assoc.pageInfo.hasNextPage ? "too_many" : assoc.nodes.map((n) => n.number),
  });
}

/** REST pulls?head=<owner>:<headRef>&state=all: every PR ever opened from this head branch. */
export function parseHeadBranchPrs(raw, { headRef } = {}) {
  if (!Array.isArray(raw)) return fail("malformed", "the pull request list is not a list");
  const numbers = [];
  for (const p of raw) {
    if (!isObject(p) || !isPosInt(p.number)) return fail("malformed", "a pull request has no number");
    if (p.state !== "open" && p.state !== "closed") return fail("malformed", "a pull request state is not open or closed");
    if (!isObject(p.head) || p.head.ref !== headRef) return fail("malformed", "a pull request has another head branch");
    if (!(p.head.repo === null || (isObject(p.head.repo) && isPosInt(p.head.repo.id)))) {
      return fail("malformed", "a pull request's head repository is not { id }");
    }
    numbers.push(p.number);
  }
  return okRecord({ numbers, capped: raw.length >= PAGE });
}

/** REST rules/branches/{branch}: the rules in force on the branch now. Proves nothing about history. */
export function parseBranchRules(raw) {
  if (!Array.isArray(raw)) return fail("malformed", "the rules answer is not a list");
  const types = [];
  for (const r of raw) {
    if (!isObject(r) || !isNonEmptyString(r.type)) return fail("malformed", "a rule has no type");
    types.push(r.type);
  }
  return okRecord({ types, nonFastForward: types.includes("non_fast_forward"), deletion: types.includes("deletion") });
}

/** REST activity?ref=...&activity_type=...: recorded history of one activity type on one ref. */
export function parseActivity(raw, { activityType, ref } = {}) {
  if (!Array.isArray(raw)) return fail("malformed", "the activity answer is not a list");
  const events = [];
  for (const e of raw) {
    if (!isObject(e)) return fail("malformed", "an activity is not an object");
    if (e.activity_type !== activityType) return fail("malformed", "an activity of another type was returned");
    if (e.ref !== ref) return fail("malformed", "an activity on another ref was returned");
    if (!isIsoUtc(e.timestamp)) return fail("malformed", "an activity timestamp is not ISO-8601 UTC");
    if (!isSha40(e.before) || !isSha40(e.after)) return fail("malformed", "an activity before/after is not 40 hex");
    events.push({ timestamp: e.timestamp, before: e.before, after: e.after });
  }
  return okRecord({ events, capped: raw.length >= PAGE });
}
