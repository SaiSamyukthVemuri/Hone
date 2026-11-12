import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Privacy C5 (PEER-1430-AND-LOOKUP-Q1, revision 2): the clients directory search term lives in the URL
// (`?q=`). It must not reach a log line, an error report, an analytics client or a network call.
// A SOURCE contract over the directory's own modules.
//
// THE RULE (not a spelling): a file in the directory set may not
//   1. REFERENCE the global `console`, `fetch`, `XMLHttpRequest` or `WebSocket`, however it is reached
//      (`console.log`, `const c = console`, `const { error } = console`, `globalThis.console`,
//      `window.fetch`, `self["fetch"]`); a reference is a violation, a call is not required;
//   2. IMPORT, `require` or dynamically `import()` a module that writes somewhere: the safe logger
//      (`@/lib/logging/*`), any Sentry package, the analytics boundary (`@/lib/analytics/*`,
//      `@/lib/posthog-server`), `posthog-*`, `@vercel/analytics*`, `@vercel/speed-insights*`;
//   3. call `navigator.sendBeacon` or `.sendBeacon(` on anything;
//   4. write to `process.stdout` / `process.stderr` (or alias, destructure or index `process`), or open an
//      `EventSource` (Privacy N1);
//   5. build error text from anything but literals (Privacy N2): the Sentry scrub strips URL queries, NOT
//      message text, so an error whose message holds the term would leave through the error report. Every
//      `new <Name>Error(...)` takes only string-literal text (a literal, a conditional or concatenation of
//      literals, or a `const` in the same file that resolves to one), and every `throw` throws such a
//      `new ...Error(...)`; a rethrow of a caught value or any computed message is a violation.
// Bindings are resolved first: an import counts by what the module IS, under any local name or alias,
// and a global is caught by the identifier it resolves to, not by `console.log(` text.
//
// ALLOWED, deliberately: `@/lib/observability/perf-timing` (page.tsx's measurement spans). Its own
// guard (tests/source-guards/perf-timing-privacy-guards.test.ts) proves it carries no path, term or id.
//
// SCOPE: the directory modules and every module they import from `./` or `@/lib/clients/`
// (closure check below, so a new helper cannot be added to the directory unguarded). Shared components,
// the Supabase clients and Next are out of scope: they are not directory code and are covered by their
// own guards (Sentry scrub for errors, vercel-url-redaction for analytics).
// If this fails on legitimate new code: do not add the module to an allow list; keep the term out of it.

const ROOT = process.cwd();

export const DIRECTORY_SCOPE = [
  "app/(app)/clients/page.tsx",
  "app/(app)/clients/ClientsDirectory.tsx",
  "app/(app)/clients/DirectoryControls.tsx",
  "app/(app)/clients/OverviewFrame.tsx",
  "app/(app)/clients/UnarchiveRowControl.tsx",
  "lib/clients/directory-rules.ts",
  "lib/clients/directory-search.ts",
  "lib/clients/directory-query.ts",
  "lib/clients/directory-read.ts",
  "lib/clients/last-visit.ts",
  "lib/clients/list-view.ts",
  "lib/clients/name-search.ts",
  "lib/clients/preferred-name-read.ts",
];

const FORBIDDEN_GLOBALS = new Set(["console", "fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);
const PROCESS_STREAMS = new Set(["stdout", "stderr"]);
const GLOBAL_HOLDERS = new Set(["globalThis", "window", "self", "global"]);
const SINK_MODULE_RE =
  /^(@\/lib\/logging(\/|$)|@sentry\/|@\/lib\/analytics(\/|$)|@\/lib\/posthog-server$|posthog-(js|node)$|@vercel\/(analytics|speed-insights)(\/|$))/;

function kind(file: string): ts.ScriptKind {
  return file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** True when `expr` can only ever be literal text: a literal, a literal-only conditional or `+`, or a same-file `const` that is one. */
function isLiteralText(expr: ts.Expression, sf: ts.SourceFile, depth = 0): boolean {
  if (depth > 6) return false;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return isLiteralText(expr.expression, sf, depth + 1);
  if (ts.isConditionalExpression(expr)) return isLiteralText(expr.whenTrue, sf, depth + 1) && isLiteralText(expr.whenFalse, sf, depth + 1);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isLiteralText(expr.left, sf, depth + 1) && isLiteralText(expr.right, sf, depth + 1);
  }
  if (ts.isIdentifier(expr)) {
    let found: ts.Expression | null = null;
    let count = 0;
    const find = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === expr.text) {
        count += 1;
        const list = n.parent;
        const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
        if (isConst && n.initializer) found = n.initializer;
      }
      ts.forEachChild(n, find);
    };
    find(sf);
    // Exactly one declaration, a const, with literal-only text. A parameter or a reassigned name never qualifies.
    return count === 1 && found !== null && isLiteralText(found, sf, depth + 1);
  }
  return false;
}

export function logsNothingViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind(file));
  const out: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const sink = (spec: string) => SINK_MODULE_RE.test(spec);

  // Aliases of the global holders (Codex P2 on #1431): `const browser = window`, `let g; g = globalThis`,
  // `const { window: w } = globalThis`, chains like `globalThis.window`. Found to a fixpoint first, so a
  // sink reached through ANY alias is judged as the holder it resolves to.
  const holders = new Set(GLOBAL_HOLDERS);
  const isHolderExpr = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return isHolderExpr(e.expression);
    if (ts.isIdentifier(e)) return holders.has(e.text);
    if (ts.isPropertyAccessExpression(e)) return GLOBAL_HOLDERS.has(e.name.text) && isHolderExpr(e.expression);
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      return GLOBAL_HOLDERS.has(e.argumentExpression.text) && isHolderExpr(e.expression);
    }
    return false;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const learn = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer && isHolderExpr(n.initializer)) {
        if (ts.isIdentifier(n.name) && !holders.has(n.name.text)) { holders.add(n.name.text); changed = true; }
        if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            const key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName)) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
            if (GLOBAL_HOLDERS.has(key) && ts.isIdentifier(el.name) && !holders.has(el.name.text)) { holders.add(el.name.text); changed = true; }
          }
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isHolderExpr(n.right) && !holders.has(n.left.text)) {
        holders.add(n.left.text);
        changed = true;
      }
      ts.forEachChild(n, learn);
    };
    learn(sf);
  }

  const visit = (node: ts.Node): void => {
    // 2. static imports and `export ... from`
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (sink(node.moduleSpecifier.text)) out.push(`${file}:${at(node)} imports ${node.moduleSpecifier.text}`);
    }
    // 2. `require("x")` and `import("x")`
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && arg && ts.isStringLiteralLike(arg) && sink(arg.text)) {
        out.push(`${file}:${at(node)} loads ${arg.text}`);
      }
      // 3. any `.sendBeacon(` call
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "sendBeacon") {
        out.push(`${file}:${at(node)} calls sendBeacon`);
      }
    }
    // 4. process.stdout / process.stderr, and any use of `process` that cannot be resolved to a plain property read
    if (ts.isIdentifier(node) && node.text === "process") {
      const p = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(p) && p.name === node;
      const isKey = ts.isPropertyAssignment(p) && p.name === node;
      const isTypePosition = ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p);
      if (!isPropertyName && !isKey && !isTypePosition) {
        if (ts.isPropertyAccessExpression(p) && p.expression === node) {
          if (PROCESS_STREAMS.has(p.name.text)) out.push(`${file}:${at(node)} references process.${p.name.text}`);
        } else {
          out.push(`${file}:${at(node)} aliases, indexes or passes process`);
        }
      }
    }
    // 5. error text must be literal
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text)) {
      for (const a of node.arguments ?? []) {
        if (!ts.isExpression(a) || !isLiteralText(a, sf)) out.push(`${file}:${at(node)} builds ${node.expression.text} text from a non-literal`);
      }
    }
    if (ts.isThrowStatement(node)) {
      const e = node.expression;
      const isNewError = ts.isNewExpression(e) && ts.isIdentifier(e.expression) && /Error$/.test(e.expression.text);
      if (!isNewError) out.push(`${file}:${at(node)} throws something other than a new ...Error(literal)`);
    }
    // 1. a reference to a forbidden global (not a property NAME, not a declaration's own name)
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const p = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(p) && p.name === node;
      const isKey = ts.isPropertyAssignment(p) && p.name === node;
      // A DECLARED member name (interface/class/method) is not a reference to the global.
      const isMemberName =
        (ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === node;
      const isTypePosition = ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p);
      if (!isPropertyName && !isKey && !isMemberName && !isTypePosition) out.push(`${file}:${at(node)} references ${node.text}`);
    }
    // 1. `globalThis.console`, `window["fetch"]`, `alias.fetch`, `const { fetch } = window`
    if (ts.isPropertyAccessExpression(node) && isHolderExpr(node.expression)) {
      if (FORBIDDEN_GLOBALS.has(node.name.text) || node.name.text === "process") {
        out.push(`${file}:${at(node)} references ${node.expression.getText(sf)}.${node.name.text}`);
      }
    }
    if (ts.isElementAccessExpression(node) && isHolderExpr(node.expression)) {
      const a = node.argumentExpression;
      if (!ts.isStringLiteralLike(a) || FORBIDDEN_GLOBALS.has(a.text) || a.text === "process") {
        out.push(`${file}:${at(node)} reaches a global through ${node.expression.getText(sf)}[...]`);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name) && isHolderExpr(node.initializer)) {
      for (const el of node.name.elements) {
        const key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName)) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
        if (FORBIDDEN_GLOBALS.has(key) || key === "process" || (el.dotDotDotToken && !GLOBAL_HOLDERS.has(key))) {
          out.push(`${file}:${at(el)} destructures ${key || "..."} from ${node.initializer.getText(sf)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every import of a file that points into the clients area, as a repo path without extension. Resolves `./`,
 * `../` and the `@/` alias generally (Privacy N3): `@/app/(app)/clients/...` and `@/lib/clients/...` land in
 * the area, and the bare `@/lib/clients` resolves to its index module. A path outside the clients area
 * (components, supabase, next, third party) is not returned: shared code has its own guards.
 */
export function clientsAreaImports(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind(file));
  const specs: string[] = [];
  const collect = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      specs.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const callee = n.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) specs.push(n.arguments[0].text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const out: string[] = [];
  for (const s of specs) {
    let base: string | null = null;
    if (s.startsWith("./") || s.startsWith("../")) base = path.posix.normalize(path.posix.join(path.posix.dirname(file), s));
    else if (s.startsWith("@/")) base = path.posix.normalize(s.slice(2));
    if (base === null) continue;
    if (base === "lib/clients") base = "lib/clients/index";
    if (base.startsWith("lib/clients/") || base.startsWith("app/(app)/clients/") || base === "app/(app)/clients") out.push(base);
  }
  return out;
}

/** Imports into the clients area that are neither scoped nor an exception with a reason. */
export function closureViolations(file: string, source: string, scope: readonly string[], exceptions: Record<string, string>): string[] {
  const scoped = new Set(scope.map((f) => f.replace(/\.tsx?$/, "")));
  return clientsAreaImports(file, source)
    .filter((base) => !scoped.has(base) && !(base in exceptions))
    .map((base) => `${file} imports ${base}`);
}

/**
 * Imports of a scoped file that are NOT scoped, each with the reason it cannot carry the term.
 * The unarchive control posts a form whose only field is the client id (pinned below), so the
 * server-action module it calls never receives the search term.
 */
export const OUT_OF_SCOPE_IMPORTS: Record<string, string> = {
  "app/(app)/clients/[id]/actions": "unarchiveClientAction receives only client_id (UnarchiveRowControl posts one hidden field)",
};

const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("the scanner catches a planted call by what it resolves to (controls)", () => {
  const planted: Record<string, string> = {
    "console.log": 'export const f = (q: string) => { console.log(q); };',
    "console alias": 'const c = console; export const f = (q: string) => c.warn(q);',
    "console destructured": 'const { error } = console; export const f = (q: string) => error(q);',
    "console method taken": 'const log = console.info; export const f = (q: string) => log(q);',
    "globalThis.console": 'export const f = (q: string) => globalThis.console.log(q);',
    "window.fetch": 'export const f = (q: string) => window.fetch("/x?q=" + q);',
    "bracket global": 'export const f = (q: string) => self["fetch"]("/x", { body: q });',
    "fetch with the term": 'export const f = async (q: string) => { await fetch("/log", { method: "POST", body: q }); };',
    "fetch alias": 'const send = fetch; export const f = (q: string) => send("/x", { body: q });',
    "XMLHttpRequest": 'export const f = () => new XMLHttpRequest();',
    "sendBeacon": 'export const f = (q: string) => navigator.sendBeacon("/x", q);',
    "safe logger import": 'import { safeLog as s } from "@/lib/logging/safe-log"; export const f = (q: string) => s.info(q);',
    "sentry import": 'import * as S from "@sentry/nextjs"; export const f = (e: unknown) => S.captureException(e);',
    "analytics boundary import": 'import { track } from "@/lib/analytics/server"; export const f = (q: string) => track(q);',
    "posthog import": 'import { PostHog } from "posthog-node"; export const f = () => PostHog;',
    "vercel analytics import": 'import { track } from "@vercel/analytics"; export const f = (q: string) => track(q);',
    "require of a sink": 'const s = require("@sentry/nextjs"); export const f = (e: unknown) => s.captureException(e);',
    "dynamic import of a sink": 'export const f = async () => (await import("@/lib/posthog-server")).default;',
    "re-export of a sink": 'export { safeLog } from "@/lib/logging/safe-log";',
    // Codex P2: aliases of the global holders
    "window alias": 'const browser = window; export const f = (q: string) => browser.fetch("/x", { body: q });',
    "globalThis alias console": 'const g = globalThis; export const f = (q: string) => g.console.log(q);',
    "self alias bracket": 'const s = self; export const f = (q: string) => s["fetch"]("/x", { body: q });',
    "alias of an alias": 'const a = window; const b = a; export const f = (q: string) => b.fetch("/x", { body: q });',
    "assigned alias": 'let w: typeof window; w = window; export const f = (q: string) => w.fetch("/x", { body: q });',
    "chained holder": 'export const f = (q: string) => globalThis.window.fetch("/x", { body: q });',
    "holder pulled out by destructuring": 'const { window: w } = globalThis; export const f = (q: string) => w.fetch("/x", { body: q });',
    "forbidden member destructured from window": 'const { fetch: send } = window; export const f = (q: string) => send("/x", { body: q });',
    "console destructured from an alias": 'const g = globalThis; const { console: c } = g; export const f = (q: string) => c.log(q);',
    "alias in a bracket-computed key": 'const w = window; export const f = (k: string, q: string) => w[k]("/x", { body: q });',
    // N1
    "process.stdout.write": 'export const f = (q: string) => process.stdout.write(q);',
    "process.stderr.write": 'export const f = (q: string) => { process.stderr.write(q); };',
    "process aliased": 'const p = process; export const f = (q: string) => p.stdout.write(q);',
    "process destructured": 'const { stderr } = process; export const f = (q: string) => stderr.write(q);',
    "process indexed": 'export const f = (q: string) => process["stdout"].write(q);',
    "globalThis.process": 'export const f = (q: string) => globalThis.process.stdout.write(q);',
    "EventSource": 'export const f = (q: string) => new EventSource("/x?q=" + q);',
    "EventSource alias": 'const E = EventSource; export const f = (q: string) => new E("/x?q=" + q);',
    // N2
    "error text interpolates the term": 'export const f = (q: string) => { throw new Error(`no client matches ${q}`); };',
    "error text concatenates the term": 'export const f = (q: string) => { throw new Error("no client " + q); };',
    "error text from String()": 'export const f = (q: string) => { throw new Error(String(q)); };',
    "error text from a parameter": 'export const f = (msg: string) => { throw new Error(msg); };',
    "error with a cause": 'export const f = (e: unknown) => { throw new Error("failed", { cause: e }); };',
    "TypeError with the term": 'export const f = (q: string) => new TypeError(q);',
    "const that is not literal": 'const m = "x " + Math.random(); export const f = () => { throw new Error(m); };',
    "rethrow of a caught value": 'export const f = () => { try { return 1; } catch (e) { throw e; } };',
    "throw of a computed value": 'export const f = (q: string) => { throw q; };',
    "let reassigned message": 'let m = "a"; m = "b"; export const f = () => { throw new Error(m); };',
  };
  for (const [name, code] of Object.entries(planted)) {
    it(`flags ${name}`, () => expect(logsNothingViolations("lib/clients/planted.ts", code).length).toBeGreaterThan(0));
  }
  it("flags a console call in a TSX file too", () => {
    expect(logsNothingViolations("app/(app)/clients/x.tsx", 'export const C = ({ q }: { q: string }) => { console.log(q); return <p>{q}</p>; };').length).toBeGreaterThan(0);
  });

  const clean: Record<string, string> = {
    "plain code": 'export const f = (q: string) => q.trim().toLowerCase();',
    "a console mention in a comment or string": '// console.log(q) is forbidden here\nexport const s = "do not console.log or fetch(q)";',
    "a property that is merely named fetch or console": 'export const o = { fetch: 1, console: 2 }; export const g = o.fetch + o.console;',
    "the perf-timing measurement import (allowed)": 'import { startPerfSpan } from "@/lib/observability/perf-timing"; export const s = startPerfSpan("clients.domain");',
    "ordinary shared imports": 'import Link from "next/link"; import { createClient } from "@/lib/supabase/server"; export const L = Link; export const c = createClient;',
    "a type named after a global": 'export type T = typeof globalThis; export interface I { fetch: () => void }',
    "an alias used only for a harmless read": 'const w = window; export const h = () => w.location.hash;',
    "destructuring a harmless member": 'const { location } = window; export const h = () => location.pathname;',
    "process.env read": 'export const e = process.env.NODE_ENV;',
    "a literal error": 'export const f = () => { throw new Error("Failed to load clients"); };',
    "a const, conditional and concatenation of literals": 'const a = "Failed to load"; const m = true ? a + " clients" : "Failed to load archived clients"; export const f = () => { throw new Error(m); };',
    "a template without substitutions": 'export const f = () => { throw new Error(`Failed to load clients`); };',
  };
  for (const [name, code] of Object.entries(clean)) {
    it(`does not flag ${name}`, () => expect(logsNothingViolations("lib/clients/clean.ts", code)).toEqual([]));
  }
});

describe("the closure resolves every import form into the clients area (controls, Privacy N3)", () => {
  const scope = ["app/(app)/clients/page.tsx", "lib/clients/directory-query.ts"];
  const v = (file: string, code: string) => closureViolations(file, code, scope, {});
  const planted: Record<string, string> = {
    "@/app/(app)/clients/ path": 'import { X } from "@/app/(app)/clients/Other"; export const a = X;',
    "bare @/lib/clients index": 'import { X } from "@/lib/clients"; export const a = X;',
    "@/lib/clients/ file": 'import { X } from "@/lib/clients/not-scoped"; export const a = X;',
    "./ sibling": 'import { X } from "./Other"; export const a = X;',
    "../ climbing back in": 'import { X } from "../clients/Other"; export const a = X;',
    "re-export": 'export { X } from "@/lib/clients/not-scoped";',
    "dynamic import": 'export const a = () => import("@/lib/clients/not-scoped");',
    "require": 'export const a = require("@/lib/clients/not-scoped");',
    "awaited relative dynamic import": 'export const a = async () => { const m = await import("./leak"); return m; };',
    "relative require": 'const m = require("./leak"); export const a = m;',
    "dynamic import of the app area": 'export const a = async () => (await import("@/app/(app)/clients/leak")).default;',
    "require of the bare index": 'const m = require("@/lib/clients"); export const a = m;',
  };
  for (const [name, code] of Object.entries(planted)) {
    it(`flags an unscoped ${name}`, () => expect(v("app/(app)/clients/page.tsx", code).length).toBeGreaterThan(0));
  }
  it("accepts scoped imports and ignores code outside the clients area", () => {
    expect(v("app/(app)/clients/page.tsx", 'import { q } from "@/lib/clients/directory-query"; import Link from "next/link"; import { c } from "@/lib/supabase/server"; export const a = [q, Link, c];')).toEqual([]);
  });
  it("accepts an unscoped import only when it is a named exception", () => {
    const code = 'import { a } from "./[id]/actions"; export const b = a;';
    expect(closureViolations("app/(app)/clients/page.tsx", code, scope, {})).toHaveLength(1);
    expect(closureViolations("app/(app)/clients/page.tsx", code, scope, { "app/(app)/clients/[id]/actions": "reason" })).toEqual([]);
  });
});

describe("the clients directory's own modules log, report and send nothing", () => {
  for (const file of DIRECTORY_SCOPE) {
    it(`${file} references no console, fetch or sink module`, () => {
      expect(logsNothingViolations(file, read(file))).toEqual([]);
    });
  }

  it("the scope is closed: every import into the clients area (./, ../, any @/ path, the bare @/lib/clients index) is itself scoped", () => {
    const missing = DIRECTORY_SCOPE.flatMap((file) => closureViolations(file, read(file), DIRECTORY_SCOPE, OUT_OF_SCOPE_IMPORTS));
    expect(missing).toEqual([]);
  });

  it("the one out-of-scope import is safe because the unarchive form posts only the client id", () => {
    const src = read("app/(app)/clients/UnarchiveRowControl.tsx");
    const inputs = [...src.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatch(/type="hidden"/);
    expect(inputs[0]).toMatch(/name="client_id"/);
    expect(src).not.toMatch(/searchParams|useSearchParams|location\.search|\bq\b/);
    expect(Object.keys(OUT_OF_SCOPE_IMPORTS)).toEqual(["app/(app)/clients/[id]/actions"]);
  });

  it("the scope lists only files that exist (a rename cannot silently shrink the guard)", () => {
    for (const file of DIRECTORY_SCOPE) expect(() => read(file)).not.toThrow();
  });
});
