import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Roles clinical-read gating, Part B guard. A loader that returns `Gated<T>` ({kind: ok | restricted | unavailable}) must have its result
// CONSUMED with a `.kind` check; reading `.value` without one, or handing the result on opaquely (argument, spread, return), would let a
// restricted result be treated as data (an empty "ok", an all-clear).
//
// It resolves BINDINGS, not spelling: a producer is a function whose declared return type is `Gated<...>` (found across lib/, app/, components/),
// and a consumer binding is a `const x = <producer>(...)` (through an import alias) or any `const x: Gated<...>`. For each binding it checks the
// scope that declares it: at least one `.kind` comparison, no use as anything but the object of a property access, and every `.value` access
// sits under a condition that mentions `x.kind`. THIS IS A TRIPWIRE, NOT A PROOF; STATED_LIMITS says what it cannot see.

type Violation = { file: string; binding: string; why: string };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const visit = (n: ts.Node, f: (n: ts.Node) => void) => { f(n); ts.forEachChild(n, (c) => visit(c, f)); };
const isGatedType = (t: ts.TypeNode | undefined) => !!t && /(^|[^\w])Gated</.test(t.getText());

/** Names (local to the file's declarations) of functions whose declared return type is Gated<...>. */
export function producersIn(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  visit(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && isGatedType(n.type)) out.push(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && isGatedType(n.initializer.type)) {
      out.push(n.name.text);
    }
  });
  return out;
}

/** Imported names (with alias resolved back to the exporting name) that are producers. */
function importedProducers(sf: ts.SourceFile, producersByName: Set<string>): Map<string, string> {
  const local = new Map<string, string>(); // local identifier -> producer name
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    for (const el of st.importClause.namedBindings.elements) {
      const exported = (el.propertyName ?? el.name).text;
      if (producersByName.has(exported)) local.set(el.name.text, exported);
    }
  }
  return local;
}

export function analyze(file: string, text: string, producers: Set<string>): Violation[] {
  const sf = parse(file, text);
  const names = new Map<string, string>(importedProducers(sf, producers));
  for (const p of producersIn(sf)) names.set(p, p);
  const out: Violation[] = [];
  visit(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name)) return;
    const init = n.initializer ? (ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer) : undefined;
    const fromProducer = !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && names.has(init.expression.text);
    if (!fromProducer && !isGatedType(n.type)) return;
    const binding = n.name.text;
    // the declaring scope: the nearest enclosing block / function / source file
    let scope: ts.Node = n;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    // module-level constants (the GATED_* sentinels in lib/permissions/gated.ts) are definitions, not consumers
    if (ts.isSourceFile(scope)) return;
    let kindChecks = 0;
    visit(scope, (u) => {
      if (!ts.isIdentifier(u) || u.text !== binding || u === n.name) return;
      const parent = u.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === u) {
        if (parent.name.text === "kind") { kindChecks += 1; return; }
        if (parent.name.text === "value") {
          // every `.value` must sit under a condition that mentions `<binding>.kind`
          let guarded = false;
          for (let a: ts.Node | undefined = parent.parent; a && !ts.isFunctionLike(a) && !ts.isSourceFile(a); a = a.parent) {
            const cond =
              ts.isConditionalExpression(a) ? a.condition
              : ts.isIfStatement(a) ? a.expression
              : ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? a.left
              : null;
            if (cond && cond.getText().includes(`${binding}.kind`)) { guarded = true; break; }
          }
          if (!guarded) out.push({ file, binding, why: "reads .value without a .kind check around it" });
          return;
        }
      }
      out.push({ file, binding, why: `used as ${ts.SyntaxKind[parent.kind]}, not through .kind (a restricted result could be passed on as data)` });
    });
    if (kindChecks === 0) out.push({ file, binding, why: "never checks .kind (restricted is not handled)" });
  });
  return out;
}

const ROOTS = ["app", "lib", "components"];
const FILES = ROOTS.flatMap((r) => sourceFiles(r));

describe("Gated<T> results are consumed with a .kind check", () => {
  const producers = new Set<string>();
  for (const f of FILES) for (const p of producersIn(parse(f, readFileSync(f, "utf8")))) producers.add(p);

  it("finds the real producers (the guard is not vacuous)", () => {
    expect([...producers]).toContain("selfReportedFitzpatrickFor");
  });

  it("every consumer in app/, lib/ and components/ handles the result through .kind", () => {
    const violations = FILES.flatMap((f) => analyze(f, readFileSync(f, "utf8"), producers));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("the known surfaces are consumers the guard actually analyses (the images picker and the intake card)", () => {
    const images = readFileSync("app/(app)/clients/[id]/images/page.tsx", "utf8");
    const client = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
    expect(images).toMatch(/const sessionPicker: Gated</);
    expect(client).toMatch(/const selfReportedFitzpatrick = selfReportedFitzpatrickFor\(/);
    expect(analyze("images", images, producers)).toEqual([]);
    expect(analyze("client", client, producers)).toEqual([]);
  });

  describe("negative fixtures: each of these is refused", () => {
    const P = new Set(["loadThing"]);
    const head = 'import { loadThing } from "./x";\nimport type { Gated } from "@/lib/permissions/gated";\n';
    const bad = (body: string) => analyze("fixture.tsx", head + body, P).map((v) => v.why);
    it("reads .value with no .kind check", () => {
      expect(bad("export async function f() { const g = await loadThing(); return g.value; }").join("|")).toMatch(/\.value without a \.kind/);
    });
    it("never checks .kind", () => {
      expect(bad("export async function f() { const g = await loadThing(); return 1; }").join("|")).toMatch(/never checks \.kind/);
    });
    it("hands the result on opaquely", () => {
      expect(bad("export async function f() { const g = await loadThing(); return render(g); }").join("|")).toMatch(/not through \.kind/);
    });
    it("a typed Gated binding is also analysed", () => {
      expect(bad("export function f(x: number) { const g: Gated<number> = make(x); return g.value; }").join("|")).toMatch(/\.value without a \.kind/);
    });
    it("an aliased import is resolved to the producer", () => {
      const v = analyze("fixture.tsx", 'import { loadThing as lt } from "./x";\nexport async function f() { const g = await lt(); return g.value; }', P);
      expect(v.map((x) => x.why).join("|")).toMatch(/\.value without a \.kind/);
    });
    it("controls: a .kind-guarded read, and a ternary on .kind, are accepted", () => {
      expect(bad('export async function f() { const g = await loadThing(); return g.kind === "ok" ? g.value : null; }')).toEqual([]);
      expect(bad('export async function f() { const g = await loadThing(); if (g.kind === "restricted") return null; return g.kind === "ok" && g.value; }')).toEqual([]);
    });
  });
});

// STATED_LIMITS (what this tripwire cannot see): a restricted result copied through another variable (`const h = g`) is flagged only because the
// copy is a non-property use; a loader that returns a bare array or boolean instead of Gated is not covered (the census lists those readers and
// each is tested by name); a type-only `Gated` alias would hide a producer. The DB policy is the boundary; this guards the rendering rule.
