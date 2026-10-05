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
// the same side of the line. Calls are found with the TypeScript parser, so a
// comment or a string that names the backstop is never mistaken for a call.

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

  it("client components and server-action modules are excluded by their directive", () => {
    const client = parse("x.tsx", '"use client";\nexport function X() { return null; }');
    const action = parse("y.ts", '"use server";\nexport async function y() {}');
    const plain = parse("z.tsx", "export default function Z() { return null; }");
    expect(directive(client)).toBe("use client");
    expect(directive(action)).toBe("use server");
    expect(directive(plain)).toBeNull();
  });
});
