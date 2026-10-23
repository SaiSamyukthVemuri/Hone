#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Test-dependency scanner for risk-based CI (record batching part 2, G1/G2/G4).
//
// Path-only lane selection misses two kinds of edge, both measured on
// production a1164b9b (RECORD-BATCHING-PROPOSAL.md part 2):
//
//   * a `tests/db/**` suite that IMPORTS an app module, or READS a source file
//     as text (a source contract), is a database-lane dependency of that file.
//     Editing the file used to select `application` only, so the DB suite first
//     ran on the production push or the nightly (#814, G1/G2);
//   * a unit test that reads a Markdown doc makes that doc test input. A
//     docs-only diff skips validate, so a wording change to the ledger,
//     AGENTS.md or CLAUDE.md broke those tests first on the release push (G4).
//
// This is NOT a second path map. It reads only TEST files and reports which
// non-test files they depend on; the lane map stays in classify-changes.mjs,
// which takes this result as an argument and stays pure.
//
// DIRECT EDGES ONLY. A transitive import closure would pull most of lib/ into
// the DB lane; that is a separate, measured decision. Dynamic or computed paths
// are not seen. Both limits only ever mean FEWER extra lanes than ideal, never
// fewer than path-only selection already ran, because every edge here ADDS a
// lane.
//
// Node builtins only: the changed-path job runs this before `npm ci`.
//
// Usage:
//   node scripts/test-dependencies.mjs           # summary
//   node scripts/test-dependencies.mjs --json    # full edge lists
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository this script belongs to, not the caller's cwd: verify:changed
 * and its tests run from scratch directories, and a scan of the wrong tree
 * would quietly drop every edge.
 */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js)$/;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"];

/** Same Markdown/doc shape as classify-changes.mjs DOCS, applied to targets. */
const DOC = /\.md$/;

/** A DB suite: what the database lane runs (vitest.db.config.ts). */
const isDbSuite = (f) => /^tests\/db\/.*\.db\.test\.ts$/.test(f);

/**
 * A unit test: what validate's `npm test` runs (vitest.config.ts includes
 * tests/**\/*.test.ts and excludes tests/db). Only these can be run alone by a
 * docs-only job with no build, no database and no browser.
 */
const isUnitTest = (f) => /^tests\/.*\.test\.ts$/.test(f) && !f.startsWith("tests/db/");

function walk(root, dir, out) {
  for (const name of readdirSync(path.join(root, dir)).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(path.join(root, rel)).isDirectory()) walk(root, rel, out);
    else if (SOURCE_EXT.test(name)) out.push(rel);
  }
  return out;
}

/** Every quoted string literal without interpolation, in source order. */
function literals(text) {
  const out = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`/g;
  for (let m; (m = re.exec(text)); ) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Literal arguments of path.join / path.resolve calls, glued with "/", so
 * `join(ROOT, "docs", "production", "migration-ledger.md")` is seen as the
 * path it names. Non-literal arguments (ROOT, __dirname) are dropped, which is
 * correct for both of their meanings: repo root and the test's own directory
 * are both tried below.
 */
function joinedLiterals(text) {
  const out = [];
  const re = /\b(?:join|resolve)\(([^()]*)\)/g;
  for (let m; (m = re.exec(text)); ) {
    const parts = literals(m[1]);
    if (parts.length > 1) out.push(parts.join("/"));
  }
  return out;
}

/**
 * Resolve one candidate against the repository: `@/x` and bare paths from the
 * root, `./x` and `../x` from the test's own directory (and from the root,
 * because tests run with the root as cwd). Returns a repo-relative path to an
 * existing FILE, or null.
 */
function resolveCandidate(root, fromDir, spec) {
  if (!spec || spec.length > 300 || /[\s*?<>|:]/.test(spec) || spec.includes("${")) return null;
  const bases = [];
  if (spec.startsWith("@/")) bases.push(spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    bases.push(path.posix.normalize(`${fromDir}/${spec}`));
    bases.push(path.posix.normalize(spec));
  } else if (spec.includes("/") || DOC.test(spec)) {
    bases.push(path.posix.normalize(spec));
  } else return null;
  for (const base of bases) {
    if (base.startsWith("..") || base.startsWith("/")) continue;
    for (const suffix of RESOLVE_SUFFIXES) {
      const rel = base + suffix;
      const abs = path.join(root, rel);
      if (existsSync(abs) && statSync(abs).isFile()) return rel;
    }
  }
  return null;
}

/** Everything one test file names that exists in the checkout, excluding itself. */
export function fileTargets(root, file, text) {
  const dir = path.posix.dirname(file);
  const found = new Set();
  for (const spec of [...literals(text), ...joinedLiterals(text)]) {
    const rel = resolveCandidate(root, dir, spec);
    if (rel && rel !== file && !rel.startsWith("node_modules/")) found.add(rel);
  }
  return found;
}

/**
 * Scan the checkout at `root`.
 *
 *   db:         Map<target, dbSuite[]>  every file a DB suite imports or reads
 *               (tests/db/**, tests/migrations/** and supabase/** already select
 *               the database lane by path, so they are not listed);
 *   docReaders: Map<doc, unitTest[]>    every Markdown file a unit test reads.
 *
 * Deterministic: files are walked in sorted order and every list is sorted.
 */
export function scanTestDependencies(root = REPO_ROOT) {
  const db = new Map();
  const docReaders = new Map();
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const file of walk(root, "tests", [])) {
    const dbSuite = isDbSuite(file);
    const unit = isUnitTest(file);
    if (!dbSuite && !unit) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    for (const target of fileTargets(root, file, text)) {
      if (dbSuite && !/^(tests\/(db|migrations)|supabase)\//.test(target)) add(db, target, file);
      if (unit && DOC.test(target)) add(docReaders, target, file);
    }
  }
  for (const map of [db, docReaders]) for (const list of map.values()) list.sort();
  return { db, docReaders };
}

const cache = new Map();

/** The real scan of `root`, computed once per process. */
export function loadTestDependencies(root = REPO_ROOT) {
  if (!cache.has(root)) cache.set(root, scanTestDependencies(root));
  return cache.get(root);
}

if (process.argv[1] && process.argv[1].endsWith("test-dependencies.mjs")) {
  const { db, docReaders } = scanTestDependencies();
  if (process.argv.includes("--json")) {
    const obj = (m) => Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
    console.log(JSON.stringify({ db: obj(db), docReaders: obj(docReaders) }, null, 2));
  } else {
    const edges = (m) => [...m.values()].reduce((n, l) => n + l.length, 0);
    console.log(`database-lane dependencies: ${db.size} files, ${edges(db)} edges`);
    console.log(`docs read by unit tests:    ${docReaders.size} docs, ${edges(docReaders)} edges`);
  }
}
