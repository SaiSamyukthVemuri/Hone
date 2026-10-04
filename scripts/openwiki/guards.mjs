// ---------------------------------------------------------------------------
// WIKI-AUTO-01: the checks between an OpenWiki run and anything leaving the
// runner. Every function here is read-only except discardChanges, and every
// finding names a file, a line and a category, never the matched text: a
// report must not re-leak what the privacy scan caught.
// ---------------------------------------------------------------------------

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWN_SIDE_EFFECT_PATHS, classifyPath, normalizePath } from "./paths.mjs";
import { git } from "./source-head.mjs";

// ---------------------------------------------------------------- run scope

/**
 * Hash the working tree as `git add -A` would see it, without touching the
 * real index: a copy of the index absorbs the add. Returns the tree SHA, so
 * "what did the generator change" is one diff against the base commit,
 * deletions included.
 */
export function snapshotWorktree(cwd) {
  const realIndex = path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index"]));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "hone-wiki-index-"));
  const tempIndex = path.join(scratch, "index");
  try {
    if (existsSync(realIndex)) copyFileSync(realIndex, tempIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
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

/**
 * A3: a subset of tests/ci/ci-config.test.ts (CI-HARDEN-01B) applied to the
 * workflow file `openwiki init` scaffolds. The runner never publishes that
 * file either way; this records WHY it could not be committed. The CI test
 * stays the authority for workflows that are committed.
 */
export function inspectWorkflow(text) {
  const violations = [];
  const body = String(text);
  const top = /^permissions:[ \t]*\n((?:[ \t]+.*\n?)*)/mu.exec(body);
  const topEntries = top ? top[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  if (topEntries.length !== 1 || !/^contents:\s*read$/u.test(topEntries[0] ?? "")) {
    violations.push("top-level permissions must be exactly `contents: read`");
  }
  if (WRITE_SCOPE.test(body)) violations.push("requests a write permission");
  if (/\$\{\{\s*secrets\./u.test(body)) violations.push("references the secrets context");
  if (/\bGITHUB_TOKEN\b/u.test(body)) violations.push("uses GITHUB_TOKEN");
  const checkouts = (body.match(/uses:\s*actions\/checkout@/gu) ?? []).length;
  const unpersisted = (body.match(/persist-credentials:\s*false\b/gu) ?? []).length;
  if (checkouts > unpersisted) violations.push("a checkout keeps persisted credentials");
  for (const match of body.matchAll(/uses:\s*([^\s#]+)/gu)) {
    const ref = match[1];
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/u.test(ref)) violations.push(`action not pinned to a full commit SHA: ${ref}`);
  }
  return violations;
}

// ---------------------------------------------------------------- page checks

const BROKEN_LINK_STAMP = /^\s*<!--\s*openwiki:\s*broken internal link\b.*?-->\s*$/u;

/** Line numbers of OpenWiki's broken-link stamps. OpenWiki stamps instead of failing. */
export function findBrokenLinkStamps(text) {
  return String(text)
    .split(/\r?\n/u)
    .flatMap((line, index) => (BROKEN_LINK_STAMP.test(line) ? [index + 1] : []));
}

/**
 * openwiki/.last-update.json after a runner run must name the source head the
 * runner pinned, as a completed update. Anything else means the generator did
 * not document what the runner thinks it documented.
 */
export function checkLastUpdate(metadata, sourceHead) {
  if (!metadata || typeof metadata !== "object") return ["openwiki/.last-update.json is missing or unreadable"];
  const errors = [];
  if (metadata.command !== "update") errors.push(`command is ${JSON.stringify(metadata.command)}, not "update"`);
  if (metadata.status !== "complete") errors.push(`status is ${JSON.stringify(metadata.status)}, not "complete"`);
  if (metadata.gitHead !== sourceHead) errors.push("gitHead does not equal the source head the run was pinned to");
  return errors;
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
  return [`${fileName} has malformed or duplicated OpenWiki managed-block markers`];
}

/** Every commit in `range` must be authored and committed by the runner identity. */
export function checkCommitAuthors(cwd, range, identity) {
  const rows = git(cwd, ["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce", range]).split("\n").filter(Boolean);
  if (rows.length === 0) return [`no commits in ${range}`];
  const errors = [];
  for (const row of rows) {
    const [sha, an, ae, cn, ce] = row.split("\0");
    if (an !== identity.name || ae !== identity.email || cn !== identity.name || ce !== identity.email) {
      errors.push(`commit ${sha} is not authored and committed by the runner identity`);
    }
  }
  return errors;
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

/**
 * Studio slugs from the canonical tenant register (docs/production/current-state.md
 * section 0): the first cell of each register table row that looks like a slug.
 */
export function loadTenantSlugs(currentStateText) {
  const lines = String(currentStateText ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith("## 0. Tenant register"));
  if (start === -1) return [];
  const slugs = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1].replace(/[*`]/gu, "").trim();
    if (/^[a-z0-9][a-z0-9-]{2,}$/u.test(cell)) slugs.push(cell);
  }
  return slugs;
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
 * The privacy-scan items for one generated file. Pages are scanned whole.
 * Claim sidecars are scanned by statement and evidence resource only: their
 * evidence `version` fields hold OpenWiki's base64 metadata, which looks like
 * a token by construction; for a sidecar, a hit's `line` counts statements
 * and evidence resources in order. Run metadata is not prose and is skipped.
 */
export function privacyItemsFor(filePath, content) {
  const p = normalizePath(filePath);
  if (p.endsWith(".md")) return [{ file: p, lines: String(content).split(/\r?\n/u) }];
  if (p.startsWith("openwiki/.claims/") && p.endsWith(".json")) {
    const parsed = JSON.parse(content);
    const lines = [];
    for (const claim of parsed.claims ?? []) {
      lines.push(String(claim.statement ?? ""));
      for (const evidence of claim.evidence ?? []) lines.push(String(evidence.resource ?? ""));
    }
    return [{ file: p, lines }];
  }
  return [];
}
