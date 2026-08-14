import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// ===========================================================================
// SYNTAX-AWARE Supabase write census (Chloe Session 1A amendment)
// ===========================================================================
//
// WHY THIS EXISTS. The first version of the `skin_notes` retirement guard was
// named "the whole app tree has ZERO skin_notes write expressions" but looped
// over FIVE hand-listed files. That name was false: a writer added to any other
// server action, an onboarding helper, an import path, a script, middleware, or
// behind a variable table expression would have survived while the test stayed
// green. A census is only worth its name if it walks the tree.
//
// It is also the same failure mode this repository has already been bitten by
// twice, a static guard that matched only the shapes it happened to think of,
// reported zero, and was believed. So this analyzer:
//
//   * walks the real runtime tree (app, lib, components, scripts, middleware);
//   * parses with the TypeScript compiler API, not proximity regexes;
//   * resolves the table expression AND the DML payload through same-scope
//     bindings, so `const patch = { skin_notes }` is caught as readily as an
//     inline object literal;
//   * FAILS CLOSED. Anything it cannot resolve, a computed table, a spread it
//     cannot follow, a chained factory receiver, a conditional or template
//     target, an opaque helper-returned patch, is reported as UNRESOLVED
//     rather than skipped. Silence is never treated as absence.
//
// Reads are untouched: `.select(...)`, display, exports and type declarations
// are not writes and are not reported.

const REPO_ROOT = join(__dirname, "..", "..", "..");

/** Runtime source roots. Tests, generated output and docs are excluded. */
const ROOTS = ["app", "lib", "components", "scripts"] as const;
const ROOT_FILES = ["middleware.ts"] as const;
const EXTENSIONS = [".ts", ".tsx", ".mjs"] as const;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "__generated__",
]);

export function runtimeSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!EXTENSIONS.some((e) => name.endsWith(e))) continue;
      // Never census the tests themselves, a fixture string in a guard is not
      // a runtime writer.
      const rel = relative(REPO_ROOT, full).split("\\").join("/");
      if (rel.startsWith("tests/") || rel.includes(".test.") || rel.includes(".spec.")) {
        continue;
      }
      out.push(full);
    }
  };
  for (const r of ROOTS) walk(join(REPO_ROOT, r));
  for (const f of ROOT_FILES) {
    try {
      statSync(join(REPO_ROOT, f));
      out.push(join(REPO_ROOT, f));
    } catch {
      /* absent is fine */
    }
  }
  return out;
}

export type WriteOp = "insert" | "update" | "upsert" | "delete";

export type WriteSite = {
  file: string;
  fn: string;
  line: number;
  table: string; // resolved table name, or the raw expression text
  /** False when `table` is the RAW expression text rather than a literal. */
  tableResolved: boolean;
  op: WriteOp;
  /** Column names the analyzer could resolve in the payload. */
  columns: string[];
  /** Set when some part of the site could not be resolved. */
  unresolved: string | null;
};

const DML = new Set<string>(["insert", "update", "upsert", "delete"]);

function sourceFileFor(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Nearest enclosing named function/method/arrow-const, for reporting. */
function enclosingName(node: ts.Node): string {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      cur.parent &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
    cur = cur.parent;
  }
  return "(top-level)";
}

/**
 * Resolve an identifier to its single initializer within the same source file.
 * Deliberately conservative: multiple declarations, or a re-assignment, yield
 * undefined so the caller reports UNRESOLVED rather than guessing.
 */
function resolveBinding(
  sf: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  const hits: ts.Expression[] = [];
  let reassigned = false;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      hits.push(n.initializer);
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === name
    ) {
      reassigned = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (reassigned || hits.length !== 1) return undefined;
  return hits[0];
}

/** The literal table name for a `.from(x)` argument, or null when unresolvable. */
function resolveTable(
  sf: ts.SourceFile,
  arg: ts.Expression | undefined,
): { table: string | null; raw: string } {
  if (!arg) return { table: null, raw: "(missing)" };
  const raw = arg.getText(sf);
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { table: arg.text, raw };
  }
  if (ts.isIdentifier(arg)) {
    const init = resolveBinding(sf, arg.text);
    if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
      return { table: init.text, raw };
    }
    return { table: null, raw };
  }
  return { table: null, raw };
}

/**
 * Column names in a DML payload. `resolved` is false when any part of the
 * payload could not be followed (a spread of an opaque value, a computed key,
 * a helper call, a conditional).
 */
function resolvePayloadColumns(
  sf: ts.SourceFile,
  arg: ts.Expression | undefined,
  depth = 0,
): { columns: string[]; resolved: boolean } {
  if (!arg) return { columns: [], resolved: true }; // e.g. .delete()
  if (depth > 6) return { columns: [], resolved: false };

  if (ts.isParenthesizedExpression(arg)) {
    return resolvePayloadColumns(sf, arg.expression, depth + 1);
  }
  if (ts.isAsExpression(arg) || ts.isSatisfiesExpression(arg)) {
    return resolvePayloadColumns(sf, arg.expression, depth + 1);
  }

  if (ts.isIdentifier(arg)) {
    const init = resolveBinding(sf, arg.text);
    if (!init) return { columns: [], resolved: false };
    return resolvePayloadColumns(sf, init, depth + 1);
  }

  // `xs.map(cb)`: the inserted rows are whatever the callback returns.
  if (
    ts.isCallExpression(arg) &&
    ts.isPropertyAccessExpression(arg.expression) &&
    arg.expression.name.text === "map" &&
    arg.arguments.length >= 1
  ) {
    const cb = arg.arguments[0];
    if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
      const body = cb.body;
      if (ts.isBlock(body)) {
        const ret = body.statements.find(ts.isReturnStatement);
        if (ret?.expression) {
          return resolvePayloadColumns(sf, ret.expression, depth + 1);
        }
        return { columns: [], resolved: false };
      }
      return resolvePayloadColumns(sf, body, depth + 1);
    }
    return { columns: [], resolved: false };
  }

  // A CONDITIONAL payload/spread: both branches can write, so the safe answer
  // is the UNION of the two. Resolved only when BOTH branches resolve.
  if (ts.isConditionalExpression(arg)) {
    const a = resolvePayloadColumns(sf, arg.whenTrue, depth + 1);
    const b = resolvePayloadColumns(sf, arg.whenFalse, depth + 1);
    return {
      columns: [...a.columns, ...b.columns],
      resolved: a.resolved && b.resolved,
    };
  }

  // A call to a SAME-REPO helper that builds the patch. One import hop, and
  // only when the helper returns a plain object literal, anything else stays
  // unresolved. This is what makes "helper-returned patch object" provable
  // instead of merely refused.
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
    const helper = resolveImportedFunctionReturn(sf, arg.expression.text);
    if (helper) return resolvePayloadColumns(helper.sf, helper.expr, depth + 1);
    // Same-file helper?
    const local = localFunctionReturn(sf, arg.expression.text);
    if (local) return resolvePayloadColumns(sf, local, depth + 1);
    return { columns: [], resolved: false };
  }

  if (ts.isArrayLiteralExpression(arg)) {
    const cols: string[] = [];
    let ok = true;
    for (const el of arg.elements) {
      const r = resolvePayloadColumns(sf, el, depth + 1);
      cols.push(...r.columns);
      ok = ok && r.resolved;
    }
    return { columns: cols, resolved: ok };
  }

  if (ts.isObjectLiteralExpression(arg)) {
    const cols: string[] = [];
    let ok = true;
    for (const prop of arg.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const r = resolvePayloadColumns(sf, prop.expression, depth + 1);
        cols.push(...r.columns);
        ok = ok && r.resolved;
        continue;
      }
      const nameNode = (prop as ts.PropertyAssignment | ts.ShorthandPropertyAssignment)
        .name;
      if (!nameNode) {
        ok = false;
        continue;
      }
      if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) {
        cols.push(nameNode.text);
      } else {
        // Computed key: cannot know what column this writes.
        ok = false;
      }
    }
    return { columns: cols, resolved: ok };
  }

  // Call result, conditional, await, template, not followable.
  return { columns: [], resolved: false };
}

/** The single `return <objectLiteral>` of a function declared in THIS file. */
function localFunctionReturn(
  sf: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      const ret = n.body.statements.find(ts.isReturnStatement);
      if (ret?.expression) found = ret.expression;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Follow ONE import hop to a same-repo module and return that function's
 * returned expression. Only `@/`-rooted specifiers are followed; a node_modules
 * import is left unresolved on purpose.
 */
function resolveImportedFunctionReturn(
  sf: ts.SourceFile,
  name: string,
): { sf: ts.SourceFile; expr: ts.Expression } | undefined {
  let spec: string | undefined;
  const visit = (n: ts.Node) => {
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.importClause?.namedBindings &&
      ts.isNamedImports(n.importClause.namedBindings)
    ) {
      for (const el of n.importClause.namedBindings.elements) {
        if (el.name.text === name) spec = (n.moduleSpecifier as ts.StringLiteral).text;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!spec || !spec.startsWith("@/")) return undefined;

  const base = join(REPO_ROOT, spec.slice(2));
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    const candidate = `${base}${ext}`;
    try {
      statSync(candidate);
    } catch {
      continue;
    }
    const target = sourceFileFor(candidate);
    const expr = localFunctionReturn(target, name);
    if (expr) return { sf: target, expr };
    return undefined;
  }
  return undefined;
}

/**
 * Every Supabase DML site in the runtime tree, with the table and payload
 * resolved where possible. Walks the `.from(...)....insert(...)` chain through
 * the AST rather than by text proximity.
 */
export function supabaseWriteSites(): WriteSite[] {
  const sites: WriteSite[] = [];

  for (const file of runtimeSourceFiles()) {
    const sf = sourceFileFor(file);
    const rel = relative(REPO_ROOT, file).split("\\").join("/");

    const visit = (node: ts.Node) => {
      // Match `<expr>.<op>(<payload>)` where `<expr>` contains a `.from(...)`
      // earlier in the SAME call chain.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        DML.has(node.expression.name.text)
      ) {
        const op = node.expression.name.text as WriteOp;

        // Walk back down the chain looking for `.from(...)`.
        let cur: ts.Node = node.expression.expression;
        let fromCall: ts.CallExpression | null = null;
        while (cur) {
          if (
            ts.isCallExpression(cur) &&
            ts.isPropertyAccessExpression(cur.expression) &&
            cur.expression.name.text === "from"
          ) {
            fromCall = cur;
            break;
          }
          if (ts.isCallExpression(cur)) {
            cur = cur.expression;
            continue;
          }
          if (ts.isPropertyAccessExpression(cur)) {
            cur = cur.expression;
            continue;
          }
          break;
        }

        if (fromCall) {
          const { table, raw } = resolveTable(sf, fromCall.arguments[0]);
          const payload = resolvePayloadColumns(sf, node.arguments[0]);
          const unresolvedParts: string[] = [];
          if (table === null) unresolvedParts.push(`table expression \`${raw}\``);
          if (!payload.resolved) {
            unresolvedParts.push(
              `payload \`${node.arguments[0]?.getText(sf).slice(0, 80) ?? "(none)"}\``,
            );
          }
          sites.push({
            file: rel,
            fn: enclosingName(node),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            table: table ?? raw,
            tableResolved: table !== null,
            op,
            columns: payload.columns,
            unresolved: unresolvedParts.length
              ? unresolvedParts.join(" and ")
              : null,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return sites;
}

/**
 * Sites that write `column` on `table`, PLUS every site the analyzer could not
 * fully resolve that could plausibly be such a write. Fail-closed by design:
 * a caller asserts this is empty, so an unresolvable shape is a failure, not a
 * silent pass.
 */
export function writesToColumn(
  table: string,
  column: string,
): { definite: WriteSite[]; unresolved: WriteSite[] } {
  const all = supabaseWriteSites();
  const writes = all.filter((s) => s.op !== "delete");

  // Could this site be targeting the table in question? A RESOLVED name answers
  // it exactly; an UNRESOLVED table could be anything, including this one.
  //
  // This used to ask whether the raw expression text "looked like" a table name,
  // and a one-letter parameter (`.from(t)`) passes that shape test, so a
  // variable table target writing skin_notes slipped straight through. The
  // negative control caught it. Resolution is now tracked explicitly.
  const mayTargetTable = (s: WriteSite) => !s.tableResolved || s.table === table;

  // DEFINITE: the payload NAMES the column, on a site that may target the table.
  const definite = writes.filter(
    (s) => mayTargetTable(s) && s.columns.includes(column),
  );

  // UNRESOLVED: we could not read the payload, so we cannot prove the column is
  // absent from it.
  //
  // A site whose PAYLOAD is fully resolved and does NOT name the column is safe
  // even when its table is unknown, a statement cannot write a column it never
  // mentions. That is what lets the reviewed `softDeleteEntry` writer
  // (`.from(table).update({ deleted_at, deleted_by, delete_reason })`, table a
  // closed two-member union) pass without weakening anything: its columns are
  // known, and none of them is this one.
  const payloadUnreadable = (s: WriteSite) =>
    s.unresolved !== null && /payload/.test(s.unresolved);

  const unresolved = writes.filter(
    (s) => mayTargetTable(s) && payloadUnreadable(s),
  );

  return { definite, unresolved };
}

/** Human-readable failure text naming file, function, op and unresolved shape. */
export function describeSites(sites: WriteSite[]): string {
  return sites
    .map(
      (s) =>
        `  ${s.file}:${s.line} in ${s.fn}(), .from(${s.table}).${s.op}(` +
        `${s.columns.length ? s.columns.join(", ") : "…"})` +
        (s.unresolved ? `  [UNRESOLVED: ${s.unresolved}]` : ""),
    )
    .join("\n");
}

// ===========================================================================
// IMPORT-SOURCE + RECEIVER PROOFS (Chloe Session 1A amendment)
// ===========================================================================
//
// A guard that asserts `!src.includes("createAdminClient")` proves nothing
// about where a factory came from. This evades it completely:
//
//     import { createAdminClient as createClient } from "@/lib/supabase/admin-server";
//
// So these read the import graph and the receiver's data flow instead of the
// file's characters.

export type ClientFactoryProof = {
  /** Local binding used in the file, e.g. `createClient`. */
  localName: string | null;
  /** The name as EXPORTED by the source module (differs under an alias). */
  importedName: string | null;
  /** The module it was imported from. */
  moduleSpecifier: string | null;
};

/** Resolve where the Supabase client factory used by a module actually comes from. */
export function clientFactoryProof(relFile: string): ClientFactoryProof {
  const sf = sourceFileFor(join(REPO_ROOT, relFile));
  let proof: ClientFactoryProof = {
    localName: null,
    importedName: null,
    moduleSpecifier: null,
  };
  const visit = (n: ts.Node) => {
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.importClause?.namedBindings &&
      ts.isNamedImports(n.importClause.namedBindings)
    ) {
      for (const el of n.importClause.namedBindings.elements) {
        // `propertyName` is set only when aliased: `{ exported as local }`.
        const exported = el.propertyName?.text ?? el.name.text;
        if (/^create(Admin)?Client$/.test(exported) || /^create(Admin)?Client$/.test(el.name.text)) {
          proof = {
            localName: el.name.text,
            importedName: exported,
            moduleSpecifier: (n.moduleSpecifier as ts.StringLiteral).text,
          };
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return proof;
}

export type AdminImport = { kind: string; local: string; from: string };

/**
 * Every import of a service-role/admin client module, in ANY form: named,
 * aliased, default, namespace or dynamic. Empty means the module cannot obtain
 * a privileged client at all.
 */
export function adminModuleImports(
  relFile: string,
  adminModules: readonly string[] = [
    "@/lib/supabase/admin-server",
    "@/lib/supabase/admin",
    "@/lib/supabase/service-role",
  ],
): AdminImport[] {
  const sf = sourceFileFor(join(REPO_ROOT, relFile));
  const hits: AdminImport[] = [];
  const isAdmin = (spec: string) =>
    adminModules.includes(spec) || /admin|service[-_]?role/i.test(spec);

  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      if (isAdmin(spec)) {
        const clause = n.importClause;
        if (!clause) hits.push({ kind: "side-effect", local: "-", from: spec });
        if (clause?.name) {
          hits.push({ kind: "default", local: clause.name.text, from: spec });
        }
        const nb = clause?.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          hits.push({ kind: "namespace", local: nb.name.text, from: spec });
        }
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            hits.push({
              kind: el.propertyName ? "named-aliased" : "named",
              local: el.name.text,
              from: spec,
            });
          }
        }
      }
    }
    // `await import("...")`
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0]) &&
      isAdmin((n.arguments[0] as ts.StringLiteral).text)
    ) {
      hits.push({
        kind: "dynamic",
        local: "-",
        from: (n.arguments[0] as ts.StringLiteral).text,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

export type ReceiverProof = {
  /** Identifier the `.from(table).insert(...)` chain hangs off. */
  receiver: string | null;
  /** The function called to create it, e.g. `createClient`. */
  initializerCallee: string | null;
  /** True if that binding is assigned again anywhere in the file. */
  reassigned: boolean;
  /** Every distinct Supabase-client factory invoked in the module. */
  distinctClientFactories: string[];
};

/** Prove the INSERT on `table` hangs off the authenticated client, unreassigned. */
export function insertReceiverProof(
  relFile: string,
  table: string,
): ReceiverProof {
  const sf = sourceFileFor(join(REPO_ROOT, relFile));
  let receiver: string | null = null;

  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "insert"
    ) {
      // Walk down to `.from(table)` and take ITS receiver.
      let cur: ts.Node = n.expression.expression;
      while (cur) {
        if (
          ts.isCallExpression(cur) &&
          ts.isPropertyAccessExpression(cur.expression) &&
          cur.expression.name.text === "from"
        ) {
          const arg = cur.arguments[0];
          if (arg && ts.isStringLiteral(arg) && arg.text === table) {
            const base = cur.expression.expression;
            // An identifier receiver is provable; a chained factory call
            // (`createAdminClient().from(...)`) deliberately is not.
            receiver = ts.isIdentifier(base) ? base.text : `(${base.getText(sf)})`;
          }
          break;
        }
        if (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) {
          cur = cur.expression;
          continue;
        }
        break;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  let initializerCallee: string | null = null;
  let reassigned = false;
  const factories = new Set<string>();

  const visit2 = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let init: ts.Expression = n.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
        const callee = init.expression.text;
        if (/^create(Admin)?Client$/.test(callee)) {
          factories.add(callee);
          if (n.name.text === receiver) initializerCallee = callee;
        }
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === receiver
    ) {
      reassigned = true;
    }
    ts.forEachChild(n, visit2);
  };
  visit2(sf);

  return {
    receiver,
    initializerCallee,
    reassigned,
    distinctClientFactories: [...factories].sort(),
  };
}
