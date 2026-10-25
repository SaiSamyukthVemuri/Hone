import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// MSG-LOG-RAW-ERROR (F3 / UI-DB-TEXT-2). SOURCE CONTRACT over app/, lib/ and
// components/: a value RETURNED to the page (or a caller) under the key `error`,
// `detail`, `details` or `errorMessage` never carries another error's text.
//
// The throw-text contract (throw-text-contract.test.ts) sees `new Error(...)`.
// This closes the other way database or provider text leaves: an object literal
// such as `{ ok: false, error: \`Failed: ${error.message}\` }` that a server
// action returns and the page prints, and a helper result whose `detail` a
// caller later throws or logs. Write `userFacingDbFailure(what, error, event)`
// for a message the person sees, or `dbErrorCode(error)` for a code.
//
// WHAT IS BANNED: under those keys, a `.message`, `.details` or `.hint` read
// whose receiver is an error (an error-named identifier such as `error`, `err`,
// `clientErr`, or any chain through a property named `error`), or
// `String(<error-named>)`, reaching the VALUE: directly, through a template
// span, `+`, `??`, `||`, the branches of a conditional, or a call on it.
//
// WHAT IS NOT: the `safeDetails` bag of an ops alert (recordOpsAlert redacts it); a read used only to DECIDE (`err.message === X ? X : ...`,
// `/re/.test(error.message)`, which are not value positions); `.message` of a
// domain result (`result.message`, `decision.message`) whose text this codebase
// wrote; and the `message` key (alerts, which redact).
//
// LAUNDERING (a local that holds the text) IS followed, name-based and file-wide,
// as in the throw guard. NOT COVERED: the `message` and `reason` keys (see the
// PR's inventory) and text that crosses a function boundary.
//
// ALLOWLIST (each entry needs a reason; the list is meant to stay short, and a
// stale entry fails):
const ALLOWED: Record<string, string> = {
  "app/(app)/calendar/calendar-block-actions.ts":
    "HELD, not repaired here: the file is changed by open #1135 (Machines), who own the line. Remove this entry in the PR that fixes it.",
  "lib/sms/send-appointment.ts":
    "hands `exception:<text>` to logSmsFailure, whose smsFailureForLog collapses any exception:-prefixed value to the fixed tag sms_send_exception before it is logged (pinned by tests/security/raw-error-recipient-exposure.test.ts); it is a log argument, not a returned value, and open PRs write this file, so it is not edited here",
  "lib/sessions/whole-session-copy-normalize.ts":
    "returns the message of CopyValidationError, a class this module throws with sentences it wrote, behind an instanceof check; never a database or provider error",
};

const KEYS = /^(error|errors|detail|details|errorMessage)$/;
const ERROR_NAME_RE = /^(e|err|error|exception|ex|thrown|caught|\w+Err|\w+Error)$/;
// A PROPERTY is error-like only by an exact name (`res.error`); a bare
// `res.error` or error-like identifier assigned straight to the key is not
// flagged (validation results carry fixed sentences in `.error`), it is flagged
// once wrapped (template, String(), toString(), JSON.stringify(), an array).
const ERROR_PROP_RE = /^(e|err|error|exception|thrown|caught)$/;
const TEXT_PROPS = new Set(["message", "details", "hint", "stack"]);
const CLOSED = /^(dbErrorCode|dbFailureCode|thrownErrorClass|userFacingDbFailure|failureCode|safeDbCode)$/;
// A closed helper is closed only for the arguments it validates (the rule from
// #1161's throw-text contract, Codex P2). These return an argument UNCHANGED or
// print it, so that argument is still scanned:
//   dbErrorCode(error, internal)             returns a code found in `internal`;
//   failureCode(error, result, fallback)     returns `fallback` when neither is usable;
//   userFacingDbFailure(what, error, event)  puts `what` into the sentence the person sees.
const PASS_THROUGH: Record<string, readonly number[]> = { dbErrorCode: [1], failureCode: [2], userFacingDbFailure: [0] };

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

function rootAndChain(node: ts.Expression): { root: string | null; chain: string[] } {
  let t: ts.Expression = node;
  const chain: string[] = [];
  for (;;) {
    if (ts.isPropertyAccessExpression(t)) {
      chain.push(t.name.text);
      t = t.expression;
    } else if (ts.isNonNullExpression(t) || ts.isParenthesizedExpression(t) || ts.isAsExpression(t)) {
      t = t.expression;
    } else if (ts.isElementAccessExpression(t)) {
      t = t.expression;
    } else break;
  }
  return { root: ts.isIdentifier(t) ? t.text : null, chain };
}

/**
 * Rules (each has a RED and a GREEN control below). Under the guarded keys:
 *   1. a `.message`, `.details`, `.hint` or `.stack` read whose receiver is an
 *      error (an error-like root, or a chain through a property named `error`);
 *      `result.message` of a domain result is not;
 *   2. an error-like value written whole: a template span, a concatenation
 *      operand, `String(x)`, `x.toString()`, `JSON.stringify(x)`, an array
 *      element, or `res.error` once wrapped;
 *   3. LAUNDERING: a local whose initializer is tainted by 1 or 2 (or by a
 *      destructuring of an error-like value's text), used in the value. This is
 *      name-based and file-wide on purpose: it can over-flag a reused name,
 *      never under-flag one;
 *   4. the pass-through arguments of the closed forms (PASS_THROUGH above).
 * Only VALUE positions are walked: the branches of a conditional, never its
 * condition, so `err.message === X ? X : y` is a decision, not a leak.
 */
export function returnedTextViolations(file: string, source: string): string[] {
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
  const errorReceiver = (recv: ts.Expression): boolean => {
    const { root, chain } = rootAndChain(recv);
    return (root !== null && errorLike(root)) || chain.includes("error");
  };

  const tainted = new Set<string>();
  function scan(node: ts.Node, leaf: boolean, found: string[], direct = false): void {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
      return scan(node.expression, leaf, found, direct);
    }
    if (ts.isArrayLiteralExpression(node)) return void node.elements.forEach((el) => scan(el, true, found, true));
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (CLOSED.test(callee)) {
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
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        // concatenation writes the operands INTO a new string
        scan(node.left, true, found);
        scan(node.right, true, found);
      } else if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        // a fallback chain passes an operand through as it is, like a conditional branch
        scan(node.left, leaf, found, direct);
        scan(node.right, leaf, found, direct);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      scan(node.whenTrue, leaf, found, direct);
      return scan(node.whenFalse, leaf, found, direct);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (TEXT_PROPS.has(node.name.text) && errorReceiver(node.expression)) found.push(node.getText(sf));
      else if (!TEXT_PROPS.has(node.name.text) && leaf && !direct && ERROR_PROP_RE.test(node.name.text)) found.push(node.getText(sf));
      else if (!TEXT_PROPS.has(node.name.text)) scan(node.expression, false, found);
      return;
    }
    if (ts.isElementAccessExpression(node)) return void scan(node.expression, false, found);
    if (ts.isIdentifier(node)) {
      // a laundered local always holds text; a bare error-like identifier is only
      // flagged once wrapped (template, String(), array element ...), not assigned whole
      if (tainted.has(node.text)) found.push(node.text);
      else if (leaf && !direct && errorLike(node.text)) found.push(node.text);
      return;
    }
    // other expression kinds (literals, arrows, object literals) carry no error text of their own
  }

  // Pass 2: launder to a fixed point.
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
    // `safeDetails` is the ops-alert detail bag: recordOpsAlert redacts it before
    // every sink, like the `message` key, so a `safeDetails: { error: ... }` is
    // not a returned value (see the header: redaction covers plain addresses and
    // numbers only; the encoded forms are PEER-1152 P6's UNKNOWN residual).
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "safeDetails") return;
    if (ts.isPropertyAssignment(n) && KEYS.test(n.name.getText(sf))) {
      const bad: string[] = [];
      scan(n.initializer, true, bad, true);
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

describe("the analyzer: RED on every way an error's text reaches a returned value", () => {
  const RED: Array<[string, string]> = [
    ["a prefixed template", "return { ok: false, error: `Failed to save: ${error.message}` };"],
    ["the bare message", "return { ok: false, error: clientErr.message };"],
    ["a nested error read", "const c = { error: clientsCount.error?.message };"],
    ["an optional chain", "return { ok: false, error: `x ${readErr?.message ?? 'unknown'}` };"],
    ["a conditional branch", "return { error: business ? error.message : 'Try again.' };"],
    ["a fallback chain", "return { error: err.message || 'x' };"],
    ["string concatenation", "return { error: 'Failed: ' + error.message };"],
    ["details", "return { ok: false, detail: `${pgErr.details}` };"],
    ["hint", "return { ok: false, details: pgErr.hint };"],
    ["a slice of the message", "return { error: error.message.slice(0, 80) };"],
    ["String(err)", "return { error: String(thrownErr) };"],
    ["code and message", "return { detail: `${error.code}:${error.message}` };"],
    // G1 (PEER-1164): a closed form is closed only for the arguments it validates.
    ["failureCode fallback is a message", "return { error: failureCode(null, null, err.message) };"],
    ["userFacingDbFailure `what` is a message", "return { error: userFacingDbFailure(error.message, error, 'ev') };"],
    ["dbErrorCode internal list holds a message", "return { error: dbErrorCode(error, [err.message]) };"],
    ["a pass-through argument laundered through a local", "const raw = e.message; return { error: failureCode(null, null, raw) };"],
    // G2: whole-value rules.
    ["an error written whole in a template", "return { error: `x ${error}` };"],
    ["error.toString()", "return { error: error.toString() };"],
    ["JSON.stringify(error)", "return { error: JSON.stringify(error) };"],
    ["an array under errors", "return { ok: false, errors: [error.message] };"],
    ["an array of an error written whole", "return { errors: [`${err}`] };"],
    ["a laundered local", "const raw = error.message; return { error: `Failed: ${raw}` };"],
    ["a destructured message", "const { message } = err; return { detail: message };"],
    ["res.error wrapped in a template", "return { error: `x ${res.error}` };"],
  ];
  for (const [name, code] of RED) {
    it(`flags ${name}`, () => expect(returnedTextViolations("t.ts", code)).toHaveLength(1));
  }

  const GREEN: Array<[string, string]> = [
    ["a fixed sentence", 'return { ok: false, error: "Plan not found." };'],
    ["the closed user-facing form", 'return { ok: false, error: userFacingDbFailure("add the stage", error, "ev") };'],
    ["the closed code", "return { ok: false, error: dbErrorCode(error) };"],
    ["a closed code inside a template", "return { detail: `${dbErrorCode(error)}` };"],
    ["the SQLSTATE alone", "return { detail: error.code };"],
    ["a decision made on the message, not returned", "return { error: err.message === OWNER_ONLY ? OWNER_ONLY : 'Unauthorized.' };"],
    ["a regex test on the message", "return { error: /changed/i.test(error.message) ? 'It changed.' : 'Try again.' };"],
    ["a domain result's own message", "return { ok: false, error: result.message };"],
    ["a decision's own message", "return { ok: false, error: decision.message };"],
    ["the alert message key", "await recordOpsAlert({ message: error.message, severity: 'warning' });"],
    ["a message read that is not returned", "const m = error.message; log(m);"],
    ["an unrelated key", "return { note: error.message };"],
    ["a fallback chain on a send result's closed tag", "return { error: result.error ?? 'unknown' };"],
    ["the alert detail bag (redacted by recordOpsAlert)", "await recordOpsAlert({ safeDetails: { attempt_id: id, error: safeError } });"],
    // pass-through arguments that are literals or fixed
    ["failureCode with a literal fallback", "return { error: failureCode(error, result, 'fallback_code') };"],
    ["userFacingDbFailure with a literal what", "return { error: userFacingDbFailure('add the stage', error, 'ev') };"],
    ["dbErrorCode with a literal internal list", "return { error: dbErrorCode(error, ['audit_write_unavailable']) };"],
    ["a bare res.error assigned whole (validation results carry fixed sentences)", "return { ok: false, error: res.error };"],
    ["an array of fixed codes", "return { errors: [dbErrorCode(error), 'fixed'] };"],
    ["a local that never held text", "const label = 'x'; return { error: label };"],
  ];
  for (const [name, code] of GREEN) {
    it(`passes ${name}`, () => expect(returnedTextViolations("t.ts", code)).toEqual([]));
  }
});

describe("whole tree", () => {
  it("no value returned under error/detail/details/errorMessage in app/, lib/ or components/ carries another error's message, details or hint", () => {
    const root = process.cwd();
    const violations: string[] = [];
    for (const dir of ["app", "lib", "components"]) {
      for (const file of walk(path.join(root, dir))) {
        const rel = path.relative(root, file).split(path.sep).join("/");
        if (ALLOWED[rel]) continue;
        violations.push(...returnedTextViolations(rel, readFileSync(file, "utf8")));
      }
    }
    expect(violations, "use userFacingDbFailure(what, error, event) or dbErrorCode(error); see the header").toEqual([]);
  }, 60_000);

  it("every allow-list entry still names a file that has a flagged value (a stale entry is removed)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(returnedTextViolations(rel, readFileSync(path.join(process.cwd(), rel), "utf8")).length, rel).toBeGreaterThan(0);
    }
  });
});
