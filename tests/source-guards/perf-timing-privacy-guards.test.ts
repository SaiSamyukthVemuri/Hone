import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ===========================================================================
// Source guards for the route-timing primitive.
//
// perf-timing lives under lib/observability/, which scripts/classify-changes.mjs
// treats as the SECURITY lane (T3) — correctly, because the module's job is to
// emit telemetry out of a clinical application, so its privacy properties are a
// boundary rather than a detail.
//
// The unit tests in tests/lib/observability/perf-timing.test.ts prove the
// module behaves safely TODAY. These guards prove the properties that make it
// safe cannot be quietly removed TOMORROW.
//
// WHY THE TYPESCRIPT AST AND NOT A REGEX
// --------------------------------------
// Earlier revisions of this file stripped comments textually so that prose
// mentioning `timed()` was not mistaken for a call site. Every textual
// stripper leaks, and each leak makes a SECURITY guard pass vacuously:
//
//   * an inline stripper truncates any line whose string, template or regex
//     literal contains a comment delimiter, deleting the code that follows —
//     `const value = "//" + headers()` became `const value = "`;
//   * a whole-line stripper deletes template CONTINUATION lines, so the
//     executable interpolation in a template whose middle line begins with a
//     comment delimiter disappeared along with the line that looked like one.
//
// Both were found by review, which is the point: a guard that can silently
// erase the code it is checking is worse than no guard. TypeScript is already
// a devDependency, so the parser is free. A comment is never a CallExpression
// and never an Identifier, and template TEXT is never either — so the whole
// class of leak is gone rather than patched.
//
// If one of these fails, do not delete the assertion. The failure means a
// change has opened a path for identifying data to reach telemetry.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const MODULE_PATH = path.join(REPO_ROOT, "lib/observability/perf-timing.ts");
const MODULE_SOURCE = readFileSync(MODULE_PATH, "utf8");

/** Directories whose call sites must pass a literal span name. */
const CALL_SITE_ROOTS = ["app", "lib", "components"];

/** The two public entry points. Any call to either is a call site. */
const ENTRY_POINTS = new Set(["timed", "startPerfSpan"]);

function parseSource(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => eachNode(child, visit));
}

type CallSite = {
  fn: string;
  /** Source text of the first argument, for the failure message. */
  argText: string;
  /** True only for a plain quoted string literal, not a template. */
  isStringLiteral: boolean;
};

/** Every real `timed(...)` / `startPerfSpan(...)` CALL in a source text. */
function findCallSites(text: string, fileName = "sample.ts"): CallSite[] {
  const sourceFile = parseSource(text, fileName);
  const found: CallSite[] = [];
  eachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const fn = node.expression.text;
    if (!ENTRY_POINTS.has(fn)) return;
    const arg = node.arguments[0];
    found.push({
      fn,
      argText: arg ? arg.getText(sourceFile) : "",
      isStringLiteral: arg !== undefined && ts.isStringLiteral(arg),
    });
  });
  return found;
}

type SourceFacts = {
  /** Module specifiers of every import declaration. */
  imports: string[];
  /**
   * Every name the code REFERS TO: identifiers, property names, and the text
   * of string-keyed element access (so `req["pathname"]` is not a blind spot).
   * A name inside a comment or an ordinary string is deliberately absent — it
   * cannot read anything.
   */
  names: Set<string>;
};

function collectFacts(text: string, fileName: string): SourceFacts {
  const sourceFile = parseSource(text, fileName);
  const imports: string[] = [];
  const names = new Set<string>();
  eachNode(sourceFile, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isIdentifier(node)) names.add(node.text);
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      names.add(node.argumentExpression.text);
    }
  });
  return { imports, names };
}

function findTypeAlias(
  sourceFile: ts.SourceFile,
  name: string,
): ts.TypeAliasDeclaration | undefined {
  let found: ts.TypeAliasDeclaration | undefined;
  eachNode(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) found = node;
  });
  return found;
}

function findFunction(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  eachNode(sourceFile, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.text === name
    ) {
      found = node;
    }
  });
  return found;
}

/** First-parameter type name, or null if it is not a plain type reference. */
function firstParamTypeName(fn: ts.FunctionDeclaration): string | null {
  const param = fn.parameters[0];
  if (!param?.type || !ts.isTypeReferenceNode(param.type)) return null;
  return param.type.typeName.getText();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const MODULE_FACTS = collectFacts(MODULE_SOURCE, "perf-timing.ts");
const MODULE_AST = parseSource(MODULE_SOURCE, "perf-timing.ts");

describe("perf-timing module source", () => {
  it("never reads the request path, headers, or cookies", () => {
    // An authenticated pathname such as /clients/<uuid> IS a client
    // identifier. The surface label must stay derived from the span name.
    expect(MODULE_FACTS.imports).not.toContain("next/headers");
    for (const forbidden of ["headers", "cookies", "nextUrl", "pathname"]) {
      expect(
        MODULE_FACTS.names.has(forbidden),
        `perf-timing refers to \`${forbidden}\``,
      ).toBe(false);
    }
  });

  it("keeps PerfSpanId a closed union of string literals", () => {
    const alias = findTypeAlias(MODULE_AST, "PerfSpanId");
    expect(alias, "PerfSpanId declaration not found").toBeTruthy();

    const type = (alias as ts.TypeAliasDeclaration).type;
    expect(ts.isUnionTypeNode(type), "PerfSpanId is no longer a union").toBe(
      true,
    );

    const members = (type as ts.UnionTypeNode).types;
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      // A widened union (`| string`) is a keyword/TypeReference, not a
      // LiteralType, and would silently turn every other guard into a no-op.
      expect(
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
        `PerfSpanId member is not a string literal: ${member.getText(MODULE_AST)}`,
      ).toBe(true);
      const literal = (member as ts.LiteralTypeNode).literal as ts.StringLiteral;
      expect(literal.text).toMatch(/^[a-z-]+\.[a-z-]+$/);
    }
  });

  it("accepts no free-text parameter on either public entry point", () => {
    // If a third, caller-controlled value is ever added, it becomes the way an
    // identifier reaches telemetry.
    const timedFn = findFunction(MODULE_AST, "timed");
    expect(timedFn, "timed() not found").toBeTruthy();
    expect((timedFn as ts.FunctionDeclaration).parameters).toHaveLength(2);
    expect(firstParamTypeName(timedFn as ts.FunctionDeclaration)).toBe(
      "PerfSpanId",
    );

    const bracketFn = findFunction(MODULE_AST, "startPerfSpan");
    expect(bracketFn, "startPerfSpan() not found").toBeTruthy();
    expect((bracketFn as ts.FunctionDeclaration).parameters).toHaveLength(1);
    expect(firstParamTypeName(bracketFn as ts.FunctionDeclaration)).toBe(
      "PerfSpanId",
    );
  });

  it("is server-only", () => {
    expect(MODULE_FACTS.imports).toContain("server-only");
  });

  it("is off unless explicitly enabled", () => {
    // A default-on measurement layer in a clinical product is a standing cost
    // and a standing risk. Enabling must stay an explicit operator act.
    const fn = findFunction(MODULE_AST, "isPerfTimingEnabled");
    expect(fn, "isPerfTimingEnabled() not found").toBeTruthy();
    expect((fn as ts.FunctionDeclaration).getText(MODULE_AST)).toMatch(
      /return process\.env\.HONE_PERF_TIMING === "1";/,
    );
  });
});

describe("perf-timing call sites", () => {
  const files = CALL_SITE_ROOTS.flatMap((root) =>
    walk(path.join(REPO_ROOT, root)),
  ).filter((file) => file !== MODULE_PATH);

  // The raw-text prefilter only ever REMOVES files that cannot contain a call
  // (no mention of either entry point anywhere in the bytes), so it cannot
  // hide one; it just avoids parsing ~1,500 files to find a handful.
  const callSites = files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    if (!text.includes("timed(") && !text.includes("startPerfSpan(")) return [];
    return findCallSites(text, file).map((site) => ({
      ...site,
      file: path.relative(REPO_ROOT, file),
    }));
  });

  it("finds the instrumented surfaces", () => {
    // Sanity: if this drops to zero the guard below passes vacuously.
    const surfaces = new Set(
      callSites
        .filter((site) => site.isStringLiteral)
        .map((site) => site.argText.replace(/["']/g, "").split(".")[0]),
    );
    expect(surfaces).toContain("shell");
    expect(surfaces).toContain("clients");
    expect(surfaces).toContain("client-profile");
    expect(surfaces).toContain("calendar");
    expect(surfaces).toContain("records");
  });

  it("passes a plain string-literal span name at every call site", () => {
    // The compile-time union already rejects a widened type, but a template
    // literal built from a const would still type-check as a literal while
    // reading as dynamic. Requiring a plain quoted string keeps every span
    // name greppable and provably free of interpolated data.
    const offenders = callSites.filter(
      (site) =>
        !site.isStringLiteral ||
        !/^["'][a-z-]+\.[a-z-]+["']$/.test(site.argText),
    );
    expect(
      offenders,
      `non-literal perf span name(s): ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guards must not be able to pass VACUOUSLY.
//
// These pin the exact leaks that two earlier textual implementations had, so
// a future "simplification" back to regex scanning fails here first.
// ---------------------------------------------------------------------------

describe("comments and literals cannot hide a violation", () => {
  it("sees an executable interpolation on a comment-like template line", () => {
    // The leak whole-line stripping still had: the middle line looks like a
    // comment but is template TEXT, and the interpolation inside it runs.
    const source = "const value = `\n  // ${headers()}\n`;";
    expect(collectFacts(source, "sample.ts").names.has("headers")).toBe(true);
  });

  it("sees a timing call hidden on a comment-like template line", () => {
    const source = "const value = `\n  // ${startPerfSpan(`${p}.domain`)}\n`;";
    const sites = findCallSites(source);
    expect(sites).toHaveLength(1);
    expect(sites[0].isStringLiteral).toBe(false);
  });

  it("sees code following a string that contains a comment delimiter", () => {
    // The leak the inline stripper had.
    expect(
      collectFacts('const value = "//" + headers();', "sample.ts").names.has(
        "headers",
      ),
    ).toBe(true);

    const sites = findCallSites(
      'const sep = "//"; startPerfSpan(`${p}.domain`);',
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].isStringLiteral).toBe(false);
  });

  it("sees code following a regex literal containing a slash pair", () => {
    const sites = findCallSites(
      "const re = /a\\/\\/b/; startPerfSpan(spanFromRequest());",
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].isStringLiteral).toBe(false);
  });

  it("sees a bracketed request-data read", () => {
    const facts = collectFacts('const p = req["pathname"];', "sample.ts");
    expect(facts.names.has("pathname")).toBe(true);
  });

  it("does not mistake prose for a call site or a read", () => {
    const source = [
      "// this file explains timed() and startPerfSpan() at length",
      "/**",
      ' * More prose about timed("a.b") and headers() and pathname.',
      " */",
      'timed("clients.domain", run);',
    ].join("\n");

    const sites = findCallSites(source);
    expect(sites).toHaveLength(1);
    expect(sites[0].isStringLiteral).toBe(true);
    expect(sites[0].argText).toBe('"clients.domain"');

    const facts = collectFacts(source, "sample.ts");
    expect(facts.names.has("headers")).toBe(false);
    expect(facts.names.has("pathname")).toBe(false);
  });

  it("does not mistake an ordinary string for a read", () => {
    const facts = collectFacts('const label = "pathname";', "sample.ts");
    expect(facts.names.has("pathname")).toBe(false);
  });
});
