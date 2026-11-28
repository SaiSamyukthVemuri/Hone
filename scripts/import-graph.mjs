// ---------------------------------------------------------------------------
// Runtime import graph of the application, used by browser selection (CI-SELECT-02).
//
// WHAT IT PROVES. For an application file F it answers one question: which ENTRY POINTS can execute F? An entry point is a file Next.js
// itself loads (a route's page, route handler, layout, template, error and loading boundary, middleware, instrumentation). A change to F
// can alter behaviour only through those entries, so the browser coverage F needs is the coverage of the entries that reach it.
//
// WHAT IT DOES NOT PROVE, and therefore refuses to answer (the caller falls back to the extended fail-safe):
//   - a file nothing in app/, components/, lib/, hooks/ imports (it may be loaded by path, by a script, or by a test);
//   - a file also imported by something outside those roots that can run in a browser lane: e2e/** and e2e-*/** (helpers and specs run
//     the code directly), scripts/** and EVERY root-level source file other than middleware.ts and instrumentation.ts (instrumentation-client.ts,
//     sentry.*.config.ts, playwright, vitest and next configs);
//   - anything that is not TypeScript source (CSS, JSON, SQL, images): no import edge is read from them.
//   Imports are read with a regular expression over `from "x"`, `import("x")` and `require("x")` literals, resolving "@/" and relative
//   specifiers. A specifier built at run time is not seen; the repository has none under the scanned roots today and
//   tests/ci/graph-selection.test.ts walks every `import(` and `require(` to keep it that way.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const SCAN_ROOTS = ["app", "components", "lib", "hooks"];
const ROOT_FILES = ["middleware.ts", "instrumentation.ts"];
const SOURCE = /\.(ts|tsx)$/;

/** Files Next.js loads on its own: they are the only roots a request can start from. */
export const ENTRY_NAME = /(^|\/)(page|route|layout|template|error|global-error|loading|not-found|default|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(ts|tsx)$/;
export const isEntry = (f) => ROOT_FILES.includes(f) || (f.startsWith("app/") && ENTRY_NAME.test(f));

/** Code that runs outside the application bundle but imports from it. Reaching one of these makes F unprovable. */
const OUTSIDE = (f) => /^(e2e[\w-]*|scripts|playwright[\w.-]*|next\.config[\w.]*|vitest[\w.-]*)(\/|\.|$)/.test(f);

function walk(root, dir, out) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(root, rel, out);
    else if (SOURCE.test(e.name)) out.push(rel);
  }
}

function walkAny(root, dir, out) {
  const abs = path.join(root, dir);
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walkAny(root, rel, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(e.name)) out.push(rel);
  }
}

function resolve(root, from, spec) {
  const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(path.join(root, from)), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && statSync(c).isFile()) return path.relative(root, c).split(path.sep).join("/");
  }
  return null;
}

const EDGE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

/** Reads the repository at `root` once. Cheap (about 1,500 files, a few hundred ms) and never committed, so it cannot go stale. */
export function buildImportGraph(root) {
  const files = [];
  for (const d of SCAN_ROOTS) walk(root, d, files);
  for (const f of ROOT_FILES) if (existsSync(path.join(root, f))) files.push(f);
  const importedBy = new Map();
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(EDGE)) {
      const target = resolve(root, f, m[1]);
      if (!target) continue;
      if (!importedBy.has(target)) importedBy.set(target, new Set());
      importedBy.get(target).add(f);
    }
  }
  // Importers from outside the application bundle: the e2e helpers and specs, scripts and root config.
  const outsideImporters = new Map();
  const outsideFiles = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory() && /^(e2e[\w-]*|scripts)$/.test(d.name)) walkAny(root, d.name, outsideFiles);
  }
  // EVERY root-level source file that is not itself a graph entry: instrumentation-client.ts, sentry.*.config.ts, the playwright, vitest and
  // next configs. Next or a tool loads them directly, so what they import can run without any route reaching it: fail safe to extended.
  for (const f of readdirSync(root)) if (/\.(ts|tsx|mjs|js|cjs)$/.test(f) && !ROOT_FILES.includes(f)) outsideFiles.push(f);
  for (const f of outsideFiles) {
    let src;
    try { src = readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    for (const m of src.matchAll(EDGE)) {
      const target = resolve(root, f, m[1]);
      if (!target) continue;
      if (!outsideImporters.has(target)) outsideImporters.set(target, new Set());
      outsideImporters.get(target).add(f);
    }
  }
  return { root, files: new Set(files), importedBy, outsideImporters };
}

/**
 * Everything that can execute `file`: the entries that import it directly or transitively (the file itself when it is an entry), plus
 * `outside` — importers from e2e/scripts/config met anywhere on the way, which make the answer unprovable.
 */
export function reachingEntries(graph, file) {
  const seen = new Set([file]);
  const stack = [file];
  const entries = new Set();
  const outside = new Set();
  if (isEntry(file)) entries.add(file);
  while (stack.length) {
    const x = stack.pop();
    for (const o of graph.outsideImporters.get(x) ?? []) outside.add(o);
    for (const y of graph.importedBy.get(x) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      stack.push(y);
      if (isEntry(y)) entries.add(y);
    }
  }
  return { entries: [...entries].sort(), outside: [...outside].sort(), reached: seen.size - 1 };
}

export { OUTSIDE };

// ---------------------------------------------------------------------------
// Who can run a DB test helper (CI-SELECT-02, rule R1)
//
// tests/db/helpers/** used to force the FULL matrix because every DB suite imports it. That is the right answer only if something outside
// the DB lane can execute it. This reads the WHOLE repository's imports (not just the application roots) and answers exactly that.
// ---------------------------------------------------------------------------
const ALL_SOURCE = /\.(ts|tsx|mjs|js|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".claude", "openwiki", "junit-results", "playwright-report", "test-results", "coverage"]);
function walkRepo(root, dir, out) {
  for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? path.posix.join(dir, e.name) : e.name;
    if (e.isDirectory()) walkRepo(root, rel, out);
    else if (ALL_SOURCE.test(e.name)) out.push(rel);
  }
}

const repoGraphs = new Map();
function repoImporters(root) {
  if (repoGraphs.has(root)) return repoGraphs.get(root);
  const files = [];
  walkRepo(root, "", files);
  const importedBy = new Map();
  for (const f of files) {
    let src;
    try { src = readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    for (const m of src.matchAll(EDGE)) {
      const t = resolve(root, f, m[1]);
      if (!t) continue;
      if (!importedBy.has(t)) importedBy.set(t, new Set());
      importedBy.get(t).add(f);
    }
  }
  const g = { importedBy, files: new Set(files) };
  repoGraphs.set(root, g);
  return g;
}

/**
 * The lanes that can execute a tests/db/helpers file, from the whole-repo import graph:
 *   - importers under tests/db/ (the suites) and tests/dependencies/ (unit tests) add nothing: the DB lane and the always-run unit lane;
 *   - importers under e2e-payment/, e2e-mobile/ and e2e-google/ select the payment, mobile and google_calendar lanes;
 *   - ANYTHING else (e2e/, e2e-mobile/, app code, scripts, config) is unprovable and the caller keeps the full matrix.
 * Helpers are followed transitively through other helpers. A file that does not exist in the checkout (deleted) is unprovable.
 */
export function dbHelperReach(root, file) {
  const g = repoImporters(root);
  if (!g.files.has(file)) return { provable: false, lanes: [], other: [file] };
  const seen = new Set([file]);
  const stack = [file];
  const lanes = new Set();
  const other = [];
  while (stack.length) {
    const x = stack.pop();
    for (const y of g.importedBy.get(x) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      if (y.startsWith("tests/db/helpers/")) stack.push(y);
      else if (y.startsWith("tests/db/") || y.startsWith("tests/dependencies/")) continue;
      else if (y.startsWith("e2e-payment/")) { lanes.add("payment"); stack.push(y); }
      else if (y.startsWith("e2e-mobile/")) { lanes.add("mobile"); stack.push(y); }
      else if (y.startsWith("e2e-google/")) { lanes.add("google_calendar"); stack.push(y); }
      else other.push(y);
    }
  }
  // A non-import reference by path (readFileSync("tests/db/helpers/x.ts"), a workflow step, a script) is not an edge the graph sees.
  return { provable: other.length === 0, lanes: [...lanes].sort(), other: other.sort() };
}

/**
 * CI-SELECT-03. Everything `seeds` import, directly or transitively, across the whole repository (the forward closure). A changed file in this
 * set can change what a seed executes; a file outside it cannot be loaded by it through an import. Seeds that do not exist are ignored.
 */
export function forwardClosure(root, seeds) {
  const g = repoImporters(root);
  const imports = new Map();
  for (const [target, who] of g.importedBy) for (const f of who) (imports.get(f) ?? imports.set(f, new Set()).get(f)).add(target);
  const seen = new Set();
  const stack = seeds.filter((f) => g.files.has(f));
  for (const f of stack) seen.add(f);
  while (stack.length) {
    for (const t of imports.get(stack.pop()) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t); }
  }
  return seen;
}
