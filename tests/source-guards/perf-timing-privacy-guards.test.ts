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

/** The two public entry points, by their EXPORTED names. */
const ENTRY_POINTS = new Set(["timed", "startPerfSpan"]);

/** Matches the perf-timing module however a caller spells the path. */
const PERF_TIMING_MODULE = /(^|\/)perf-timing$/;

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

/**
 * Local names an entry point is reachable by in this file.
 *
 * Matching the exported spelling alone is evadable: `import { timed as
 * measure }` and `import * as perf` both produce calls that a name-only check
 * never sees. Resolving the import bindings closes that.
 */
function perfTimingBindings(sourceFile: ts.SourceFile): {
  local: Set<string>;
  namespaces: Set<string>;
} {
  const local = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !PERF_TIMING_MODULE.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        // `propertyName` is the EXPORTED name when the import is aliased.
        const exported = (element.propertyName ?? element.name).text;
        if (ENTRY_POINTS.has(exported)) local.add(element.name.text);
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { local, namespaces };
}

/** Every real `timed(...)` / `startPerfSpan(...)` CALL in a source text. */
function findCallSites(text: string, fileName = "sample.ts"): CallSite[] {
  const sourceFile = parseSource(text, fileName);
  const { local, namespaces } = perfTimingBindings(sourceFile);
  // The exported spellings are always candidates too: the synthetic snippets
  // below carry no import, and nothing else in the tree defines a function by
  // either name. A future collision surfaces here as a LOUD false positive,
  // which is the safe direction for a security guard.
  const callable = new Set<string>([...ENTRY_POINTS, ...local]);

  const found: CallSite[] = [];
  eachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;

    // Covers `timed(...)`, `timed<T>(...)`, `timed?.(...)`, a newline or a
    // comment between the callee and its parenthesis — all of which are the
    // same CallExpression once parsed, and none of which a text scan sees.
    const callee = node.expression;
    let fn: string | null = null;
    if (ts.isIdentifier(callee) && callable.has(callee.text)) {
      fn = callee.text;
    } else if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      ENTRY_POINTS.has(callee.name.text)
    ) {
      fn = `${callee.expression.text}.${callee.name.text}`;
    }
    if (fn === null) return;

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
    if (ts.isElementAccessExpression(node)) {
      // A statically-named key is a real read whichever literal form spells
      // it: `req["pathname"]` and `req[`pathname`]` are the same access, but
      // only the first is a StringLiteral node.
      const key = node.argumentExpression;
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
        names.add(key.text);
      }
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

  // EVERY file is parsed. An earlier revision prefiltered on the raw bytes
  // `timed(` / `startPerfSpan(` to save work, but a call can be written
  // `timed\n(`, `timed<T>(`, `timed?.(` or `timed /* c */ (` — none of which
  // contain those bytes — so the filter could skip a file holding exactly the
  // construct being guarded against. Parsing all of app/, lib/ and
  // components/ measures ~1.4s for ~640 files, which is a cheap price for an
  // assertion that cannot be dodged.
  const callSites = files.flatMap((file) =>
    findCallSites(readFileSync(file, "utf8"), file).map((site) => ({
      ...site,
      file: path.relative(REPO_ROOT, file),
    })),
  );

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

  it("sees a template-literal element-access key", () => {
    // `req[`pathname`]` is a NoSubstitutionTemplateLiteral, not a
    // StringLiteral — the same read wearing a different node kind.
    const facts = collectFacts("const p = req[`pathname`];", "sample.ts");
    expect(facts.names.has("pathname")).toBe(true);
  });
});

describe("call sites cannot evade the guard by how they are written", () => {
  // Each of these parses to a CallExpression that a name-and-bytes scan misses.
  const IMPORT = 'import { timed, startPerfSpan } from "@/lib/observability/perf-timing";\n';

  function firstSite(source: string) {
    const sites = findCallSites(source, "sample.ts");
    expect(sites).toHaveLength(1);
    return sites[0];
  }

  it("sees a call split across a newline before the parenthesis", () => {
    expect(firstSite(IMPORT + "timed\n(`${surface}.domain`, run);").isStringLiteral).toBe(
      false,
    );
  });

  it("sees a call with explicit type arguments", () => {
    expect(
      firstSite(IMPORT + "timed<Result>(`${surface}.domain`, run);").isStringLiteral,
    ).toBe(false);
  });

  it("sees an optional call", () => {
    expect(
      firstSite(IMPORT + "timed?.(`${surface}.domain`, run);").isStringLiteral,
    ).toBe(false);
  });

  it("sees a call with a comment between callee and parenthesis", () => {
    expect(
      firstSite(IMPORT + "timed /* still a call */ (`${surface}.domain`, run);")
        .isStringLiteral,
    ).toBe(false);
  });

  it("resolves an aliased import", () => {
    const source =
      'import { timed as measure } from "@/lib/observability/perf-timing";\n' +
      "measure(`${surface}.domain`, run);";
    const site = firstSite(source);
    expect(site.fn).toBe("measure");
    expect(site.isStringLiteral).toBe(false);
  });

  it("resolves an aliased bracket import", () => {
    const source =
      'import { startPerfSpan as begin } from "@/lib/observability/perf-timing";\n' +
      "begin(spanFromRequest());";
    expect(firstSite(source).fn).toBe("begin");
  });

  it("resolves a namespace import", () => {
    const source =
      'import * as perf from "@/lib/observability/perf-timing";\n' +
      "perf.timed(`${surface}.domain`, run);";
    const site = firstSite(source);
    expect(site.fn).toBe("perf.timed");
    expect(site.isStringLiteral).toBe(false);
  });

  it("does not claim an unrelated namespace call", () => {
    const source =
      'import * as other from "@/lib/something-else";\n' +
      "other.timed(`${surface}.domain`, run);";
    expect(findCallSites(source, "sample.ts")).toEqual([]);
  });
});
