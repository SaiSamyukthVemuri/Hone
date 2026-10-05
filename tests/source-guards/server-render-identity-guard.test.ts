import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// ===========================================================================
// SENTRY-IDENTITY-01 — a server-rendered module never calls the THROWING
// identity backstop.
// ===========================================================================
//
// lib/supabase/queries.ts has two resolvers over the same request identity:
//
//   requirePractitionerWithStudio()     REDIRECTS: anonymous -> /login,
//                                       no active membership -> /no-access,
//                                       2+ with no valid selection -> chooser
//   getCurrentPractitionerWithStudio()  THROWS on those states — the backstop
//                                       for server actions, whose try/catch
//                                       would swallow a redirect
//
// A page, layout or server component must use the redirecting one. Next renders
// a route's layouts and its page IN PARALLEL, so the shell layout's redirect
// does not stop a page from running: a page that throws on an expected identity
// state still reaches `onRequestError` (Sentry) on every full load, and on a
// soft navigation — where the shell layout is not re-rendered at all — the
// throw IS what the practitioner sees. That is the production group
// "No active practitioner found for the signed-in user." on /calendar/[id].
//
// The behaviour is proved against the real page in
// tests/app/calendar/appointment-detail-identity-boundary.test.ts. This file is
// the architectural tripwire that keeps every OTHER server-rendered module on
// the same side of the line, in both directions: nothing server-rendered calls
// the backstop, and every authenticated page calls the guard itself (a page
// that resolves NO identity is exposed to the same race). Calls are found with
// the TypeScript parser, so a comment or a string that names either function is
// never mistaken for a call.

const ROOT = path.resolve(__dirname, "../..");
const BACKSTOP = "getCurrentPractitionerWithStudio";
const GUARD = "requirePractitionerWithStudio";

// Next's server-rendered route-segment conventions. error.tsx / global-error
// are client components by definition and are excluded by their directive.
const SEGMENT_FILE = /^(page|layout|template|default|not-found|forbidden|unauthorized)\.(tsx|ts|jsx|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The module's leading directive ("use client" / "use server"), if any. */
function directive(sf: ts.SourceFile): string | null {
  for (const statement of sf.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      return statement.expression.text;
    }
    break;
  }
  return null;
}

function parse(fileName: string, source: string): ts.SourceFile {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** Line numbers of every CALL to `name` (comments and strings never match). */
function callLines(sf: ts.SourceFile, name: string): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

type Module = { rel: string; sf: ts.SourceFile };

/**
 * Every module that renders on the server as part of a route: the segment
 * convention files, plus any .tsx module under app/ or components/ that is
 * neither a client component nor a server-action module.
 */
function serverRenderedModules(): Module[] {
  const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components"))];
  const modules: Module[] = [];
  for (const full of files) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    const sf = parse(rel, readFileSync(full, "utf8"));
    const d = directive(sf);
    if (d === "use client" || d === "use server") continue;
    const isSegment = rel.startsWith("app/") && SEGMENT_FILE.test(path.basename(rel));
    if (isSegment || /\.(tsx|jsx)$/.test(rel)) modules.push({ rel, sf });
  }
  return modules;
}

const MODULES = serverRenderedModules();
const byRel = new Map(MODULES.map((m) => [m.rel, m]));

/** Does the module render any JSX at all? */
function rendersJsx(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every module specifier this file imports from. */
function importsFrom(sf: ts.SourceFile): string[] {
  return sf.statements.flatMap((s) =>
    ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
      ? [s.moduleSpecifier.text]
      : [],
  );
}

// The ONLY authenticated pages allowed to skip the guard, each with the property
// that makes skipping it safe. The property is re-proved on every run, so an
// exemption that stops being true fails here instead of quietly widening.
const GUARD_EXEMPT_PAGES: Record<
  string,
  { why: string; stillTrue: (sf: ts.SourceFile) => boolean }
> = {
  "app/(app)/settings/calendar/page.tsx": {
    why: "legacy bookmark route that only redirects: it renders nothing and reads nothing",
    stillTrue: (sf) =>
      callLines(sf, "redirect").length > 0 &&
      !rendersJsx(sf) &&
      importsFrom(sf).every((m) => m === "next/navigation"),
  },
  "app/(app)/e2e-fault/[case]/page.tsx": {
    why: "E2E failure-injection fixture that is notFound() in every deployed build",
    stillTrue: (sf) =>
      callLines(sf, "notFound").length > 0 &&
      importsFrom(sf).includes("@/lib/reliability/e2e-route-fault"),
  },
};

const isAuthenticatedPage = (rel: string) =>
  rel.startsWith("app/(app)/") && /\/page\.(tsx|ts|jsx|js)$/.test(rel);

/** Authenticated pages that resolve no identity of their own. */
function pagesMissingGuard(modules: Module[]): string[] {
  return modules
    .filter(({ rel }) => isAuthenticatedPage(rel) && !(rel in GUARD_EXEMPT_PAGES))
    .filter(({ sf }) => callLines(sf, GUARD).length === 0)
    .map(({ rel }) => rel);
}

describe("server-rendered modules use the redirecting identity guard", () => {
  it("no page, layout or server component calls the throwing backstop", () => {
    const offenders = MODULES.flatMap(({ rel, sf }) =>
      callLines(sf, BACKSTOP).map((line) => `${rel}:${line}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the page behind the production Sentry group resolves identity with the guard", () => {
    const page = byRel.get("app/(app)/calendar/[id]/page.tsx");
    expect(page, "the scan must reach the incident page").toBeDefined();
    expect(callLines(page!.sf, GUARD)).toHaveLength(1);
  });

  it("the shell layout and the settings layout both use the guard", () => {
    for (const rel of ["app/(app)/layout.tsx", "app/(app)/settings/layout.tsx"]) {
      const layout = byRel.get(rel);
      expect(layout, `the scan must reach ${rel}`).toBeDefined();
      expect(callLines(layout!.sf, GUARD).length, rel).toBeGreaterThan(0);
    }
  });

  it("every authenticated page resolves identity ITSELF with the guard", () => {
    // Not calling the backstop is not enough. A layout's guard does not run on
    // a soft navigation, so a page that resolves nothing renders for a
    // practitioner whose membership was removed after the middleware admitted
    // the request: /clients/new handed exactly that user the new-client form.
    expect(pagesMissingGuard(MODULES)).toEqual([]);
  });

  it("each exemption from the guard still holds the property that makes it safe", () => {
    for (const [rel, { why, stillTrue }] of Object.entries(GUARD_EXEMPT_PAGES)) {
      const page = byRel.get(rel);
      expect(page, `exempt page no longer exists: ${rel}`).toBeDefined();
      expect(stillTrue(page!.sf), `${rel} is exempt as a ${why}; that no longer holds`).toBe(
        true,
      );
    }
  });
});

describe("anti-vacuity: the scan sees what it claims to rule out", () => {
  it("covers the authenticated app's pages, not an empty set", () => {
    const appPages = MODULES.filter(
      ({ rel }) => rel.startsWith("app/(app)/") && rel.endsWith("/page.tsx"),
    );
    // A floor, not a pin: adding a page must not red this file.
    expect(appPages.length).toBeGreaterThan(30);
    expect(MODULES.filter(({ sf }) => callLines(sf, GUARD).length > 0).length).toBeGreaterThan(30);
  });

  it("the detector FINDS the backstop where it is legitimately called (a server action)", () => {
    const rel = "app/(app)/calendar/[id]/manual-fee-actions.ts";
    const sf = parse(rel, readFileSync(path.join(ROOT, rel), "utf8"));
    expect(directive(sf)).toBe("use server");
    expect(callLines(sf, BACKSTOP).length).toBeGreaterThan(0);
    // ...and that module is correctly NOT in the server-rendered set.
    expect(byRel.has(rel)).toBe(false);
  });

  it("a page that calls the backstop is flagged; prose and strings that name it are not", () => {
    const mutant = parse(
      "page.tsx",
      [
        "// getCurrentPractitionerWithStudio() would throw here, which is the point.",
        'const label = "getCurrentPractitionerWithStudio()";',
        "export default async function Page() {",
        "  const { studio } = await getCurrentPractitionerWithStudio();",
        "  return <p>{studio.id}{label}</p>;",
        "}",
      ].join("\n"),
    );
    expect(callLines(mutant, BACKSTOP)).toEqual([4]);
  });

  it("a page that renders without the guard is flagged; a guarded one is not", () => {
    const bare = parse("page.tsx", "export default function P() { return <p>form</p>; }");
    const guarded = parse(
      "page.tsx",
      "export default async function P() { await requirePractitionerWithStudio(); return <p />; }",
    );
    expect(
      pagesMissingGuard([
        { rel: "app/(app)/bare/page.tsx", sf: bare },
        { rel: "app/(app)/guarded/page.tsx", sf: guarded },
        // Outside the authenticated group the rule does not apply.
        { rel: "app/book/[slug]/page.tsx", sf: bare },
      ]),
    ).toEqual(["app/(app)/bare/page.tsx"]);
    // ...and neither exemption's safety property accepts a page that renders a form.
    for (const { stillTrue } of Object.values(GUARD_EXEMPT_PAGES)) {
      expect(stillTrue(bare)).toBe(false);
    }
  });

  it("client components and server-action modules are excluded by their directive", () => {
    const client = parse("x.tsx", '"use client";\nexport function X() { return null; }');
    const action = parse("y.ts", '"use server";\nexport async function y() {}');
    const plain = parse("z.tsx", "export default function Z() { return null; }");
    expect(directive(client)).toBe("use client");
    expect(directive(action)).toBe("use server");
    expect(directive(plain)).toBeNull();
  });
});
