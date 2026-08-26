// ===========================================================================
// APPLICATION TABLE ENTRYPOINTS — which tables the app opens with `.from(...)`
// ===========================================================================
//
// Codex P2 on 327b3487. Entrypoint discovery was a regex for `.from("table")`,
// so every indirect shape the repository actually uses was invisible:
//
//     .from(CLIENT_BUDGET_CONTEXT_RELATION)      a const, imported from another
//                                                module (lib/budget/queries.ts)
//     const count = (table: string) => .from(table)   a helper parameter, fed
//                                                literals at its call sites
//     softDeleteEntry(table: "a" | "b")          a parameter whose TYPE names
//                                                every table it can be
//
// A missed entrypoint does not fail loudly. It silently shrinks the closure,
// and a shrunken closure makes `dead` EASIER to claim — the one direction the
// reachability check must never drift in.
//
// This resolves the argument through the TypeScript AST rather than by widening
// the regex. Grammar, not spelling: an identifier is followed to its
// declaration, a parameter to its call sites or its string-literal-union type.
//
// FAIL CLOSED. An argument that cannot be resolved is REPORTED, not dropped.
// The dead-resource guard refuses while any relevant one is outstanding, so a
// new dynamic shape blocks a confident `dead` claim instead of quietly
// weakening one.

import ts from "typescript";

export type AppFromScan = {
  /** Every table name an application `.from(...)` can resolve to. */
  readonly tables: readonly string[];
  /** Supabase `.from(...)` arguments that could not be resolved to a name. */
  readonly unresolved: ReadonlyArray<{ readonly file: string; readonly expression: string }>;
  /** Files the parser could not read. A truncated AST hides entrypoints. */
  readonly unparsed: ReadonlyArray<{ readonly file: string; readonly detail: string }>;
};

/** Receivers whose `.from` is a JavaScript built-in, not a Supabase query. */
const NOT_SUPABASE = /^(Buffer|Array|Object|String|Number|Set|Map|WeakMap|WeakSet|Date|Promise|JSON|Math|BigInt|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|Reflect|Proxy)$/;

const MAX_ALIAS_HOPS = 8;

function isStringish(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** `supabase.storage.from("bucket")` is a bucket, not a table. */
function isStorageReceiver(receiver: ts.Expression): boolean {
  return (
    (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "storage") ||
    (ts.isIdentifier(receiver) && receiver.text === "storage")
  );
}

function receiverIsBuiltin(receiver: ts.Expression): boolean {
  return ts.isIdentifier(receiver) && NOT_SUPABASE.test(receiver.text);
}

/** The function-ish node a parameter belongs to, and that function's name. */
function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
  }
  return null;
}

function functionName(fn: ts.SignatureDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
    return fn.name && ts.isIdentifier(fn.name) ? fn.name.text : null;
  }
  // `const count = (table) => ...`
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

export function scanFromEntrypoints(
  files: ReadonlyArray<{ rel: string; code: string }>,
): AppFromScan {
  // SCRIPT KIND IS LOAD-BEARING. Parsing a .ts file as TSX reads `<T>(v: T)`
  // as an unclosed JSX tag: the parser then produces a truncated tree and every
  // `.from(...)` after that point silently disappears. That was not
  // hypothetical — it dropped two real tables
  // (appointment_policy_acknowledgements, manual_fee_charge_attempts) from
  // lib/billing/manual-fee-eligibility.ts, in the direction that makes `dead`
  // easier to claim. Parse failures are now REPORTED rather than absorbed.
  const unparsed: Array<{ file: string; detail: string }> = [];
  const sources = files.map(({ rel, code }) => {
    const sf = ts.createSourceFile(
      rel,
      code,
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const diagnostics =
      (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
      unparsed.push({
        file: rel,
        detail: `${diagnostics.length} parse diagnostic(s); first: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")}`,
      });
    }
    return { rel, sf };
  });

  // ---- pass 1: const string values, const aliases, and call-site arguments --
  //
  // Keyed by identifier NAME across the whole app, which is how an imported
  // const resolves without a type-checker. Over-approximating here can only ADD
  // reachable tables, never remove one, so it errs in the safe direction.
  const constStrings = new Map<string, Set<string>>();
  const constAliases = new Map<string, Set<string>>();
  const callArgs = new Map<string, Map<number, Set<ts.Expression>>>();

  const addTo = <V,>(m: Map<string, Set<V>>, k: string, v: V) => {
    (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
  };

  for (const { sf } of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (isStringish(node.initializer)) {
          addTo(constStrings, node.name.text, node.initializer.text);
        } else if (ts.isIdentifier(node.initializer)) {
          addTo(constAliases, node.name.text, node.initializer.text);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const byIndex =
          callArgs.get(node.expression.text) ??
          callArgs.set(node.expression.text, new Map()).get(node.expression.text)!;
        node.arguments.forEach((arg, i) => {
          (byIndex.get(i) ?? byIndex.set(i, new Set()).get(i)!).add(arg);
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /** Follow `const a = b; const b = "table"` to its string values. */
  function identifierValues(name: string, hops = 0): string[] {
    if (hops > MAX_ALIAS_HOPS) return [];
    const out = new Set<string>(constStrings.get(name) ?? []);
    for (const alias of constAliases.get(name) ?? []) {
      for (const v of identifierValues(alias, hops + 1)) out.add(v);
    }
    return [...out];
  }

  /** String-literal members of `table: "a" | "b"`. */
  function unionTypeValues(param: ts.ParameterDeclaration): string[] {
    const t = param.type;
    if (!t) return [];
    const members = ts.isUnionTypeNode(t) ? t.types : [t];
    const out: string[] = [];
    for (const m of members) {
      if (ts.isLiteralTypeNode(m) && isStringish(m.literal)) out.push(m.literal.text);
    }
    return out;
  }

  function resolve(expr: ts.Expression, depth = 0): string[] | null {
    if (depth > MAX_ALIAS_HOPS) return null;
    if (isStringish(expr)) return [expr.text];

    if (ts.isIdentifier(expr)) {
      const direct = identifierValues(expr.text);
      if (direct.length > 0) return direct;

      // A parameter: its type may enumerate the tables, and failing that its
      // call sites supply them.
      const fn = enclosingFunction(expr);
      if (fn) {
        const index = fn.parameters.findIndex(
          (p) => ts.isIdentifier(p.name) && p.name.text === expr.text,
        );
        if (index >= 0) {
          const fromType = unionTypeValues(fn.parameters[index]);
          if (fromType.length > 0) return fromType;

          const name = functionName(fn);
          const args = name ? callArgs.get(name)?.get(index) : undefined;
          if (args && args.size > 0) {
            const out = new Set<string>();
            for (const arg of args) {
              const resolved = resolve(arg, depth + 1);
              if (!resolved) return null; // one unresolvable call site poisons it
              resolved.forEach((v) => out.add(v));
            }
            return [...out];
          }
        }
      }
      return null;
    }
    return null;
  }

  // ---- pass 2: every `.from(...)` that could be a Supabase read -------------
  const tables = new Set<string>();
  const unresolved: Array<{ file: string; expression: string }> = [];

  for (const { rel, sf } of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "from" &&
        node.arguments.length > 0
      ) {
        const receiver = node.expression.expression;
        if (!receiverIsBuiltin(receiver) && !isStorageReceiver(receiver)) {
          const resolved = resolve(node.arguments[0]);
          if (resolved) {
            resolved.forEach((t) => tables.add(t));
          } else {
            unresolved.push({ file: rel, expression: node.arguments[0].getText(sf) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { tables: [...tables].sort(), unresolved, unparsed };
}
