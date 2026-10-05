import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// ===========================================================================
// SENTRY-FETCH-01 — A SERVER ACTION'S PROMISE IS NEVER DISCARDED.
//
// Invoking a Server Action from the browser is a POST. When that request is
// lost in transit, the browser rejects the invocation with its own
// `TypeError: Failed to fetch`, and Next passes the rejection to the caller
// unchanged. A caller that DISCARDS the promise (`void action()`, or a bare
// `action();` statement) turns that into an unhandled rejection, which Sentry
// records as an unhandled crash with no Hone frame in its stack.
//
// Measured against the local production build with the transport failed on
// purpose, every UNHANDLED Dashboard "TypeError: Failed to fetch" traced to one
// of the six fire-and-forget onboarding writes, the only discarded Server
// Action calls in the app. They now attach a rejection handler
// (lib/reliability/server-action-transport.ts).
//
// WHAT THIS PROVES: no module under app/, components/ or lib/ discards the
// promise of a call to a function it imports from a "use server" module.
//
// WHAT THIS DOES NOT ATTEMPT, DELIBERATELY: it does not interpret promise
// chains (`action().then(onlyFulfilled)` still loses the rejection), aliases
// (`const go = action; void go()`), or actions arriving as props. Those need a
// type-aware interpreter, and a tripwire that grows one fails on its own
// machinery (see section-label-adoption.test.ts). It also does not judge an
// AWAITED call: whether a lost write may be absorbed is the caller's decision,
// and money writes deliberately let it reach the boundary.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = ["app", "components", "lib"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, sf);
  }
  return sf;
}

function hasDirective(sf: ts.SourceFile, directive: string): boolean {
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === directive) return true;
  }
  return false;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(REPO_ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Local names bound to VALUE imports from a "use server" module. */
function serverActionBindings(file: string, sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const target = resolveImport(file, statement.moduleSpecifier.text);
    if (!target || !hasDirective(parse(target), "use server")) continue;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return names;
}

/** Calls to `actions` whose promise nobody receives: a bare statement or `void`. */
function discardedCalls(
  sf: ts.SourceFile,
  actions: ReadonlySet<string>,
): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      actions.has(node.expression.text)
    ) {
      let consumer = node.parent;
      while (ts.isParenthesizedExpression(consumer)) consumer = consumer.parent;
      if (ts.isExpressionStatement(consumer) || ts.isVoidExpression(consumer)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push({ name: node.expression.text, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const FILES = ROOTS.flatMap((root) => sourceFiles(path.join(REPO_ROOT, root)));

function scan() {
  const bindingsByFile = new Map<string, Set<string>>();
  const violations: string[] = [];
  for (const file of FILES) {
    const sf = parse(file);
    const actions = serverActionBindings(file, sf);
    if (actions.size === 0) continue;
    bindingsByFile.set(path.relative(REPO_ROOT, file), actions);
    for (const call of discardedCalls(sf, actions)) {
      violations.push(`${path.relative(REPO_ROOT, file)}:${call.line} discards ${call.name}()`);
    }
  }
  return { bindingsByFile, violations };
}

describe("SENTRY-FETCH-01 — Server Action promises are never discarded", () => {
  const { bindingsByFile, violations } = scan();

  it("no module discards the promise of a Server Action call", () => {
    expect(violations).toEqual([]);
  });

  it("the scan actually reaches the call sites it protects (anti-vacuity)", () => {
    // Import resolution must see through both spellings the app uses.
    expect(
      [...(bindingsByFile.get("app/(app)/dashboard/onboarding/OnboardingSurface.tsx") ?? [])].sort(),
    ).toEqual(["completeOnboardingAction", "dismissOnboardingAction", "reopenOnboardingAction"]);
    expect([...(bindingsByFile.get("app/(app)/dashboard/onboarding/OnboardingWizard.tsx") ?? [])].sort()).toEqual([
      "acknowledgeWelcomeAction",
      "markCelebrationShownAction",
      "setOnboardingStepAction",
      "skipPaymentsAction",
    ]);
    expect(bindingsByFile.get("app/(app)/GlobalSearch.tsx")).toEqual(new Set(["globalSearchAction"]));
    // And it covers the corpus, not a handful of files.
    expect(bindingsByFile.size).toBeGreaterThan(40);
  });

  it("the detector flags exactly the discarding spellings (anti-vacuity)", () => {
    const sample = ts.createSourceFile(
      "sample.tsx",
      [
        "startTransition(() => { void dismissOnboardingAction(); });", // 1 flagged
        "dismissOnboardingAction();", // 2 flagged
        "(dismissOnboardingAction());", // 3 flagged
        "dismissOnboardingAction().catch(absorbTransportFailure);", // 4 handled
        "async function f() { await dismissOnboardingAction(); }", // 5 received
        "const pending = dismissOnboardingAction();", // 6 received
        "void unrelatedHelper();", // 7 not an action
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(discardedCalls(sample, new Set(["dismissOnboardingAction"]))).toEqual([
      { name: "dismissOnboardingAction", line: 1 },
      { name: "dismissOnboardingAction", line: 2 },
      { name: "dismissOnboardingAction", line: 3 },
    ]);
  });
});
