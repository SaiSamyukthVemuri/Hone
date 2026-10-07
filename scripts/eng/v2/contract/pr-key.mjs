// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: the PrSnapshotKey contract.
//
// Contract: PR-SNAPSHOT-01 §2 — nine fields from ONE GraphQL request, with
// `isDraft` a coherence field (PR-SNAPSHOT-DRAFT-01 §15). Equality is
// structural over all nine, and `null` equals only `null`.
//
// The RAW answer is validated before anything is projected. A missing field, a
// wrong type, a `null` where none is allowed, an unknown enum value or an
// unrequested field makes the whole answer `malformed`; a GitHub error, an
// invisible repository or a missing pull request is `read_failed`. There is no
// default branch: nothing is coerced into a plausible value.
//
// Pure: no I/O, no clock, no shared state.
// ---------------------------------------------------------------------------

/** The one request the key comes from. Exactly the nine key fields. */
export const PR_KEY_QUERY =
  "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){" +
  "number state isDraft headRefOid headRefName headRepository{databaseId} baseRefName baseRepository{databaseId} " +
  "baseRef{target{oid}}}}}";

/** The key's fields, in a fixed order. */
export const KEY_FIELDS = Object.freeze([
  "prNumber",
  "state",
  "isDraft",
  "headSha",
  "headRef",
  "headRepoId",
  "baseRef",
  "baseRepoId",
  "baseSha",
]);

const STATES = Object.freeze(["OPEN", "CLOSED", "MERGED"]);
const PR_FIELDS = Object.freeze([
  "number",
  "state",
  "isDraft",
  "headRefOid",
  "headRefName",
  "headRepository",
  "baseRefName",
  "baseRepository",
  "baseRef",
]);
const SHA40 = /^[0-9a-f]{40}$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasExactly = (o, keys) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};
const isPosInt = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
const isSha40 = (v) => typeof v === "string" && SHA40.test(v);

const malformed = (detail) => Object.freeze({ ok: false, reason: "malformed", detail });
const readFailed = (detail) => Object.freeze({ ok: false, reason: "read_failed", detail });

/** `{ databaseId: <positive integer> }` and nothing else, or `undefined`. */
function repoIdOf(v) {
  return isObject(v) && hasExactly(v, ["databaseId"]) && isPosInt(v.databaseId) ? v.databaseId : undefined;
}

/**
 * Validate one raw GraphQL answer to PR_KEY_QUERY.
 *
 * @param {unknown} raw the parsed response body, untouched
 * @param {{ expectedNumber?: number }} [opts] the PR that was asked for
 * @returns {{ ok: true, key: object } | { ok: false, reason: "malformed" | "read_failed", detail: string }}
 */
export function parsePrKey(raw, opts) {
  try {
    return parse(raw, opts);
  } catch {
    // Nothing throws: a getter, a Proxy or any other exotic input fails closed.
    return malformed("the answer could not be validated");
  }
}

function parse(raw, opts) {
  // The number that was asked for is required: a key never compared with it is not this PR's key.
  const expectedNumber = opts === null || opts === undefined ? undefined : opts.expectedNumber;
  if (!isPosInt(expectedNumber)) return malformed("the requested pull request number is required");
  if (!isObject(raw)) return malformed("the answer is not a JSON object");
  if (!Object.keys(raw).every((k) => k === "data" || k === "errors")) {
    return malformed("the answer has a top-level field other than data and errors");
  }
  if (Object.hasOwn(raw, "errors")) {
    if (!Array.isArray(raw.errors) || raw.errors.length === 0) {
      return malformed("errors is present but is not a non-empty list");
    }
    return readFailed("GitHub reported an error for the key request");
  }
  if (!Object.hasOwn(raw, "data")) return malformed("the answer has no data");

  const data = raw.data;
  if (!isObject(data) || !hasExactly(data, ["repository"])) return malformed("data is not exactly { repository }");
  if (data.repository === null) return readFailed("the repository is not visible to this credential");
  const repository = data.repository;
  if (!isObject(repository) || !hasExactly(repository, ["pullRequest"])) {
    return malformed("repository is not exactly { pullRequest }");
  }
  if (repository.pullRequest === null) return readFailed("no such pull request");

  const p = repository.pullRequest;
  if (!isObject(p) || !hasExactly(p, PR_FIELDS)) {
    return malformed("the pull request does not carry exactly the nine key fields");
  }
  if (!isPosInt(p.number)) return malformed("number is not a positive integer");
  if (p.number !== expectedNumber) {
    return malformed(`the answer names pull request ${p.number}, not ${expectedNumber}`);
  }
  if (!STATES.includes(p.state)) return malformed("state is not OPEN, CLOSED or MERGED");
  if (typeof p.isDraft !== "boolean") return malformed("isDraft is not a boolean");
  if (!isSha40(p.headRefOid)) return malformed("headRefOid is not 40 lowercase hex");
  if (!isNonEmptyString(p.headRefName)) return malformed("headRefName is not a non-empty string");
  if (!isNonEmptyString(p.baseRefName)) return malformed("baseRefName is not a non-empty string");

  const baseRepoId = repoIdOf(p.baseRepository);
  if (baseRepoId === undefined) return malformed("baseRepository is not { databaseId: <positive integer> }");

  const open = p.state === "OPEN";

  // A head repository can be deleted after the PR closes; an open PR needs it.
  let headRepoId;
  if (p.headRepository === null) {
    if (open) return malformed("an open pull request has no head repository");
    headRepoId = null;
  } else {
    headRepoId = repoIdOf(p.headRepository);
    if (headRepoId === undefined) return malformed("headRepository is not { databaseId: <positive integer> }");
  }

  // The live base tip, never the recorded baseRefOid. A terminal PR has no live
  // merge target, so its base value is present but ignored (PR-SNAPSHOT-01 §2).
  let baseSha = null;
  if (open) {
    const b = p.baseRef;
    if (
      !isObject(b) ||
      !hasExactly(b, ["target"]) ||
      !isObject(b.target) ||
      !hasExactly(b.target, ["oid"]) ||
      !isSha40(b.target.oid)
    ) {
      return malformed("an open pull request has no readable live base tip");
    }
    baseSha = b.target.oid;
  }

  return Object.freeze({
    ok: true,
    key: Object.freeze({
      prNumber: p.number,
      state: p.state,
      isDraft: p.isDraft,
      headSha: p.headRefOid,
      headRef: p.headRefName,
      headRepoId,
      baseRef: p.baseRefName,
      baseRepoId,
      baseSha,
    }),
  });
}

/**
 * Is `k` a well-formed key — exactly the nine fields, each satisfying §2? The
 * coherence pass re-checks every key a reader hands it, so even an
 * out-of-contract reader can never make a non-key coherent.
 */
export function isPrKey(k) {
  try {
    if (!isObject(k) || !hasExactly(k, KEY_FIELDS)) return false;
    if (!isPosInt(k.prNumber) || !STATES.includes(k.state) || typeof k.isDraft !== "boolean") return false;
    if (!isSha40(k.headSha) || !isNonEmptyString(k.headRef) || !isNonEmptyString(k.baseRef)) return false;
    if (!isPosInt(k.baseRepoId)) return false;
    if (k.state === "OPEN") return isPosInt(k.headRepoId) && isSha40(k.baseSha);
    return (k.headRepoId === null || isPosInt(k.headRepoId)) && k.baseSha === null;
  } catch {
    return false;
  }
}

/** Structural equality over all nine fields; `null` equals only `null`. */
export function keysEqual(a, b) {
  return KEY_FIELDS.every((f) => a[f] === b[f]);
}
