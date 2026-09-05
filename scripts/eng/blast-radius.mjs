#!/usr/bin/env node
/**
 * Hone blast-radius recon — SOURCE OBSERVATION ONLY.
 *
 * Answers, from the repository tree alone, the questions we otherwise pay for by
 * hand every release:
 *
 *   node scripts/eng/blast-radius.mjs rpc <function_name>
 *   node scripts/eng/blast-radius.mjs table <table_name>
 *   node scripts/eng/blast-radius.mjs module <path>
 *   node scripts/eng/blast-radius.mjs authority
 *   node scripts/eng/blast-radius.mjs --selftest
 *
 * WHY THIS EXISTS. A Supabase RPC is reached by a STRING LITERAL
 * (`admin.rpc("issue_x")`) and defined in SQL. No TypeScript-only graph can join
 * those two halves, so "what runtime code reaches this Postgres command" was a
 * manual grep every time. This joins them.
 *
 * ============================================================================
 * HARD REFUSAL BOUNDARY — READ BEFORE TRUSTING ANY OUTPUT
 * ============================================================================
 * This tool reads SOURCE. Source can establish what code says. It cannot
 * establish what the database currently is.
 *
 * IT MAY REPORT: IMPORT, REEXPORT, TYPE_ONLY, FUNCTION_CALL, ROUTE_ENTRY,
 * SERVER_ACTION, TEST_CONSUMER, TABLE_QUERY, RPC_STRING_LITERAL,
 * SQL_FUNCTION_DEFINITION, SECURITY_DEFINER_DECLARED_IN_SOURCE.
 *
 * IT MUST REFUSE TO CONCLUDE: effective RLS permission, effective grants,
 * function owner, effective search_path, hosted function existence, hosted
 * function definition, hosted schema truth, production state, release
 * readiness. Every one of those needs catalog or hosted evidence and is
 * reported as HOSTED_CURRENT_UNKNOWN.
 *
 * `.from("t")` means the source can ADDRESS the relation. It does NOT mean RLS
 * permits the read. Reachable is not permitted.
 *
 * SCOPE: general engineering recon. NOT a security authority. It can inform a
 * security review; it may never be the evidence for one.
 *
 * FAIL-CLOSED. A partial graph looks exactly like a real absence — during the
 * pilot a regex defect silently dropped 17.9% of imports and understated a
 * privileged-reachability answer by 31 files while looking entirely plausible.
 * Every invocation runs the completeness invariants first; any mandatory
 * failure exits non-zero and emits NO result.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

const SKIP = new Set(["node_modules", ".next", ".git", "public", ".vercel", "coverage", "playwright-report"]);
const CODE = /\.(ts|tsx|mjs|js|jsx)$/;
const EXTS = ["", ".ts", ".tsx", ".mjs", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
const BUILTIN_FROM = new Set(["Array", "Object", "Buffer", "Date", "Number", "String", "Set", "Map",
  "Promise", "BigInt", "Int8Array", "Uint8Array", "Float64Array"]);

/**
 * THE REFUSAL CONTRACT — one canonical definition, stamped on EVERY result.
 *
 * Emitted as an OBJECT with every field always present, never as a list of
 * names. A consumer must not be able to confuse "not implemented by accident"
 * with "intentionally refused": if the field is absent the tool is broken, and
 * if it is present it always reads HOSTED_CURRENT_UNKNOWN.
 */
export const HOSTED_CURRENT_UNKNOWN = "HOSTED_CURRENT_UNKNOWN";
export const REFUSED_CONCLUSIONS = Object.freeze([
  "effectiveRlsPermission", "effectiveGrants", "functionOwner", "effectiveSearchPath",
  "hostedFunctionExistence", "hostedFunctionDefinition", "hostedSchemaTruth",
  "productionState", "releaseReadiness",
]);
export function refusalContract() {
  return Object.fromEntries(REFUSED_CONCLUSIONS.map((k) => [k, HOSTED_CURRENT_UNKNOWN]));
}

/**
 * CODE MASK — the detectors must never read non-code.
 *
 * Returns a string of identical length and line structure in which every byte
 * that is NOT executable code is blanked: line comments, block comments,
 * single/double-quoted string bodies, template-literal TEXT, and regex-literal
 * bodies. Offsets and newlines are preserved so reported line numbers stay
 * exact.
 *
 * Template interpolations are CODE: in `` `x${admin.from("t")}y` `` the `x`/`y`
 * text is blanked but the expression inside `${...}` is preserved, because a
 * real call can live there.
 *
 * Blanking rather than deleting is deliberate. A previous version only stripped
 * comments, so a string containing `.from('ghost')` or a comment reading
 * "No createAdminClient" manufactured edges that did not exist — the second one
 * inverted a service-role conclusion.
 *
 * Regex-vs-division is resolved by the preceding significant code character,
 * the standard lexical heuristic: after a value (identifier, number, `)`, `]`,
 * backtick, quote) a `/` is division; anywhere else it opens a regex literal.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do",
  "else", "yield", "await", "case", "throw",
]);

export function codeSpans(src) {
  const n = src.length;
  const flag = new Uint8Array(n); // 1 = code-bearing, 0 = comment/string/regex body
  const out = new Array(n);
  const blank = (i) => { out[i] = src[i] === "\n" ? "\n" : " "; flag[i] = 0; };
  const keep = (i) => { out[i] = src[i]; flag[i] = 1; };

  // Template stack: each entry tracks whether we are in template TEXT or inside
  // a ${ } interpolation, plus brace depth so nested objects close correctly.
  const tpl = [];
  let i = 0;
  let lastSig = ""; // last significant CODE character emitted

  const prevWord = (at) => {
    let e = at - 1;
    while (e >= 0 && /\s/.test(src[e])) e--;
    let b = e;
    while (b >= 0 && /[A-Za-z_$]/.test(src[b])) b--;
    return src.slice(b + 1, e + 1);
  };
  const regexCanStart = (at) => {
    if (lastSig === "") return true;
    if (/[)\]}]/.test(lastSig)) return false;
    if (/[A-Za-z0-9_$]/.test(lastSig)) return REGEX_PRECEDING_KEYWORDS.has(prevWord(at));
    return true;
  };

  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    const inTplText = tpl.length > 0 && tpl[tpl.length - 1].mode === "text";

    if (inTplText) {
      if (c === "\\") { blank(i); blank(i + 1); i += 2; continue; }
      if (c === "`") { keep(i); tpl.pop(); lastSig = "`"; i++; continue; }
      if (c === "$" && c2 === "{") { keep(i); keep(i + 1); tpl[tpl.length - 1].mode = "expr"; tpl[tpl.length - 1].depth = 0; lastSig = "{"; i += 2; continue; }
      blank(i); i++; continue;
    }

    // line comment
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") { blank(i); i++; } continue; }
    // block comment
    if (c === "/" && c2 === "*") {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { blank(i); i++; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    // string
    if (c === '"' || c === "'") {
      keep(i); const q = c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
        if (src[i] === "\n") break;
        blank(i); i++;
      }
      if (i < n && src[i] === q) { keep(i); i++; }
      lastSig = q;
      continue;
    }
    // template open
    if (c === "`") { keep(i); tpl.push({ mode: "text", depth: 0 }); lastSig = "`"; i++; continue; }
    // regex literal
    if (c === "/" && regexCanStart(i)) {
      keep(i); i++;
      let cls = false;
      while (i < n) {
        const d = src[i];
        if (d === "\\") { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
        if (d === "\n") break;
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) { keep(i); i++; break; }
        blank(i); i++;
      }
      while (i < n && /[dgimsuvy]/.test(src[i])) { keep(i); i++; }
      lastSig = "/";
      continue;
    }
    // template interpolation brace tracking
    if (tpl.length > 0 && tpl[tpl.length - 1].mode === "expr") {
      const top = tpl[tpl.length - 1];
      if (c === "{") top.depth++;
      else if (c === "}") {
        if (top.depth === 0) { keep(i); top.mode = "text"; lastSig = "}"; i++; continue; }
        top.depth--;
      }
    }
    keep(i);
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return { masked: out.join(""), code: flag };
}

/** Offset-preserving blanked source. Non-code bytes become spaces. */
export function codeMask(src) {
  return codeSpans(src).masked;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

export function buildGraph(root = REPO_ROOT) {
  const rel = (p) => relative(root, p).split("\\").join("/");
  const all = walk(root);
  const codeFiles = all.filter((f) => CODE.test(f));
  const sqlFiles = all.filter((f) => f.endsWith(".sql") && rel(f).startsWith("supabase/migrations/"));
  const codeSet = new Set(codeFiles.map(rel));

  const resolveSpec = (spec, fromFile) => {
    let base;
    if (spec.startsWith("@/")) base = spec.slice(2);
    else if (spec.startsWith(".")) base = rel(resolve(dirname(fromFile), spec));
    else return null;
    for (const ext of EXTS) {
      const cand = (base + ext).replace(/\/+/g, "/");
      if (codeSet.has(cand)) return cand;
    }
    return null;
  };

  const nodes = new Map();
  const edges = [];
  const add = (from, to, type, line, detail) =>
    edges.push({ from, to, type, line, ...(detail ? { detail } : {}) });

  // SQL side. A redefined function is ONE identity with N historical
  // definitions — never N live functions.
  const sqlFns = new Map();
  const migNum = (f) => Number.parseInt(rel(f).match(/(\d{4})_/)?.[1] ?? "-1", 10);
  for (const f of sqlFiles.sort((a, b) => migNum(a) - migNum(b))) {
    const text = readFileSync(f, "utf8");
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1].toLowerCase();
      const after = text.slice(m.index, m.index + 4000);
      const bodyAt = after.search(/\bas\s*\$\$|\blanguage\b/i);
      const header = bodyAt > 0 ? after.slice(0, bodyAt + 200) : after.slice(0, 800);
      const line = text.slice(0, m.index).split("\n").length;
      if (!sqlFns.has(name)) sqlFns.set(name, []);
      sqlFns.get(name).push({
        migration: rel(f), number: migNum(f), line,
        securityDefinerDeclaredInSource: /security\s+definer/i.test(header),
      });
    }
  }

  for (const f of codeFiles) {
    const r = rel(f);
    const raw = readFileSync(f, "utf8");
    // Detect on RAW so string LITERAL VALUES survive (a table name lives inside
    // quotes), but require the CALL SITE itself to sit in a code-bearing span.
    // `".from('ghost')"` therefore yields nothing: its `.from(` is string body.
    const { code } = codeSpans(raw);
    const text = raw;
    const isCode = (i) => code[i] === 1;
    const lineOf = (i) => text.slice(0, i).split("\n").length;

    nodes.set(r, {
      file: r,
      serverAction: /^\s*["']use server["']/m.test(raw.slice(0, 400)),
      routeEntry: /^app\/.*\/(page|layout|route|template|error|not-found)\.tsx?$/.test(r) || /^middleware\.tsx?$/.test(r),
      test: /^(tests|e2e|e2e-payment)\//.test(r),
      script: /^scripts\//.test(r),
    });

    let m;
    // IMPORT / REEXPORT / TYPE_ONLY. `import type` is ERASED at runtime and
    // must never carry reachability. Bounded [\s\S] captures multi-line blocks;
    // the newline-forbidding form silently dropped 17.9% of them.
    const imp = /(^|\n)\s*(import|export)\b[\s\S]{0,600}?from\s*["']([^"']+)["']/g;
    while ((m = imp.exec(text))) {
      if (!isCode(m.index + m[0].search(/\S/))) continue;
      const to = resolveSpec(m[3], f);
      if (!to) continue;
      const typeOnly = /\b(import|export)\s+type\b/.test(m[0]);
      add(r, to, typeOnly ? "TYPE_ONLY" : m[2] === "export" ? "REEXPORT" : "IMPORT", lineOf(m.index));
    }
    const dyn = /\bimport\(\s*["']([^"']+)["']\s*,?\s*\)/g;
    while ((m = dyn.exec(text))) {
      if (!isCode(m.index)) continue;
      const to = resolveSpec(m[1], f);
      if (!to) continue;
      // TYPE-POSITION import() is erased: `typeof import("x")`, and an
      // `import("x").Thing` used inside a type alias / interface / annotation.
      const before = text.slice(Math.max(0, m.index - 200), m.index);
      const typePosition = /\btypeof\s*$/.test(before) ||
        /(^|[\n;{}])\s*(export\s+)?(type|interface)\b[^\n;]*$/.test(before) ||
        /:\s*$/.test(before);
      add(r, to, typePosition ? "TYPE_ONLY" : "IMPORT", lineOf(m.index), typePosition ? "type-position" : "dynamic");
    }

    // RPC_STRING_LITERAL — the half a TypeScript-only graph discards.
    const rpc = /\.rpc\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
    while ((m = rpc.exec(text))) {
      if (!isCode(m.index)) continue;
      add(r, `sqlfn:${m[1].toLowerCase()}`, "RPC_STRING_LITERAL", lineOf(m.index));
    }

    // CREATE_ADMIN_CLIENT — service-role authority, by call site not import.
    const adm = /\bcreateAdminClient\s*\(/g;
    while ((m = adm.exec(text))) {
      if (!isCode(m.index)) continue;
      add(r, "authority:service_role", "CREATE_ADMIN_CLIENT", lineOf(m.index));
    }

    // TABLE_QUERY. Generated declarations name every table and query none.
    if (!/^lib\/types\/database\.ts$/.test(r) && !/\.d\.ts$/.test(r)) {
      const from = /(?:([A-Za-z_$][\w$]*)\s*)?\.from\(\s*(?:(["'`])([a-z0-9_]+)\2|([A-Za-z_$][\w$.]*))\s*[,)]/g;
      while ((m = from.exec(text))) {
        if (m[1] && BUILTIN_FROM.has(m[1])) continue;
        if (!isCode(m.index + m[0].indexOf(".from("))) continue;
        // Attribute the line to `.from(`, not to the match start: a chained
        // `await supabase\n  .from("x")` begins at the receiver's line.
        const line = lineOf(m.index + m[0].indexOf(".from("));
        const opM = text.slice(m.index, m.index + 300).match(/\.(select|insert|update|upsert|delete)\s*\(/);
        const op = opM ? opM[1] : "unknown";
        const T = { select: "TABLE_SELECT", insert: "TABLE_INSERT", update: "TABLE_UPDATE", upsert: "TABLE_UPDATE", delete: "TABLE_DELETE" };
        if (m[3]) add(r, `table:${m[3]}`, T[op] ?? "TABLE_QUERY", line, op);
        else if (m[4]) add(r, "table:UNKNOWN_DYNAMIC", "TABLE_QUERY", line, `dynamic:${m[4]}`);
      }
    }

    // FUNCTION_CALL: a named import that is subsequently called. Inline `type`
    // specifiers are erased and excluded.
    const named = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    while ((m = named.exec(text))) {
      if (!isCode(m.index)) continue;
      const to = resolveSpec(m[2], f);
      if (!to) continue;
      for (const raw2 of m[1].split(",")) {
        const spec = raw2.trim();
        if (!spec || /^type\s/.test(spec)) continue;
        const nm = spec.split(/\s+as\s+/).pop().trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(nm)) continue;
        const cre = new RegExp(`\\b${nm}\\s*\\(`, "g");
        let c, at = null;
        while ((c = cre.exec(text))) if (c.index > m.index) { at = c.index; break; }
        if (at != null) add(r, to, "FUNCTION_CALL", lineOf(at), nm);
      }
    }
  }

  for (const [name, defs] of sqlFns)
    for (const d of defs) {
      add(d.migration, `sqlfn:${name}`, "SQL_FUNCTION_DEFINITION", d.line);
      if (d.securityDefinerDeclaredInSource) add(d.migration, `sqlfn:${name}`, "SECURITY_DEFINER_DECLARED_IN_SOURCE", d.line);
    }

  const sqlFunctions = [...sqlFns].map(([name, history]) => ({
    name, definitionCount: history.length, latest: history[history.length - 1], history,
    securityDefinerDeclaredInSource: history[history.length - 1].securityDefinerDeclaredInSource,
    hostedCurrentDefinition: "HOSTED_CURRENT_UNKNOWN",
    hostedGrants: "HOSTED_CURRENT_UNKNOWN",
    hostedOwner: "HOSTED_CURRENT_UNKNOWN",
    hostedSearchPath: "HOSTED_CURRENT_UNKNOWN",
  }));

  return { root, nodes, edges, sqlFunctions, resolveSpec, counts: { codeFiles: codeFiles.length, sqlMigrations: sqlFiles.length, sqlIdentities: sqlFunctions.length } };
}

/**
 * Independent import oracle. Uses the TypeScript compiler's own file
 * pre-processor — a different implementation by a different author — to
 * enumerate module specifiers, then checks this extractor found at least as
 * many resolvable internal ones per file.
 *
 * If TypeScript cannot be loaded the oracle is UNAVAILABLE and the selftest
 * FAILS: an unprovable graph is refused rather than trusted.
 */
export function importOracle(g) {
  let ts;
  try {
    ts = createRequire(join(g.root, "package.json"))("typescript");
  } catch (e) {
    return { available: false, ok: false, reason: `typescript not resolvable (${e.code ?? e.message})`, deficitFiles: [], filesCompared: 0 };
  }
  const found = new Map();
  for (const e of g.edges) {
    if (e.type !== "IMPORT" && e.type !== "REEXPORT" && e.type !== "TYPE_ONLY") continue;
    found.set(e.from, (found.get(e.from) ?? 0) + 1);
  }
  const deficitFiles = [];
  let filesCompared = 0;
  for (const [file] of g.nodes) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const abs = join(g.root, file);
    if (!existsSync(abs)) continue;
    const raw = readFileSync(abs, "utf8");
    const pre = ts.preProcessFile(raw, true, true);
    // `preProcessFile` is a naive scanner: it reports `from "@/x"` even when it
    // sits inside a REGEX LITERAL in a test assertion. Its POSITION is used to
    // drop those, so TypeScript still independently decides what is an import
    // and only the code/non-code judgement is shared. That judgement is proven
    // separately by the negative fixtures in the test suite.
    const { code } = codeSpans(raw);
    const internal = pre.importedFiles
      .filter((x) => code[x.pos] === 1)
      .map((x) => x.fileName)
      .filter((spec) => spec.startsWith("@/") || spec.startsWith("."))
      .filter((spec) => g.resolveSpec(spec, abs));
    if (internal.length === 0) continue;
    filesCompared++;
    const got = found.get(file) ?? 0;
    if (got < internal.length) deficitFiles.push({ file, found: got, expected: internal.length });
  }
  return { available: true, ok: deficitFiles.length === 0, tsVersion: ts.version, filesCompared, deficitFiles, reason: null };
}

/** Completeness invariants. Every one is MANDATORY: failure means UNAVAILABLE. */
export function selftest(g) {
  const byType = (t) => g.edges.filter((e) => e.type === t);
  const tableEdges = g.edges.filter((e) => e.type.startsWith("TABLE_"));
  const inv = [];
  const chk = (id, pass, detail) => inv.push({ id, pass: !!pass, detail });

  // ---------------------------------------------------------------------
  // IMPORT COMPLETENESS — proved against an INDEPENDENT parser, per file.
  //
  // The previous form was a repo-wide ratio (imports/file >= 1.4). That is not
  // a completeness proof: it is the extractor grading itself, and it survives
  // the exact defect it was written for. Deleting 17.9% of imports leaves the
  // ratio at ~1.42 and the selftest PASSED.
  //
  // Now: TypeScript's own `preProcessFile` scanner (already a devDependency,
  // no new package) enumerates the module specifiers in every file. Any file
  // where this extractor found FEWER resolvable internal specifiers than the
  // compiler did is a completeness failure. Per-file comparison catches the
  // loss of a SINGLE import, not only a wholesale collapse.
  // ---------------------------------------------------------------------
  const oracle = importOracle(g);
  chk("import_completeness_vs_typescript", oracle.ok,
    oracle.available
      ? `${oracle.filesCompared} files compared against TypeScript ${oracle.tsVersion}; ${oracle.deficitFiles.length} file(s) missing specifiers${oracle.deficitFiles.length ? " — e.g. " + oracle.deficitFiles.slice(0, 3).map((d) => `${d.file} (${d.found}/${d.expected})`).join(", ") : ""}`
      : `UNPROVABLE: ${oracle.reason} — completeness cannot be demonstrated, so the graph is refused`);
  chk("reexport_recognition", byType("REEXPORT").length >= 5, `${byType("REEXPORT").length} REEXPORT (floor 5)`);
  chk("type_only_recognition", byType("TYPE_ONLY").length >= 100, `${byType("TYPE_ONLY").length} TYPE_ONLY (floor 100)`);
  chk("table_query_recognition", tableEdges.length >= 400, `${tableEdges.length} TABLE_* (floor 400)`);
  chk("rpc_literal_recognition", byType("RPC_STRING_LITERAL").length >= 60, `${byType("RPC_STRING_LITERAL").length} RPC literals (floor 60)`);
  chk("sql_definitions_parsed", g.counts.sqlIdentities >= 150, `${g.counts.sqlIdentities} SQL identities (floor 150)`);
  chk("dynamic_never_guessed", tableEdges.some((e) => e.to === "table:UNKNOWN_DYNAMIC"),
    `${tableEdges.filter((e) => e.to === "table:UNKNOWN_DYNAMIC").length} dynamic refs preserved as UNKNOWN`);
  chk("hosted_truth_stamped", g.sqlFunctions.every((f) => f.hostedCurrentDefinition === "HOSTED_CURRENT_UNKNOWN"),
    `all ${g.sqlFunctions.length} SQL identities stamped HOSTED_CURRENT_UNKNOWN`);

  // Every literal TABLE edge must cite a line that really contains the call.
  let ok = 0, bad = 0;
  for (const e of tableEdges) {
    if (e.to === "table:UNKNOWN_DYNAMIC") continue;
    const p = join(g.root, e.from);
    if (!existsSync(p)) { bad++; continue; }
    const ln = readFileSync(p, "utf8").split("\n")[e.line - 1] ?? "";
    const t = e.to.slice(6);
    if (ln.includes(`.from("${t}")`) || ln.includes(`.from('${t}')`)) ok++; else bad++;
  }
  chk("table_edge_line_self_verification", bad === 0, `${ok} verified / ${bad} mismatched cited lines`);

  const failed = inv.filter((i) => !i.pass);
  return { pass: failed.length === 0, invariants: inv, failed: failed.map((f) => f.id) };
}

// --------------------------------------------------------------------------- queries
const isTest = (g, f) => !!g.nodes.get(f)?.test;
const isScript = (g, f) => !!g.nodes.get(f)?.script;
const isRuntime = (g, f) => g.nodes.has(f) && !isTest(g, f) && !isScript(g, f);

export function queryRpc(g, name) {
  const key = `sqlfn:${name.toLowerCase()}`;
  const calls = g.edges.filter((e) => e.type === "RPC_STRING_LITERAL" && e.to === key);
  const def = g.sqlFunctions.find((f) => f.name === name.toLowerCase());
  return {
    rpc: name,
    runtimeCallers: calls.filter((e) => isRuntime(g, e.from)).map((e) => `${e.from}:L${e.line}`),
    testCallers: calls.filter((e) => isTest(g, e.from)).map((e) => `${e.from}:L${e.line}`),
    scriptCallers: calls.filter((e) => isScript(g, e.from)).map((e) => `${e.from}:L${e.line}`),
    sqlDefinitionInMigrationHistory: def ? def.history.map((h) => `${h.migration}:L${h.line}`) : [],
    definitionCount: def?.definitionCount ?? 0,
    securityDefinerDeclaredInSource: def?.securityDefinerDeclaredInSource ?? null,
    refuses: refusalContract(),
  };
}

export function queryTable(g, table) {
  const key = `table:${table}`;
  const sites = g.edges.filter((e) => e.type.startsWith("TABLE_") && e.to === key);
  const group = (pred) => sites.filter((e) => pred(e.from)).map((e) => `${e.type} ${e.from}:L${e.line}`);
  return {
    table,
    runtimeQuerySites: group((f) => isRuntime(g, f)),
    testQuerySites: group((f) => isTest(g, f)),
    caveat: "reachability only: the source can ADDRESS this relation. It says NOTHING about whether RLS permits the operation.",
    refuses: refusalContract(),
  };
}

export function queryModule(g, path) {
  const inc = g.edges.filter((e) => e.to === path);
  const b = { productionConsumers: new Set(), testConsumers: new Set(), reexports: new Set(), typeOnly: new Set() };
  for (const e of inc) {
    if (e.type === "TYPE_ONLY") b.typeOnly.add(e.from);
    else if (e.type === "REEXPORT") b.reexports.add(e.from);
    else if (e.type === "IMPORT" || e.type === "FUNCTION_CALL") (isTest(g, e.from) ? b.testConsumers : b.productionConsumers).add(e.from);
  }
  return {
    module: path, existsInTree: g.nodes.has(path),
    productionConsumers: [...b.productionConsumers].sort(), testConsumers: [...b.testConsumers].sort(),
    reexports: [...b.reexports].sort(), typeOnlyConsumers: [...b.typeOnly].sort(),
    note: "TYPE_ONLY consumers are erased at runtime and are NOT runtime dependencies.",
    refuses: refusalContract(),
  };
}

export function queryAuthority(g) {
  const direct = new Set(g.edges.filter((e) => e.type === "CREATE_ADMIN_CLIENT" && isRuntime(g, e.from)).map((e) => e.from));
  const rev = new Map();
  for (const e of g.edges) if (e.type === "IMPORT" || e.type === "REEXPORT") {
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to).push(e.from);
  }
  const seen = new Set(direct), q = [...direct];
  while (q.length) { const c = q.shift(); for (const p of rev.get(c) ?? []) if (!seen.has(p)) { seen.add(p); q.push(p); } }
  const entries = [...seen].filter((f) => isRuntime(g, f) && (g.nodes.get(f)?.routeEntry || g.nodes.get(f)?.serverAction));
  const sec = g.edges.filter((e) => e.type === "RPC_STRING_LITERAL" && isRuntime(g, e.from) &&
    g.sqlFunctions.find((f) => f.name === e.to.slice(6))?.securityDefinerDeclaredInSource);
  return {
    directServiceRoleHolders: [...direct].sort(),
    runtimeTransitiveReach: [...seen].filter((f) => isRuntime(g, f)).length,
    entryPoints: entries.length,
    entryPointsHoldingDirectly: entries.filter((f) => direct.has(f)).length,
    securityDefinerCallSitesDeclaredInSource: sec.length,
    caveat: "DIRECT holders are the source-visible boundary; the transitive tail is import reach, not authority.",
    refuses: refusalContract(),
  };
}

// --------------------------------------------------------------------------- CLI
function main(argv) {
  const [cmd, arg] = argv;
  const g = buildGraph();
  const st = selftest(g);

  if (!st.pass) {
    console.error("BLAST-RADIUS SELFTEST FAILED — RESULT = UNAVAILABLE / INCOMPLETE.");
    console.error("A partial graph is indistinguishable from a real absence, so no result is emitted.");
    for (const i of st.invariants.filter((x) => !x.pass)) console.error(`  FAILED ${i.id}: ${i.detail}`);
    return 2;
  }
  if (cmd === "--selftest") {
    console.log(`SELFTEST PASS — ${st.invariants.length} invariants`);
    for (const i of st.invariants) console.log(`  PASS ${i.id}: ${i.detail}`);
    return 0;
  }

  let out;
  if (cmd === "rpc" && arg) out = queryRpc(g, arg);
  else if (cmd === "table" && arg) out = queryTable(g, arg);
  else if (cmd === "module" && arg) out = queryModule(g, arg);
  else if (cmd === "authority") out = queryAuthority(g);
  else {
    console.error("usage: node scripts/eng/blast-radius.mjs <rpc NAME | table NAME | module PATH | authority | --selftest>");
    console.error("SOURCE OBSERVATION ONLY. Never authority for RLS, grants, hosted schema, production state or release readiness.");
    return 1;
  }
  console.log(JSON.stringify({ selftest: "PASS", scope: "SOURCE_OBSERVATION_ONLY", ...out }, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
