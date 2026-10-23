// ---------------------------------------------------------------------------
// WIKI-AUTO-01: who owns a path, for every OpenWiki nightly-runner decision.
//
// One classifier answers that question everywhere: source-head discovery, the
// generated publishing scope, and which generator writes are discarded. If two
// of those decisions used different lists, a page could be published that the
// source-head walk never considered, or a source edit could ride along with a
// generated update.
//
// The `.openwikiignore` matcher mirrors openwiki@0.6.1
// dist/agent/openwiki-ignore.js rule for rule (last match wins, `!` negation,
// leading or embedded `/` anchors, trailing `/` scopes to directories, `*`,
// `**` and `?` globs, case-insensitive). The runner and OpenWiki must agree on
// which changes are meaningful, or the runner's no-op and OpenWiki's no-op
// disagree about the same commit.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The one OpenWiki release the runner drives, and whose rules this module and guards.mjs mirror. */
export const OPENWIKI_VERSION = "0.6.1";

export const WIKI_DIR = "openwiki";
export const OPENWIKI_IGNORE_FILE = ".openwikiignore";

/** The classes classifyPath returns. */
export const PATH_CLASSES = Object.freeze(["authored", "transient", "generated", "ignored", "source"]);

/** Authored inputs inside the wiki directory. OpenWiki reads them; the runner never publishes a change to them. */
export const AUTHORED_WIKI_PATHS = new Set(["openwiki/INSTRUCTIONS.md"]);

/** OpenWiki's resumable run state. A completed run removes it; it is never published. */
export const TRANSIENT_WIKI_PATHS = new Set(["openwiki/.run.json"]);

/** Run metadata OpenWiki rewrites on every run, a no-op included. */
export const RUN_METADATA_PATHS = new Set(["openwiki/.last-update.json", "openwiki/.page-manifest.json"]);

/** The scheduled-workflow scaffold `openwiki init` writes when the file is missing. */
export const OPENWIKI_WORKFLOW_PATH = ".github/workflows/openwiki-update.yml";

/**
 * Writes OpenWiki 0.6.1 makes outside `openwiki/` by design: the managed
 * blocks in AGENTS.md and CLAUDE.md on every init and update, and the workflow
 * scaffold on init. The runner discards them and records that it did; any
 * other write outside the generated scope fails the run.
 */
export const KNOWN_SIDE_EFFECT_PATHS = new Set(["AGENTS.md", "CLAUDE.md", OPENWIKI_WORKFLOW_PATH]);

/**
 * Canonical repo-relative spelling, so `./openwiki/x`, `/openwiki/x` and
 * `openwiki/../openwiki/x` cannot be classified differently. Same
 * normalization as OpenWiki's `normalizeIgnorePath`.
 */
export function normalizePath(filePath) {
  const slashed = String(filePath).replace(/\\/gu, "/");
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  return normalized.replace(/^\/+/u, "").replace(/\/+$/u, "");
}

function globToRegexSource(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
  }
  return source;
}

function compileRule(rawPattern) {
  let pattern = rawPattern.replace(/\\/gu, "/");
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  pattern = pattern.replace(/^\.\/+/u, "").replace(/\/+/gu, "/");
  const anchored = pattern.startsWith("/");
  const directoryOnly = pattern.endsWith("/");
  pattern = pattern.replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (pattern.length === 0) return undefined;
  const source = globToRegexSource(pattern);
  const matcher =
    anchored || pattern.includes("/")
      ? new RegExp(`^${source}(?:/.*)?$`, "iu")
      : new RegExp(`(^|/)${source}(/.*)?$`, "iu");
  return { negated, directoryOnly, matcher };
}

/** Parse `.openwikiignore` text into a matcher with OpenWiki's semantics. */
export function parseOpenWikiIgnore(contents) {
  const rules = String(contents)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(compileRule)
    .filter(Boolean);
  return {
    rules,
    ignores(filePath, isDirectory = false) {
      const p = normalizePath(filePath);
      if (p.length === 0) return false;
      let ignored = false;
      for (const rule of rules) {
        if (!rule.matcher.test(p)) continue;
        if (rule.directoryOnly && !isDirectory && !p.includes("/")) continue;
        ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

/** Load the repository's `.openwikiignore`; a missing file means no rules, as in OpenWiki. */
export function loadOpenWikiIgnore(repoRoot) {
  const file = path.join(repoRoot, OPENWIKI_IGNORE_FILE);
  return parseOpenWikiIgnore(existsSync(file) ? readFileSync(file, "utf8") : "");
}

const NO_RULES = parseOpenWikiIgnore("");

/**
 * Classify one repository path.
 *
 *   authored  - an authored wiki input (openwiki/INSTRUCTIONS.md)
 *   transient - OpenWiki run state that is never published
 *   generated - everything else under openwiki/: pages, indexes, Claim
 *               sidecars and run metadata; the only scope the runner publishes
 *   ignored   - outside the wiki and excluded by .openwikiignore
 *   source    - everything else: what the wiki documents
 *
 * `.openwikiignore` itself is always source: OpenWiki fingerprints it even
 * when a rule would match it (agent/utils.js isFingerprintSourcePath).
 */
export function classifyPath(filePath, ignore = NO_RULES) {
  const p = normalizePath(filePath);
  if (AUTHORED_WIKI_PATHS.has(p)) return "authored";
  if (TRANSIENT_WIKI_PATHS.has(p)) return "transient";
  if (p === WIKI_DIR || p.startsWith(`${WIKI_DIR}/`)) return "generated";
  if (p === OPENWIKI_IGNORE_FILE) return "source";
  if (ignore.ignores(p)) return "ignored";
  return "source";
}
