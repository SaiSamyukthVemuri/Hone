import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// MSG-LOG-RAW-ERROR-2. SOURCE CONTRACT over ALL of app/ and lib/: no raw error
// object, message, stack, detail, hint, cause, body or unvalidated code reaches
// a log call. A log line carries dbErrorCode(), thrownErrorClass(),
// stripeErrorFields() or a fixed literal instead.
//
// WHAT COUNTS AS A LOG CALL
//   * console.log/info/warn/error/debug and safeLog.info/warn/error;
//   * any call named log or log<Something> (logError, logInternal, logLine, ...);
//   * any function DECLARED IN THE SAME FILE whose body writes to console or
//     safeLog (a forwarder, under whatever name it has).
//
// WHAT COUNTS AS AN ERROR (Insurance's #1138 review F1: a name list alone was
// bypassed by `console.error(thrown)`). In a file, an identifier is error-like
// when it is
//   * bound by a catch clause (`catch (thrown)`, `catch ({ message })`),
//   * a parameter of a `.catch(...)` callback,
//   * the `error` of a destructuring, under any alias
//     (`const { data, error: lookupFail } = await supabase...`),
//   * or, as a fallback, named like an error (e, err, error, thrown, caught,
//     exception, *Err, *Error).
// Reading `.message`, `.stack`, `.details`, `.hint`, `.cause`, `.body`,
// `.response`, `.text` or a raw `.code` off an error-like identifier, or writing
// the identifier itself, is a violation. The analyzer reads the written value
// structurally (object properties, spreads, conditionals, templates,
// JSON.stringify, String()), skips the allow-listed classifiers, and ignores
// calls it cannot see into (the #1106 census owns "values the source cannot
// prove"). Not done: flagging any bare identifier by TYPE (that needs the type
// checker, which makes this test minutes slower); the catch/destructuring rules
// cover how errors enter a scope in this codebase.

const LOG_CALLEE_RE =
  /^(console\.(log|info|warn|error|debug)|safeLog\.(info|warn|error)|log|log[A-Z_]\w*)$/;
const CLASSIFIERS = new Set(["dbErrorCode", "thrownErrorClass", "safeDbCode", "stripeErrorFields"]);
// Forwarders that are DESIGNED to receive an error and classify it inside. Each
// is still checked: its own body is a log call, and it must write a class, not
// the parameter. This list is short on purpose; a new entry needs a reason.
const ERROR_ACCEPTING_FORWARDERS = new Set(["logBackendUnavailable"]);
const BAD_PROPS = new Set(["message", "stack", "details", "hint", "cause", "body", "response", "text", "code"]);
const ERROR_NAME_RE = /^(e|err|error|exception|ex|thrown|caught|\w+Err|\w+Error)$/;

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

function rootIdentifier(node: ts.Expression): string | null {
  let cur: ts.Expression = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

export function rawErrorLogViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // Pass 1: which identifiers are errors in this file, and which local
  // functions forward to a log writer.
  const errorNames = new Set<string>();
  const forwarders = new Set<string>();
  const writesToLog = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && /^(console\.(log|info|warn|error|debug)|safeLog\.(info|warn|error))$/.test(n.expression.getText(sf))) found = true;
      else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };
  const collect = (n: ts.Node) => {
    if (ts.isCatchClause(n) && n.variableDeclaration) bindingNames(n.variableDeclaration.name, errorNames);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch") {
      for (const a of n.arguments) if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0]) bindingNames(a.parameters[0].name, errorNames);
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const prop = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "");
        if (prop === "error") bindingNames(el.name, errorNames);
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body && writesToLog(n.body)) forwarders.add(n.name.text);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
      writesToLog(n.initializer.body)
    ) {
      forwarders.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const errorLike = (name: string) => errorNames.has(name) || ERROR_NAME_RE.test(name);

  function inspect(node: ts.Node, sink: string): void {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
      return inspect(node.expression, sink);
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) inspect(p.initializer, sink);
        else if (ts.isShorthandPropertyAssignment(p)) {
          if (errorLike(p.name.text)) out.push(`${file}:${at(p)} ${sink}: shorthand "${p.name.text}"`);
        } else if (ts.isSpreadAssignment(p)) inspect(p.expression, sink);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) return void node.elements.forEach((e) => inspect(e, sink));
    if (ts.isConditionalExpression(node)) {
      inspect(node.whenTrue, sink);
      return inspect(node.whenFalse, sink);
    }
    if (ts.isBinaryExpression(node)) {
      inspect(node.left, sink);
      return inspect(node.right, sink);
    }
    if (ts.isTemplateExpression(node)) return void node.templateSpans.forEach((s) => inspect(s.expression, sink));
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (CLASSIFIERS.has(callee)) return; // the only way an error's identity may be logged
      if (callee === "JSON.stringify" && node.arguments[0]) return inspect(node.arguments[0], sink);
      if (callee === "String" && node.arguments[0]) return inspect(node.arguments[0], sink);
      return; // opaque call: not this contract's business
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = rootIdentifier(node);
      const prop = ts.isPropertyAccessExpression(node) ? node.name.text : null;
      if (root && errorLike(root) && (prop === null || BAD_PROPS.has(prop))) {
        out.push(`${file}:${at(node)} ${sink}: ${node.getText(sf)}`);
      } else if (prop && (prop === "message" || prop === "stack")) {
        out.push(`${file}:${at(node)} ${sink}: ${node.getText(sf)}`);
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      if (errorLike(node.text)) out.push(`${file}:${at(node)} ${sink}: bare "${node.text}"`);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (ERROR_ACCEPTING_FORWARDERS.has(callee)) {
        // its body is checked on its own; the call site hands it the error by design
      } else if (LOG_CALLEE_RE.test(callee) || forwarders.has(callee)) node.arguments.forEach((a) => inspect(a, callee));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// The analyzer itself: it must fail on every leaking shape and pass the clean ones.
// ---------------------------------------------------------------------------
describe("the analyzer: RED on every way an error's text reaches a log line", () => {
  const RED: Array<[string, string]> = [
    ["a message in a JSON line", 'console.error(JSON.stringify({ event: "x", message: err.message }));'],
    ["a message beside a code", 'safeLog.error(JSON.stringify({ code: error.code, message: error.message }));'],
    ["an optional-chained message", 'console.error(JSON.stringify({ message: insertErr?.message }));'],
    ["the old ternary", 'console.error(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));'],
    ["String(err)", 'logError("x", { error: String(err) });'],
    ["a stack", "console.error({ stack: e.stack });"],
    ["a bare error object", 'console.error("failed", error);'],
    ["a shorthand error", 'logInternal("x", { error });'],
    ["a spread error", 'logInternal("x", { ...error });'],
    ["a template with a message", "console.error(`failed: ${lookupErr.message}`);"],
    ["details and hint", 'logInternal("x", { d: error.details, h: error.hint });'],
    ["a raw code (unvalidated)", 'logInternal("x", { code: error.code });'],
    ["a raw cause", "console.error({ c: err.cause });"],
    ["a message through the file-local helper", 'logSilently({ event: "x", err_message: error.message });'],
    ["a message through the intake helper", 'logInternalIntakeError("x", { code: lookupErr.code, message: lookupErr.message });'],
    ["a message in a plain two-argument console call", 'console.error("Failed to sync:", updateErr.message);'],
    ["a message on a root that does not look like an error", 'logInternal("x", { m: sendResult.message });'],
    ["a stack on a root that does not look like an error", "console.error(JSON.stringify({ s: response.stack }));"],
    // ---- the name-based bypasses Insurance reproduced or predicted (#1138 F1) ----
    ["INSURANCE'S REPRODUCTION: a bare caught value under another name", "try { run(); } catch (thrown) { console.error(thrown); }"],
    ["a caught value under an arbitrary name, logged bare", 'try { run(); } catch (boom) { console.error("x", boom); }'],
    ["a caught value's message under an arbitrary name", 'try { run(); } catch (boom) { console.error("x", boom.message); }'],
    ["a caught value inside a log object", 'try { run(); } catch (c) { logInternal("x", { detail: c }); }'],
    ["a caught value in a template", "try { run(); } catch (c) { console.error(`failed: ${c}`); }"],
    ["a destructured Supabase error under an alias, its message", 'const { data, error: lookupFail } = await sb.from("t").select(); if (lookupFail) console.error("x", lookupFail.message);'],
    ["a destructured Supabase error under an alias, bare", 'const { error: pgFail } = await sb.rpc("f"); if (pgFail) console.error(pgFail);'],
    ["a destructured Supabase error under an alias, shorthand", 'const { error: pgFail } = await sb.rpc("f"); logInternal("x", { pgFail });'],
    ["a destructured Supabase error under an alias, raw code", 'const { error: pgFail } = await sb.rpc("f"); logInternal("x", { code: pgFail.code });'],
    ["a promise .catch callback parameter", "run().catch((failure) => console.error(failure));"],
    ["a promise .catch callback parameter's message", "run().catch((failure) => console.error(failure.message));"],
    ["a forwarder not on any list (function declaration)", "function logLine(x: unknown) { console.error(x); } try { run(); } catch (c) { logLine(c); }"],
    ["a forwarder not on any list (arrow function)", "const emit = (x: unknown) => console.error(x); try { run(); } catch (c) { emit({ c }); }"],
    ["a log<Name> forwarder declared elsewhere (imported)", "try { run(); } catch (c) { logElsewhere(c); }"],
  ];
  it.each(RED)("flags %s", (_name, source) => {
    expect(rawErrorLogViolations("fixture.ts", source).length).toBeGreaterThan(0);
  });

  const CLEAN: Array<[string, string]> = [
    ["a database code", 'console.error(JSON.stringify({ event: "x", code: dbErrorCode(error) }));'],
    ["a thrown class", 'logError("x", { errorClass: thrownErrorClass(err) });'],
    ["a caught value reduced to a class", 'try { run(); } catch (thrown) { console.error(JSON.stringify({ errorClass: thrownErrorClass(thrown) })); }'],
    ["a destructured Supabase error reduced to a code", 'const { error: pgFail } = await sb.rpc("f"); if (pgFail) logInternal("x", { code: dbErrorCode(pgFail) });'],
    ["a fixed literal note", 'logIntakeActionFailure("x", { note: "expected 1 affected row" });'],
    ["the helper forwarding a validated code", 'safeLog.error(JSON.stringify({ event, code: safeDbCode(detail.code), message: detail.note ?? null }));'],
    ["a plain forwarding helper", "console.error(JSON.stringify({ event, ...detail, timestamp }));"],
    ["a closed category from a result", 'logSanitized("x", { retryable: sendResult.retryable });'],
    ["an id-bearing field that is not error text", 'logInternal("x", { appointmentId: asserted.original.appointment_id });'],
    ["a non-sink call that mentions an error", "const label = describe(error.message);"],
    ["a catch variable that is only classified, in a forwarder", "function logLine(x: unknown) { console.error(x); } try { run(); } catch (c) { logLine({ errorClass: thrownErrorClass(c) }); }"],
    ["a call to the one forwarder designed to classify an error inside", 'try { run(); } catch (err) { logBackendUnavailable("route", err); }'],
    ["a variable named 'reason' (a fixed union, not an error)", 'const reason: "error" | "truncated" = pick(); console.error(JSON.stringify({ reason }));'],
  ];
  it.each(CLEAN)("passes %s", (_name, source) => {
    expect(rawErrorLogViolations("fixture.ts", source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The contract over the WHOLE of app/ and lib/ (#1138 F2). Not only the files
// that adopted the helper: a regression in a file that never did is exactly the
// one this test exists to catch.
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}
const TREE = ["app", "lib"].flatMap((d) => walk(path.join(ROOT, d))).map((f) => path.relative(ROOT, f)).sort();

/**
 * THE ALLOW-LIST. File -> how many violations it is known to have. It can ONLY
 * SHRINK: a file over its allowance fails (a new leak), and a file UNDER its
 * allowance fails too (delete the entry or lower the number, so the list never
 * carries stale slack). Do not add a file here to make a new log line pass; fix
 * the log line (dbErrorCode, thrownErrorClass, stripeErrorFields or a literal).
 */
const KNOWN_VIOLATIONS: Readonly<Record<string, number>> = {
  // (empty) every writer in app/ and lib/ is classified.
};

describe("the contract over ALL of app/ and lib/", () => {
  const all = new Map<string, string[]>();
  it("scans the whole tree (a broken walk cannot pass vacuously)", () => {
    expect(TREE.length).toBeGreaterThan(700);
    for (const f of TREE) {
      const v = rawErrorLogViolations(f, readFileSync(path.join(ROOT, f), "utf8"));
      if (v.length) all.set(f, v);
    }
    expect(TREE).toContain("lib/logging/error-class.ts");
    expect(TREE).toContain("app/api/stripe/webhook/route.ts");
  }, 120_000);

  it("no file exceeds its allowance: no raw error object, message or code reaches a log call", () => {
    const over = [...all.entries()]
      .filter(([f, v]) => v.length > (KNOWN_VIOLATIONS[f] ?? 0))
      .map(([f, v]) => `${f} (allowed ${KNOWN_VIOLATIONS[f] ?? 0}, found ${v.length}):\n    ${v.join("\n    ")}`);
    expect(over, over.join("\n")).toEqual([]);
  });

  it("no allowance is stale: the allow-list can only shrink", () => {
    const stale = Object.entries(KNOWN_VIOLATIONS)
      .filter(([f, n]) => (all.get(f)?.length ?? 0) < n)
      .map(([f, n]) => `${f}: allowed ${n}, found ${all.get(f)?.length ?? 0}`);
    expect(stale, "lower or delete these allowances").toEqual([]);
  });

  it("the allow-list names only real files", () => {
    for (const f of Object.keys(KNOWN_VIOLATIONS)) expect(TREE, f).toContain(f);
  });
});
