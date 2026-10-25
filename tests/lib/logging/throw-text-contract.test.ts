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
// WHAT IS BANNED: `new Error(<expr>)` where <expr> reads `.message`, `.details`
// or `.hint` off anything, or stringifies an error-named identifier
// (`String(err)`). `.code` is not banned: it is the SQLSTATE the caller may
// branch on, and dbErrorCode() already validates its shape.
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

export function throwTextViolations(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && n.expression.getText(sf) === "Error" && n.arguments?.length) {
      const arg = n.arguments[0];
      const bad: string[] = [];
      const inspect = (c: ts.Node): void => {
        if (ts.isCallExpression(c) && /^(dbErrorCode|thrownErrorClass)$/.test(c.expression.getText(sf))) return; // closed form
        if (ts.isPropertyAccessExpression(c) && /^(message|details|hint)$/.test(c.name.text)) bad.push(c.getText(sf));
        if (
          ts.isCallExpression(c) &&
          c.expression.getText(sf) === "String" &&
          c.arguments[0] &&
          ts.isIdentifier(c.arguments[0]) &&
          ERROR_NAME_RE.test(c.arguments[0].text)
        ) {
          bad.push(c.getText(sf));
        }
        ts.forEachChild(c, inspect);
      };
      inspect(arg);
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
