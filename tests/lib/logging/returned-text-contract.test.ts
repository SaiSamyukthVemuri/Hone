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
type Allowed = { text: string; reason: string };
// Each entry is a (file, flagged text) PAIR: a new flagged value in the same file
// is still reported, and the stale-entry check requires every pair to still exist.
const ALLOWED: Record<string, Allowed[]> = {
  "app/(app)/calendar/calendar-block-actions.ts": [
    {
      text: "error.message",
      reason: "HELD, not repaired here: the file is changed by open #1135 (Machines), who own the line. Remove this entry in the PR that fixes it.",
    },
  ],
  "lib/sms/send-appointment.ts": [
    {
      text: "message",
      reason:
        "hands `exception:<text>` to logSmsFailure, whose smsFailureForLog collapses any exception:-prefixed value to the fixed tag sms_send_exception before it is logged (pinned by tests/security/raw-error-recipient-exposure.test.ts); a log argument, not a returned value; open PRs write this file, so it is not edited here",
    },
    {
      text: "result.error",
      reason:
        "the SMS send result's closed category tag (the `ambiguous ? `${result.error}:outcome_unknown` : result.error` log argument); smsFailureForLog validates it against SMS_LOG_FAILURES before logging",
    },
  ],
  "lib/export/paginate.ts": [
    {
      text: "error",
      reason:
        "PageResult pass-through (`return { data: null, error }`, two sites): an INTERNAL result whose only consumer, exportStudioDataAction, converts it to a fixed sentence through exportReadFailure and logs dbErrorCode; it never reaches the page",
    },
  ],
  "lib/billing/payment-receipt.ts": [
    {
      text: "err",
      reason:
        "`error: err` is an argument to releaseAfterPdfFailure, which only logs thrownErrorClass(args.error) and puts a sanitised copy in an ops-alert detail bag; an internal call, not a returned value (payment path, deliberately not edited here)",
    },
  ],
  "lib/sessions/whole-session-copy-normalize.ts": [
    {
      text: "e.message",
      reason: "returns the message of CopyValidationError, a class this module throws with sentences it wrote, behind an instanceof check; never a database or provider error",
    },
  ],
};

const KEYS = /^(error|errors|detail|details|errorMessage)$/;
const ERROR_NAME_RE = /^(e|err|error|exception|ex|thrown|caught|\w+Err|\w+Error)$/;
// A PROPERTY is error-like only by an exact name (`res.error`); a bare
// `res.error` or error-like identifier assigned straight to the key is not
// flagged (validation results carry fixed sentences in `.error`), it is flagged
// once wrapped (template, String(), toString(), JSON.stringify(), an array).
const ERROR_PROP_RE = /^(e|err|error|exception|thrown|caught)$/;
const TEXT_PROPS = new Set(["message", "details", "hint", "stack"]);
// The ops-alert helpers whose `safeDetails` bag is redacted before every sink.
const ALERT_CALLS = /^(recordOpsAlert|fireAndForgetOpsAlert|safeAlert)$/;
// Results whose `.error` is a CLOSED string tag, never a database error object:
// validation results and the email/SMS send results (#1110). Never tracked as a
// supabase result even if declared from a call.
const CLOSED_TAG_ROOTS = new Set(["validated", "sendResult"]);
// A variable initialised from one of these calls holds a supabase-js result, whose
// `.error` is a PostgrestError OBJECT (message, details, hint).
const SUPABASE_CALL_RE = /\.(from|rpc)\(/;
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
export function returnedTextFindings(file: string, source: string): Array<{ line: number; texts: string[] }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  // Pass 1: names that are errors in this file, each with the SCOPE it is bound in
  // (a catch clause, a `.catch` callback, or the block a destructuring sits in), so a
  // reused name elsewhere in the file (a string parameter called `error`, a map
  // callback's `e`) is not mistaken for an error object.
  const errorBindings: Array<{ name: string; scope: ts.Node }> = [];
  const bind = (name: ts.BindingName, scope: ts.Node) => {
    const names = new Set<string>();
    bindingNames(name, names);
    for (const nm of names) errorBindings.push({ name: nm, scope });
  };
  const blockOf = (n: ts.Node): ts.Node => {
    let p: ts.Node | undefined = n.parent;
    while (p && !ts.isBlock(p) && !ts.isSourceFile(p) && !ts.isModuleBlock(p)) p = p.parent;
    return p ?? sf;
  };
  const collect = (n: ts.Node): void => {
    if (ts.isCatchClause(n) && n.variableDeclaration) bind(n.variableDeclaration.name, n);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch") {
      for (const a of n.arguments) if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0]) bind(a.parameters[0].name, a);
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
        if (prop === "error") bind(el.name, blockOf(n));
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const bareNames = new Set(errorBindings.map((b) => b.name));
  /** `name` is an error object bound in a scope that contains `at`. */
  const errorBound = (name: string, at: ts.Node) => errorBindings.some((b) => b.name === name && at.getStart(sf) >= b.scope.getStart(sf) && at.end <= b.scope.end);
  // Names that hold a supabase-js result (`const res = await x.from(...)...`,
  // `const [a, b] = await Promise.all([x.from(...)...])`): their `.error` is an object.
  const resultNames = new Set<string>();
  const collectResults = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && SUPABASE_CALL_RE.test(n.initializer.getText(sf))) {
      if (ts.isIdentifier(n.name)) resultNames.add(n.name.text);
      else if (ts.isArrayBindingPattern(n.name)) bindingNames(n.name, resultNames);
    }
    ts.forEachChild(n, collectResults);
  };
  collectResults(sf);
  for (const root of CLOSED_TAG_ROOTS) resultNames.delete(root);
  const isResultError = (n: ts.Node): boolean =>
    ts.isPropertyAccessExpression(n) && n.name.text === "error" && ts.isIdentifier(n.expression) && resultNames.has(n.expression.text);
  const errorLike = (name: string) => bareNames.has(name) || ERROR_NAME_RE.test(name);
  const errorReceiver = (recv: ts.Expression): boolean => {
    const { root, chain } = rootAndChain(recv);
    return (root !== null && (errorLike(root) || tainted.has(root))) || chain.includes("error");
  };

  const tainted = new Set<string>();
  function scan(node: ts.Node, leaf: boolean, found: string[], direct = false): void {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
      return scan(node.expression, leaf, found, direct);
    }
    if (ts.isArrayLiteralExpression(node)) return void node.elements.forEach((el) => scan(el, true, found, true));
    if (ts.isObjectLiteralExpression(node)) {
      // A nested literal under a guarded key is a value too: its properties are scanned.
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) scan(prop.expression, true, found, true);
        else if (ts.isPropertyAssignment(prop)) scan(prop.initializer, true, found, true);
        else if (ts.isShorthandPropertyAssignment(prop)) {
          if (errorBound(prop.name.text, prop) || tainted.has(prop.name.text)) found.push(prop.name.text);
        }
      }
      return;
    }
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
      if (isResultError(node)) found.push(node.getText(sf)); // a supabase result's error OBJECT, bare or wrapped
      else if (TEXT_PROPS.has(node.name.text) && errorReceiver(node.expression)) found.push(node.getText(sf));
      else if (!TEXT_PROPS.has(node.name.text) && leaf && !direct && ERROR_PROP_RE.test(node.name.text)) found.push(node.getText(sf));
      // any other property of an error OBJECT (`decline.payment_intent`, `res.data`) is not its
      // text; a longer chain (`error.message.slice`) is walked to find a text read inside it
      else if (ts.isPropertyAccessExpression(node.expression) || ts.isCallExpression(node.expression)) scan(node.expression, false, found);
      return;
    }
    if (ts.isElementAccessExpression(node)) return void scan(node.expression, false, found);
    if (ts.isIdentifier(node)) {
      // a laundered local always holds text; a bare error-like identifier is only
      // flagged once wrapped (template, String(), array element ...), not assigned whole
      // a destructured/caught error OBJECT assigned whole carries its message,
      // details and hint to whoever serialises it
      // (an error handed to ANOTHER function as an argument is not this rule's business:
      // only the value itself, a branch of it, an array element or a nested property)
      if (tainted.has(node.text) || (direct && errorBound(node.text, node))) found.push(node.text);
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

  const findings: Array<{ line: number; texts: string[] }> = [];
  const report = (n: ts.Node, bad: string[]) => {
    if (bad.length) findings.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, texts: [...new Set(bad)] });
  };
  const isAlertArgument = (obj: ts.Node): boolean => {
    const call = obj.parent;
    return !!call && ts.isCallExpression(call) && call.arguments.includes(obj as ts.Expression) && ALERT_CALLS.test(call.expression.getText(sf));
  };
  /** `({ data, error: e } = await ...)`: an assignment TARGET, not a value. */
  const isAssignmentTarget = (obj: ts.Node): boolean => {
    let p: ts.Node | undefined = obj.parent;
    while (p && ts.isParenthesizedExpression(p)) p = p.parent;
    return !!p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === (obj.parent === p ? obj : obj.parent);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n) && isAssignmentTarget(n)) return;
    // `safeDetails` is the ops-alert detail bag: recordOpsAlert redacts it before
    // every sink, like the `message` key, so a `safeDetails: { error: ... }` is
    // not a returned value. Skipped ONLY as an argument of the alert helpers; a
    // `safeDetails` key on any other object is an ordinary key (see the header:
    // redaction covers plain addresses and numbers only; the encoded forms are
    // PEER-1152 P6's UNKNOWN residual).
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "safeDetails" && isAlertArgument(n.parent)) return;
    if (ts.isPropertyAssignment(n) && KEYS.test(n.name.getText(sf))) {
      const bad: string[] = [];
      scan(n.initializer, true, bad, true);
      report(n, bad);
    }
    // `{ ok: false, error }` / `{ detail }`: the shorthand key is the error object itself
    if (ts.isShorthandPropertyAssignment(n) && KEYS.test(n.name.text) && (errorBound(n.name.text, n) || tainted.has(n.name.text))) {
      report(n, [n.name.text]);
    }
    // `{ ...error }` / `{ ...res.error }`: spreads an error's message, details and hint into the result
    if (ts.isSpreadAssignment(n)) {
      const bad: string[] = [];
      scan(n.expression, true, bad, true);
      report(n, bad);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

export function returnedTextViolations(file: string, source: string): string[] {
  return returnedTextFindings(file, source).map((f) => `${file}:${f.line} ${f.texts.join(", ")}`);
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
    // W1 (PEER-1164-DELTA): the error OBJECT assigned whole. Privacy's five shapes.
    ["shorthand { ok: false, error } of a destructured supabase error", "const { error } = await supabase.from('t').select(); return { ok: false, error };"],
    ["a spread of the error object", "const { error } = await supabase.from('t').select(); return { ...error };"],
    ["error: res.error of a supabase result", "const res = await supabase.from('t').select(); return { ok: false, error: res.error };"],
    ["detail: res.error of a supabase result", "const res = await supabase.from('t').select(); return { ok: false, detail: res.error };"],
    ["a nested literal { message: error.message }", "return { error: { message: error.message } };"],
    // the same family, other spellings
    ["a destructured error under a key", "const { error: clientErr } = await supabase.from('t').select(); return { ok: false, error: clientErr };"],
    ["a caught value under a key", "try { go(); } catch (thrown) { return { ok: false, error: thrown }; }"],
    ["a spread of res.error", "const res = await supabase.rpc('f'); return { ok: false, ...res.error };"],
    ["a result array element", "const res = await supabase.from('t').select(); return { errors: [res.error] };"],
    ["a promise-all result's error", "const [a, b] = await Promise.all([supabase.from('x').select(), supabase.from('y').select()]); return { error: b.error };"],
    ["a nested literal with details", "return { detail: { text: pgErr.details, code: 'x' } };"],
    // W3: safeDetails is skipped only inside the alert helpers
    ["a safeDetails key on a returned object", "return { ok: false, safeDetails: { error: error.message } };"],
    ["a safeDetails key on a non-alert call", "report({ safeDetails: { error: err.message } });"],
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
    ["the alert detail bag of fireAndForgetOpsAlert", "fireAndForgetOpsAlert({ safeDetails: { error: err.message } });"],
    ["the alert detail bag of safeAlert", "await safeAlert({ safeDetails: { thrown: String(err) } });"],
    // string-tag results stay allowed (W1)
    ["validated.error is a closed validation tag", "const validated = validate(x); return { ok: false, error: validated.error };"],
    ["sendResult.error is a closed send tag", "const sendResult = await send(); return { ok: false, error: sendResult.error ?? 'unknown' };"],
    ["a string tag in a plain local named error", "const error = 'plan_not_found'; return { ok: false, error };"],
    ["a destructured error that is only decided on", "const { error } = await supabase.from('t').select(); if (error) { log(dbErrorCode(error)); } return { ok: true };"],
    ["a destructured error through the closed forms", "const { error } = await supabase.from('t').select(); return { ok: false, error: userFacingDbFailure('save', error, 'ev'), detail: dbErrorCode(error) };"],
    ["a nested literal of fixed values", "return { error: { code: dbErrorCode(error), message: 'Could not save.' } };"],
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
        const allowed = new Set((ALLOWED[rel] ?? []).map((a) => a.text));
        for (const f of returnedTextFindings(rel, readFileSync(file, "utf8"))) {
          const rest = f.texts.filter((t) => !allowed.has(t));
          if (rest.length) violations.push(`${rel}:${f.line} ${rest.join(", ")}`);
        }
      }
    }
    expect(violations, "use userFacingDbFailure(what, error, event) or dbErrorCode(error); see the header").toEqual([]);
  }, 60_000);

  it("every allow-list entry (file + flagged text) still exists, and carries a reason (a stale entry is removed)", () => {
    for (const [rel, entries] of Object.entries(ALLOWED)) {
      const flagged = new Set(returnedTextFindings(rel, readFileSync(path.join(process.cwd(), rel), "utf8")).flatMap((f) => f.texts));
      for (const entry of entries) {
        expect(entry.reason.length, `${rel} :: ${entry.text} has no reason`).toBeGreaterThan(20);
        expect(flagged.has(entry.text), `${rel} :: ${entry.text} is no longer flagged`).toBe(true);
      }
    }
  });

  it("an allow-listed file is not exempt: a NEW flagged value in it is still reported", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/sms/send-appointment.ts"), "utf8") + "\nconst probe = { error: `x ${readErr.message}` };\n";
    const texts = returnedTextFindings("lib/sms/send-appointment.ts", src).flatMap((f) => f.texts);
    const allowed = new Set(ALLOWED["lib/sms/send-appointment.ts"].map((a) => a.text));
    expect(texts.filter((t) => !allowed.has(t))).toEqual(["readErr.message"]);
  });
});
