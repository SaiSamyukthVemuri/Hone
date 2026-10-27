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
//   G4  a unit test reads a document, so a docs-only change to that document
//       must run that test - a docs-only diff ran no tests at all.
//
// This scanner derives those edges FROM THE TESTS THEMSELVES. It reads only
// test files, which is why it is not a second competing path map: the
// classifier's own rules stay the one map, and this adds the edges a path
// cannot see.
//
// COMPUTED, NEVER COMMITTED. `classify()` runs this over the checkout it is
// classifying - in CI that is the PR's merge ref, so tests that reached
// production through OTHER PRs are seen. A committed copy went stale whenever
// any other PR added a reading test, and its freshness check would have failed
// the unit lane of unrelated PRs (#1053 round 4, CI run 39889013435).
//
// Edges, from the most to the least precise:
//   - a literal path, or a join/resolve of literals, naming a file;
//   - a directory named the same way in a test that ENUMERATES directories
//     (readdirSync, glob, git ls-files): every file beneath it counts as read,
//     INCLUDING files that do not exist yet - so it is kept as a directory
//     prefix and matched at classify time, never expanded into today's list;
//   - a unit test that enumerates AND touches documentation at all is a reader
//     of EVERY document (`docWildcard`). Its directory usually arrives through a
//     variable (`readdirSync(ROOT)`, `walk(full)`), which a scanner cannot
//     follow, so it is selected conservatively (Codex, #1053 4355527598).
//
// LIMITS, stated so nobody mistakes this for a proof:
//   - DIRECT edges only. A transitive import closure would pull most of lib/
//     into the DB lane; measure before proposing it.
//   - A DB suite that enumerates through variables only (no literal directory)
//     is not seen. Every DB suite that enumerates today names its roots.
//   - A DB suite that walks a WHOLE top-level source root (app/, lib/,
//     components/) is REPORTED in `dbRootWalkers` but does not select the DB
//     lane: honoured, it would run the DB lane for every application change,
//     which is a CI-cost decision for the operator, not a scanner default.
//     None does today: export-resource-registry.db.test.ts's application half
//     became a unit test (OPS ruling 20261023T1430Z, option b), and
//     tests/ci/classify-changes.test.ts pins the report empty.
//   - A literal that names a MISSING file still counts when it is shaped like a
//     repository path under a real top-level directory (or is a root document
//     such as AGENTS.md), so deleting a file a test still reads stays
//     attributable (Codex, #1053 4355376850). The price: paths a test creates
//     inside a throwaway fixture repository (openwiki/topic/kept-page.md,
//     docs/x.md) are kept too. They are inert unless that exact path changes
//     here, and then they add a cheap unit test - over-selection, never a
//     missed lane.
//
// Usage:
//   node scripts/test-dependencies.mjs           # print the derived map
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDocsPath } from "./docs-paths.mjs";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.[cm]?[jt]sx?$/;
const UNIT_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IMPORT_EXT = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
/** Where an edge's TARGET may live. Tests, fixtures and dependencies are never targets. */
const SOURCE_TARGET = /^(app|lib|components|hooks|types|scripts|supabase|middleware\.[cm]?[jt]s$)/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "test-results", "playwright-report"]);
// The classifier's own test names paths as classification INPUTS, never as
// files it reads, so scanning it would make it a "reader" of every document it
// uses as a fixture. Anywhere else a stray literal only over-selects a cheap
// test, which is the safe direction; this one file would do it by design.
const NOT_A_READER = new Set(["tests/ci/classify-changes.test.ts"]);
/** A test that lists directories rather than naming files. */
const ENUMERATES = /\b(readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(|\bls-files\b/;
/** ...and touches documentation at all: a `.md` name or a docs/ path. */
const TOUCHES_DOCS = /\.md\b|["'`]docs["'`/]|\bdocs\//;

const toPosix = (p) => p.split(path.sep).join("/");

function walk(root, rel, out = { files: [], dirs: [] }) {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.dirs.push(child);
      walk(root, child, out);
    } else if (entry.isFile()) out.files.push(child);
  }
  return out;
}

/** ONE walk of the checkout per scan, then set lookups. */
function indexOf(root) {
  const { files, dirs } = walk(root, "");
  const top = new Set(dirs.filter((d) => !d.includes("/")));
  return { files: new Set(files), fileList: files.sort(), dirs: new Set(dirs), top };
}

/** A repo-relative path, or null when the candidate escapes the repository. */
function normalise(fromDir, candidate) {
  const cleaned = candidate.replace(/^\$\{[^}]*\}\/?/, "");
  if (!cleaned || /\$\{/.test(cleaned)) return null;
  const base = /^\.\.?\//.test(cleaned) ? fromDir : "";
  const rel = toPosix(path.posix.normalize(path.posix.join(base, cleaned)));
  if (rel === "." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

function resolveImport(idx, fromDir, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) base = normalise(fromDir, spec);
  else return null; // a package, never a repository edge
  if (!base) return null;
  for (const ext of IMPORT_EXT) {
    if (idx.files.has(base + ext)) return base + ext;
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
const COMMENT_LINES = /^[ \t]*(\/\/|\/\*|\*).*$/gm;
const withoutCommentLines = (text) => text.replace(COMMENT_LINES, "");

/**
 * A path that does NOT exist is still an edge when a test names it under one
 * of the checkout's real top-level directories (or as a root-level document).
 * Otherwise a PR DELETING a file its tests still read would classify the
 * deletion away from those tests, and the ENOENT would first surface on the
 * production push (Codex, #1053 4355376850).
 */
function attributable(idx, rel, isDoc) {
  if (idx.files.has(rel)) return true;
  // A real repository path, not prose or a fixture name: only the characters
  // this tree's paths use (Next's `(group)` and `[param]` segments included).
  if (!/^[A-Za-z0-9_.@()[\]+-]+(\/[A-Za-z0-9_.@()[\]+-]+)*$/.test(rel)) return false;
  const segments = rel.split("/");
  // A root-level file only by the root-document convention (AGENTS.md,
  // README.md, CLAUDE.md...): bare basenames like "current-state.md" are joined
  // onto a directory at runtime and name nothing at the root.
  if (segments.length === 1) return /^[A-Z][A-Z0-9_]*\.md$/.test(rel) && isDoc(rel);
  return idx.top.has(segments[0]);
}

// No whitespace, quotes or control characters: prose and messages are most of
// the ~140k literals in tests/, and rejecting them before any path work is what
// keeps a whole-tree scan inside the changes job's budget.
const PATHLIKE = /^[^\s"'`<>|*?]{1,300}$/;

/** Every repo path a test names as data: files (by extension) and directories. */
function namedPaths(idx, file, text, isDoc) {
  const fromDir = path.posix.dirname(file);
  const files = new Set();
  const dirs = new Set();
  const consider = (candidate) => {
    if (!PATHLIKE.test(candidate)) return;
    // Without a slash a literal can only be a root-level file (it has an
    // extension) or a top-level directory: identifiers and ids are neither.
    if (!candidate.includes("/") && !candidate.includes(".") && !idx.top.has(candidate)) return;
    const rel = normalise(fromDir, candidate);
    if (!rel) return;
    if (idx.dirs.has(rel)) dirs.add(rel);
    // A file path has an extension; most literals in a test are not paths.
    else if (/\.[A-Za-z0-9]+$/.test(candidate) && attributable(idx, rel, isDoc)) files.add(rel);
  };
  // A literal that is one PART of a multi-literal join names only the joined
  // path: join(ROOT, "docs", "runbooks") reads docs/runbooks, not all of docs.
  const joinedSpans = [];
  for (const m of text.matchAll(JOIN_CALL)) {
    const parts = [...m[1].matchAll(STRING)].map((s) => s[2]);
    if (parts.length > 1) {
      consider(parts.join("/"));
      joinedSpans.push([m.index, m.index + m[0].length]);
    }
  }
  // Spans and literal matches both arrive in source order: one moving pointer.
  let span = 0;
  for (const m of text.matchAll(STRING)) {
    while (span < joinedSpans.length && joinedSpans[span][1] <= m.index) span++;
    const inside = span < joinedSpans.length && m.index >= joinedSpans[span][0];
    if (!inside) consider(m[2]);
  }
  return { files, dirs };
}

// ---------------------------------------------------------------------------
// READS THROUGH A DIRECTORY CONSTANT (Codex P1 4362833513, #1053).
//
//   const DIR = join(process.cwd(), "docs/audits/2026-07-30");
//   const read = (f) => readFileSync(join(DIR, f), "utf8");
//
// names no file, so the literal scan saw a directory it only honours for an
// enumerating test. A string constant that resolves to a repository directory
// is followed to every use: `join(DIR, "a.json")` or `${DIR}/a.json` with an
// all-literal remainder names that path; ANY other use (a variable basename, a
// call, a template with another hole) makes the test a reader of EVERY file
// under the directory. Fails safe: an edge that cannot be resolved is widened,
// never dropped.
// ---------------------------------------------------------------------------
const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
const LITERAL = /^(["'])((?:\\.|(?!\1)[^\\\n])*)\1$|^`([^`$]*)`$/;
const CALL = /^(?:path\s*\.\s*)?(?:join|resolve)\s*\(/;

/** The balanced text from `(` at `open` to its `)`: [inner, index after]. */
function parenSpan(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return [text.slice(open + 1, i), i + 1];
    else if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
    }
  }
  return null;
}

/** Top-level comma-separated arguments, trimmed. */
function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      for (; j < inner.length && inner[j] !== ch; j++) if (inner[j] === "\\") j++;
      cur += inner.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") args.push(cur.trim());
  return args;
}

const literalValue = (arg) => {
  const m = LITERAL.exec(arg);
  return m ? (m[2] ?? m[3]) : null;
};

/** Directory constants, then the files and directories their uses read. */
function directoryConstantReads(idx, file, code) {
  const fromDir = path.posix.dirname(file);
  const files = new Set();
  const dirs = new Set();
  if (!code.includes("join") && !code.includes("resolve") && !code.includes("${")) return { files, dirs };
  const constants = new Map(); // name -> repo-relative directory
  const decls = [];
  for (const m of code.matchAll(DECL)) {
    const start = m.index + m[0].length;
    const rest = code.slice(start);
    let dir = null;
    const lit = /^(["'`])/.test(rest) ? literalValue((/^(["'])(?:\\.|(?!\1)[^\\\n])*\1|^`[^`$]*`/.exec(rest) ?? [""])[0]) : null;
    if (lit !== null) dir = normalise(fromDir, lit);
    else if (CALL.test(rest)) {
      const span = parenSpan(rest, rest.indexOf("("));
      if (span) {
        const args = splitArgs(span[0]);
        let base = "";
        const parts = [];
        let ok = args.length > 0;
        args.forEach((arg, i) => {
          const v = literalValue(arg);
          if (v !== null) parts.push(v);
          else if (i === 0 && /^(?:__dirname|import\.meta\.dirname)$/.test(arg)) base = fromDir;
          else if (i === 0 && constants.has(arg)) base = constants.get(arg);
          else if (i !== 0) ok = false; // a hole after the root: not a constant
        });
        if (ok && parts.length) dir = toPosix(path.posix.normalize(path.posix.join(base, ...parts)));
      }
    }
    if (dir && dir !== "." && !dir.startsWith("../") && idx.dirs.has(dir)) {
      constants.set(m[1], dir);
      decls.push({ name: m[1], at: m.index, end: start });
    }
  }
  for (const { name, end } of decls) {
    const dir = constants.get(name);
    for (const use of code.slice(end).matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g"))) {
      const at = end + use.index;
      const before = code.slice(Math.max(0, at - 40), at);
      const after = code.slice(at + name.length);
      let path_ = null; // the all-literal path this use names, if any
      if (/(?:\bjoin|\bresolve)\s*\(\s*$/.test(before)) {
        const open = code.lastIndexOf("(", at);
        const span = parenSpan(code, open);
        const tail = span ? splitArgs(span[0]).slice(1) : null;
        const lits = tail ? tail.map(literalValue) : [null];
        if (tail && lits.every((v) => v !== null)) path_ = [dir, ...lits].join("/");
      } else if (/\$\{\s*$/.test(before)) {
        const m = /^\s*\}([^`$]*)`/.exec(after);
        if (m) path_ = `${dir}${m[1].startsWith("/") ? "" : "/"}${m[1]}`;
      }
      if (path_ === null) {
        dirs.add(dir);
        continue;
      }
      const rel = toPosix(path.posix.normalize(path_));
      if (idx.dirs.has(rel)) dirs.add(rel);
      else if (/\.[A-Za-z0-9]+$/.test(rel)) files.add(rel);
      else dirs.add(dir);
    }
  }
  return { files, dirs };
}

function importedPaths(idx, file, text) {
  const fromDir = path.posix.dirname(file);
  const found = new Set();
  for (const m of text.matchAll(IMPORT_SPEC)) {
    const rel = resolveImport(idx, fromDir, m[2]);
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
 * `isDoc` is the classifier's documentation rule, passed in so the two can
 * never disagree about what a document is (a `.md`-only copy missed a JSON
 * manifest under docs/: Codex, #1053 4355376845).
 *
 * - `db`: source file -> the tests/db files that import or read it.
 * - `dbDirs`: directory -> the tests/db files that enumerate it (every file
 *   beneath it, present or future). Below a top-level root only.
 * - `dbRootWalkers`: top-level source root -> the tests/db files that walk all
 *   of it. Reported, NOT selected (see LIMITS).
 * - `docReaders`: document -> the UNIT-lane test files that read it by name.
 * - `docReaderDirs`: directory -> the UNIT-lane test files that enumerate it.
 * - `docWildcard`: UNIT-lane tests that enumerate directories and touch
 *   documentation: readers of every document.
 *   tests/db readers of documents are not tracked: a docs-only change cannot
 *   start the DB lane, and nothing under tests/db reads a document today.
 */
export function scanTestDependencies(root, isDoc) {
  if (typeof isDoc !== "function") throw new TypeError("scanTestDependencies(root, isDoc): isDoc is required");
  const idx = indexOf(root);
  const db = new Map();
  const dbDirs = new Map();
  const dbRootWalkers = new Map();
  const docReaders = new Map();
  const docReaderDirs = new Map();
  const docWildcard = new Set();

  for (const file of idx.fileList.filter((f) => f.startsWith("tests/") && TEST_FILE.test(f) && !NOT_A_READER.has(f))) {
    const text = readFileSync(path.join(root, file), "utf8");
    const code = withoutCommentLines(text);
    const { files: literalFiles, dirs } = namedPaths(idx, file, code, isDoc);
    // Reads assembled from a directory constant (Codex P1 4362833513): named
    // files, plus whole directories wherever a basename is not static.
    const viaConstant = directoryConstantReads(idx, file, code);
    const named = new Set([...literalFiles, ...viaConstant.files]);
    // A substring check first: the regex alone was a measurable share of the scan.
    const enumerates = (code.includes("readdir") || code.includes("opendir") || code.includes("glob") || code.includes("ls-files")) && ENUMERATES.test(code);
    // Only an enumerating test reads a directory literal; elsewhere "app" is a
    // word. A directory reached THROUGH a constant is read either way.
    const notTests = (d) => d !== "tests" && !d.startsWith("tests/");
    const listedDirs = [...new Set([...(enumerates ? [...dirs] : []), ...viaConstant.dirs])].filter(notTests);

    if (file.startsWith("tests/db/")) {
      for (const target of [...importedPaths(idx, file, text), ...named]) {
        if (SOURCE_TARGET.test(target) && !target.endsWith(".md")) addEdge(db, target, file);
      }
      for (const dir of listedDirs) {
        if (!SOURCE_TARGET.test(dir)) continue;
        addEdge(dir.includes("/") ? dbDirs : dbRootWalkers, dir, file);
      }
    } else if (UNIT_TEST.test(file)) {
      for (const target of named) {
        if (isDoc(target) && !target.startsWith("tests/")) addEdge(docReaders, target, file);
      }
      // A directory holds documentation when the classifier would call a file
      // in it documentation by location (docs/, openwiki/...).
      for (const dir of listedDirs) if (isDoc(`${dir}/x`)) addEdge(docReaderDirs, dir, file);
      if (enumerates && TOUCHES_DOCS.test(code)) docWildcard.add(file);
    }
  }

  return {
    db: sortObject(db),
    dbDirs: sortObject(dbDirs),
    dbRootWalkers: sortObject(dbRootWalkers),
    docReaders: sortObject(docReaders),
    docReaderDirs: sortObject(docReaderDirs),
    docWildcard: [...docWildcard].sort(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(scanTestDependencies(process.cwd(), isDocsPath), null, 2)}\n`);
}
