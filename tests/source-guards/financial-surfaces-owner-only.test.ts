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
  return calls(stmt).find((c) => callName(c) === "loadFinancialsView" && compact(c.arguments[0]!) === "practitioner");
}
function assertionCall(stmt: ts.Statement): ts.CallExpression | undefined {
  return calls(stmt).find((c) => ASSERTIONS.has(callName(c)) && c.arguments.length === 1 && compact(c.arguments[0]!) === "practitioner");
}
// Only a direct, executed top-level call counts as assertion/delegation; a
// callback or string containing the name cannot satisfy the gate.
function directCall(stmt: ts.Statement, target: ts.CallExpression): boolean {
  let expr: ts.Node | undefined;
  if (ts.isExpressionStatement(stmt)) expr = stmt.expression;
  if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1)
    expr = stmt.declarationList.declarations[0]!.initializer;
  if (expr && ts.isAwaitExpression(expr)) expr = expr.expression;
  return expr === target;
}
function ownHalt(stmt: ts.Statement): boolean {
  const body = ts.isBlock(stmt) ? [...stmt.statements] : [stmt];
  if (body.length !== 1) return false;
  const last = body[0]!;
  if (ts.isReturnStatement(last)) return !last.expression || calls(last.expression).length === 0;
  return ts.isExpressionStatement(last) && ts.isCallExpression(last.expression)
    && callName(last.expression) === "redirect";
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
  const gateIndex = statements.findIndex((stmt) => {
    if (ts.isIfStatement(stmt) && compact(stmt.expression) === NON_OWNER) return true;
    const assertion = assertionCall(stmt);
    if (assertion && directCall(stmt, assertion)) return true;
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
      if (!PREFIX_CALLS.has(callName(call))) issues.push(`pre-gate call: ${callName(call)}`);
    }
    for (const n of nodes(stmt)) {
      if (ts.isAwaitExpression(n)) {
        const expr = n.expression;
        if (!(ts.isCallExpression(expr) && PREFIX_CALLS.has(callName(expr))) &&
            !(ts.isIdentifier(expr) && ["searchParams", "params"].includes(expr.text)))
          issues.push("unsupported pre-gate await");
      }
    }
  }
  if (ts.isIfStatement(gate) && !ownHalt(gate.thenStatement)) issues.push("refusal must itself halt");
  return issues;
}
function practitionerGates(text: string): string[] {
  // Scan syntax, not strings/comments. Both equivalent role predicates and
  // assertion/delegation helpers would violate the named sample's contract.
  return nodes(component(parse(text)).body!).flatMap((n) => {
    if (ts.isCallExpression(n) && (ASSERTIONS.has(callName(n)) || callName(n) === "loadFinancialsView")) return [callName(n)];
    if (ts.isIfStatement(n) && nodes(n.expression).some((x) => ts.isPropertyAccessExpression(x) && x.name.text === "role")) {
      const literals = nodes(n.expression).filter(ts.isStringLiteral).map((x) => x.text);
      if (literals.includes("owner") || literals.includes("practitioner")) return [n.expression.getText()];
    }
    return [];
  });
}
function helperIssues(text: string): string[] {
  const fn = parse(text).statements.find((n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && n.name?.text === "loadFinancialsView");
  const first = fn?.body?.statements[0];
  if (!first || !ts.isIfStatement(first) || compact(first.expression) !== NON_OWNER || !ownHalt(first.thenStatement))
    return ["helper must refuse as its first statement"];
  const halt = ts.isBlock(first.thenStatement) ? first.thenStatement.statements[0]! : first.thenStatement;
  if (!ts.isReturnStatement(halt) || !halt.expression || !ts.isObjectLiteralExpression(halt.expression) ||
      !halt.expression.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === "access" &&
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
      roleConstraintName = /constraint\s+([a-z_][a-z0-9_]*)/i.exec(role[0])?.[1] ?? "practitioners_role_check";
      const expr = balanced(body, role.index + role[0].length - 1).replace(/\s+/g, "").replace(/^rolein\(/i, "rolein(");
      if (expr !== "rolein('owner','practitioner')") issues.push(`${name}: role CHECK domain changed`);
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?practitioners\b([^;]*)/gi)) {
      const change = m[1]!;
      if (/\brole\b|\brename\b|\bset\s+schema\b/i.test(change) ||
          new RegExp(`\\b${roleConstraintName}\\b`, "i").test(change))
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

const page = (prefix: string, gate = 'if (practitioner.role !== "owner") { redirect("/settings/payments"); }') =>
  `export default async function Page() { ${prefix} ${gate} await readMoney(); }`;
const identity = "const { practitioner, studio } = await requirePractitionerWithStudio();";
const baseSql = "create table public.practitioners (id uuid, role text check (role in ('owner', 'practitioner')));";
describe("permanent controls: supported weaknesses must turn the tripwire red", () => {
  it.each(["await readMoney();", "await (readMoney());", "db.from('money');", "await db.rpc('money');"])("detects %s before identity and on the gate's own line", (readCall) => {
    expect(pageIssues(page(readCall + identity))).not.toEqual([]);
    expect(pageIssues(page(identity + readCall))).not.toEqual([]);
    expect(pageIssues(page(identity + readCall, "await loadFinancialsView(practitioner, studio);"), true)).not.toEqual([]);
  });
  it("compares reads directly with assertion position, never suffix length", () => {
    expect(pageIssues(page(identity, "assertStudioOwner(practitioner);"))).toEqual([]);
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
