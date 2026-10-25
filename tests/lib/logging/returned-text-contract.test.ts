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
// WHAT IS NOT: a read used only to DECIDE (`err.message === X ? X : ...`,
// `/re/.test(error.message)`, which are not value positions); `.message` of a
// domain result (`result.message`, `decision.message`) whose text this codebase
// wrote; and the `message` key (alerts, which redact).
//
// KNOWN LIMIT (same as the throw guard): an error's text copied into a local
// variable first and returned from the local is not followed.
//
// ALLOWLIST (each entry needs a reason; the list is meant to stay short, and a
// stale entry fails):
const ALLOWED: Record<string, string> = {
  "app/(app)/calendar/calendar-block-actions.ts":
    "HELD, not repaired here: the file is changed by open #1135 (Machines), who own the line. Remove this entry in the PR that fixes it.",
  "lib/sessions/whole-session-copy-normalize.ts":
    "returns the message of CopyValidationError, a class this module throws with sentences it wrote, behind an instanceof check; never a database or provider error",
};

const KEYS = /^(error|detail|details|errorMessage)$/;
const ERROR_NAME_RE = /^(e|err|error|exception|ex|thrown|caught|\w+Err|\w+Error)$/;
const TEXT_PROPS = /^(message|details|hint)$/;
const CLOSED_FORMS = /^(dbErrorCode|thrownErrorClass|userFacingDbFailure|safeDbCode|failureCode|dbFailureCode)$/;

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

function isErrorReceiver(recv: ts.Expression): boolean {
  const { root, chain } = rootAndChain(recv);
  return (root !== null && ERROR_NAME_RE.test(root)) || chain.includes("error");
}

export function returnedTextViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];

  // Walk only the positions that become the VALUE.
  const value = (n: ts.Node, bad: string[]): void => {
    if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n)) return value(n.expression, bad);
    if (ts.isTemplateExpression(n)) return n.templateSpans.forEach((s) => value(s.expression, bad));
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        value(n.left, bad);
        value(n.right, bad);
      }
      return;
    }
    if (ts.isConditionalExpression(n)) {
      value(n.whenTrue, bad);
      value(n.whenFalse, bad);
      return;
    }
    if (ts.isPropertyAccessExpression(n)) {
      if (TEXT_PROPS.test(n.name.text) && isErrorReceiver(n.expression)) bad.push(n.getText(sf));
      else if (!TEXT_PROPS.test(n.name.text)) value(n.expression, bad);
      return;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (CLOSED_FORMS.test(callee)) return;
      if (callee === "String" && n.arguments[0]) {
        const { root } = rootAndChain(n.arguments[0]);
        if (root !== null && ERROR_NAME_RE.test(root)) bad.push(n.getText(sf));
        return;
      }
      if (ts.isPropertyAccessExpression(n.expression)) value(n.expression.expression, bad); // e.g. error.message.slice(0, 80)
      return;
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && KEYS.test(n.name.getText(sf))) {
      const bad: string[] = [];
      value(n.initializer, bad);
      if (bad.length) out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${bad.join(", ")}`);
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
