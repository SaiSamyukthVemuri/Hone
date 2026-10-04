// ---------------------------------------------------------------------------
// WIKI-AUTO-01: the checks between an OpenWiki run and anything leaving the
// runner. Every function here is read-only except discardChanges. A finding is
// a code from a closed set, with a cleared path and a line number at most,
// never the text it matched: a report must not re-leak what a check caught.
// What a report may hold is enforced once, at the sink (report.mjs).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWN_SIDE_EFFECT_PATHS, RUN_METADATA_PATHS, classifyPath, normalizePath } from "./paths.mjs";
import { git } from "./source-head.mjs";

// ---------------------------------------------------------------- run scope

/**
 * Hash the working tree as `git add -A` would see it, relative to `base`, and
 * return the tree SHA. "What did the generator change" is then one diff
 * against `base`, deletions included. The real index is never touched.
 *
 * The scratch index is seeded with `git read-tree <base>`, whose entries
 * carry no stat data, so every file is compared by CONTENT. A copy of the
 * real index would carry its stat cache under a newer file mtime, defeating
 * git's racy-clean check. A same-size rewrite within the same second as the
 * checkout (a gitHead swap in .last-update.json, for one) would then look
 * unchanged.
 */
export function snapshotWorktree(cwd, base) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "hone-wiki-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    git(cwd, ["read-tree", base], { env });
    git(cwd, ["add", "-A"], { env });
    return git(cwd, ["write-tree"], { env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Name-status diff between two tree-ishes, renames split into delete + add. */
export function diffTrees(cwd, from, to) {
  const fields = git(cwd, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to]).split("\0");
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i]) changes.push({ status: fields[i], path: fields[i + 1] });
  }
  return changes;
}

/**
 * Split a run's changes by owner. Generated paths are the publishing scope.
 * Known OpenWiki side effects are discarded and recorded. Anything else,
 * including openwiki/INSTRUCTIONS.md and leftover run state, is unexpected
 * and fails the run after being discarded.
 */
export function sortRunChanges(changes, ignore) {
  const generated = [];
  const sideEffects = [];
  const unexpected = [];
  for (const change of changes) {
    const kind = classifyPath(change.path, ignore);
    if (kind === "generated") generated.push(change);
    else if (KNOWN_SIDE_EFFECT_PATHS.has(normalizePath(change.path))) sideEffects.push({ ...change, kind });
    else unexpected.push({ ...change, kind });
  }
  return { generated, sideEffects, unexpected };
}

/** Restore `changes` to their state in `base`: added files are deleted, the rest checked out. */
export function discardChanges(cwd, base, changes) {
  const restore = [];
  for (const change of changes) {
    if (change.status === "A") rmSync(path.join(cwd, change.path), { force: true });
    else restore.push(change.path);
  }
  if (restore.length > 0) git(cwd, ["checkout", base, "--", ...restore]);
}

// ---------------------------------------------------------------- workflow (A3)

const WRITE_SCOPE = /^\s*[a-z-]+\s*:\s*write\b|permissions\s*:\s*write-all\b/mu;

/** What inspectWorkflow can find, as codes. An unpinned action is reported without its reference. */
export const WORKFLOW_VIOLATIONS = Object.freeze([
  "top-level-permissions-not-read-only",
  "write-permission",
  "secrets-context",
  "github-token",
  "persisted-credentials",
  "unpinned-action",
]);

/**
 * A3: a subset of tests/ci/ci-config.test.ts (CI-HARDEN-01B) applied to the
 * workflow file `openwiki init` scaffolds. The runner never publishes that
 * file either way; this records WHY it could not be committed. The CI test
 * stays the authority for workflows that are committed.
 */
export function inspectWorkflow(text) {
  const violations = new Set();
  const body = String(text);
  const top = /^permissions:[ \t]*\n((?:[ \t]+.*\n?)*)/mu.exec(body);
  const topEntries = top ? top[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  if (topEntries.length !== 1 || !/^contents:\s*read$/u.test(topEntries[0] ?? "")) violations.add("top-level-permissions-not-read-only");
  if (WRITE_SCOPE.test(body)) violations.add("write-permission");
  if (/\$\{\{\s*secrets\./u.test(body)) violations.add("secrets-context");
  if (/\bGITHUB_TOKEN\b/u.test(body)) violations.add("github-token");
  const checkouts = (body.match(/uses:\s*actions\/checkout@/gu) ?? []).length;
  const unpersisted = (body.match(/persist-credentials:\s*false\b/gu) ?? []).length;
  if (checkouts > unpersisted) violations.add("persisted-credentials");
  for (const match of body.matchAll(/uses:\s*([^\s#]+)/gu)) {
    const ref = match[1];
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/u.test(ref)) violations.add("unpinned-action");
  }
  return WORKFLOW_VIOLATIONS.filter((code) => violations.has(code));
}

// ---------------------------------------------------------------- state files

/**
 * A text file in the working tree: absent, present-valid (a regular file, its
 * `text`), or present-invalid (something else is at that path).
 */
export function readWorktreeFile(root, filePath) {
  const full = path.join(root, filePath);
  let stat;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { state: "absent" };
    throw error;
  }
  return stat.isFile() ? { state: "present-valid", text: readFileSync(full, "utf8") } : { state: "present-invalid" };
}

/**
 * A JSON state file in the working tree, in one of three states:
 *
 *   absent          - nothing at that path
 *   present-valid   - a regular file whose content parses as JSON (`value`)
 *   present-invalid - something is there, but it is not a regular file whose
 *                     content parses as JSON
 *
 * Malformed content is never reported as absent. The committed counterpart
 * is source-head.mjs readCommittedState.
 */
export function readWorktreeState(root, filePath) {
  const file = readWorktreeFile(root, filePath);
  if (file.state !== "present-valid") return file;
  try {
    return { state: "present-valid", value: JSON.parse(file.text) };
  } catch {
    return { state: "present-invalid" };
  }
}

/** Whether anything at all is at `filePath` in the working tree, a dangling link included. */
export function worktreePathExists(root, filePath) {
  try {
    lstatSync(path.join(root, filePath));
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------- page checks

/**
 * Leftover merge-conflict markers, with git's grammar (default marker size 7):
 * `<<<<<<<`, `|||||||` or `>>>>>>>` followed by a space or end of line, or a
 * bare `=======`. Read as data, so the subject's .gitattributes cannot switch
 * the check off the way it can for `git diff --check`.
 */
export function findConflictMarkers(text) {
  return String(text)
    .split(/\r?\n/u)
    .flatMap((line, index) => (/^(?:<{7}|\|{7}|>{7})(?: |$)|^={7}$/u.test(line) ? [index + 1] : []));
}

const FACTUAL_PAGE_EXCLUDED = new Set(["index.md", "log.md", "INSTRUCTIONS.md"]);

function isFactualPage(p) {
  return (
    p.startsWith("openwiki/") &&
    p.endsWith(".md") &&
    !p.split("/").some((segment) => segment.startsWith(".")) &&
    !FACTUAL_PAGE_EXCLUDED.has(path.posix.basename(p))
  );
}

/** What checkProvenance can find, as codes. */
export const PROVENANCE_PROBLEMS = Object.freeze([
  "no-sidecar",
  "sidecar-not-json",
  "no-claims",
  "sidecar-page-version-mismatch",
  "manifest-page-version-mismatch",
  "deleted-page-sidecar-left",
  "deleted-page-manifest-entry-left",
  "evidence-version-invalid",
]);

// openwiki@0.6.1 evidence versions, from its only resolver
// (claims/evidence/repository/resolver.js):
//   whole file  createHashedVersion("repo-file-v1", source)
//               -> repo-file-v1:sha256:<64 hex>
//   line range  formatLineRangeVersion
//               -> repo-lines-v1:sha256:<64 hex>:<base64url of JSON.stringify(metadata)>
// where metadata holds exactly seven fields (isLineRangeVersionMetadata):
// selectedLineCount >= 1, precedingContextLineCount and
// followingContextLineCount in 0..RANGE_CONTEXT_LINE_COUNT (3), and four
// lowercase sha256 hex line hashes. An unchanged span reuses its previous
// version, so that is one of these two forms as well.
const FILE_EVIDENCE_VERSION = /^repo-file-v1:sha256:[a-f0-9]{64}$/u;
const RANGE_EVIDENCE_VERSION = /^repo-lines-v1:sha256:[a-f0-9]{64}:([A-Za-z0-9_-]+)$/u;
const RANGE_CONTEXT_LINE_COUNT = 3;
const RANGE_LINE_HASHES = ["firstSelectedLineHash", "lastSelectedLineHash", "precedingContextHash", "followingContextHash"];

function isLineRangeVersionMetadata(metadata) {
  const inRange = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
  return (
    isPlainObject(metadata) &&
    Object.keys(metadata).length === 7 &&
    inRange(metadata.selectedLineCount, 1, Number.MAX_SAFE_INTEGER) &&
    inRange(metadata.precedingContextLineCount, 0, RANGE_CONTEXT_LINE_COUNT) &&
    inRange(metadata.followingContextLineCount, 0, RANGE_CONTEXT_LINE_COUNT) &&
    RANGE_LINE_HASHES.every((key) => typeof metadata[key] === "string" && /^[a-f0-9]{64}$/u.test(metadata[key]))
  );
}

/**
 * THE evidence-version validator: true only for a value openwiki@0.6.1
 * writes, where every byte is a digest or a count. The whole value is
 * checked, not its prefix: the discriminator, the sha256, and for a line
 * range a base64url part that must decode and parse to exactly the
 * seven-field metadata, then re-encode to the same text. So a malformed,
 * truncated, non-canonical or text-bearing value is refused.
 */
export function isValidEvidenceVersion(value) {
  if (typeof value !== "string") return false;
  if (FILE_EVIDENCE_VERSION.test(value)) return true;
  const range = RANGE_EVIDENCE_VERSION.exec(value);
  if (!range) return false;
  try {
    const metadata = JSON.parse(Buffer.from(range[1], "base64url").toString("utf8"));
    return isLineRangeVersionMetadata(metadata) && Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url") === range[1];
  } catch {
    return false;
  }
}

/** Whether any evidence in a parsed sidecar carries a `version` that is not valid (evidence without one holds no text). */
function hasInvalidEvidenceVersion(sidecar) {
  return (Array.isArray(sidecar.claims) ? sidecar.claims : []).some(
    (claim) =>
      isPlainObject(claim) &&
      Array.isArray(claim.evidence) &&
      claim.evidence.some((evidence) => isPlainObject(evidence) && Object.hasOwn(evidence, "version") && !isValidEvidenceVersion(evidence.version)),
  );
}

/**
 * OpenWiki provenance for every factual page a run touched (the page itself,
 * or its Claim sidecar), against the run's VALIDATED page manifest (its
 * `pages` map; see checkPageManifest). A live page needs a sidecar with at
 * least one Claim, and `sha256:<hex of the page bytes>` as the pageVersion in
 * both the sidecar and the manifest. A deleted page may leave neither a
 * sidecar nor a manifest entry behind.
 *
 * Every evidence `version` must pass isValidEvidenceVersion. Any other
 * value is invalid Claim state, and could carry text inside base64 where no
 * scanner sees it.
 *
 * Each problem is `{ file, problem }`, where `file` is the changed path that
 * touched the page, so it is always a path the run's path gate cleared. The
 * offending value is never part of a problem.
 */
export function checkProvenance(root, generatedChanges, manifestPages) {
  const touched = new Map();
  for (const change of generatedChanges) {
    const p = normalizePath(change.path);
    if (isFactualPage(p)) touched.set(p, p);
    else if (p.startsWith("openwiki/.claims/") && p.endsWith(".json")) {
      const page = `openwiki/${p.slice("openwiki/.claims/".length, -".json".length)}.md`;
      if (!touched.has(page)) touched.set(page, p);
    }
  }
  const listed = (page) => Object.hasOwn(manifestPages, `/${page}`);
  const problems = [];
  for (const [page, file] of [...touched].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sidecar = `openwiki/.claims/${page.slice("openwiki/".length, -".md".length)}.json`;
    if (!worktreePathExists(root, page)) {
      if (worktreePathExists(root, sidecar)) problems.push({ file, problem: "deleted-page-sidecar-left" });
      if (listed(page)) problems.push({ file, problem: "deleted-page-manifest-entry-left" });
      continue;
    }
    const claims = readWorktreeState(root, sidecar);
    if (claims.state === "absent") {
      problems.push({ file, problem: "no-sidecar" });
      continue;
    }
    if (claims.state !== "present-valid" || !isPlainObject(claims.value)) {
      problems.push({ file, problem: "sidecar-not-json" });
      continue;
    }
    if (!Array.isArray(claims.value.claims) || claims.value.claims.length === 0) problems.push({ file, problem: "no-claims" });
    if (hasInvalidEvidenceVersion(claims.value)) problems.push({ file, problem: "evidence-version-invalid" });
    const version = `sha256:${createHash("sha256").update(readFileSync(path.join(root, page))).digest("hex")}`;
    if (claims.value.pageVersion !== version) problems.push({ file, problem: "sidecar-page-version-mismatch" });
    if (!listed(page) || manifestPages[`/${page}`].pageVersion !== version) problems.push({ file, problem: "manifest-page-version-mismatch" });
  }
  return problems;
}

const BROKEN_LINK_STAMP = /^\s*<!--\s*openwiki:\s*broken internal link\b.*?-->\s*$/u;

/** Line numbers of OpenWiki's broken-link stamps. OpenWiki stamps instead of failing. */
export function findBrokenLinkStamps(text) {
  return String(text)
    .split(/\r?\n/u)
    .flatMap((line, index) => (BROKEN_LINK_STAMP.test(line) ? [index + 1] : []));
}

/** What checkLastUpdate can find, as codes. */
export const LAST_UPDATE_PROBLEMS = Object.freeze([
  "missing",
  "malformed",
  "not-an-object",
  "unknown-key",
  "invalid-updated-at",
  "command-not-update",
  "invalid-model",
  "status-not-complete",
  "invalid-language",
  "git-head-mismatch",
]);

const LAST_UPDATE_KEYS = new Set(["updatedAt", "command", "gitHead", "model", "status", "language"]);
// What openwiki@0.6.1 writes for updatedAt: new Date().toISOString().
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** A free-text metadata value: a non-blank string with no control characters. It is privacy-scanned, never trusted. */
function isMetadataText(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * A language openwiki@0.6.1 resolveLanguage would record: a canonical locale
 * tag whose primary language Intl recognizes. A variant subtag can still carry
 * a word, so the value is privacy-scanned too (metadataPrivacyItems).
 */
function isResolvedLanguage(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (canonical !== value) return false;
    const primary = new Intl.Locale(canonical).language;
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(primary);
    return Boolean(name) && name.toLowerCase() !== primary.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * openwiki/.last-update.json after a runner run (a readWorktreeState result),
 * against the strict schema openwiki@0.6.1 writes it with (agent/utils.js
 * writeLastUpdateMetadata, generation/run-state.js UpdateMetadataSchema):
 *
 *   { updatedAt: ISO instant, command: "init"|"update", gitHead?: string,
 *     model: string, status: "complete"|"interrupted", language?: string }
 *
 * No other key is allowed, so no extra key can carry text. The runner further
 * requires a completed update recording exactly the pinned source head, a
 * non-blank model and a resolvable language. `model` and `language` are free
 * text, so metadataPrivacyItems scans them.
 */
export function checkLastUpdate(state, sourceHead) {
  if (state?.state === "absent") return ["missing"];
  if (state?.state !== "present-valid") return ["malformed"];
  const metadata = state.value;
  if (!isPlainObject(metadata)) return ["not-an-object"];
  const problems = new Set();
  if (Object.keys(metadata).some((key) => !LAST_UPDATE_KEYS.has(key))) problems.add("unknown-key");
  if (typeof metadata.updatedAt !== "string" || !ISO_INSTANT.test(metadata.updatedAt)) problems.add("invalid-updated-at");
  if (metadata.command !== "update") problems.add("command-not-update");
  if (!isMetadataText(metadata.model)) problems.add("invalid-model");
  if (metadata.status !== "complete") problems.add("status-not-complete");
  if (metadata.language !== undefined && !isResolvedLanguage(metadata.language)) problems.add("invalid-language");
  if (metadata.gitHead !== sourceHead) problems.add("git-head-mismatch");
  return LAST_UPDATE_PROBLEMS.filter((code) => problems.has(code));
}

/** What checkPageManifest can find, as codes. */
export const MANIFEST_PROBLEMS = Object.freeze([
  "missing",
  "malformed",
  "not-an-object",
  "unknown-top-level-key",
  "schema-version",
  "pages-not-an-object",
  "invalid-page-path",
  "entry-not-an-object",
  "unknown-entry-key",
  "invalid-page-version",
  "invalid-git-head",
  "invalid-source-fingerprint",
  "invalid-completed-by",
  "invalid-completed-run-id",
]);

const MANIFEST_ENTRY_KEYS = new Set(["gitHead", "sourceFingerprint", "pageVersion", "completedBy", "completedRunId"]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
// The producers openwiki@0.6.1 records: the CLI as openwiki/<version>
// (version.js OPENWIKI_PRODUCER_ACTOR), or a host integration id
// (integrations/core/protocol.js HOST_ID_PATTERN). A host id can still spell
// a name, so completedBy is privacy-scanned too (metadataPrivacyItems).
const PRODUCER_ID = /^(?:openwiki\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[a-z0-9-]{1,64})$/u;
// zod 4's z.string().uuid(), which openwiki@0.6.1 applies to completedRunId.
const ZOD_UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
const RESERVED_WIKI_FILES = new Set(["index.md", "log.md", "instructions.md"]);

/** openwiki@0.6.1 normalizeWikiPagePath, plus its canonical-key rule: the key must already be in canonical form. */
function isCanonicalFactualPageKey(page) {
  const slashed = page.trim().replace(/\\/gu, "/");
  if (slashed.split("/").some((segment) => segment === "." || segment === "..")) return false;
  const absolute = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  if (!absolute.startsWith("/openwiki/") || !absolute.endsWith(".md")) return false;
  const lower = absolute.toLowerCase();
  if (lower.split("/").includes(".claims") || RESERVED_WIKI_FILES.has(path.posix.basename(lower))) return false;
  return absolute === page;
}

/**
 * openwiki/.page-manifest.json (a readWorktreeState result) against the
 * schema openwiki@0.6.1 itself enforces (generation/page-manifest.js, strict
 * zod objects):
 *
 *   { schemaVersion: 1, pages: { "/openwiki/<factual page>.md": entry } }
 *   entry: { pageVersion: "sha256:<64 hex>", gitHead?: string,
 *            sourceFingerprint?: "sha256:<64 hex>", completedBy?: string,
 *            completedRunId?: UUID }
 *
 * Where OpenWiki's schema allows any string, the runner holds the field to
 * what OpenWiki actually writes: gitHead is the run's full commit SHA, and
 * completedBy a producer id. Page keys and completedBy are still free enough
 * to spell a name, so metadataPrivacyItems scans them.
 *
 * The manifest is OpenWiki's committed record of page coverage, and every run
 * rewrites it, a metadata-only run included. So it is checked on every run,
 * not only when a page or Claim sidecar changed.
 */
export function checkPageManifest(state) {
  if (state?.state === "absent") return ["missing"];
  if (state?.state !== "present-valid") return ["malformed"];
  const manifest = state.value;
  if (!isPlainObject(manifest)) return ["not-an-object"];
  const problems = new Set();
  if (Object.keys(manifest).some((key) => key !== "schemaVersion" && key !== "pages")) problems.add("unknown-top-level-key");
  if (manifest.schemaVersion !== 1) problems.add("schema-version");
  if (!isPlainObject(manifest.pages)) {
    problems.add("pages-not-an-object");
  } else {
    for (const [page, entry] of Object.entries(manifest.pages)) {
      if (!isCanonicalFactualPageKey(page)) problems.add("invalid-page-path");
      if (!isPlainObject(entry)) {
        problems.add("entry-not-an-object");
        continue;
      }
      if (Object.keys(entry).some((key) => !MANIFEST_ENTRY_KEYS.has(key))) problems.add("unknown-entry-key");
      if (typeof entry.pageVersion !== "string" || !SHA256_DIGEST.test(entry.pageVersion)) problems.add("invalid-page-version");
      if (entry.gitHead !== undefined && !(typeof entry.gitHead === "string" && COMMIT_SHA.test(entry.gitHead))) problems.add("invalid-git-head");
      if (entry.sourceFingerprint !== undefined && !(typeof entry.sourceFingerprint === "string" && SHA256_DIGEST.test(entry.sourceFingerprint))) {
        problems.add("invalid-source-fingerprint");
      }
      if (entry.completedBy !== undefined && !(typeof entry.completedBy === "string" && PRODUCER_ID.test(entry.completedBy))) problems.add("invalid-completed-by");
      if (entry.completedRunId !== undefined && !(typeof entry.completedRunId === "string" && ZOD_UUID.test(entry.completedRunId))) {
        problems.add("invalid-completed-run-id");
      }
    }
  }
  return MANIFEST_PROBLEMS.filter((code) => problems.has(code));
}

/**
 * OpenWiki throws on malformed or duplicated managed-block markers, so the
 * runner refuses before spending a model run. A file with no markers is
 * valid: OpenWiki appends a block, which the runner then discards.
 */
export function checkManagedBlockMarkers(fileName, text) {
  if (text === undefined) return [];
  const starts = text.split("<!-- OPENWIKI:START -->").length - 1;
  const ends = text.split("<!-- OPENWIKI:END -->").length - 1;
  if (starts === 0 && ends === 0) return [];
  if (starts === 1 && ends === 1 && text.indexOf("<!-- OPENWIKI:START -->") < text.indexOf("<!-- OPENWIKI:END -->")) {
    return [];
  }
  return [{ code: "MANAGED_BLOCK_MARKERS_MALFORMED", details: { file: fileName } }];
}

/** Every commit in `range` must be authored and committed by the runner identity. */
export function checkCommitAuthors(cwd, range, identity) {
  const rows = git(cwd, ["log", "--format=%an%x00%ae%x00%cn%x00%ce", range]).split("\n").filter(Boolean);
  const mismatched = rows.filter((row) => {
    const [an, ae, cn, ce] = row.split("\0");
    return an !== identity.name || ae !== identity.email || cn !== identity.name || ce !== identity.email;
  }).length;
  return { commits: rows.length, mismatched };
}

// ---------------------------------------------------------------- privacy

/** Secret and PII shapes. Ported from the #782 OpenWiki privacy gate, plus the runner's own credential shapes. */
export const PRIVACY_PATTERNS = Object.freeze([
  ["jwt", /\beyJ[A-Za-z0-9_-]{15,}/u],
  ["stripe-key", /\b[rs]k_(?:live|test)_\w{6,}/u],
  ["webhook-secret", /\bwhsec_\w{6,}/u],
  ["provider-id", /\b(?:acct|cus|pi|pm|seti|ch|re|in)_[A-Za-z0-9]{10,}\b/u],
  ["supabase-ref", /\b[a-z0-9]{20}\.supabase\.(?:co|in)\b/u],
  ["dsn", /https:\/\/[0-9a-f]{16,}@/u],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu],
  ["deployment", /\bdpl_[A-Za-z0-9]{6,}|\b[a-z0-9-]+\.vercel\.app\b/u],
  ["email", /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u],
  ["phone", /(?<![\w+])\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}(?!\w)|\(\d{3}\) ?\d{3}-\d{4}\b/u],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}/u],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{10,}/u],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
]);

/** Every category scanPrivacy can report. */
export const PRIVACY_CATEGORIES = Object.freeze([...PRIVACY_PATTERNS.map(([category]) => category), "denylist-term", "tenant-slug"]);

/** Every category the path gate can report: the privacy categories, plus a path it cannot safely record at all. */
export const PATH_GATE_CATEGORIES = Object.freeze([...PRIVACY_CATEGORIES, "unsafe-path-format"]);

/**
 * The tenant register (docs/production/current-state.md section 0): whether
 * the section is there, and the first cell of each register table row that
 * looks like a studio slug.
 */
export function parseTenantRegister(currentStateText) {
  const lines = String(currentStateText ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith("## 0. Tenant register"));
  if (start === -1) return { found: false, slugs: [] };
  const slugs = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1].replace(/[*`]/gu, "").trim();
    if (/^[a-z0-9][a-z0-9-]{2,}$/u.test(cell)) slugs.push(cell);
  }
  return { found: true, slugs };
}

export function loadTenantSlugs(currentStateText) {
  return parseTenantRegister(currentStateText).slugs;
}

/** One term per line; blank lines and `#` comments skipped. The file lives on the host, never in the repository. */
export function parseDenylist(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function termMatchers(terms) {
  const out = [];
  for (const term of terms) {
    const escaped = term.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
    out.push(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "iu"));
    if (term.includes("-")) out.push(new RegExp(`\\b${escaped.replace(/-/gu, " ")}\\b`, "iu"));
  }
  return out;
}

/**
 * Scan text items for secret/PII shapes and denylisted terms. Each item is
 * `{ file, lines: string[] }`; a hit is `{ file, line, category }`. The
 * matched text is never returned.
 */
export function scanPrivacy(items, { denylistTerms = [], tenantSlugs = [] } = {}) {
  const denylist = termMatchers(denylistTerms);
  const tenants = termMatchers(tenantSlugs);
  const hits = [];
  for (const { file, lines } of items) {
    lines.forEach((text, index) => {
      for (const [category, pattern] of PRIVACY_PATTERNS) {
        if (pattern.test(text)) hits.push({ file, line: index + 1, category });
      }
      if (denylist.some((re) => re.test(text))) hits.push({ file, line: index + 1, category: "denylist-term" });
      if (tenants.some((re) => re.test(text))) hits.push({ file, line: index + 1, category: "tenant-slug" });
    });
  }
  return hits;
}

/**
 * The grammar of a path a report may hold: every path in the repository today
 * fits it. No whitespace, quotes, backticks, angle brackets, `$`, `%`, `&`,
 * `#` or control characters, so a recorded path can be neither markup nor
 * shell, and no empty, `.` or `..` segment.
 */
const REPORTABLE_PATH = /^[A-Za-z0-9._@+~()[\]/-]{1,512}$/u;

function isReportablePathFormat(p) {
  return REPORTABLE_PATH.test(p) && p.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** `people/jane-doe.md` read with its separators as spaces: `people jane doe md`. */
function humanizePath(p) {
  return p.replace(/[-_./]+/gu, " ").trim();
}

/** One scan line holding a value as written and humanized, so `jane-doe` also matches the term "Jane Doe". */
function writtenAndHumanized(value) {
  return `${value} ${humanizePath(value)}`;
}

/**
 * THE PATH GATE. It runs over every path a run changed (generated pages and
 * metadata, OpenWiki's known side effects, and unexpected writes, whether
 * added, modified or deleted) BEFORE any of them is recorded, reported or
 * interpolated anywhere. Each path is normalized, then scanned as written and
 * humanized (`people/jane-doe.md` matches the denylist term "Jane Doe").
 *
 * A path is cleared only if it has no privacy hit, is already in canonical
 * form, and fits the reportable grammar. Any other path fails the run, and
 * only the categories and a count are kept: the path itself is never
 * returned. The sink (report.mjs) accepts no pathname outside `cleared`.
 */
export function gateChangedPaths(changes, terms = {}) {
  const cleared = new Set();
  const categories = new Set();
  let rejected = 0;
  for (const change of changes) {
    const p = normalizePath(change.path);
    const hits = new Set(scanPrivacy([{ file: "", lines: [p, humanizePath(p)] }], terms).map((hit) => hit.category));
    if (p !== change.path || !isReportablePathFormat(p)) hits.add("unsafe-path-format");
    if (hits.size === 0) {
      cleared.add(p);
      continue;
    }
    rejected += 1;
    for (const category of hits) categories.add(category);
  }
  return { scanned: changes.length, rejected, categories: PATH_GATE_CATEGORIES.filter((c) => categories.has(c)), cleared };
}

/**
 * The only sidecar values the privacy scan skips: the top-level
 * `pageVersion`, and each `claims[i].evidence[j].version`. Each is skipped
 * only when the value itself has its exact digest grammar
 * (isValidEvidenceVersion for evidence). A key named `version` anywhere
 * else, or a value that does not conform, is scanned like any other string.
 */
function isSidecarDigest(at, value) {
  if (at.length === 1 && at[0] === "pageVersion") return SHA256_DIGEST.test(value);
  const isEvidenceVersion =
    at.length === 5 && at[0] === "claims" && typeof at[1] === "number" && at[2] === "evidence" && typeof at[3] === "number" && at[4] === "version";
  return isEvidenceVersion && isValidEvidenceVersion(value);
}

/**
 * The privacy-scan items for one generated file: everything it publishes,
 * unless a strict grammar shows it cannot carry text.
 *
 * - Pages, and any generated file of an unknown type, are scanned whole.
 * - A Claim sidecar is scanned by every key and every string value (as
 *   written and humanized), except a `pageVersion` or evidence `version`
 *   whose value has its exact digest grammar (isSidecarDigest). Valid
 *   digests look like tokens by construction. For a sidecar, a hit's `line`
 *   counts the scanned strings in document order.
 * - Run metadata is scanned field by field against its schema
 *   (metadataPrivacyItems), so it is skipped here.
 */
export function privacyItemsFor(filePath, content) {
  const p = normalizePath(filePath);
  if (RUN_METADATA_PATHS.has(p)) return [];
  if (p.startsWith("openwiki/.claims/") && p.endsWith(".json")) {
    const lines = [];
    const walk = (node, at) => {
      if (typeof node === "string") {
        if (!isSidecarDigest(at, node)) lines.push(writtenAndHumanized(node));
      } else if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, [...at, index]));
      } else if (isPlainObject(node)) {
        for (const [name, value] of Object.entries(node)) {
          lines.push(name);
          walk(value, [...at, name]);
        }
      }
    };
    walk(JSON.parse(content), []);
    return [{ file: p, lines }];
  }
  return [{ file: p, lines: String(content).split(/\r?\n/u) }];
}

/**
 * The privacy-scan items for run metadata: every value a strict grammar does
 * not pin down. These are `.last-update.json`'s `model` and `language`, and
 * every `.page-manifest.json` page key (as written and humanized) and
 * `completedBy`, each as written and humanized. Digests, SHAs, UUIDs,
 * timestamps and enums are held to their
 * grammar by checkLastUpdate and checkPageManifest instead. A hit's `line`
 * counts the scanned values in order, never quoting one.
 */
export function metadataPrivacyItems(lastUpdate, manifest) {
  const items = [];
  const metadata = lastUpdate?.state === "present-valid" && isPlainObject(lastUpdate.value) ? lastUpdate.value : {};
  const lastUpdateLines = [metadata.model, metadata.language].filter((value) => typeof value === "string").map(writtenAndHumanized);
  if (lastUpdateLines.length > 0) items.push({ file: "openwiki/.last-update.json", lines: lastUpdateLines });
  const pages = manifest?.state === "present-valid" && isPlainObject(manifest.value) && isPlainObject(manifest.value.pages) ? manifest.value.pages : {};
  const manifestLines = [];
  for (const [page, entry] of Object.entries(pages)) {
    manifestLines.push(writtenAndHumanized(page));
    if (isPlainObject(entry) && typeof entry.completedBy === "string") manifestLines.push(writtenAndHumanized(entry.completedBy));
  }
  if (manifestLines.length > 0) items.push({ file: "openwiki/.page-manifest.json", lines: manifestLines });
  return items;
}
