import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// ===========================================================================
// SENTRY-IDENTITY-01 — server-rendered modules resolve identity through the
// REDIRECTING guard, and never through the throwing backstop.
// ===========================================================================
//
// lib/supabase/queries.ts has two resolvers over the same request identity:
//
//   requirePractitionerWithStudio()     REDIRECTS: anonymous -> /login,
//                                       no active membership -> /no-access,
//                                       2+ with no valid selection -> chooser
//   getCurrentPractitionerWithStudio()  THROWS on those states — the backstop
//                                       for server actions, whose try/catch
//                                       would swallow a redirect
//
// A page, layout or server component must use the redirecting one. Next renders
// a route's layouts and its page IN PARALLEL, so the shell layout's redirect
// does not stop a page from running: a page that throws on an expected identity
// state still reaches `onRequestError` (Sentry) on every full load, and on a
// soft navigation — where the shell layout is not re-rendered at all — the
// throw IS what the practitioner sees. That is the production group
// "No active practitioner found for the signed-in user." on /calendar/[id].
// A page that resolves NO identity is exposed to the same race: /clients/new
// handed a removed practitioner the new-client form.
//
// The behaviour is proved against the real page in
// tests/app/calendar/appointment-detail-identity-boundary.test.ts. This file is
// the architectural tripwire for every OTHER route, in both directions: nothing
// server-rendered calls the backstop, and every authenticated page calls the
// guard itself — no exemptions.
//
// WHAT "CALLS" MEANS HERE. A call counts only when its callee RESOLVES, through
// the module's import declarations, to the export of lib/supabase/queries: a
// named import (aliases included), or a namespace import (`q.x()`, `q["x"]()`).
// The spelling of a callee proves nothing, so a local function that merely
// shares a resolver's name resolves to nothing, and an aliased backstop is still
// the backstop. Shapes this resolution cannot see through are REPORTED, never
// guessed at: a local declaration that shadows or impersonates a resolver, a
// dynamic import of the queries module, and any re-export of either resolver
// (forbidden everywhere, so every import of one names lib/supabase/queries).
//
// STATED LIMIT. The tripwire follows import bindings, not values or call
// graphs: a helper in another module that itself calls the backstop, or that
// hands a resolver on as a value, is outside its reach. That shape is owned by
// the resolver contract in lib/supabase/queries.ts and by the behavioural test
// above, not by this file.

const ROOT = path.resolve(__dirname, "../..");
const QUERIES = "lib/supabase/queries";
const BACKSTOP = "getCurrentPractitionerWithStudio";
const GUARD = "requirePractitionerWithStudio";
const RESOLVERS = new Set([BACKSTOP, GUARD]);

// Next's server-rendered route-segment conventions. error.tsx / global-error
// are client components by definition and are excluded by their directive.
const SEGMENT_FILE = /^(page|layout|template|default|not-found|forbidden|unauthorized)\.(tsx|ts|jsx|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The module's leading directive ("use client" / "use server"), if any. */
function directive(sf: ts.SourceFile): string | null {
  for (const statement of sf.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      return statement.expression.text;
    }
    break;
  }
  return null;
}

function parse(fileName: string, source: string): ts.SourceFile {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

const lineOf = (sf: ts.SourceFile, node: ts.Node) =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Does `specifier`, written in module `rel`, name lib/supabase/queries? */
function isQueriesModule(rel: string, specifier: string): boolean {
  if (specifier === `@/${QUERIES}`) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
  return resolved === QUERIES || resolved === `${QUERIES}.ts`;
}

type Bindings = { named: Map<string, string>; namespaces: Set<string> };

/** How a module binds lib/supabase/queries: local name -> export, and namespaces. */
function queriesBindings(rel: string, sf: ts.SourceFile): Bindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (!isQueriesModule(rel, s.moduleSpecifier.text)) continue;
    const bindings = s.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else {
      for (const el of bindings.elements) {
        named.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
  }
  return { named, namespaces };
}

type ResolvedCall = { exportName: string; line: number };

/** Every call whose callee resolves, by import binding, to a queries export. */
function resolvedQueriesCalls(rel: string, sf: ts.SourceFile): ResolvedCall[] {
  const { named, namespaces } = queriesBindings(rel, sf);
  const calls: ResolvedCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let exportName: string | null = null;
      if (ts.isIdentifier(callee)) {
        exportName = named.get(callee.text) ?? null;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        exportName = callee.name.text;
      } else if (
        ts.isElementAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        ts.isStringLiteralLike(callee.argumentExpression)
      ) {
        exportName = callee.argumentExpression.text;
      }
      if (exportName) calls.push({ exportName, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

const callsTo = (rel: string, sf: ts.SourceFile, exportName: string) =>
  resolvedQueriesCalls(rel, sf)
    .filter((c) => c.exportName === exportName)
    .map((c) => c.line);

/**
 * Shapes the binding resolution cannot see through, reported (fail CLOSED):
 * a local declaration that shadows a queries import or impersonates either
 * resolver by name, and a dynamic import of the queries module.
 */
function unresolvableShapes(rel: string, sf: ts.SourceFile): string[] {
  const { named, namespaces } = queriesBindings(rel, sf);
  const watched = new Set([...named.keys(), ...namespaces, ...RESOLVERS]);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const declares =
      ts.isVariableDeclaration(node) ||
      ts.isBindingElement(node) ||
      ts.isParameter(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node);
    if (declares && node.name && ts.isIdentifier(node.name) && watched.has(node.name.text)) {
      found.push(`${rel}:${lineOf(sf, node)} declares a local "${node.name.text}"`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg) && isQueriesModule(rel, arg.text)) {
        found.push(`${rel}:${lineOf(sf, node)} imports ${QUERIES} dynamically`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** A re-export of either resolver (or of the whole queries module). */
function resolverReExports(rel: string, sf: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const s of sf.statements) {
    if (!ts.isExportDeclaration(s) || !s.moduleSpecifier) continue;
    if (!ts.isStringLiteral(s.moduleSpecifier) || !isQueriesModule(rel, s.moduleSpecifier.text)) {
      continue;
    }
    const clause = s.exportClause;
    const names =
      !clause || ts.isNamespaceExport(clause)
        ? ["*"]
        : clause.elements.map((e) => (e.propertyName ?? e.name).text);
    if (names.some((n) => n === "*" || RESOLVERS.has(n))) {
      found.push(`${rel}:${lineOf(sf, s)} re-exports ${names.join(", ")} from ${QUERIES}`);
    }
  }
  return found;
}

type Module = { rel: string; sf: ts.SourceFile };

function loadModules(dirs: string[]): Module[] {
  return dirs.flatMap((dir) =>
    walk(path.join(ROOT, dir)).map((full) => {
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      return { rel, sf: parse(rel, readFileSync(full, "utf8")) };
    }),
  );
}

const ALL = loadModules(["app", "lib", "components"]);

/**
 * Every module that renders on the server as part of a route: the segment
 * convention files, plus any .tsx module under app/ or components/ that is
 * neither a client component nor a server-action module.
 */
const MODULES = ALL.filter(({ rel, sf }) => {
  if (rel.startsWith("lib/")) return false;
  const d = directive(sf);
  if (d === "use client" || d === "use server") return false;
  const isSegment = rel.startsWith("app/") && SEGMENT_FILE.test(path.basename(rel));
  return isSegment || /\.(tsx|jsx)$/.test(rel);
});
const byRel = new Map(MODULES.map((m) => [m.rel, m]));

const isAuthenticatedPage = (rel: string) =>
  rel.startsWith("app/(app)/") && /\/page\.(tsx|ts|jsx|js)$/.test(rel);

/**
 * Authenticated pages that do not resolve identity THEMSELVES through the
 * guard. A client-component page is reported too: it cannot resolve identity
 * on the server at all.
 */
function pagesMissingGuard(modules: Module[]): string[] {
  return modules
    .filter(({ rel }) => isAuthenticatedPage(rel))
    .filter(({ rel, sf }) => directive(sf) !== null || callsTo(rel, sf, GUARD).length === 0)
    .map(({ rel }) => rel);
}

describe("server-rendered modules resolve identity through the redirecting guard", () => {
  it("no page, layout or server component calls the throwing backstop", () => {
    const offenders = MODULES.flatMap(({ rel, sf }) =>
      callsTo(rel, sf, BACKSTOP).map((line) => `${rel}:${line}`),
    );
    expect(offenders).toEqual([]);
  });

  it("every authenticated page resolves identity ITSELF with the guard — no exemptions", () => {
    // Not calling the backstop is not enough. A layout's guard does not run on
    // a soft navigation, so a page that resolves nothing renders for a
    // practitioner whose membership was removed after the middleware admitted
    // the request.
    expect(pagesMissingGuard(ALL)).toEqual([]);
  });

  it("no server-rendered module hides a binding the scan cannot resolve", () => {
    expect(MODULES.flatMap(({ rel, sf }) => unresolvableShapes(rel, sf))).toEqual([]);
  });

  it("nothing re-exports a resolver, so every import of one names lib/supabase/queries", () => {
    const offenders = ALL.filter(({ rel }) => rel !== `${QUERIES}.ts`).flatMap(({ rel, sf }) =>
      resolverReExports(rel, sf),
    );
    expect(offenders).toEqual([]);
  });

  it("the page behind the production Sentry group resolves identity with the guard", () => {
    const rel = "app/(app)/calendar/[id]/page.tsx";
    const page = byRel.get(rel);
    expect(page, "the scan must reach the incident page").toBeDefined();
    expect(callsTo(rel, page!.sf, GUARD)).toHaveLength(1);
  });

  it("the shell layout and the settings layout both use the guard", () => {
    for (const rel of ["app/(app)/layout.tsx", "app/(app)/settings/layout.tsx"]) {
      const layout = byRel.get(rel);
      expect(layout, `the scan must reach ${rel}`).toBeDefined();
      expect(callsTo(rel, layout!.sf, GUARD).length, rel).toBeGreaterThan(0);
    }
  });
});

describe("anti-vacuity: the scan sees what it claims to rule out", () => {
  const page = (source: string) => parse("page.tsx", source);
  const Q = `"@/${QUERIES}"`;

  it("covers the authenticated app's pages, not an empty set", () => {
    const appPages = ALL.filter(({ rel }) => isAuthenticatedPage(rel));
    // Floors, not pins: adding a page must not red this file.
    expect(appPages.length).toBeGreaterThan(30);
    expect(MODULES.filter(({ rel, sf }) => callsTo(rel, sf, GUARD).length > 0).length).toBeGreaterThan(30);
  });

  it("the detector RESOLVES the backstop where it is legitimately called (a server action)", () => {
    const rel = "app/(app)/calendar/[id]/manual-fee-actions.ts";
    const action = ALL.find((m) => m.rel === rel);
    expect(action, "the scan must reach the action module").toBeDefined();
    expect(directive(action!.sf)).toBe("use server");
    expect(callsTo(rel, action!.sf, BACKSTOP).length).toBeGreaterThan(0);
    // ...and that module is correctly NOT in the server-rendered set.
    expect(byRel.has(rel)).toBe(false);
  });

  it("aliased and namespaced calls resolve to the export; prose, strings and look-alikes do not", () => {
    const aliased = page(
      `import { ${BACKSTOP} as resolveIdentity } from ${Q};\n` +
        "export default async function P() { const { studio } = await resolveIdentity(); return <p>{studio.id}</p>; }",
    );
    expect(resolvedQueriesCalls("app/(app)/x/page.tsx", aliased)).toEqual([
      { exportName: BACKSTOP, line: 2 },
    ]);

    const namespaced = page(
      `import * as q from ${Q};\n` +
        `export default async function P() { await q.${BACKSTOP}(); await q["${GUARD}"](); return null; }`,
    );
    expect(resolvedQueriesCalls("app/(app)/x/page.tsx", namespaced)).toEqual([
      { exportName: BACKSTOP, line: 2 },
      { exportName: GUARD, line: 2 },
    ]);

    const prose = page(`// ${BACKSTOP}() would throw here.\nconst s = "${GUARD}()";\nexport default function P() { return <p>{s}</p>; }`);
    expect(resolvedQueriesCalls("app/(app)/x/page.tsx", prose)).toEqual([]);

    const lookAlike = page(
      `async function ${GUARD}() { return null; }\n` +
        `export default async function P() { await ${GUARD}(); return <p />; }`,
    );
    expect(resolvedQueriesCalls("app/(app)/x/page.tsx", lookAlike)).toEqual([]);
    expect(unresolvableShapes("app/(app)/x/page.tsx", lookAlike)).toEqual([
      `app/(app)/x/page.tsx:1 declares a local "${GUARD}"`,
    ]);
  });

  it("the guard rule flags a bare page, a look-alike guard and a client page; an aliased guard counts", () => {
    const at = (rel: string, source: string): Module => ({ rel, sf: page(source) });
    expect(
      pagesMissingGuard([
        at("app/(app)/bare/page.tsx", "export default function P() { return <p>form</p>; }"),
        at(
          "app/(app)/look-alike/page.tsx",
          `async function ${GUARD}() { return null; }\nexport default async function P() { await ${GUARD}(); return <p />; }`,
        ),
        at(
          "app/(app)/client/page.tsx",
          `"use client";\nimport { ${GUARD} } from ${Q};\nexport default function P() { return <p />; }`,
        ),
        at(
          "app/(app)/aliased/page.tsx",
          `import { ${GUARD} as guard } from ${Q};\nexport default async function P() { await guard(); return <p />; }`,
        ),
        // Outside the authenticated group the rule does not apply.
        at("app/book/[slug]/page.tsx", "export default function P() { return <p />; }"),
      ]),
    ).toEqual(["app/(app)/bare/page.tsx", "app/(app)/look-alike/page.tsx", "app/(app)/client/page.tsx"]);
  });

  it("shadowing and dynamic imports are reported, never guessed at", () => {
    const shadowed = page(
      `import { ${GUARD} } from ${Q};\n` +
        `export default async function P() {\n  const ${GUARD} = async () => null;\n  await ${GUARD}();\n  return null;\n}`,
    );
    expect(unresolvableShapes("app/(app)/x/page.tsx", shadowed)).toEqual([
      `app/(app)/x/page.tsx:3 declares a local "${GUARD}"`,
    ]);

    const dynamic = page(
      `export default async function P() {\n  const q = await import(${Q});\n  await q.${BACKSTOP}();\n  return null;\n}`,
    );
    expect(unresolvableShapes("app/(app)/x/page.tsx", dynamic)).toEqual([
      `app/(app)/x/page.tsx:2 imports ${QUERIES} dynamically`,
    ]);
  });

  it("a re-export of either resolver, or of the whole module, is reported; other re-exports are not", () => {
    const mod = (source: string) => parse("helper.ts", source);
    expect(resolverReExports("lib/x/helper.ts", mod(`export { ${BACKSTOP} } from ${Q};`))).toEqual([
      `lib/x/helper.ts:1 re-exports ${BACKSTOP} from ${QUERIES}`,
    ]);
    expect(resolverReExports("lib/x/helper.ts", mod(`export * from ${Q};`))).toEqual([
      `lib/x/helper.ts:1 re-exports * from ${QUERIES}`,
    ]);
    expect(resolverReExports("lib/x/helper.ts", mod(`export { getClientById } from ${Q};`))).toEqual([]);
  });

  it("relative specifiers resolve to the same module; look-alike module names do not", () => {
    expect(isQueriesModule("lib/supabase/middleware.ts", "./queries")).toBe(true);
    expect(isQueriesModule("app/(app)/x/page.tsx", "../../../lib/supabase/queries")).toBe(true);
    expect(isQueriesModule("app/(app)/x/page.tsx", `@/${QUERIES}-extra`)).toBe(false);
    expect(isQueriesModule("app/(app)/x/page.tsx", "./queries")).toBe(false);
  });

  it("client components and server-action modules are excluded by their directive", () => {
    const client = parse("x.tsx", '"use client";\nexport function X() { return null; }');
    const action = parse("y.ts", '"use server";\nexport async function y() {}');
    const plain = parse("z.tsx", "export default function Z() { return null; }");
    expect(directive(client)).toBe("use client");
    expect(directive(action)).toBe("use server");
    expect(directive(plain)).toBeNull();
  });
});
