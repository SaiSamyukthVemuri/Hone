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
//   3. call `navigator.sendBeacon` or `.sendBeacon(` on anything.
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

const FORBIDDEN_GLOBALS = new Set(["console", "fetch", "XMLHttpRequest", "WebSocket"]);
const GLOBAL_HOLDERS = new Set(["globalThis", "window", "self", "global"]);
const SINK_MODULE_RE =
  /^(@\/lib\/logging(\/|$)|@sentry\/|@\/lib\/analytics(\/|$)|@\/lib\/posthog-server$|posthog-(js|node)$|@vercel\/(analytics|speed-insights)(\/|$))/;

function kind(file: string): ts.ScriptKind {
  return file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export function logsNothingViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind(file));
  const out: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const sink = (spec: string) => SINK_MODULE_RE.test(spec);

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
    // 1. `globalThis.console`, `window["fetch"]`, `self.console`
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_HOLDERS.has(node.expression.text)) {
      if (FORBIDDEN_GLOBALS.has(node.name.text)) out.push(`${file}:${at(node)} references ${node.expression.text}.${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_HOLDERS.has(node.expression.text)) {
      const a = node.argumentExpression;
      if (!ts.isStringLiteralLike(a) || FORBIDDEN_GLOBALS.has(a.text)) {
        out.push(`${file}:${at(node)} reaches a global through ${node.expression.text}[...]`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Relative and @/lib/clients/ imports of a file, as repo paths (extension resolved against the scope list). */
export function localImports(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind(file));
  const specs: string[] = [];
  sf.forEachChild((n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      specs.push(n.moduleSpecifier.text);
    }
  });
  const resolved: string[] = [];
  for (const s of specs) {
    let base: string | null = null;
    if (s.startsWith("./") || s.startsWith("../")) base = path.posix.normalize(path.posix.join(path.posix.dirname(file), s));
    else if (s.startsWith("@/lib/clients/")) base = s.slice(2);
    if (base) resolved.push(base);
  }
  return resolved;
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
  };
  for (const [name, code] of Object.entries(clean)) {
    it(`does not flag ${name}`, () => expect(logsNothingViolations("lib/clients/clean.ts", code)).toEqual([]));
  }
});

describe("the clients directory's own modules log, report and send nothing", () => {
  for (const file of DIRECTORY_SCOPE) {
    it(`${file} references no console, fetch or sink module`, () => {
      expect(logsNothingViolations(file, read(file))).toEqual([]);
    });
  }

  it("the scope is closed: every ./ or @/lib/clients/ import of a scoped file is itself scoped", () => {
    const scoped = new Set(DIRECTORY_SCOPE.map((f) => f.replace(/\.(tsx?|ts)$/, "")));
    const missing: string[] = [];
    for (const file of DIRECTORY_SCOPE) {
      for (const base of localImports(file, read(file))) {
        if (!scoped.has(base) && !(base in OUT_OF_SCOPE_IMPORTS)) missing.push(`${file} imports ${base}`);
      }
    }
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
