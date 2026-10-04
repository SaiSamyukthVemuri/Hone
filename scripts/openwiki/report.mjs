// ---------------------------------------------------------------------------
// WIKI-AUTO-01: the one boundary between the runner and everything that
// leaves it. That is the run report ($HONE_WIKI_STATE_DIR/last-run.json and
// runs/*.json), the CLI summary, and the publish commit message, pull request
// title, body and review request.
//
// Producers never hand this module text. A producer hands it a reason CODE
// from the closed catalog below, with DETAILS that are counts, booleans,
// constants from closed sets, or identifiers in a strict runner-owned format
// (commit SHAs, nightly branch names, pull request numbers). Every sentence a
// reader sees is rendered here from those validated values. So an untrusted
// string (a pathname, generator output, a remote ref, an API error, parsed
// repository state) has no way into a sink. A value that fails its kind is
// withheld and counted, never passed through.
//
// Pathnames are the only untrusted strings a report may hold, and only those
// the run's path gate cleared (guards.mjs gateChangedPaths), plus the
// runner's own constant paths.
// ---------------------------------------------------------------------------

import { ENV_VALUE_RULES, FORBIDDEN_ENV_PREFIXES, KNOWN_ENV_NAMES, RUN_LIMIT_DEFAULTS } from "./environment.mjs";
import {
  LAST_UPDATE_PROBLEMS,
  MANIFEST_PROBLEMS,
  PATH_GATE_CATEGORIES,
  PRIVACY_CATEGORIES,
  PROVENANCE_PROBLEMS,
  WORKFLOW_VIOLATIONS,
} from "./guards.mjs";
import {
  AUTHORED_WIKI_PATHS,
  KNOWN_SIDE_EFFECT_PATHS,
  OPENWIKI_VERSION,
  OPENWIKI_WORKFLOW_PATH,
  PATH_CLASSES,
  RUN_METADATA_PATHS,
  TRANSIENT_WIKI_PATHS,
} from "./paths.mjs";
import { LIVENESS_PROBLEMS } from "./source-head.mjs";

export const NIGHTLY_BRANCH_PREFIX = "openwiki/nightly-";
/** The only branch names the runner creates: openwiki/nightly-<YYYYMMDD>-<first 7 of the source head>. */
export const NIGHTLY_BRANCH = /^openwiki\/nightly-\d{8}-[0-9a-f]{7}$/u;

/** A failure that carries a catalog code and details instead of a message. Its message is only the code. */
export class CodedError extends Error {
  constructor(reasonCode, safeDetails = {}) {
    super(reasonCode);
    this.reasonCode = reasonCode;
    this.safeDetails = safeDetails;
  }
}

// ---------------------------------------------------------------- value kinds

const WITHHELD = Symbol("withheld");
const SHA = /^[0-9a-f]{40}$/u;

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : WITHHELD);
const integer = (v) => (Number.isSafeInteger(v) ? v : WITHHELD);
const positive = (v) => (Number.isSafeInteger(v) && v > 0 ? v : WITHHELD);
const flag = (v) => (typeof v === "boolean" ? v : WITHHELD);
const matching = (re) => (v) => (typeof v === "string" && re.test(v) ? v : WITHHELD);
const oneOf = (values) => {
  const allowed = new Set(values);
  return (v) => (allowed.has(v) ? v : WITHHELD);
};
const sha = matching(SHA);
const sha256Hex = matching(/^[0-9a-f]{64}$/u);
const runId = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const isoTime = matching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const nightlyBranch = matching(NIGHTLY_BRANCH);
const httpStatus = (v) => (Number.isSafeInteger(v) && v >= 100 && v <= 599 ? v : WITHHELD);
const systemErrorCode = matching(/^E[A-Z0-9_]{1,40}$/u);
const envName = oneOf(KNOWN_ENV_NAMES);

/** Paths the runner itself names. They are constants, not untrusted input. */
const RUNNER_PATHS = new Set([...KNOWN_SIDE_EFFECT_PATHS, ...AUTHORED_WIKI_PATHS, ...TRANSIENT_WIKI_PATHS, ...RUN_METADATA_PATHS]);

/** A pathname, only if the run's path gate cleared it or the runner owns it. */
const reportablePath = (v, ctx) => (typeof v === "string" && (RUNNER_PATHS.has(v) || ctx.clearedPaths.has(v)) ? v : WITHHELD);

function listOf(kind) {
  return (v, ctx) => {
    if (!Array.isArray(v)) return WITHHELD;
    const out = [];
    for (const item of v) {
      const checked = kind(item, ctx);
      if (checked === WITHHELD) ctx.withheld += 1;
      else out.push(checked);
    }
    return out;
  };
}

/** A closed object. Unknown keys and values that fail their kind are dropped and counted. */
function shape(fields) {
  return (v, ctx) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return WITHHELD;
    const out = {};
    for (const [key, value] of Object.entries(v)) {
      if (value === undefined || value === null) continue;
      const checked = Object.hasOwn(fields, key) ? fields[key](value, ctx) : WITHHELD;
      if (checked === WITHHELD) ctx.withheld += 1;
      else out[key] = checked;
    }
    return out;
  };
}

// ---------------------------------------------------------------- reason catalog

const short = (value) => (typeof value === "string" ? value.slice(0, 7) : "?");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const texts = (table, codes) => (codes ?? []).map((code) => table[code]);

const LAST_UPDATE_TEXT = Object.freeze({
  missing: "is missing after the run",
  malformed: "is not valid JSON",
  "not-an-object": "is not a JSON object",
  "unknown-key": "has a key outside OpenWiki's schema (updatedAt, command, gitHead, model, status, language)",
  "invalid-updated-at": "updatedAt is not an ISO instant",
  "command-not-update": 'command is not "update"',
  "invalid-model": "model is not a non-blank string",
  "status-not-complete": 'status is not "complete"',
  "invalid-language": "language is not a canonical locale OpenWiki resolves",
  "git-head-mismatch": "gitHead does not equal the source head the run was pinned to",
});

const MANIFEST_TEXT = Object.freeze({
  missing: "is missing",
  malformed: "is not valid JSON",
  "not-an-object": "is not a JSON object",
  "unknown-top-level-key": "has a key other than schemaVersion and pages",
  "schema-version": "schemaVersion is not 1",
  "pages-not-an-object": "pages is not an object",
  "invalid-page-path": "lists a page path that is not a canonical factual /openwiki/*.md page",
  "entry-not-an-object": "has an entry that is not an object",
  "unknown-entry-key": "has an entry with an unknown key",
  "invalid-page-version": "has an entry without a sha256 pageVersion",
  "invalid-git-head": "has an entry whose gitHead is not a full commit SHA",
  "invalid-source-fingerprint": "has an entry with a malformed sourceFingerprint",
  "invalid-completed-by": "has an entry whose completedBy is not an OpenWiki producer id",
  "invalid-completed-run-id": "has an entry whose completedRunId is not a UUID",
});

const PROVENANCE_TEXT = Object.freeze({
  "no-sidecar": "page has no Claim sidecar",
  "sidecar-not-json": "Claim sidecar is not valid JSON",
  "no-claims": "Claim sidecar has no Claims",
  "sidecar-page-version-mismatch": "Claim sidecar pageVersion does not match the page",
  "manifest-page-version-mismatch": "page manifest pageVersion does not match the page",
  "deleted-page-sidecar-left": "Claim sidecar of a deleted page",
  "deleted-page-manifest-entry-left": "page manifest still lists a deleted page",
});

const LIVENESS_TEXT = Object.freeze({
  missing: "openwiki/.last-update.json is missing at the production tip",
  malformed: "openwiki/.last-update.json at the production tip is not valid JSON",
  "not-an-object": "openwiki/.last-update.json at the production tip is not a JSON object",
  "status-not-complete": 'previous OpenWiki run status is not "complete"',
  "git-head-not-full-sha": "recorded gitHead is not a full commit SHA",
  "git-head-not-in-history": "recorded gitHead is not in production history",
});

const PUBLISH_CHECK_TEXT = Object.freeze({
  "branch-name-invalid": "the nightly branch name is not in the runner's format",
  "publish-text-invalid": "a value for the commit or pull request text is not in its safe format",
  "untracked-not-staged": "an untracked file was not staged",
  "diff-check": "git diff --check found whitespace errors or conflict markers",
  "worktree-not-clean": "the working tree is not clean after the commit",
  "worktree-not-head": "the working tree differs from HEAD",
  "index-not-head": "the index differs from HEAD",
  "not-single-child-of-tip": "the publish commit is not a single-parent child of the production tip",
  "leaves-generated-scope": "the publish commit leaves the generated scope",
  "not-replace-exact": "published openwiki/ is not exactly the run's output (replace, not overlay)",
  "author-mismatch": "a publish commit is not authored and committed by the runner identity",
});

const DISCARD_TEXT = Object.freeze({
  KNOWN_SIDE_EFFECT: "known OpenWiki side effect outside the generated scope",
  WORKFLOW_SCAFFOLD: "A3: OpenWiki's workflow scaffold is outside the generated scope; never published",
  WORKFLOW_SCAFFOLD_FAILS_INSPECTION: "A3: OpenWiki's workflow scaffold would fail CI-workflow inspection; never published",
  UNEXPECTED_WRITE: "unexpected generator write outside the generated scope",
});

export const TOKEN_CAUSES = Object.freeze(["key-file-not-owner-only", "http-status", "permissions-not-exact", "repository-scope", "invalid-repository", "unknown"]);

/** Where a pass was when an error with no catalog code ended it. */
export const STEPS = Object.freeze([
  "start",
  "environment",
  "token",
  "sync",
  "baseline",
  "source-head",
  "liveness",
  "in-flight",
  "prerequisites",
  "generate",
  "scope",
  "validate",
  "publish-token",
  "publish-commit",
  "publish-push",
  "pull-request",
  "review-request",
  "cleanup",
]);

function tokenCauseText(d) {
  switch (d.cause) {
    case "key-file-not-owner-only":
      return `${d.name ?? "the App private key file"} must exist and be readable by its owner only`;
    case "http-status":
      return `installation token request failed${d.httpStatus ? `: HTTP ${d.httpStatus}` : ""}`;
    case "permissions-not-exact":
      return "installation token permissions are not exactly the runner's set";
    case "repository-scope":
      return "installation token is not scoped to exactly the configured repository";
    case "invalid-repository":
      return "HONE_WIKI_REPOSITORY must be owner/name";
    default:
      return "no installation token could be minted (details withheld)";
  }
}

const CLEANUP_DETAILS = {
  number: positive,
  branch: nightlyBranch,
  pullRequest: oneOf(["closed", "close-failed"]),
  branchState: oneOf(["deleted", "delete-failed"]),
};

function notCompleted(failure, d) {
  const recovery =
    d.pullRequest === "closed" && d.branchState === "deleted"
      ? "pull request closed and branch deleted"
      : `cleanup incomplete (pull request #${d.number ?? "?"}: ${d.pullRequest ?? "unknown"}; branch ${d.branch ?? "(withheld)"}: ${d.branchState ?? "unknown"}); recover by hand`;
  return `pull request #${d.number ?? "?"} was not completed (${failure}); ${recovery}`;
}

const reason = (outcome, details, text) => Object.freeze({ outcome, details, text });
const fixed = (outcome, text) => reason(outcome, {}, () => text);

/**
 * Every reason a pass can end with: its outcome, the details it may carry and
 * the kind of each, and the text rendered from them.
 */
export const REASONS = Object.freeze({
  NIGHTLY_DISABLED: fixed("SKIP", 'HONE_WIKI_NIGHTLY is not "on"'),
  KILL_SWITCH: fixed("SKIP", "kill switch: DISABLED file is present"),
  LOCK_HELD: fixed("SKIP", "another runner pass holds the lock"),
  IN_FLIGHT_RUN_EXISTS: reason("SKIP", { branches: listOf(nightlyBranch), unrecognized: count }, (d) =>
    [
      d.branches?.length ? `unmerged nightly branch awaits a human: ${d.branches.join(", ")}` : "",
      d.unrecognized
        ? `${plural(d.unrecognized, "unmerged openwiki/nightly-* branch", "unmerged openwiki/nightly-* branches")} not in the runner's naming format (names withheld)`
        : "",
    ]
      .filter(Boolean)
      .join("; ") || "an unmerged nightly branch awaits a human",
  ),

  WIKI_LIVE: reason("NOOP", { gitHead: sha }, () => "wiki is live: no source change after its recorded gitHead"),

  PUBLISHING_OFF: reason("DRY_RUN", { metadataOnly: flag }, (d) =>
    d.metadataOnly ? "checks passed; metadata-only source advance; publishing is off" : "checks passed; publishing is off",
  ),

  PULL_REQUEST_OPENED: reason("PUBLISHED", { number: positive, metadataOnly: flag }, (d) => `pull request #${d.number ?? "?"}${d.metadataOnly ? " (metadata only)" : ""}`),

  GENERATOR_EXIT_NONZERO: reason("FAILED", { exitCode: integer, timedOut: flag }, (d) => `OpenWiki exited ${d.exitCode ?? "?"}${d.timedOut ? " after the run timeout" : ""}`),
  RUN_STATE_LEFT_BEHIND: fixed("FAILED", "OpenWiki left openwiki/.run.json: the run did not complete"),
  PATH_PRIVACY_REJECTED: reason("FAILED", { paths: count, categories: listOf(oneOf(PATH_GATE_CATEGORIES)) }, (d) =>
    `${plural(d.paths ?? 0, "changed path")} failed the privacy/secret path gate (${(d.categories ?? []).join(", ")}); no pathname was recorded`,
  ),
  UNEXPECTED_GENERATOR_WRITE: reason("FAILED", { paths: count }, (d) => `generator wrote outside the generated scope: ${plural(d.paths ?? 0, "path")}, listed under discarded`),
  SCOPE_DISCARD_INCOMPLETE: fixed("FAILED", "writes outside the generated scope survived the discard"),
  LAST_UPDATE_INVALID: reason("FAILED", { problems: listOf(oneOf(LAST_UPDATE_PROBLEMS)) }, (d) => `openwiki/.last-update.json: ${texts(LAST_UPDATE_TEXT, d.problems).join("; ")}`),
  MANIFEST_INVALID: reason("FAILED", { problems: listOf(oneOf(MANIFEST_PROBLEMS)) }, (d) => `openwiki/.page-manifest.json: ${texts(MANIFEST_TEXT, d.problems).join("; ")}`),
  BROKEN_LINK_STAMPS: reason("FAILED", { count }, (d) => `${plural(d.count ?? 0, "broken-link stamp")} left by OpenWiki`),
  CONFLICT_MARKERS: reason("FAILED", { count }, (d) => plural(d.count ?? 0, "conflict marker line")),
  PROVENANCE_INVALID: reason("FAILED", { count, problems: listOf(oneOf(PROVENANCE_PROBLEMS)) }, (d) =>
    `${plural(d.count ?? 0, "provenance problem")}: ${texts(PROVENANCE_TEXT, d.problems).join("; ")}`,
  ),
  CONTENT_PRIVACY_HITS: reason("FAILED", { hits: count, categories: listOf(oneOf(PRIVACY_CATEGORIES)) }, (d) =>
    `${plural(d.hits ?? 0, "privacy/secret denylist hit")} in generated content (${(d.categories ?? []).join(", ")})`,
  ),
  PUBLISH_CHECK_FAILED: reason("FAILED", { check: oneOf(Object.keys(PUBLISH_CHECK_TEXT)) }, (d) => `publish stopped by a trusted check: ${PUBLISH_CHECK_TEXT[d.check] ?? "unknown check"}`),
  BASE_MOVED: reason("FAILED", { pinnedTip: sha, remoteTip: sha }, (d) =>
    `production advanced during the run (${short(d.pinnedTip)} -> ${d.remoteTip ? short(d.remoteTip) : "missing"}); nothing published, the next pass regenerates from the new tip`,
  ),
  PULL_REQUEST_CREATE_FAILED: reason("FAILED", { httpStatus, invalidResponse: flag, branchState: oneOf(["deleted", "delete-failed"]) }, (d) =>
    [
      `opening the pull request failed${d.httpStatus ? ` (HTTP ${d.httpStatus})` : ""}${d.invalidResponse ? " (the response carried no valid pull request number)" : ""}`,
      d.branchState === "deleted" ? "the pushed branch was deleted" : "the pushed branch could not be deleted, so the next pass reports it in flight",
    ].join("; "),
  ),
  PULL_REQUEST_HEAD_MISMATCH: reason("FAILED", CLEANUP_DETAILS, (d) => notCompleted("head-mismatch", d)),
  REVIEW_REQUEST_FAILED: reason("FAILED", CLEANUP_DETAILS, (d) => notCompleted("review-request-failed", d)),
  UNEXPECTED_ERROR: reason("FAILED", { step: oneOf(STEPS), errorCode: systemErrorCode, exitStatus: integer }, (d) =>
    `unexpected runner error during ${d.step ?? "an unknown step"}${d.errorCode ? ` (${d.errorCode})` : ""}${d.exitStatus !== undefined ? ` (exit status ${d.exitStatus})` : ""}; details withheld`,
  ),
  REPORT_REASON_REJECTED: fixed("FAILED", "the runner tried to report a reason outside its closed catalog; withheld"),

  STATE_DIR_MISSING: fixed("PRECONDITION", "required HONE_WIKI_STATE_DIR is not set"),
  REQUIRED_ENV_MISSING: reason("PRECONDITION", { name: envName }, (d) => `required ${d.name ?? "variable"} is not set`),
  FORBIDDEN_ENV_PRESENT: reason("PRECONDITION", { name: envName }, (d) => `forbidden ${d.name ?? "variable"} is set`),
  FORBIDDEN_ENV_PREFIX_PRESENT: reason("PRECONDITION", { prefix: oneOf(FORBIDDEN_ENV_PREFIXES), count }, (d) =>
    `forbidden ${d.prefix ?? "?"}* variable is set${(d.count ?? 1) > 1 ? ` (${d.count} of them)` : ""}`,
  ),
  ENV_VALUE_INVALID: reason("PRECONDITION", { name: oneOf(Object.keys(ENV_VALUE_RULES)) }, (d) =>
    d.name ? `${d.name} must be ${ENV_VALUE_RULES[d.name]}` : "an environment value is not the required one",
  ),
  RUNNER_INSIDE_SUBJECT: fixed("PRECONDITION", "the runner must run from a pinned checkout outside HONE_WIKI_SUBJECT_DIR"),
  APP_TOKEN_UNAVAILABLE: reason("PRECONDITION", { phase: oneOf(["start", "publish"]), cause: oneOf(TOKEN_CAUSES), httpStatus, name: envName }, (d) =>
    `GitHub App token${d.phase === "publish" ? " before publishing" : ""}: ${tokenCauseText(d)}`,
  ),
  LOCK_UNREADABLE: fixed("PRECONDITION", "run.lock exists but holds no process id; remove it by hand once no runner pass is active"),
  SUBJECT_ORIGIN_MISMATCH: fixed("PRECONDITION", "subject checkout's origin is not the configured repository"),
  SUBJECT_NOT_CLEAN: fixed("PRECONDITION", "subject checkout is not clean after reset"),
  MANAGED_BLOCK_MARKERS_MALFORMED: reason("PRECONDITION", { file: oneOf(["AGENTS.md", "CLAUDE.md"]) }, (d) =>
    `${d.file ?? "a managed file"} has malformed or duplicated OpenWiki managed-block markers`,
  ),
  WORKFLOW_SCAFFOLD_COMMITTED: fixed("PRECONDITION", `${OPENWIKI_WORKFLOW_PATH} is committed at the production tip`),
  COMMITTED_RUN_STATE_PRESENT: fixed("PRECONDITION", "openwiki/.run.json is committed at the production tip; transient run state must never be committed"),
  SOURCE_HEAD_NOT_FOUND: reason("PRECONDITION", { commitsScanned: count }, (d) => `no source change within ${d.commitsScanned ?? "?"} first-parent commits of the production tip`),
  LIVENESS_INVALID: reason("PRECONDITION", { problem: oneOf(LIVENESS_PROBLEMS) }, (d) => LIVENESS_TEXT[d.problem] ?? "openwiki/.last-update.json cannot be assessed"),
  OPENWIKI_INSTALL_MISSING: fixed("PRECONDITION", "pinned OpenWiki install is missing (HONE_WIKI_OPENWIKI_DIR)"),
  OPENWIKI_INSTALL_MALFORMED: fixed("PRECONDITION", "pinned OpenWiki package.json is not valid JSON"),
  OPENWIKI_VERSION_MISMATCH: fixed("PRECONDITION", `pinned OpenWiki must be openwiki@${OPENWIKI_VERSION}`),
  OPENWIKI_CLI_MISSING: fixed("PRECONDITION", "OpenWiki CLI entry point is missing"),
  NODE_TOO_OLD: fixed("PRECONDITION", `node >= 22.22.0 is required by openwiki@${OPENWIKI_VERSION}`),
  MODEL_KEY_FILE_NOT_OWNER_ONLY: fixed("PRECONDITION", "HONE_WIKI_ANTHROPIC_API_KEY_FILE must exist and be readable by its owner only"),
  MODEL_KEY_FILE_EMPTY: fixed("PRECONDITION", "HONE_WIKI_ANTHROPIC_API_KEY_FILE is empty"),
  DENYLIST_FILE_NOT_OWNER_ONLY: fixed("PRECONDITION", "HONE_WIKI_DENYLIST_FILE must exist and be readable by its owner only"),
  DENYLIST_EMPTY: fixed("PRECONDITION", "HONE_WIKI_DENYLIST_FILE holds no terms, so the name scan would check nothing"),
  TENANT_REGISTER_UNREADABLE: fixed(
    "PRECONDITION",
    "docs/production/current-state.md has no readable tenant register (section 0), so the tenant-slug scan would check nothing",
  ),
  MODEL_ID_EMPTY: fixed("PRECONDITION", "OPENWIKI_MODEL_ID is empty"),
  RUN_LIMIT_INVALID: reason("PRECONDITION", { name: oneOf(Object.keys(RUN_LIMIT_DEFAULTS)) }, (d) =>
    `${d.name ?? "a run limit"} must be a plain positive number (unset or blank means its default)`,
  ),
  LOW_DISK: fixed("PRECONDITION", "free disk space is below HONE_WIKI_MIN_FREE_GB"),
});

/**
 * Reasons as a producer hands them over: { code, details }, or a list.
 * Anything else (free text above all) becomes REPORT_REASON_REJECTED, and
 * counts as withheld.
 */
function normalizeReasons(input, ctx) {
  const list = Array.isArray(input) && input.length > 0 ? input : [input];
  return list.map((item) => {
    if (item !== null && typeof item === "object" && typeof item.code === "string" && Object.hasOwn(REASONS, item.code)) {
      return { code: item.code, details: item.details ?? {} };
    }
    ctx.withheld += 1;
    return { code: "REPORT_REASON_REJECTED", details: {} };
  });
}

function resolveReasons(input, ctx) {
  const list = normalizeReasons(input, ctx).map(({ code, details }) => {
    const checked = shape(REASONS[code].details)(details, ctx);
    if (checked === WITHHELD) ctx.withheld += 1;
    return { reasonCode: code, safeDetails: checked === WITHHELD ? {} : checked };
  });
  return {
    outcome: REASONS[list[0].reasonCode].outcome,
    list,
    reason: list.map((r) => REASONS[r.reasonCode].text(r.safeDetails)).join("; "),
  };
}

/** The text a list of reasons renders to, for display only. Nothing is persisted. */
export function renderReasons(input) {
  return resolveReasons(input, { clearedPaths: new Set(), withheld: 0 }).reason;
}

// ---------------------------------------------------------------- the report

const DISCARDED_ENTRY = (() => {
  const fields = shape({
    path: reportablePath,
    status: oneOf(["A", "M", "D", "T"]),
    kind: oneOf(PATH_CLASSES),
    reasonCode: oneOf(Object.keys(DISCARD_TEXT)),
    workflowInspection: listOf(oneOf(WORKFLOW_VIOLATIONS)),
  });
  return (v, ctx) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return WITHHELD;
    // A `reason` already on the entry is ignored: it is always rendered from reasonCode.
    const entry = fields(Object.fromEntries(Object.entries(v).filter(([key]) => key !== "reason")), ctx);
    if (entry !== WITHHELD && entry.reasonCode) entry.reason = DISCARD_TEXT[entry.reasonCode];
    return entry;
  };
})();

const FILE_LINE = shape({ file: reportablePath, line: positive });

const REPORT_FIELDS = shape({
  runId,
  startedAt: isoTime,
  finishedAt: isoTime,
  tip: sha,
  sourceHead: sha,
  skippedGeneratedCommits: count,
  liveness: shape({
    state: oneOf(["live", "stale", "invalid"]),
    gitHead: sha,
    note: oneOf(["recorded-after-source-change"]),
    problem: oneOf(LIVENESS_PROBLEMS),
  }),
  pathGate: shape({ scanned: count, rejected: count, categories: listOf(oneOf(PATH_GATE_CATEGORIES)) }),
  generator: shape({ exitCode: integer, timedOut: flag, outputBytes: count, outputSha256: sha256Hex }),
  generated: shape({ changed: count, added: count, modified: count, deleted: count }),
  metadataOnly: flag,
  discarded: listOf(DISCARDED_ENTRY),
  checks: shape({
    lastUpdate: listOf(oneOf(LAST_UPDATE_PROBLEMS)),
    manifest: listOf(oneOf(MANIFEST_PROBLEMS)),
    brokenLinkStamps: listOf(FILE_LINE),
    conflictMarkers: listOf(FILE_LINE),
    provenance: listOf(shape({ file: reportablePath, problem: oneOf(PROVENANCE_PROBLEMS) })),
    privacyHits: listOf(shape({ file: reportablePath, line: positive, category: oneOf(PRIVACY_CATEGORIES) })),
  }),
  publish: shape({
    branch: nightlyBranch,
    head: sha,
    pr: shape({ number: positive }),
    failure: oneOf(["head-mismatch", "review-request-failed"]),
    cleanup: shape({ pullRequest: oneOf(["closed", "close-failed"]), branch: oneOf(["deleted", "delete-failed"]) }),
  }),
});

/** Keys the sink derives itself. A caller's value for any of them is ignored. */
const DERIVED = new Set(["reasons", "outcome", "reasonCode", "reason", "safeDetails", "additionalReasons", "withheld"]);

/**
 * THE SINK. The only form of a report that is written to disk or printed.
 *
 * `raw.reasons` holds the pass's reasons ({ code, details }); a report this
 * function already produced is accepted too, so applying it twice changes
 * nothing. The outcome comes from the primary reason's catalog entry and the
 * `reason` text is rendered here. Every other field must be in the closed
 * schema above. `withheld` counts the values dropped on the way. It is 0
 * unless a producer handed over something it should not have.
 */
export function persistableReport(raw, { clearedPaths = new Set() } = {}) {
  const ctx = { clearedPaths, withheld: 0 };
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const reasons =
    source.reasons ??
    (source.reasonCode === undefined
      ? undefined
      : [
          { code: source.reasonCode, details: source.safeDetails },
          ...(Array.isArray(source.additionalReasons) ? source.additionalReasons.map((r) => ({ code: r?.reasonCode, details: r?.safeDetails })) : []),
        ]);
  const resolved = resolveReasons(reasons, ctx);
  const rest = Object.fromEntries(Object.entries(source).filter(([key]) => !DERIVED.has(key)));
  const { runId: id, startedAt, finishedAt, ...fields } = REPORT_FIELDS(rest, ctx);
  const [primary, ...additional] = resolved.list;
  return {
    runId: id,
    startedAt,
    finishedAt,
    outcome: resolved.outcome,
    reasonCode: primary.reasonCode,
    reason: resolved.reason,
    safeDetails: primary.safeDetails,
    ...(additional.length > 0 ? { additionalReasons: additional } : {}),
    ...fields,
    withheld: ctx.withheld,
  };
}

// ---------------------------------------------------------------- publish text

/** A value that is not exactly its kind stops the publish. It is never interpolated. */
function strict(kind, value, ctx) {
  const checked = kind(value, ctx);
  if (checked === WITHHELD || ctx.withheld > 0) throw new CodedError("PUBLISH_CHECK_FAILED", { check: "publish-text-invalid" });
  return checked;
}

/** openwiki/nightly-<YYYYMMDD>-<source7>, or a refusal: the runner never pushes a name outside its format. */
export function nightlyBranchName(nowMs, sourceHead) {
  const stamp = new Date(nowMs).toISOString().slice(0, 10).replace(/-/gu, "");
  const branch = `${NIGHTLY_BRANCH_PREFIX}${stamp}-${String(sourceHead).slice(0, 7)}`;
  if (!SHA.test(String(sourceHead)) || !NIGHTLY_BRANCH.test(branch)) throw new CodedError("PUBLISH_CHECK_FAILED", { check: "branch-name-invalid" });
  return branch;
}

/** The commit message, pull request title and body, from validated values only. */
export function renderPublishText({ sourceHead, tip, previousGitHead, generated, metadataOnly, discarded }, { clearedPaths = new Set() } = {}) {
  const ctx = { clearedPaths, withheld: 0 };
  const source = strict(sha, sourceHead, ctx);
  const production = strict(sha, tip, ctx);
  const previous = strict(sha, previousGitHead, ctx);
  const s = strict(shape({ changed: count, added: count, modified: count, deleted: count }), generated, ctx);
  const metadata = strict(flag, metadataOnly, ctx);
  const entries = strict(listOf(DISCARDED_ENTRY), discarded, ctx);
  const title = metadata ? `docs(openwiki): record source ${source.slice(0, 7)} (metadata only)` : `docs(openwiki): nightly update at source ${source.slice(0, 7)}`;
  const body = [
    "Automated OpenWiki update (WIKI-AUTO-01). Generated `openwiki/` files only; no product, runtime, test or workflow change.",
    "",
    `- Source head documented: \`${source}\` (newest production commit with a source change)`,
    `- Production tip: \`${production}\``,
    `- Previous wiki gitHead: \`${previous}\``,
    `- Generated files: ${s.changed} (${s.added} added, ${s.modified} modified, ${s.deleted} deleted)${metadata ? ", run metadata only: records the processed source head" : ""}`,
    `- Discarded generator writes: ${entries.map((e) => `\`${e.path}\` (${e.reason})`).join("; ") || "none"}`,
    "- Trusted pre-publish checks passed on the runner host: liveness, `.last-update.json` gitHead equality, privacy/secret gate on every changed path, generated-only scope, page-manifest schema, replace-not-overlay, single child of the production tip, runner authorship, clean worktree with HEAD/tree identity, `git diff --check`, conflict markers, provenance, broken-link stamps, privacy/secret denylist on generated content",
    "- Repository-controlled verification (the test suites and `verify:prepush`) runs in this PR's CI; the runner executes no repository code",
    "",
    "The runner never merges. Merge authority stays with a human.",
  ].join("\n");
  const commitBody = `Generated by the WIKI-AUTO-01 runner from production source ${source} (production tip ${production}). Only generated openwiki/ files change.`;
  return { title, body, commitBody };
}

/** The exact-head review request, for a validated commit SHA only. */
export function renderReviewRequest(head) {
  return `@codex review\n\nExact head \`${strict(sha, head, { clearedPaths: new Set(), withheld: 0 })}\`.`;
}
