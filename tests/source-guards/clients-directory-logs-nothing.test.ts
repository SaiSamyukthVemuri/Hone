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
// WHAT THIS GUARD DOES NOT COVER (stated so the claim matches the check; Privacy decides whether each residual matters):
//   - code built or run from strings: `eval`, `new Function(...)`, `setTimeout("...")`, `import()` of a computed path
//     that is not flagged here (a computed specifier IS a violation; the string's CONTENT is never read);
//   - sinks reached through modules OUTSIDE the clients closure (shared components, supabase clients, next, third-party
//     code the directory calls): they have their own guards, and a directory file is not judged by what they do;
//   - runtime-generated names (`Reflect.get(window, name)`, `Reflect.construct(Error, [q])`, a property name assembled at
//     run time on an object this scanner cannot resolve to a global holder), and an Error class defined outside this file;
//   - server infrastructure: the host's request logs, Vercel platform logs and browser history record the URL itself.
// Computed access to a global holder (window, globalThis, self, global, navigator, process, or any alias) is a violation
// unless the key is a string literal that is not a forbidden name: fail closed.
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

// MODULE RESOLUTION (Codex P2 #3 on #1431, the root cause of three rounds of import gaps): a module specifier is
// never judged by its spelling. Every specifier (relative, parent-relative, `@/` alias, bare, `require`, dynamic
// `import()`, `import x = require()`) is resolved to the real file TypeScript would load, with the repo's own
// tsconfig, and sinks are judged by the RESOLVED path. A relative, alias or absolute specifier that does not
// resolve is itself a violation (fail closed): the guard never guesses.
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const cfgPath = path.join(ROOT, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, ROOT).options;
})();

const SINK_PATH_RE =
  /^(lib\/logging(\/|$)|lib\/analytics(\/|$)|lib\/posthog-server$|(.*\/)?node_modules\/(@sentry\/|posthog-(js|node)(\/|$)|@vercel\/(analytics|speed-insights)(\/|$)))/;

export type ResolvedModule = { spec: string; path: string | null; local: boolean };

/** Resolve `spec` as imported from the repo-relative `file`. `path` is the repo-relative real file without its extension (or the node_modules path). */
export function resolveModule(file: string, spec: string): ResolvedModule {
  const local = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/");
  const hit = ts.resolveModuleName(spec, path.join(ROOT, file), COMPILER_OPTIONS, ts.sys).resolvedModule;
  if (!hit) return { spec, path: null, local };
  const real = ts.sys.realpath ? ts.sys.realpath(hit.resolvedFileName) : hit.resolvedFileName;
  const rel = path.relative(ROOT, real).split(path.sep).join("/").replace(/\.d\.ts$/, "").replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  return { spec, path: rel, local };
}

/** Why this specifier is a sink (or cannot be judged), or null when it is neither. */
export function sinkReason(file: string, spec: string): string | null {
  if (SINK_MODULE_RE.test(spec)) return spec; // a bare package name is a sink by its own name even when not installed
  const r = resolveModule(file, spec);
  if (r.path !== null) {
    const normalized = r.path.replace(/\/index$/, "");
    if (SINK_PATH_RE.test(r.path) || SINK_PATH_RE.test(normalized)) return `${spec} (resolves to ${r.path})`;
    return null;
  }
  return r.local ? `${spec} (cannot be resolved)` : null;
}

function kind(file: string): ts.ScriptKind {
  return file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function bindingNames(name: ts.BindingName, into: Map<string, ts.Node>, owner: ts.Node): void {
  if (ts.isIdentifier(name)) { if (!into.has(name.text)) into.set(name.text, owner); return; }
  for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, into, el);
}

/** Names declared directly in one scope node (not in nested scopes), mapped to their declaring node. */
function declaredIn(scope: ts.Node): Map<string, ts.Node> {
  const m = new Map<string, ts.Node>();
  const fromVarList = (l: ts.VariableDeclarationList) => {
    for (const d of l.declarations) {
      if (ts.isIdentifier(d.name)) m.set(d.name.text, d);
      else bindingNames(d.name, m, d); // a destructured name is never a literal const
    }
  };
  const fromStatements = (stmts: readonly ts.Statement[]) => {
    for (const st of stmts) {
      if (ts.isVariableStatement(st)) fromVarList(st.declarationList);
      else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) m.set(st.name.text, st);
      else if (ts.isImportDeclaration(st) && st.importClause) {
        const c = st.importClause;
        if (c.name) m.set(c.name.text, c);
        if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) m.set(c.namedBindings.name.text, c); else for (const e of c.namedBindings.elements) m.set(e.name.text, e); }
      }
    }
  };
  // `var` hoists to the function (or file): collect it from nested blocks, not across a function boundary.
  const hoistedVars = (n: ts.Node): void => {
    ts.forEachChild(n, (c) => {
      if (ts.isFunctionLike(c) || ts.isClassLike(c)) return;
      if (ts.isVariableDeclarationList(c) && (c.flags & ts.NodeFlags.BlockScoped) === 0) fromVarList(c);
      hoistedVars(c);
    });
  };
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) bindingNames(p.name, m, p);
    if ((ts.isFunctionExpression(scope)) && scope.name) m.set(scope.name.text, scope);
    if ("body" in scope && scope.body) hoistedVars(scope.body);
  }
  if (ts.isSourceFile(scope)) { fromStatements(scope.statements); hoistedVars(scope); }
  if (ts.isBlock(scope) || ts.isModuleBlock(scope)) fromStatements(scope.statements);
  if (ts.isCaseBlock(scope)) for (const c of scope.clauses) fromStatements(c.statements);
  if (ts.isCatchClause(scope) && scope.variableDeclaration) bindingNames(scope.variableDeclaration.name, m, scope.variableDeclaration);
  if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) fromVarList(scope.initializer);
  return m;
}

function resolveBinding(id: ts.Identifier): ts.Node | undefined {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    const hit = declaredIn(n).get(id.text);
    if (hit) return hit;
  }
  return undefined;
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
    // Resolve the identifier to the binding it actually names at this use site (Codex P2 on #1431): the NEAREST
    // enclosing scope that declares the name wins, so a parameter or inner declaration shadowing a literal
    // same-file const is that parameter, not the const. Literal only when that binding is a `const` with a
    // literal-only initializer.
    const binding = resolveBinding(expr);
    if (!binding || !ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name) || !binding.initializer) return false;
    const list = binding.parent;
    const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    return isConst && isLiteralText(binding.initializer, sf, depth + 1);
  }
  return false;
}

const ERROR_NAME_RE = /^(Error|[A-Z]\w*Error|DOMException)$/;

/** True when `expr` names an Error constructor: by name, through a same-file `const` alias, a holder property (`globalThis.Error`), or an in-file class extending one. */
function isErrorCtor(expr: ts.Expression, depth = 0): boolean {
  if (depth > 6) return false;
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isAsExpression(expr)) return isErrorCtor(expr.expression, depth + 1);
  if (ts.isPropertyAccessExpression(expr)) return ERROR_NAME_RE.test(expr.name.text) && ts.isIdentifier(expr.expression) && GLOBAL_HOLDERS.has(expr.expression.text);
  if (ts.isElementAccessExpression(expr)) return ts.isStringLiteralLike(expr.argumentExpression) && ERROR_NAME_RE.test(expr.argumentExpression.text) && ts.isIdentifier(expr.expression) && GLOBAL_HOLDERS.has(expr.expression.text);
  if (!ts.isIdentifier(expr)) return false;
  const b = resolveBinding(expr);
  if (b === undefined) return ERROR_NAME_RE.test(expr.text); // a global, or an unresolved name: judged by its name
  if (ts.isVariableDeclaration(b) && b.initializer) return isErrorCtor(b.initializer, depth + 1);
  if (ts.isClassDeclaration(b)) {
    const ext = b.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    return ext !== undefined && isErrorCtor(ext, depth + 1);
  }
  return false;
}

export function logsNothingViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind(file));
  const out: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

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
      const why = sinkReason(file, node.moduleSpecifier.text);
      if (why) out.push(`${file}:${at(node)} imports ${why}`);
    }
    // 2. `import x = require("y")`
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      const why = ts.isStringLiteralLike(e) ? sinkReason(file, e.text) : "a computed specifier";
      if (why) out.push(`${file}:${at(node)} imports ${why}`);
    }
    // 2. `require("x")` and `import("x")`
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        if (arg && ts.isStringLiteralLike(arg)) {
          const why = sinkReason(file, arg.text);
          if (why) out.push(`${file}:${at(node)} loads ${why}`);
        } else if (arg) {
          out.push(`${file}:${at(node)} loads a module by a computed specifier`);
        }
      }
    }
    // 3. sendBeacon by ANY route (Codex P2 on #1431): the name `sendBeacon` as a property, bracket key, destructured
    // key, or bare identifier; and `navigator` (or `<holder>.navigator`) used for anything but a plain
    // `.<other>` property read, so an alias, a computed key, a destructure or a pass-along cannot reach it.
    if (ts.isIdentifier(node) && node.text === "sendBeacon" && !ts.isTypeReferenceNode(node.parent)) {
      out.push(`${file}:${at(node)} references sendBeacon`);
    }
    if (ts.isStringLiteralLike(node) && (node.text === "sendBeacon" || node.text === "navigator")) {
      const p = node.parent;
      if ((ts.isElementAccessExpression(p) && p.argumentExpression === node) || (ts.isBindingElement(p) && p.propertyName === node)) {
        out.push(`${file}:${at(node)} names ${node.text} by a computed key`);
      }
    }
    if (ts.isIdentifier(node) && node.text === "navigator") {
      const p = node.parent;
      const isKey = ts.isPropertyAssignment(p) && p.name === node;
      const isMemberName = (ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === node;
      const isTypePosition = ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p);
      if (!isKey && !isMemberName && !isTypePosition) {
        const ref: ts.Node = ts.isPropertyAccessExpression(p) && p.name === node ? p : node;
        const rp = ref.parent;
        const plainRead = ts.isPropertyAccessExpression(rp) && rp.expression === ref && rp.name.text !== "sendBeacon";
        if (!plainRead) out.push(`${file}:${at(node)} uses navigator other than a plain property read`);
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
    // 5. error text must be literal: every CALL of an Error constructor, with or without `new`, is error construction
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && isErrorCtor(node.expression)) {
      for (const a of node.arguments ?? []) {
        if (!ts.isExpression(a) || !isLiteralText(a, sf)) out.push(`${file}:${at(node)} builds ${node.expression.getText(sf)} text from a non-literal`);
      }
    }
    if (ts.isThrowStatement(node)) {
      const e = node.expression;
      const isErr = (ts.isNewExpression(e) || ts.isCallExpression(e)) && isErrorCtor(e.expression);
      if (!isErr) out.push(`${file}:${at(node)} throws something other than a new ...Error(literal)`);
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
      if (!ts.isStringLiteralLike(a) || FORBIDDEN_GLOBALS.has(a.text) || a.text === "process" || a.text === "navigator") {
        out.push(`${file}:${at(node)} reaches a global through ${node.expression.getText(sf)}[...]`);
      }
    }
    // Destructuring a global holder, in every position it can occur: a declaration, a parameter default, an assignment.
    // Any computed key is a violation unless it is a string literal that is not a forbidden name (fail closed).
    const badKey = (k: string) => FORBIDDEN_GLOBALS.has(k) || k === "process" || k === "navigator";
    const checkKey = (nameNode: ts.PropertyName | undefined, localName: ts.Node | undefined, rest: boolean, src: ts.Expression, at2: ts.Node): void => {
      let key = "";
      if (nameNode && ts.isComputedPropertyName(nameNode)) {
        const inner = nameNode.expression;
        if (!ts.isStringLiteralLike(inner)) { out.push(`${file}:${at(at2)} destructures a computed key from ${src.getText(sf)}`); return; }
        key = inner.text;
      } else if (nameNode && (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode))) key = nameNode.text;
      else if (localName && ts.isIdentifier(localName)) key = localName.text;
      if (badKey(key) || (rest && !GLOBAL_HOLDERS.has(key))) out.push(`${file}:${at(at2)} destructures ${key || "..."} from ${src.getText(sf)}`);
    };
    const checkBinding = (pattern: ts.ObjectBindingPattern, src: ts.Expression): void => {
      for (const el of pattern.elements) checkKey(el.propertyName, el.name, !!el.dotDotDotToken, src, el);
    };
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer && ts.isObjectBindingPattern(node.name) && isHolderExpr(node.initializer)) {
      checkBinding(node.name, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isHolderExpr(node.right)) {
      let left: ts.Expression = node.left;
      while (ts.isParenthesizedExpression(left)) left = left.expression;
      if (ts.isObjectLiteralExpression(left)) {
        for (const prop of left.properties) {
          if (ts.isPropertyAssignment(prop)) checkKey(prop.name, ts.isIdentifier(prop.initializer) ? prop.initializer : undefined, false, node.right, prop);
          else if (ts.isShorthandPropertyAssignment(prop)) checkKey(prop.name, prop.name, false, node.right, prop);
          else if (ts.isSpreadAssignment(prop)) checkKey(undefined, undefined, true, node.right, prop);
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
    // Resolve with the repo's tsconfig; fall back to the syntactic base only when TypeScript cannot resolve it.
    let base: string | null = resolveModule(file, s).path;
    if (base === null) {
      if (s.startsWith("./") || s.startsWith("../")) base = path.posix.normalize(path.posix.join(path.posix.dirname(file), s));
      else if (s.startsWith("@/")) base = path.posix.normalize(s.slice(2));
    }
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
    // Codex P2 #3: resolve before judging
    "relative import of the safe logger": 'import { safeLog } from "../logging/safe-log"; export const f = (q: string) => safeLog.info(q);',
    "parent-relative import of the safe logger": 'import { safeLog } from "../../lib/logging/safe-log"; export const f = (q: string) => safeLog.info(q);',
    "relative import of the analytics boundary": 'import { track } from "../analytics/server"; export const f = (q: string) => track(q);',
    "relative import of posthog-server": 'import { x } from "../posthog-server"; export const f = () => x;',
    "alias import of the safe logger by file": 'import { safeLog } from "@/lib/logging/safe-log"; export const f = (q: string) => safeLog.info(q);',
    "alias import of the logging folder index": 'import * as L from "@/lib/logging"; export const f = () => L;',
    "relative import with an explicit extension": 'import { safeLog } from "../logging/safe-log.ts"; export const f = (q: string) => safeLog.info(q);',
    "relative require of a sink": 'const s = require("../logging/safe-log"); export const f = (q: string) => s.safeLog.info(q);',
    "relative dynamic import of a sink": 'export const f = async () => (await import("../analytics/server")).track;',
    "import-equals require of a sink": 'import S = require("@sentry/nextjs"); export const f = (e: unknown) => S.captureException(e);',
    "re-export of a relative sink": 'export { safeLog } from "../logging/safe-log";',
    "bare sentry subpath import": 'import { captureException } from "@sentry/nextjs/dist/index"; export const f = (e: unknown) => captureException(e);',
    "computed require specifier": 'export const f = (m: string) => require(m);',
    "computed dynamic import": 'export const f = (m: string) => import(m);',
    "an alias import that does not resolve": 'import { x } from "@/lib/does-not-exist-anywhere"; export const f = () => x;',
    "a relative import that does not resolve": 'import { x } from "./nope"; export const f = () => x;',
    // Codex P2 #4 classes: computed keys on a holder, and Error called without `new`
    "computed destructuring key": 'const key = "fetch"; const { [key]: send } = window; export const f = (q: string) => send("/x", { body: q });',
    "computed destructuring key from an alias": 'const g = globalThis; const k = "con" + "sole"; const { [k]: c } = g; export const f = (q: string) => c.log(q);',
    "computed destructuring key, literal forbidden": 'const { ["fetch"]: send } = window; export const f = (q: string) => send("/x", { body: q });',
    "computed key in a parameter default": 'const key = "fetch"; export const f = ({ [key]: send } = window) => send("/x");',
    "computed key in an assignment destructure": 'let send: unknown; const key = "fetch"; ({ [key]: send } = window); export const f = () => send;',
    "rest destructure of a holder": 'const { location, ...others } = window; export const f = () => [location, others];',
    "parameter default destructure of fetch": 'export const f = ({ fetch: send } = window) => send;',
    "assignment destructure of fetch": 'let send: unknown; ({ fetch: send } = window); export const f = () => send;',
    "shorthand assignment destructure of fetch": 'let fetch2: unknown; ({ fetch: fetch2 } = globalThis); export const f = () => fetch2;',
    "computed element key on a holder alias": 'const w = self; export const f = (k: string) => w[k];',
    "navigator by literal key on a holder": 'export const f = () => window["navigator"];',
    "Error called without new": 'export const f = (q: string) => Promise.reject(Error(q));',
    "TypeError called without new": 'export const f = (q: string) => TypeError(q);',
    "throw of an Error call with the term": 'export const f = (q: string) => { throw Error(`no ${q}`); };',
    "Error alias called": 'const E = Error; export const f = (q: string) => E(q);',
    "Error alias constructed": 'const E = TypeError; export const f = (q: string) => new E(q);',
    "holder Error called": 'export const f = (q: string) => globalThis.Error(q);',
    "holder Error constructed": 'export const f = (q: string) => new window.RangeError(q);',
    "class extending Error with the term": 'class MyFailure extends Error {} export const f = (q: string) => new MyFailure(q);',
    "class extending an Error alias": 'const B = Error; class MyFailure extends B {} export const f = (q: string) => MyFailure(q);',
    "DOMException with the term": 'export const f = (q: string) => new DOMException(q);',
    "AggregateError with the term": 'export const f = (q: string) => new AggregateError([], q);',
    "throw of an Error call alias": 'const E = Error; export const f = (q: string) => { throw E(q); };',
    "parameter shadowing a literal const": 'const msg = "Failed to load"; export const f = (msg: string) => { throw new Error(msg); };',
    "inner const shadowing a literal const": 'const msg = "Failed"; export const f = (q: string) => { { const msg = q; throw new Error(msg); } };',
    "catch variable shadowing a literal const": 'const e = "Failed"; export const f = () => { try { return 1; } catch (e) { throw new Error(e as string); } };',
    "destructured parameter shadowing a literal const": 'const msg = "Failed"; export const f = ({ msg }: { msg: string }) => { throw new Error(msg); };',
    "sendBeacon bracket key": 'export const f = (q: string) => navigator["sendBeacon"]("/x", q);',
    "sendBeacon computed key": 'export const f = (q: string) => navigator["send" + "Beacon"]("/x", q);',
    "navigator alias": 'const n = navigator; export const f = (q: string) => n.sendBeacon("/x", q);',
    "navigator alias with computed key": 'const n = navigator; export const f = (k: string, q: string) => n[k]("/x", q);',
    "sendBeacon taken as a value": 'const b = navigator.sendBeacon; export const f = (q: string) => b("/x", q);',
    "sendBeacon destructured": 'const { sendBeacon } = navigator; export const f = (q: string) => sendBeacon("/x", q);',
    "sendBeacon destructured and renamed": 'const { sendBeacon: s } = navigator; export const f = (q: string) => s("/x", q);',
    "window.navigator alias": 'const n = window.navigator; export const f = (q: string) => n.sendBeacon("/x", q);',
    "navigator via a holder bracket": 'export const f = (q: string) => window["navigator"].sendBeacon("/x", q);',
    "navigator destructured from a holder": 'const { navigator: n } = window; export const f = (q: string) => n.sendBeacon("/x", q);',
    "navigator passed along": 'const use = (n: unknown) => n; export const f = () => use(navigator);',
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
    "a literal const read from an inner scope that does not shadow it": 'const msg = "Failed to load"; export const f = (q: string) => { if (q) { throw new Error(msg); } return q; };',
    "an unrelated parameter beside a literal const": 'const msg = "Failed"; export const f = (q: string) => { if (q) return q; throw new Error(msg); };',
    "a plain navigator property read": 'export const ua = () => navigator.userAgent; export const l = () => window.navigator.language;',
    "a relative import of a sibling clients module": 'import { matchesDirectoryQuery } from "./directory-search"; export const m = matchesDirectoryQuery;',
    "a parent-relative import of a harmless shared module": 'import { createClient } from "../supabase/server"; export const c = createClient;',
    "an import-equals of a harmless package": 'import path = require("node:path"); export const j = path.join;',
    "a literal Error called without new": 'export const f = () => { throw Error("Failed to load clients"); };',
    "a literal Error alias": 'const E = TypeError; export const f = () => new E("Failed to load");',
    "a class extending Error with a literal": 'class MyFailure extends Error {} export const f = () => { throw new MyFailure("Failed to load clients"); };',
    "a function merely named like an error check": 'const isError = (x: unknown) => x instanceof Error; export const f = (q: unknown) => isError(q);',
    "a literal computed destructuring key that is not forbidden": 'const { ["location"]: loc } = window; export const f = () => loc.hash;',
    "a literal element key on a holder": 'export const f = () => window["location"].hash;',
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
