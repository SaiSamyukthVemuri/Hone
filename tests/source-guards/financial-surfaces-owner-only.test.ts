import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Regression tripwires for ALREADY owner-only studio-wide financial surfaces.
// No runtime authority is added. These syntax checks deliberately accept only
// the page/gate forms below; unsupported control flow fails for human review.
// The recording-client financial-briefing tests remain the behavioral proof.
// SQL checks establish the role constraint from ordered repository DDL, NOT a
// hosted catalog: relevant unsupported DDL fails closed rather than being ignored.
const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const parse = (text: string) => ts.createSourceFile("page.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, "").replace(/'/g, '"');
function nodes(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  function visit(n: ts.Node) { out.push(n); ts.forEachChild(n, visit); }
  visit(root);
  return out;
}
const callName = (call: ts.CallExpression) => call.expression.getText();
const calls = (root: ts.Node) => nodes(root).filter(ts.isCallExpression);
function component(src: ts.SourceFile): ts.FunctionDeclaration {
  const fn = src.statements.find((n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  if (!fn?.body) throw new Error("missing default function body");
  return fn;
}
const NON_OWNER = 'practitioner.role!=="owner"';
const ASSERTIONS = new Set(["assertStudioOwner", "requireStudioOwner"]);
function delegatedCall(stmt: ts.Statement): ts.CallExpression | undefined {
  return calls(stmt).find((c) => callName(c) === "loadFinancialsView" && c.arguments.length > 0 && compact(c.arguments[0]!) === "practitioner");
}
// Only a direct, executed delegation can qualify; a callback or string
// containing its name cannot satisfy the gate. Assertion names alone never
// supply authority: no runtime assertion helper currently has a proved contract.
function directCall(stmt: ts.Statement, target: ts.CallExpression): boolean {
  let expr: ts.Node | undefined;
  if (ts.isExpressionStatement(stmt)) expr = stmt.expression;
  if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1)
    expr = stmt.declarationList.declarations[0]!.initializer;
  if (expr && ts.isAwaitExpression(expr)) expr = expr.expression;
  return expr === target;
}
const TRUSTED_MODULES: Readonly<Record<string, string>> = {
  loadFinancialsView: "@/lib/finance/financial-briefing",
  redirect: "next/navigation",
  requirePractitionerWithStudio: "@/lib/supabase/queries",
  isReportingPeriod: "@/lib/booking/reporting-period",
  cookies: "next/headers", headers: "next/headers", draftMode: "next/headers",
};
function bindingNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((e) => ts.isOmittedExpression(e) ? [] : bindingNames(e.name));
}
function locallyDeclared(src: ts.SourceFile, name: string): boolean {
  return nodes(src).some((n) => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) return bindingNames(n.name).includes(name);
    return (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name;
  });
}
// Restricted import forms, not a spelling-based contract. Reject local shadows
// and duplicate/foreign imports; canonical helper behavior is checked separately.
function trustedCall(call: ts.CallExpression): boolean {
  const src = call.getSourceFile(), name = callName(call);
  if (name === "Array.isArray") return !locallyDeclared(src, "Array");
  if (!TRUSTED_MODULES[name] || locallyDeclared(src, name)) return false;
  const imports = src.statements.filter(ts.isImportDeclaration).flatMap((decl) => {
    const clause = decl.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return [];
    return clause.namedBindings.elements.filter((e) => e.name.text === name).map((e) => ({
      module: ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : "",
      original: (e.propertyName ?? e.name).text, typeOnly: e.isTypeOnly,
    }));
  });
  return imports.length === 1 && imports[0]!.module === TRUSTED_MODULES[name] &&
    imports[0]!.original === name && !imports[0]!.typeOnly;
}
// Refusal rendering is work too. Accept static intrinsic markup, not server
// components, spread props or dynamic expressions that can execute a read.
function inertReturn(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) return inertReturn(expression.expression);
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) ||
      [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(expression.kind)) return true;
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.every((p) =>
    ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && inertReturn(p.initializer));
  if (!ts.isJsxElement(expression) && !ts.isJsxSelfClosingElement(expression) && !ts.isJsxFragment(expression)) return false;
  const intrinsicTags = new Set(["section", "div", "p", "h1", "h2", "h3", "span", "strong", "em", "br"]);
  return nodes(expression).every((n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))
      return ts.isIdentifier(n.tagName) && intrinsicTags.has(n.tagName.text);
    if (ts.isJsxSpreadAttribute(n)) return false;
    if (ts.isJsxExpression(n)) return !n.expression || ts.isStringLiteral(n.expression) || ts.isNumericLiteral(n.expression);
    return true;
  });
}
function ownHalt(stmt: ts.Statement, requireInertReturn = true): boolean {
  const body = ts.isBlock(stmt) ? [...stmt.statements] : [stmt];
  if (body.length !== 1) return false;
  const last = body[0]!;
  if (ts.isReturnStatement(last)) return !requireInertReturn || !last.expression || inertReturn(last.expression);
  return ts.isExpressionStatement(last) && ts.isCallExpression(last.expression)
    && callName(last.expression) === "redirect" && trustedCall(last.expression)
    && last.expression.arguments.length === 1 && ts.isStringLiteral(last.expression.arguments[0]!);
}
// A returned refusal is not an exception. The caller must stop page work
// itself, before ANY statement after delegation can read financial data.
function delegationIssues(stmt: ts.Statement, next: ts.Statement | undefined): string[] {
  if (!ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1)
    return ["delegated result must be bound and awaited"];
  const declaration = stmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isAwaitExpression(declaration.initializer))
    return ["delegated result must be bound and awaited"];
  const call = declaration.initializer.expression;
  if (!ts.isCallExpression(call) || !trustedCall(call)) return ["delegation must use the canonical imported helper"];
  const allowedArguments = ["practitioner", "studio", "period"];
  if (call.arguments.length < 2 || call.arguments.length > 3 || call.arguments.some((arg, i) =>
    !ts.isIdentifier(arg) || arg.text !== allowedArguments[i]))
    return ["delegation arguments must be side-effect-free approved bindings"];
  const expected = `${declaration.name.text}.access==="refused"`;
  if (!next || !ts.isIfStatement(next) || compact(next.expression) !== expected || !ownHalt(next.thenStatement))
    return ["delegated refusal must halt immediately before later page work"];
  return [];
}
// Calls before the gate are restricted to identity, framework request primitives
// and the two pure period parsers used by the existing financials page. This
// also detects non-awaited .from/.rpc, parenthesized awaits, same-line reads,
// and reads before identity. Unknown forms fail rather than disappear.
const PREFIX_CALLS = new Set([
  "requirePractitionerWithStudio", "cookies", "headers", "draftMode",
  "Array.isArray", "isReportingPeriod",
]);
function pageIssues(text: string, delegationAllowed = false): string[] {
  const src = parse(text), fn = component(src), statements = [...fn.body!.statements];
  const issues: string[] = [];
  // Defaults (including nested destructuring defaults/computed keys) run
  // before the body. Existing Next bindings need no parameter-time work.
  if (fn.parameters.some((p) => nodes(p).some((n) =>
    ((ts.isParameter(n) || ts.isBindingElement(n)) && !!n.initializer) || ts.isComputedPropertyName(n))))
    issues.push("unsupported page parameter initialization");
  const gateIndex = statements.findIndex((stmt) => {
    if (ts.isIfStatement(stmt) && compact(stmt.expression) === NON_OWNER) return true;
    const delegated = delegationAllowed && delegatedCall(stmt);
    return !!delegated && directCall(stmt, delegated);
  });
  if (gateIndex < 0) return ["missing unconditional owner gate"];
  const gate = statements[gateIndex]!;
  const prefix = statements.slice(0, gateIndex);
  const identity = prefix.flatMap(calls).filter((c) => callName(c) === "requirePractitionerWithStudio");
  if (identity.length !== 1 || !ts.isAwaitExpression(identity[0]!.parent)) issues.push("identity must be awaited exactly once before gate");
  for (const stmt of prefix) {
    for (const call of calls(stmt)) {
      if (!PREFIX_CALLS.has(callName(call)) || !trustedCall(call)) issues.push(`untrusted pre-gate call: ${callName(call)}`);
    }
    for (const n of nodes(stmt)) {
      if (ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) ||
          ts.isPostfixUnaryExpression(n) || ts.isDeleteExpression(n) || ts.isYieldExpression(n) ||
          (ts.isPrefixUnaryExpression(n) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) ||
          (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            n.operatorToken.kind <= ts.SyntaxKind.LastAssignment))
        issues.push("unsupported executable pre-gate expression");
      if (ts.isAwaitExpression(n)) {
        const expr = n.expression;
        if (!(ts.isCallExpression(expr) && PREFIX_CALLS.has(callName(expr))) &&
            !(ts.isIdentifier(expr) && ["searchParams", "params"].includes(expr.text)))
          issues.push("unsupported pre-gate await");
      }
    }
  }
  if (ts.isIfStatement(gate)) {
    if (!ownHalt(gate.thenStatement)) issues.push("refusal must itself halt");
  } else {
    issues.push(...delegationIssues(gate, statements[gateIndex + 1]));
  }
  return issues;
}
function practitionerGates(text: string): string[] {
  // Scan syntax, not strings/comments. Both equivalent role predicates and
  // assertion/delegation helpers would violate the named sample's contract.
  return nodes(component(parse(text)).body!).flatMap((n) => {
    if (ts.isCallExpression(n) && (ASSERTIONS.has(callName(n)) || callName(n) === "loadFinancialsView")) return [callName(n)];
    if (ts.isIfStatement(n)) {
      const condition = compact(n.expression);
      const nonOwnerBranch = [NON_OWNER, 'practitioner.role==="practitioner"'].includes(condition)
        ? n.thenStatement : ['practitioner.role==="owner"', 'practitioner.role!=="practitioner"'].includes(condition)
          ? n.elseStatement : undefined;
      if (nonOwnerBranch && ownHalt(nonOwnerBranch, false)) return [n.expression.getText()];
    }
    return [];
  });
}
function helperIssues(text: string): string[] {
  const source = parse(text);
  const fn = source.statements.find((n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && n.name?.text === "loadFinancialsView");
  // Parameter initialization precedes the first body statement. Keep this
  // proof bounded to bare bindings and the existing unshadowed undefined
  // default; destructuring and other defaults require a separate proof.
  const shadowsUndefined = nodes(source).some((n) =>
    ts.isIdentifier(n) && n.text === "undefined" &&
    ("name" in n.parent && n.parent.name === n));
  if (!fn || fn.parameters.some((p) => !ts.isIdentifier(p.name) || p.name.text === "undefined" ||
      (p.initializer && (!ts.isIdentifier(p.initializer) || p.initializer.text !== "undefined" || shadowsUndefined))))
    return ["helper parameters must not execute work before refusal"];
  const first = fn.body?.statements[0];
  if (!first || !ts.isIfStatement(first) || compact(first.expression) !== NON_OWNER || !ownHalt(first.thenStatement))
    return ["helper must refuse as its first statement"];
  const halt = ts.isBlock(first.thenStatement) ? first.thenStatement.statements[0]! : first.thenStatement;
  if (!ts.isReturnStatement(halt) || !halt.expression || !ts.isObjectLiteralExpression(halt.expression) ||
      halt.expression.properties.length !== 1 ||
      !halt.expression.properties.every((p) => ts.isPropertyAssignment(p) && p.name.getText() === "access" &&
        ts.isStringLiteral(p.initializer) && p.initializer.text === "refused"))
    return ["helper must return access refused"];
  return [];
}
function discoverPages(rel: string): string[] {
  return readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = `${rel}/${entry.name}`;
    return entry.isDirectory() ? discoverPages(child) : entry.name === "page.tsx" ? [child] : [];
  }).sort();
}

// Bounded SQL inspection: locate the practitioners CREATE TABLE, select its
// role column (not the first CHECK on an unrelated column/table), and compare
// the ENTIRE CHECK. Later DDL that can change its effective meaning is refused.
const sqlCode = (s: string) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").replace(/"([a-z_]+)"/g, "$1");
function balanced(text: string, at: number): string {
  let depth = 0, quoted = false;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return text.slice(at + 1, i);
  }
  throw new Error("unbalanced SQL");
}
function sqlIdentifier(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
}
function roleIssues(migrations: Array<{ name: string; sql: string }>): string[] {
  const issues: string[] = [];
  let found = false;
  let roleConstraintName = "practitioners_role_check";
  for (const { name, sql: raw } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = sqlCode(raw);
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?practitioners\s*\(/i.exec(sql);
    if (create) {
      if (found) issues.push(`${name}: practitioners recreated`);
      found = true;
      const body = balanced(sql, create.index + create[0].length - 1);
      const role = /(?:^|,)\s*role\s+text\b[^,]*?(?:check\s*\()/i.exec(body);
      if (!role) { issues.push(`${name}: missing practitioners.role CHECK`); continue; }
      const named = /constraint\s+("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\s+check/i.exec(role[0]);
      if (/\bconstraint\b/i.test(role[0]) && !named) issues.push(`${name}: unsupported role constraint identifier`);
      roleConstraintName = named ? sqlIdentifier(named[1]!) : "practitioners_role_check";
      const definition = role[0].replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "");
      if (!/\bnot\s+null\b/i.test(definition)) issues.push(`${name}: practitioners.role must remain NOT NULL`);
      const expr = balanced(body, role.index + role[0].length - 1).replace(/\s+/g, "").replace(/^rolein\(/i, "rolein(");
      if (expr !== "rolein('owner','practitioner')") issues.push(`${name}: role CHECK domain changed`);
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?practitioners\b([^;]*)/gi)) {
      const change = m[1]!;
      const references = [...change.matchAll(/(?:drop|rename|alter|validate)\s+constraint\s+(?:if\s+exists\s+)?("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)/gi)];
      if (/\brole\b|\brename\b|\bset\s+schema\b/i.test(change) ||
          references.some((m) => sqlIdentifier(m[1]!) === roleConstraintName))
        issues.push(`${name}: effective role constraint needs migrated-catalog validation`);
    }
    if (/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?practitioners\b/i.test(sql)) issues.push(`${name}: practitioners dropped`);
  }
  if (!found) issues.push("missing practitioners table");
  return issues;
}

const PAYMENTS = discoverPages("app/(app)/settings/payments");
const FINANCIALS = discoverPages("app/(app)/financials");
describe("existing owner-only financial surface tripwires", () => {
  it("discovers the known pages non-vacuously", () => {
    for (const rel of ["page.tsx", "refresh/page.tsx", "return/page.tsx"])
      expect(PAYMENTS).toContain(`app/(app)/settings/payments/${rel}`);
    expect(FINANCIALS).toContain("app/(app)/financials/page.tsx");
  });
  for (const rel of PAYMENTS) it(`${rel}: identity then unconditional halting owner gate before reads`, () => expect(pageIssues(read(rel))).toEqual([]));
  for (const rel of FINANCIALS) it(`${rel}: no reads before identity/delegation`, () => expect(pageIssues(read(rel), true)).toEqual([]));
  it("helper refuses before table, RPC or other reads", () => expect(helperIssues(read("lib/finance/financial-briefing.ts"))).toEqual([]));
  for (const rel of ["app/(app)/dashboard/page.tsx", "app/(app)/clients/[id]/page.tsx"])
    it(`${rel}: named practitioner sample has no owner gate`, () => expect(practitionerGates(read(rel))).toEqual([]));
  it("ordered repository migrations retain exactly the practitioners role constraint", () => {
    const dir = path.join(ROOT, "supabase/migrations");
    expect(roleIssues(readdirSync(dir).filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(path.join(dir, name), "utf8") })))).toEqual([]);
  });
});

const TRUSTED_IMPORTS = `
  import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
  import { loadFinancialsView } from "@/lib/finance/financial-briefing";
  import { redirect } from "next/navigation";
`;
const page = (prefix: string, gate = 'if (practitioner.role !== "owner") { redirect("/settings/payments"); }') =>
  `${TRUSTED_IMPORTS} export default async function Page() { ${prefix} ${gate} await readMoney(); }`;
const identity = "const { practitioner, studio } = await requirePractitionerWithStudio();";
const baseSql = "create table public.practitioners (id uuid, role text not null check (role in ('owner', 'practitioner')));";
describe("permanent controls: supported weaknesses must turn the tripwire red", () => {
  it.each(["await readMoney();", "await (readMoney());", "db.from('money');", "await db.rpc('money');"])("detects %s before identity and on the gate's own line", (readCall) => {
    expect(pageIssues(page(readCall + identity))).not.toEqual([]);
    expect(pageIssues(page(identity + readCall))).not.toEqual([]);
    expect(pageIssues(page(identity + readCall, "await loadFinancialsView(practitioner, studio);"), true)).not.toEqual([]);
  });
  it("orders real owner refusal before reads and rejects unproven assertion names", () => {
    expect(pageIssues(page(identity))).toEqual([]);
    expect(pageIssues(page(identity, "assertStudioOwner(practitioner);"))).not.toEqual([]);
    expect(pageIssues(page(identity + "await readMoney();", "assertStudioOwner(practitioner);"))).not.toEqual([]);
    expect(pageIssues(page(identity, "items.map(() => assertStudioOwner(practitioner));"))).not.toEqual([]);
  });
  it.each(['items.map(() => { return null; });', 'const text = "redirect(";', '', 'if (flag) return null;'])("refusal does not halt through nested/string/conditional text: %s", (body) => {
    expect(pageIssues(page(identity, `if (practitioner.role !== "owner") { ${body} }`))).toContain("refusal must itself halt");
  });
  it("accepts the existing refusal return and rejects narrowed predicates", () => {
    expect(pageIssues(page(identity, 'if (practitioner.role !== "owner") return <p>Owner only</p>;'))).toEqual([]);
    expect(pageIssues(page(identity, 'if (practitioner.role !== "owner" && enabled) redirect("/");'))).not.toEqual([]);
  });
  it.each(['if (practitioner.role === "practitioner") redirect("/");', 'assertStudioOwner(practitioner);', 'requireStudioOwner(practitioner);'])("detects equivalent owner restriction on a practitioner sample: %s", (gate) => {
    expect(practitionerGates(page(identity, gate))).not.toEqual([]);
  });
  it("helper rejects ASI, RPC and arbitrary reads before its refusal", () => {
    for (const pre of ["await preloadFinancialData()\n", "await db.rpc('money');", "db.from('money');"])
      expect(helperIssues(`export async function loadFinancialsView() { ${pre} if (practitioner.role !== "owner") return { access: "refused" }; }`)).not.toEqual([]);
  });
  it("the helper's own return must be the refusal, not merely any return", () => {
    expect(helperIssues('export async function loadFinancialsView() { if (practitioner.role !== "owner") return { access: "granted" }; }')).not.toEqual([]);
  });
  it("role CHECK cannot be borrowed from another column or table", () => {
    expect(roleIssues([{ name: "0001.sql", sql: baseSql }])).toEqual([]);
    expect(roleIssues([{ name: "0001.sql", sql: "create table public.practitioners (role text, other text check (role in ('owner','practitioner'))); create table pending_invitations (role text check(role in ('owner','practitioner')));" }])).not.toEqual([]);
  });
  it.each(["studio-admin", "frontDesk", "admin2"])("whole CHECK rejects additional role %s", (role) => {
    expect(roleIssues([{ name: "0001.sql", sql: baseSql.replace("'practitioner'))", `'practitioner','${role}'))`) }])).not.toEqual([]);
    expect(roleIssues([{ name: "0001.sql", sql: baseSql.replace("'practitioner'))", `'practitioner') or role = '${role}')`) }])).not.toEqual([]);
  });
  it("preserves role literal case and tracks a named role constraint", () => {
    expect(roleIssues([{ name: "0001.sql", sql: baseSql.replace("'owner'", "'OWNER'") }])).not.toEqual([]);
    expect(roleIssues([
      { name: "0001.sql", sql: baseSql.replace("check (", "constraint membership_domain check (") },
      { name: "9999.sql", sql: "alter table public.practitioners drop constraint membership_domain;" },
    ])).not.toEqual([]);
  });
  it.each([
    "alter table public.practitioners drop constraint practitioners_role_check;",
    "alter table public.practitioners add constraint replacement check(role in ('owner','practitioner','admin'));",
    "alter table public.practitioners rename constraint practitioners_role_check to old_check;",
    "alter table public.practitioners drop column role;",
    "drop table public.practitioners;",
  ])("effective migrated constraint refuses unsupported later DDL: %s", (sql) => {
    expect(roleIssues([{ name: "0001.sql", sql: baseSql }, { name: "9999.sql", sql }])).not.toEqual([]);
  });
});

// Exact review regressions 4320848397 / 4320918043. These exercise the
// detector with unsafe source in memory, never the runtime pages themselves.
describe("delegation and assertion authority controls", () => {
  const financialPage = (body: string) => `${TRUSTED_IMPORTS} export default async function Page() { ${identity} ${body} }`;
  const delegate = "const view = await loadFinancialsView(practitioner, studio);";
  const refusal = 'if (view.access === "refused") return <p>Owner only</p>;';
  it("accepts a bound delegated result whose refusal halts before later reads", () => {
    expect(pageIssues(financialPage(`${delegate} ${refusal} await loadBalances(studio.id);`), true)).toEqual([]);
  });
  it.each([
    "await loadFinancialsView(practitioner, studio); await loadBalances(studio.id);",
    `${delegate} await loadBalances(studio.id);`,
    `${delegate} await loadBalances(studio.id); ${refusal}`,
    `${delegate} if (view.access === "refused") { items.map(() => { return null; }); } await loadBalances(studio.id);`,
    `${delegate} if (other.access === "refused") return null; await loadBalances(studio.id);`,
    'const view = loadFinancialsView(practitioner, studio); if (view.access === "refused") return null; await loadBalances(studio.id);',
  ])("refuses delegated work without its own timely halt: %s", (body) => {
    expect(pageIssues(financialPage(body), true)).not.toEqual([]);
  });
  it.each(["assertStudioOwner", "requireStudioOwner"])("unproven %s spelling cannot supply authority", (helper) => {
    for (const definition of [
      `function ${helper}() {}`,
      `function ${helper}(practitioner: unknown) { return false; }`,
      `import { ${helper} } from "./unverified-owner-helper";`,
    ]) {
      expect(pageIssues(`${definition} ${page(identity, `${helper}(practitioner);`)}`)).not.toEqual([]);
    }
  });
});

describe("current exact-head authority and role controls", () => {
  const resultGuard = 'if (view.access === "refused") return <p>Owner only</p>;';
  const delegatedPage = (argument: string) => `${TRUSTED_IMPORTS} export default async function Page() { ${identity} const view = await loadFinancialsView(practitioner, studio, ${argument}); ${resultGuard} await loadBalances(); }`;
  it.each(['await loadBalances(studio.id)', 'loadBalances(studio.id)', '(period = loadBalances())', '...values'])("delegation rejects argument work: %s", (argument) => {
    expect(pageIssues(delegatedPage(argument), true)).not.toEqual([]);
  });
  it("untrusted delegation imports and local redirects cannot supply a gate", () => {
    expect(pageIssues('import { loadFinancialsView } from "./untrusted"; ' + delegatedPage('period'), true)).not.toEqual([]);
    expect(pageIssues('function redirect() {} ' + page(identity))).not.toEqual([]);
  });
  it("quoted constraint removal cannot evade effective-role checks", () => {
    const named = baseSql.replace('check (', 'constraint "MembershipDomain" check (');
    expect(roleIssues([{ name: "0001.sql", sql: named }, { name: "9999.sql", sql: 'alter table public.practitioners drop constraint "MembershipDomain";' }])).not.toEqual([]);
  });
  it("role requires NOT NULL, not CHECK alone", () => {
    const nullable = baseSql.replace(/not null/gi, '');
    expect(roleIssues([{ name: "0001.sql", sql: nullable }])).not.toEqual([]);
  });
  it.each(['if (practitioner.role === "owner") return <OwnerTools />;', 'if (practitioner.role !== "practitioner") return <OwnerTools />;', 'if (practitioner.role === "owner") { showOwnerExtras(); }'])("owner-only UI does not deny practitioner access: %s", (branch) => {
    expect(practitionerGates(`export default async function Page() { ${identity} ${branch} return <SharedWork />; }`)).toEqual([]);
  });
  it("a non-halting practitioner-role branch is not an access gate", () => {
    expect(practitionerGates(`export default async function Page() { ${identity} if (practitioner.role === "practitioner") { showTools(); } return <SharedWork />; }`)).toEqual([]);
  });
});

describe("trusted gate and role-contract positive controls", () => {
  it("canonical delegation passes, but a local shadow or argument read cannot", () => {
    const body = `${identity} const view = await loadFinancialsView(practitioner, studio, period); if (view.access === "refused") return null; await loadBalances();`;
    expect(pageIssues(`${TRUSTED_IMPORTS} export default async function Page() { ${body} }`, true)).toEqual([]);
    expect(pageIssues(`${TRUSTED_IMPORTS} export default async function Page() { function loadFinancialsView() { return { access: "granted" }; } ${body} }`, true)).not.toEqual([]);
    expect(pageIssues(page(identity, 'if (practitioner.role !== "owner") redirect(loadBalances());'))).not.toEqual([]);
  });
  it.each(['MembershipDomain', 'Member.Domain', 'Member"Domain'])("retains quoted SQL identifier %s", (name) => {
    const quoted = '"' + name.replace(/"/g, '""') + '"';
    const sql = baseSql.replace('check (', `constraint ${quoted} check (`);
    expect(roleIssues([{ name: "0001.sql", sql }])).toEqual([]);
    expect(roleIssues([{ name: "0001.sql", sql }, { name: "9999.sql", sql: `alter table public.practitioners drop constraint ${quoted};` }])).not.toEqual([]);
  });
  it("a default string cannot masquerade as NOT NULL", () => {
    expect(roleIssues([{ name: "0001.sql", sql: baseSql.replace('not null', "default 'not null'") }])).not.toEqual([]);
  });
  it("detects a real non-owner halt in the else branch", () => {
    expect(practitionerGates(`${TRUSTED_IMPORTS} export default async function Page() { ${identity} if (practitioner.role === "owner") { showOwnerExtras(); } else { redirect("/"); } return <SharedWork />; }`)).not.toEqual([]);
    expect(practitionerGates(`${TRUSTED_IMPORTS} export default async function Page() { ${identity} if (practitioner.role === "practitioner") return <Refused />; return <OwnerWork />; }`)).not.toEqual([]);
  });
});

describe("refusal render and final discriminator controls", () => {
  it.each(['<FinancialDetails studio={studio} />', '<Financial.Details />', '<section><FinancialDetails /></section>'])("an executable refusal component is not inert: %s", (jsx) => {
    expect(pageIssues(page(identity, `if (practitioner.role !== "owner") return ${jsx};`))).not.toEqual([]);
  });
  it.each(['{ access: "refused", ...metadata }', '{ ...metadata, access: "refused" }', '{ access: "refused", access: "granted" }'])("the helper discriminator cannot be overridden: %s", (value) => {
    expect(helperIssues(`export async function loadFinancialsView() { if (practitioner.role !== "owner") return ${value}; }`)).not.toEqual([]);
  });
});


describe("helper parameter initialization controls", () => {
  const helper = (parameters: string) => `export async function loadFinancialsView(${parameters}) { if (practitioner.role !== "owner") return { access: "refused" }; }`;
  it("accepts the existing undefined default without executing parameter work", () => {
    expect(helperIssues(helper("practitioner, studio, period, supabaseClient = undefined"))).toEqual([]);
    expect(helperIssues(helper("practitioner, studio, period"))).toEqual([]);
  });
  it.each([
    "preload = readFinancials(studio.id)",
    "preload = (readFinancials(studio.id))",
    "preload = new FinancialReader()",
    "preload = settings.financials",
    "{ preload = readFinancials(studio.id) } = {}",
    "[preload = readFinancials(studio.id)] = []",
    "undefined, preload = undefined",
  ])("refuses executable or unproven parameter initialization: %s", (parameters) => {
    expect(helperIssues(helper(parameters))).not.toEqual([]);
  });
});


describe("page parameter and executable-prefix controls", () => {
  it.each(["preload = loadBalancesForCurrentStudio()", "{ preload = loadBalancesForCurrentStudio() }", "{ [loadBalancesForCurrentStudio()]: preload }"])("rejects pre-body parameter work: %s", (parameters) => {
    expect(pageIssues(page(identity).replace("function Page()", `function Page(${parameters})`))).not.toEqual([]);
  });
  it.each(["new FinancialReader(studio.id);", "financialReader`balance`;", "counter++;", "delete financials.balance;"])("rejects unsupported executable prefix: %s", (work) => {
    expect(pageIssues(page(`${identity} ${work}`))).not.toEqual([]);
  });
  it("keeps ordinary Next page parameter destructuring supported", () => {
    expect(pageIssues(page(identity).replace("function Page()", "function Page({ params, searchParams })"))).toEqual([]);
  });
});
