import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// MSG-LOG-RAW-ERROR (R1). SOURCE CONTRACT over app/, lib/ and components/:
// a thrown Error's message never embeds the text of another error.
//
// Why a throw is a log line. Next prints an uncaught server error, message and
// stack, to stderr, which is Vercel's runtime log, a third party. #1138 closed
// the log CALLS; this closes the other way text leaves: a database or provider
// message interpolated into `new Error(...)`. A Postgres message can quote the
// value it rejected (`invalid input syntax for type uuid: "<text>"`), and a
// provider message can quote the request. Write the closed form instead:
// `dbErrorCode(x)` for a database error, `thrownErrorClass(x)` for anything
// caught.
//
// WHAT IS BANNED: the first argument of Error, TypeError, RangeError,
// SyntaxError, EvalError or URIError (called or `new`ed) carrying another
// error's text: a `.message`, `.details`, `.hint` or `.stack` read; an
// error-like value written whole (a template span, `+`, `String(x)`,
// `x.toString()`, `JSON.stringify(x)`, a bare `new Error(err)`); or a local that
// was LAUNDERED from either (`const raw = e.message; new Error(raw)`, a
// destructured `{ message }`). `.code` is not banned: it is the SQLSTATE the
// caller may branch on, and dbErrorCode() already validates its shape. The
// rules, and their limits, are documented on throwTextViolations().
//
// WHAT IS NOT: a throw that carries its own fixed sentence, a rethrow of a
// caught value (`throw err`; its text is whatever its source wrote, and the
// sources are covered here), and `new Error` outside this tree.
//
// ALLOWLIST (each entry needs a reason; this list is meant to stay short):
const ALLOWED: Record<string, string> = {
  "lib/logging/safe-log.ts":
    "builds the COPY safeLog logs, from scrubText(value.message): it is the redactor, not a thrower",
};

const ERROR_NAME_RE = /^(e|err|error|exception|ex|thrown|caught|\w+Err|\w+Error)$/;
// A PROPERTY is error-like only by an exact name: `res.error`, never
// `options.genericError` (a constant sentence). And a bare `res.error` handed
// straight to the constructor is not flagged (validation results carry fixed
// sentences in `.error`); it is flagged once wrapped (template, String(),
// toString(), JSON.stringify()).
const ERROR_PROP_RE = /^(e|err|error|exception|thrown|caught)$/;
const TEXT_PROPS = new Set(["message", "details", "hint", "stack"]);
const CLOSED = /^(dbErrorCode|dbFailureCode|thrownErrorClass|failureCode|safeDbCode)$/;
// A closed helper is closed only for the arguments it validates. These return
// an argument UNCHANGED in some case, so that argument is still scanned:
//   dbErrorCode(error, internal)        returns a code found in `internal`;
//   failureCode(error, result, fallback) returns `fallback` when neither the
//                                        error nor a valid result is present.
// Every other helper in lib/logging/error-class.ts was read: dbFailureCode and
// safeDbCode return a fixed label or a shape-validated code; thrownErrorClass
// returns a member of a closed enum; stripeErrorFields returns validated
// fields (and is not a string); boundedErrorLabel is not in CLOSED at all, so a
// `.message` inside it is flagged like any other.
const PASS_THROUGH: Record<string, readonly number[]> = { dbErrorCode: [1], failureCode: [2] };
const ERROR_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "EvalError", "URIError"]);

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/**
 * Rules (each has a RED and a GREEN control below). In the first argument of an
 * Error constructor, called or `new`ed, for Error, TypeError, RangeError,
 * SyntaxError, EvalError and URIError:
 *   1. a `.message`, `.details`, `.hint` or `.stack` read off anything;
 *   2. an error-like value written whole: a template span, a concatenation
 *      operand, `String(x)`, `x.toString()`, `JSON.stringify(x)`, where x is an
 *      error-like identifier or a property named like an error (`res.error`);
 *   3. LAUNDERING: a local whose initializer is tainted by 1 or 2 (or by a
 *      destructuring of an error-like value's text), used in the argument. This
 *      is name-based and file-wide on purpose: it can over-flag a reused name,
 *      never under-flag one.
 * Error-like: ERROR_NAME_RE, a catch binding, a `.catch` callback parameter, or
 * the `error` of a destructuring under any alias. The closed forms
 * (dbErrorCode and friends) end the walk: they are the way out.
 */
export function throwTextViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];

  // Pass 1: names that are errors in this file.
  const errorNames = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isCatchClause(n) && n.variableDeclaration) bindingNames(n.variableDeclaration.name, errorNames);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch") {
      for (const a of n.arguments) if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0]) bindingNames(a.parameters[0].name, errorNames);
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
        if (prop === "error") bindingNames(el.name, errorNames);
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const errorLike = (name: string) => errorNames.has(name) || ERROR_NAME_RE.test(name);

  // The shared walk. `tainted` is the set of laundered locals (pass 2).
  const tainted = new Set<string>();
  function scan(node: ts.Node, leaf: boolean, found: string[], direct = false): void {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
      return scan(node.expression, leaf, found, direct);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (CLOSED.test(callee)) {
        // the way out, for its closed arguments only
        for (const i of PASS_THROUGH[callee] ?? []) if (node.arguments[i]) scan(node.arguments[i], true, found, true);
        return;
      }
      if (callee === "String" || callee === "JSON.stringify" || /(^|\.)inspect$/.test(callee)) {
        for (const a of node.arguments) scan(a, true, found);
        return;
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toString") {
        scan(node.expression.expression, true, found);
        return;
      }
      ts.forEachChild(node, (c) => scan(c, false, found));
      return;
    }
    if (ts.isTemplateExpression(node)) return void node.templateSpans.forEach((sp) => scan(sp.expression, true, found));
    if (ts.isBinaryExpression(node)) {
      scan(node.left, true, found);
      return scan(node.right, true, found);
    }
    if (ts.isConditionalExpression(node)) {
      scan(node.whenTrue, leaf, found, direct);
      return scan(node.whenFalse, leaf, found, direct);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (TEXT_PROPS.has(node.name.text)) found.push(node.getText(sf));
      else if (leaf && !direct && ERROR_PROP_RE.test(node.name.text)) found.push(node.getText(sf));
      else scan(node.expression, false, found);
      return;
    }
    if (ts.isElementAccessExpression(node)) return void scan(node.expression, false, found);
    if (ts.isIdentifier(node)) {
      if (leaf && (errorLike(node.text) || tainted.has(node.text))) found.push(node.text);
      else if (!leaf && tainted.has(node.text)) found.push(node.text);
      return;
    }
    ts.forEachChild(node, (c) => scan(c, false, found));
  }

  // Pass 2: launder to a fixed point. A local is tainted when its initializer
  // is, or when it destructures a text property off an error-like value.
  for (let changed = true; changed; ) {
    changed = false;
    const walkDecl = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const probe: string[] = [];
        scan(n.initializer, true, probe, true);
        const names = new Set<string>();
        if (ts.isIdentifier(n.name)) names.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          const fromError = ts.isIdentifier(n.initializer) && errorLike(n.initializer.text);
          for (const el of n.name.elements) {
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
            if (fromError && TEXT_PROPS.has(prop)) bindingNames(el.name, names);
          }
        }
        if ((probe.length || (!ts.isIdentifier(n.name) && names.size)) && names.size) {
          for (const nm of names) if (!tainted.has(nm)) { tainted.add(nm); changed = true; }
        }
      }
      ts.forEachChild(n, walkDecl);
    };
    walkDecl(sf);
  }

  const visit = (n: ts.Node): void => {
    const ctor =
      ts.isNewExpression(n) || ts.isCallExpression(n)
        ? n.expression.getText(sf)
        : "";
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ERROR_CTORS.has(ctor) && n.arguments?.length) {
      const bad: string[] = [];
      scan(n.arguments[0], true, bad, true);
      if (bad.length) out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${[...new Set(bad)].join(", ")}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("the analyzer: RED on every way another error's text enters a thrown message", () => {
  const RED: Array<[string, string]> = [
    ["a prefixed template", "throw new Error(`Failed to save: ${error.message}`);"],
    ["the bare message", "throw new Error(error.message);"],
    ["code and message", "throw new Error(`x:${e.code}:${e.message}`);"],
    ["an optional-chained message", "throw new Error(`x: ${readErr?.message ?? 'not found'}`);"],
    ["a ternary on instanceof", "throw new Error(`x:${err instanceof Error ? err.message : String(err)}`);"],
    ["details", "throw new Error(`x: ${pgErr.details}`);"],
    ["hint", "throw new Error(`x: ${pgErr.hint}`);"],
    ["String(err)", "throw new Error(`x: ${String(thrownErr)}`);"],
    ["a nested property", "throw new Error(`x: ${res.error.message}`);"],
    ["an Error built, not thrown", "const e = new Error(`x: ${error.message}`); fail(e);"],
    // ---- local-variable laundering ----
    ["a message copied into a local", "const raw = e.message; throw new Error(`x ${raw}`);"],
    ["a local passed bare", "const raw = err.message; throw new Error(raw);"],
    ["a local of a local", "const a = error.details; const b = a; throw new Error(b);"],
    ["a local of a stringified error", "const s = String(thrown); throw new Error(`x ${s}`);"],
    ["a destructured message", "const { message } = err; throw new Error(message);"],
    ["a destructured message under an alias", "const { message: m } = error; throw new Error(`x: ${m}`);"],
    ["a stack in a local", "const st = e.stack; throw new Error(st);"],
    // ---- an error-like value written whole ----
    ["${err} in a template", "throw new Error(`x: ${err}`);"],
    ["${error} in a template", "throw new Error(`x: ${error}`);"],
    ["a catch binding under another name", "try { run(); } catch (boom) { throw new Error(`x: ${boom}`); }"],
    ["a promise .catch parameter", "run().catch((failure) => { throw new Error(`x: ${failure}`); });"],
    ["a destructured error alias", "const { error: lookupFail } = await sb.rpc('f'); throw new Error(`x: ${lookupFail}`);"],
    ["concatenation", 'throw new Error("x: " + err);'],
    ["a bare error handed to the constructor", "throw new Error(err);"],
    // ---- stringifiers ----
    [".toString()", "throw new Error(err.toString());"],
    [".toString() inside a template", "throw new Error(`x: ${error.toString()}`);"],
    ["JSON.stringify(error)", "throw new Error(JSON.stringify(error));"],
    ["String(res.error)", "throw new Error(`x: ${String(res.error)}`);"],
    ["a property named error in a template", "throw new Error(`x: ${res.error}`);"],
    ["util.inspect", "throw new Error(inspect(err));"],
    // ---- constructors ----
    ["Error without new", "throw Error(`x: ${error.message}`);"],
    ["new TypeError", "throw new TypeError(`x: ${error.message}`);"],
    ["new RangeError", "throw new RangeError(String(err));"],
    ["new SyntaxError", "throw new SyntaxError(`x: ${e.message}`);"],
    ["TypeError without new", "throw TypeError(err.message);"],
    ["new EvalError", "throw new EvalError(err.message);"],
    // ---- a closed helper's pass-through argument (Codex P2 on #1161) ----
    ["failureCode fallback is a message", "throw new Error(failureCode(null, null, err.message));"],
    ["failureCode fallback inside a template", "throw new Error(`x: ${failureCode(error, result, error.message)}`);"],
    ["failureCode fallback is a laundered local", "const raw = e.message; throw new Error(failureCode(null, null, raw));"],
    ["failureCode fallback is a bare error", "throw new Error(failureCode(null, null, err));"],
    ["failureCode fallback is String(err)", "throw new Error(failureCode(null, null, String(err)));"],
    ["dbErrorCode internal list carries a message", "throw new Error(dbErrorCode(error, [err.message]));"],
    ["nested: the closed helper's fallback is another helper's fallback", "throw new Error(failureCode(null, null, failureCode(null, null, e.message)));"],
  ];
  for (const [name, code] of RED) {
    it(`flags ${name}`, () => expect(throwTextViolations("t.ts", code)).toHaveLength(1));
  }

  const GREEN: Array<[string, string]> = [
    ["a fixed sentence", 'throw new Error("That slug is already taken.");'],
    ["the closed database form", "throw new Error(`Failed to save: ${dbErrorCode(error)}`);"],
    ["the closed thrown form", "throw new Error(`x:${thrownErrorClass(err)}`);"],
    ["the SQLSTATE code alone", "throw new Error(`x:${error.code}`);"],
    ["a rethrow", "try { run(); } catch (err) { throw err; }"],
    ["a message read that is not thrown", "const m = error.message; log(m);"],
    ["an unrelated Error argument", "throw new Error(`bad ${field} value`);"],
    ["a code copied into a local", "const raw = e.code; throw new Error(`x ${raw}`);"],
    ["a closed form in a local", "const m = dbErrorCode(error); throw new Error(`x: ${m}`);"],
    ["a constant sentence property", "throw new Error(options.genericError);"],
    ["a validation result's fixed sentence", "if (!lotCheck.ok) throw new Error(lotCheck.error);"],
    ["a fixed sentence in a local", 'const label = "x failed"; throw new Error(label);'],
    ["a destructured code", "const { code } = err; throw new Error(`x: ${code}`);"],
    ["Error without new, closed form", "throw Error(`x: ${dbErrorCode(error)}`);"],
    ["new TypeError, fixed", 'throw new TypeError("expected a string");'],
    ["a stringified non-error", "throw new Error(`x: ${String(count)}`);"],
    ["JSON.stringify of data", "throw new Error(JSON.stringify({ a: 1 }));"],
    [".toString() of a number", "throw new Error(`x: ${count.toString()}`);"],
    ["an error name used as a code", "throw new Error(`x: ${error.code}:${error.name}`);"],
    ["an error's code via String", "throw new Error(`x: ${String(error.code)}`);"],
    ["a call with no arguments", "throw new Error();"],
    ["failureCode with a literal fallback", 'throw new Error(failureCode(error, result, "none"));'],
    ["failureCode with the default fallback", "throw new Error(failureCode(error, result));"],
    ["failureCode of a result string", "throw new Error(`x: ${failureCode(null, row.result)}`);"],
    ["dbErrorCode with a literal internal list", 'throw new Error(dbErrorCode(error, ["audit_write_unavailable"]));'],
    ["dbErrorCode with a constant list", "throw new Error(dbErrorCode(error, INTERNAL_CODES));"],
    ["thrownErrorClass of anything", "throw new Error(`x: ${thrownErrorClass(err)}`);"],
    ["safeDbCode of a code", "throw new Error(`x: ${safeDbCode(error.code)}`);"],
  ];
  for (const [name, code] of GREEN) {
    it(`passes ${name}`, () => expect(throwTextViolations("t.ts", code)).toEqual([]));
  }
});

describe("whole tree", () => {
  it("no `new Error(...)` in app/, lib/ or components/ embeds another error's message, details or hint", () => {
    const root = process.cwd();
    const violations: string[] = [];
    for (const dir of ["app", "lib", "components"]) {
      for (const file of walk(path.join(root, dir))) {
        const rel = path.relative(root, file).split(path.sep).join("/");
        if (ALLOWED[rel]) continue;
        violations.push(...throwTextViolations(rel, readFileSync(file, "utf8")));
      }
    }
    expect(violations, "use dbErrorCode(x) or thrownErrorClass(x); see the header").toEqual([]);
  }, 60_000);

  it("every allow-list entry still names a file that has a flagged throw (a stale entry is removed)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(throwTextViolations(rel, readFileSync(path.join(process.cwd(), rel), "utf8")).length, rel).toBeGreaterThan(0);
    }
  });
});
