// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: the shapes of the parser records, as predicates. A binder
// checks every input against these before any rule runs, so an input outside
// the contract is `malformed` — never a pass, never another reason (SPEC-05A
// §0, §3.4). Positive checks only; nothing here throws on a plain value.
// ---------------------------------------------------------------------------

import { isPrKey } from "../../../contract/pr-key.mjs";
import { isIsoUtc, isNonEmptyString, isNonNegInt, isObject, isPosInt, isSha40 } from "../../../contract/strict.mjs";

const isStringOrNull = (v) => v === null || typeof v === "string";
const arrayOf = (v, item) => Array.isArray(v) && v.every(item);

export const isOpenKey = (k) => isPrKey(k) && k.state === "OPEN";

/** `null`, or `{ id: positive integer | null, type: non-empty string }`. */
export const isActor = (a) => a === null || (isObject(a) && (a.id === null || isPosInt(a.id)) && isNonEmptyString(a.type));

export const isCompareRecord = (c) =>
  isObject(c) &&
  isNonNegInt(c.behindBy) &&
  isNonNegInt(c.aheadBy) &&
  isSha40(c.baseSha) &&
  isSha40(c.mergeBaseSha) &&
  arrayOf(c.files, isNonEmptyString) &&
  typeof c.filesCapped === "boolean";

export const isPrContextRecord = (p) =>
  isObject(p) &&
  isIsoUtc(p.createdAt) &&
  isNonNegInt(p.changedFiles) &&
  (isNonNegInt(p.baseRefChanges) || p.baseRefChanges === "too_many") &&
  (arrayOf(p.associatedPrNumbers, isPosInt) || p.associatedPrNumbers === "too_many");

/** bindBase's value (SPEC-05A §2.6), as bindCi receives it. */
export const isBaseValue = (b) =>
  isObject(b) &&
  isObject(b.drift) &&
  isNonNegInt(b.drift.behindBy) &&
  isNonNegInt(b.drift.aheadBy) &&
  arrayOf(b.files, isNonEmptyString) &&
  typeof b.filesCapped === "boolean" &&
  isNonNegInt(b.changedFiles) &&
  (isNonNegInt(b.baseRefChanges) || b.baseRefChanges === "too_many") &&
  (arrayOf(b.associatedPrNumbers, isPosInt) || b.associatedPrNumbers === "too_many");

export const isHeadBranchPrsRecord = (h) => isObject(h) && arrayOf(h.numbers, isPosInt) && typeof h.capped === "boolean";

export const isRulesRecord = (r) =>
  isObject(r) && arrayOf(r.types, isNonEmptyString) && typeof r.nonFastForward === "boolean" && typeof r.deletion === "boolean";

const isEvent = (e) => isObject(e) && isIsoUtc(e.timestamp) && isSha40(e.before) && isSha40(e.after);
export const isActivityRecord = (a) => isObject(a) && arrayOf(a.events, isEvent) && typeof a.capped === "boolean";

const isRun = (r) =>
  isObject(r) &&
  isPosInt(r.id) &&
  isPosInt(r.runNumber) &&
  isPosInt(r.workflowId) &&
  isNonEmptyString(r.event) &&
  isSha40(r.headSha) &&
  isStringOrNull(r.headBranch) &&
  (r.headRepoId === null || isPosInt(r.headRepoId)) &&
  typeof r.status === "string" &&
  isStringOrNull(r.conclusion) &&
  isPosInt(r.runAttempt) &&
  isIsoUtc(r.createdAt);
export const isRunsRecord = (r) => isObject(r) && arrayOf(r.runs, isRun);

const isJob = (j) => isObject(j) && isNonEmptyString(j.name) && typeof j.status === "string" && isStringOrNull(j.conclusion);
export const isJobsRecord = (j) => isObject(j) && arrayOf(j.jobs, isJob);

/** A plain object from run id to a §3.2 jobs record; a Map, an array or a class instance is not one. */
export const isJobsByRunId = (m) => {
  if (!isObject(m)) return false;
  const proto = Object.getPrototypeOf(m);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(m).every((id) => /^[1-9]\d*$/.test(id) && isJobsRecord(m[id]));
};

const isReview = (r) =>
  isObject(r) &&
  isPosInt(r.id) &&
  isNonEmptyString(r.state) &&
  typeof r.body === "string" &&
  (r.commitOid === null || isSha40(r.commitOid)) &&
  isActor(r.author);
const isComment = (c) =>
  isObject(c) && isPosInt(c.id) && typeof c.body === "string" && typeof c.edited === "boolean" && isActor(c.author);
const isThread = (t) =>
  isObject(t) && typeof t.isResolved === "boolean" && typeof t.isOutdated === "boolean" && isActor(t.resolver) && isActor(t.opener);
export const isReviewEvidenceRecord = (e) =>
  isObject(e) && arrayOf(e.reviews, isReview) && arrayOf(e.comments, isComment) && arrayOf(e.threads, isThread);

const isContext = (c) =>
  isObject(c) &&
  ((c.kind === "CheckRun" &&
    typeof c.name === "string" &&
    isNonEmptyString(c.status) &&
    isStringOrNull(c.conclusion) &&
    (c.appSlug === null || isNonEmptyString(c.appSlug))) ||
    (c.kind === "StatusContext" && typeof c.context === "string" && isNonEmptyString(c.state)));
export const isRollupRecord = (r) => isObject(r) && arrayOf(r.contexts, isContext);
