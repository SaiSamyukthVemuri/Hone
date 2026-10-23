#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Test-dependency scanner for risk-based CI selection.
//
// Path rules alone cannot see that a test READS or IMPORTS a file elsewhere in
// the tree. Two classes of that went unselected (RECORD-BATCHING-PROPOSAL.md
// part 2):
//
//   G1  a tests/db suite reads an app or lib file as a SOURCE CONTRACT
//       (readFileSync("lib/waitlist/invite-to-book-adapter.ts")), so editing
//       that file must run the DB lane - it did not, and the guard first ran
//       on the production push (#814);
//   G2  a tests/db suite IMPORTS a module and exercises it against real RLS,
//       so editing the module must run the DB lane;
//   G4  a unit test reads a Markdown document, so a docs-only change to that
//       document must run that test - a docs-only diff ran no tests at all.
//
// This scanner derives those edges FROM THE TESTS THEMSELVES, so there is no
// hand-maintained list to drift. It reads only test files, which is why it is
// not a second competing path map: the classifier's own rules stay the one
// map, and this adds the edges a path cannot see.
//
// The output is committed as scripts/test-dependencies.json so every caller of
// `classify()` - CI, `npm run ci:plan`, `verify:changed`, ENG-LOOP's local CI
// model - selects identically without each having to run a scan. A freshness
// test in tests/ci/classify-changes.test.ts regenerates it from the checkout
// and fails on any difference, so a PR that adds an edge must commit it.
//
// LIMITS, stated so nobody mistakes this for a proof:
//   - DIRECT edges only. A transitive import closure would pull most of lib/
//     into the DB lane; measure before proposing it.
//   - Paths computed at runtime (a readdir loop, a template with a variable
//     segment) are not seen. A literal or a join/resolve of literals is.
//   - A literal that names a MISSING file still counts when it is shaped like a
//     repository path under a real top-level directory (or is a root document
//     such as AGENTS.md), so deleting a file a test still reads stays
//     attributable. The price: paths a test creates inside a throwaway fixture
//     repository (openwiki/topic/kept-page.md, docs/x.md) are kept too. They are
//     inert unless that exact path changes here, and then they add a cheap unit
//     test - over-selection, never a missed lane.
//
// Usage:
//   node scripts/test-dependencies.mjs           # print the derived map
//   node scripts/test-dependencies.mjs --write   # regenerate the committed JSON
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDocsPath } from "./classify-changes.mjs";

export const OUTPUT = "scripts/test-dependencies.json";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.[cm]?[jt]sx?$/;
const IMPORT_EXT = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
/** Where an edge's TARGET may live. Tests, fixtures and dependencies are never targets. */
const SOURCE_TARGET = /^(app|lib|components|hooks|types|scripts|supabase|middleware\.[cm]?[jt]s$)/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "test-results", "playwright-report"]);
// The classifier's own test names paths as classification INPUTS, never as
// files it reads, so scanning it would make it a "reader" of every document it
// uses as a fixture. Anywhere else a stray literal only over-selects a cheap
// test, which is the safe direction; this one file would do it by design.
const NOT_A_READER = new Set(["tests/ci/classify-changes.test.ts"]);

const toPosix = (p) => p.split(path.sep).join("/");

function walk(root, rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

// ONE walk of the checkout, then set lookups. Statting every string literal
// in ~1,200 test files cost five seconds; the index costs a fraction of that.
let index = null;
const isFile = (root, rel) => {
  if (!index || index.root !== root) index = { root, files: new Set(walk(root, "")) };
  return index.files.has(rel);
};

/** A repo-relative path, or null when the candidate escapes the repository. */
function normalise(root, fromDir, candidate) {
  const cleaned = candidate.replace(/^\$\{[^}]*\}\/?/, "");
  if (!cleaned || /\$\{/.test(cleaned)) return null;
  const base = /^\.\.?\//.test(cleaned) ? fromDir : "";
  const rel = toPosix(path.posix.normalize(path.posix.join(base, cleaned)));
  if (rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

function resolveImport(root, fromDir, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) base = normalise(root, fromDir, spec);
  else return null; // a package, never a repository edge
  if (!base) return null;
  for (const ext of IMPORT_EXT) {
    if (isFile(root, base + ext)) return base + ext;
  }
  return null;
}

const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
// join(ROOT, "lib", "types", "database.ts") / resolve(__dirname, "../../x.ts"):
// the consecutive string-literal arguments, glued with "/".
const JOIN_CALL = /\b(?:join|resolve)\s*\(([^()]*)\)/g;

// WHOLE-LINE comments only. A comment that MENTIONS a path is prose, not a
// read: `// lib/practitioner-colors.ts says adding a colour...` in a DB suite
// would otherwise put that file in the DB lane. Trailing `//` is left alone on
// purpose - stripping it would also cut "https://..." literals in half.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const withoutCommentLines = (text) =>
  text
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");

let topDirs = null;
/**
 * A path that does NOT exist is still an edge when a test names it under one
 * of the checkout's real top-level directories (or as a root-level document).
 * Otherwise a PR DELETING a file its tests still read regenerates a map
 * without the edge, classifies the deletion away from those tests, and the
 * ENOENT first surfaces on the production push (Codex, #1053 4355376850).
 * Anchoring to roots that exist keeps prose, URLs and scratch paths out.
 */
function attributable(root, rel) {
  if (isFile(root, rel)) return true;
  if (!topDirs || topDirs.root !== root) {
    topDirs = { root, dirs: new Set(readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name)) };
  }
  // A real repository path, not prose or a fixture name: only the characters
  // this tree's paths use (Next's `(group)` and `[param]` segments included).
  if (!/^[A-Za-z0-9_.@()[\]+-]+(\/[A-Za-z0-9_.@()[\]+-]+)*$/.test(rel)) return false;
  const segments = rel.split("/");
  // A root-level file only by the root-document convention (AGENTS.md,
  // README.md, CLAUDE.md...): bare basenames like "current-state.md" are joined
  // onto a directory at runtime and name nothing at the root.
  if (segments.length === 1) return /^[A-Z][A-Z0-9_]*\.md$/.test(rel) && isDocsPath(rel);
  return topDirs.dirs.has(segments[0]);
}

/** Every repo path a test file names as data: literals and literal joins. */
function namedPaths(root, file, raw) {
  const text = withoutCommentLines(raw);
  const fromDir = path.posix.dirname(file);
  const found = new Set();
  const consider = (candidate) => {
    // A file path has an extension; most literals in a test are not paths.
    if (!/\.[A-Za-z0-9]+$/.test(candidate)) return;
    const rel = normalise(root, fromDir, candidate);
    if (rel && attributable(root, rel)) found.add(rel);
  };
  for (const m of text.matchAll(STRING)) consider(m[2]);
  for (const m of text.matchAll(JOIN_CALL)) {
    const parts = [...m[1].matchAll(STRING)].map((s) => s[2]);
    if (parts.length > 1) consider(parts.join("/"));
  }
  return found;
}

function importedPaths(root, file, text) {
  const fromDir = path.posix.dirname(file);
  const found = new Set();
  for (const m of text.matchAll(IMPORT_SPEC)) {
    const rel = resolveImport(root, fromDir, m[2]);
    if (rel) found.add(rel);
  }
  return found;
}

const sortObject = (map) =>
  Object.fromEntries([...map.keys()].sort().map((k) => [k, [...map.get(k)].sort()]));

const addEdge = (map, target, test) => {
  if (!map.has(target)) map.set(target, new Set());
  map.get(target).add(test);
};

/**
 * Derive the dependency map from a checkout.
 *
 * - `db`: source file -> the tests/db files that import it or read it.
 * - `docReaders`: documentation file -> the UNIT-lane test files that read it.
 *   "Documentation" is the classifier's own rule (`isDocsPath`), any extension:
 *   a `.md`-only copy missed a JSON manifest under docs/ (Codex, #1053
 *   4355376845). tests/db readers are excluded: a docs-only change cannot
 *   start the DB lane, and nothing under tests/db reads a document today.
 */
export function scanTestDependencies(root = process.cwd()) {
  const db = new Map();
  const docReaders = new Map();

  for (const file of walk(root, "tests").filter((f) => TEST_FILE.test(f) && !NOT_A_READER.has(f)).sort()) {
    const text = readFileSync(path.join(root, file), "utf8");
    const named = namedPaths(root, file, text);

    if (file.startsWith("tests/db/")) {
      for (const target of [...importedPaths(root, file, text), ...named]) {
        if (SOURCE_TARGET.test(target) && !target.endsWith(".md")) addEdge(db, target, file);
      }
    } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      for (const target of named) {
        if (isDocsPath(target) && !target.startsWith("tests/")) addEdge(docReaders, target, file);
      }
    }
  }

  return { db: sortObject(db), docReaders: sortObject(docReaders) };
}

export function renderTestDependencies(map) {
  return JSON.stringify(map, null, 2) + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const rendered = renderTestDependencies(scanTestDependencies(process.cwd()));
  if (process.argv.includes("--write")) {
    writeFileSync(path.join(process.cwd(), OUTPUT), rendered);
    console.log(`wrote ${OUTPUT}`);
  } else {
    process.stdout.write(rendered);
  }
}
