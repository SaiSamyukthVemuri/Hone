import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Census of every path that can write or release protected data, derived from the source with the TypeScript
// parser (never by matching spelling): each exported server action, each HTTP handler of a route file, and each
// database command the app calls by name. permission-coverage.test.ts holds the explicit decision for every entry.
//
// "Evidence" is what the code of the entry itself does, and only that. A gate that lives in a helper the entry calls
// is NOT seen here; such an entry names the helper (`via`) and the test checks the entry really calls it.

const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export const STAFF_HELPERS = new Set(["getCurrentPractitionerWithStudio", "requirePractitionerWithStudio"]);
export const ADMIN_CLIENT_FACTORIES = new Set(["createAdminClient", "createServiceClient"]);

export type Evidence = {
  /** Reaches a shared helper that resolves the signed-in practitioner and studio (a receptionist is not one). */
  staffHelper: string[];
  /** The entry first awaits the active, selected-studio receptionist guard directly. */
  receptionistGuard: boolean;
  /** The helper the entry calls directly that leads to the staff helper, or null when it calls it itself. */
  staffVia: string | null;
  /** A guard that refuses a non-owner before the rest of the entry runs: its own, or a helper it calls first. */
  ownerGuard: boolean;
  /** The helper the entry calls at the top level that carries the owner guard, or null when the guard is its own. */
  ownerVia: string | null;
  /** How the guard refuses: by throwing (aborts the caller) or by returning a value the caller must check. */
  ownerKind: "throws" | "returns" | null;
  /** Uses a service-role client, which bypasses row security. */
  adminClient: boolean;
  /** Keys it asks the permission engine about (observe only today). */
  observed: string[];
  /** Every callee name in the body, so a `via` helper can be checked. */
  calls: string[];
};

export type PathEntry = { id: string; kind: "action" | "route"; file: string; name: string; evidence: Evidence | null };

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(name)) out.push(full);
  }
  return out;
}

const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const hasExport = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
const isFunctionLike = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

const comparesOwner = (n: ts.Node): boolean => {
  let found = false;
  const visit = (x: ts.Node) => {
    if (ts.isBinaryExpression(x) && [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(x.operatorToken.kind)) {
      const lit = (s: ts.Expression) => ts.isStringLiteral(s) && s.text === "owner";
      const role = (s: ts.Expression) => (ts.isPropertyAccessExpression(s) && s.name.text === "role") || (ts.isIdentifier(s) && s.text === "role");
      if ((lit(x.left) && role(x.right)) || (lit(x.right) && role(x.left))) found = true;
    }
    ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
};

/** How a refusal leaves: by throwing (or notFound/redirect), which aborts the caller, or by returning a value the caller must check. */
const refusalKind = (s: ts.Statement): "throws" | "returns" | null => {
  const last = ts.isBlock(s) ? s.statements[s.statements.length - 1] : s;
  if (!last) return null;
  if (ts.isThrowStatement(last)) return "throws";
  if (ts.isReturnStatement(last)) return "returns";
  if (ts.isExpressionStatement(last) && ts.isCallExpression(last.expression) && ["notFound", "redirect", "forbidden"].includes(calleeName(last.expression) ?? "")) return "throws";
  return null;
};

const endsInRefusal = (s: ts.Statement): boolean => {
  const last = ts.isBlock(s) ? s.statements[s.statements.length - 1] : s;
  if (!last) return false;
  if (ts.isReturnStatement(last) || ts.isThrowStatement(last)) return true;
  if (ts.isExpressionStatement(last) && ts.isCallExpression(last.expression)) return ["notFound", "redirect", "forbidden"].includes(calleeName(last.expression) ?? "");
  return false;
};

// The statements that run unconditionally at the top of a body. A `try` is looked into only when its catch cannot
// fall through (it returns or throws), because then a guard inside the try still protects everything after it.
function topStatements(body: ts.Node): ts.Statement[] {
  if (!ts.isBlock(body)) return [];
  const out: ts.Statement[] = [];
  for (const st of body.statements) {
    out.push(st);
    if (ts.isTryStatement(st) && (!st.catchClause || endsInRefusal(st.catchClause.block))) out.push(...topStatements(st.tryBlock));
  }
  return out;
}

function ownerGuard(body: ts.Node): "throws" | "returns" | null {
  if (!ts.isBlock(body)) return null;
  // Refuses when the actor is NOT owner: `role !== "owner"`, possibly OR-ed with more conditions.
  const refusesNonOwner = (c: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(c)) return refusesNonOwner(c.expression);
    if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.BarBarToken) return refusesNonOwner(c.left) || refusesNonOwner(c.right);
    return ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && comparesOwner(c);
  };
  for (const s of topStatements(body)) {
    if (ts.isIfStatement(s) && refusesNonOwner(s.expression) && endsInRefusal(s.thenStatement)) return refusalKind(s.thenStatement);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolving the helpers an entry calls. A gate usually lives in a helper (`assertOwner`, `requireOwner`), so the
// evidence follows plain calls into functions of the same file and into named imports from this repository, to a
// bounded depth. A call it cannot resolve contributes nothing: the census under-reports a gate, never invents one.
// ---------------------------------------------------------------------------
const MAX_DEPTH = 3;
const parsed = new Map<string, ts.SourceFile | null>();
const fnIndex = new Map<string, Map<string, ts.Node>>();
const importIndex = new Map<string, Map<string, { file: string; name: string }>>();

function sourceOf(root: string, rel: string): ts.SourceFile | null {
  const key = `${root}\0${rel}`;
  if (parsed.has(key)) return parsed.get(key)!;
  let sf: ts.SourceFile | null = null;
  try {
    sf = parse(join(root, rel), readFileSync(join(root, rel), "utf8"));
  } catch {
    sf = null;
  }
  parsed.set(key, sf);
  return sf;
}

function resolveModule(root: string, from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = join(from.split("/").slice(0, -1).join("/"), spec).replace(/\\/g, "/");
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      if (statSync(join(root, cand)).isFile()) return cand;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function functionsOf(root: string, rel: string): Map<string, ts.Node> {
  const key = `${root}\0${rel}`;
  const hit = fnIndex.get(key);
  if (hit) return hit;
  const map = new Map<string, ts.Node>();
  const sf = sourceOf(root, rel);
  if (sf) {
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) map.set(st.name.text, st);
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && isFunctionLike(d.initializer)) map.set(d.name.text, d.initializer);
    }
  }
  fnIndex.set(key, map);
  return map;
}

function importsOf(root: string, rel: string): Map<string, { file: string; name: string }> {
  const key = `${root}\0${rel}`;
  const hit = importIndex.get(key);
  if (hit) return hit;
  const map = new Map<string, { file: string; name: string }>();
  const sf = sourceOf(root, rel);
  if (sf) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
      const file = resolveModule(root, rel, st.moduleSpecifier.text);
      if (!file) continue;
      for (const el of st.importClause.namedBindings.elements) map.set(el.name.text, { file, name: (el.propertyName ?? el.name).text });
    }
  }
  importIndex.set(key, map);
  return map;
}

function lookup(root: string, file: string, name: string): { file: string; node: ts.Node } | null {
  const local = functionsOf(root, file).get(name);
  if (local) return { file, node: local };
  const imp = importsOf(root, file).get(name);
  if (!imp) return null;
  const node = functionsOf(root, imp.file).get(imp.name);
  return node ? { file: imp.file, node } : null;
}

const bodyOf = (node: ts.Node): ts.Node => (ts.isFunctionDeclaration(node) || isFunctionLike(node) ? (node.body ?? node) : node);

function topLevelCalls(body: ts.Node): string[] {
  const names: string[] = [];
  for (const st of topStatements(body)) {
    let e: ts.Expression | undefined;
    if (ts.isExpressionStatement(st)) e = st.expression;
    else if (ts.isVariableStatement(st)) e = st.declarationList.declarations[0]?.initializer;
    if (e && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) e = e.right;
    while (e && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))) e = e.expression;
    if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression)) names.push(e.expression.text);
  }
  return names;
}

function startsWithReceptionistGuard(root: string, file: string, body: ts.Node): boolean {
  if (!ts.isBlock(body)) return false;
  const first = body.statements[0];
  if (!first) return false;
  const expression = ts.isExpressionStatement(first) ? first.expression
    : ts.isVariableStatement(first) ? first.declarationList.declarations[0]?.initializer : undefined;
  if (!expression || !ts.isAwaitExpression(expression) || !ts.isCallExpression(expression.expression)) return false;
  const call = expression.expression.expression;
  if (!ts.isIdentifier(call)) return false;
  const imported = importsOf(root, file).get(call.text);
  return imported?.file === "lib/desk/guard.ts" && imported.name === "requireReceptionistWithStudio";
}

function evidenceOf(root: string, file: string, node: ts.Node, depth = 0, seen: Set<string> = new Set()): Evidence {
  const calls = new Set<string>();
  const observed: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name) calls.add(name);
      if (name === "observePermission") {
        const arg = n.arguments[3];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === "key" && ts.isStringLiteral(p.initializer)) observed.push(p.initializer.text);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  const body = bodyOf(node);
  const staff = new Set([...calls].filter((c) => STAFF_HELPERS.has(c)));
  let staffVia: string | null = staff.size ? null : null;
  let ownerKind = ownerGuard(body);
  let guard = ownerKind !== null;
  let ownerVia: string | null = null;
  const topCalls = new Set(topLevelCalls(body));
  if (depth < MAX_DEPTH) {
    for (const name of [...calls].sort()) {
      if (STAFF_HELPERS.has(name)) continue;
      const found = lookup(root, file, name);
      const id = found ? `${found.file}#${name}` : "";
      if (!found || seen.has(id)) continue;
      const sub = evidenceOf(root, found.file, found.node, depth + 1, new Set([...seen, id]));
      if (sub.staffHelper.length && !staff.size) staffVia ??= name;
      for (const h of sub.staffHelper) staff.add(h);
      if (!guard && sub.ownerGuard && topCalls.has(name)) {
        guard = true;
        ownerVia = name;
        ownerKind = sub.ownerKind;
      }
    }
  }
  return {
    staffHelper: [...staff].sort(),
    receptionistGuard: startsWithReceptionistGuard(root, file, body),
    staffVia: staff.size && [...calls].some((c) => STAFF_HELPERS.has(c)) ? null : staffVia,
    ownerGuard: guard,
    ownerVia,
    ownerKind,
    adminClient: [...calls].some((c) => ADMIN_CLIENT_FACTORIES.has(c)),
    observed: observed.sort(),
    calls: [...calls].sort(),
  };
}

function exportsOf(sf: ts.SourceFile, routeFile: boolean): Array<{ name: string; node: ts.Node | null }> {
  const locals = new Map<string, ts.Node>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) locals.set(s.name.text, s);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
  }
  const out: Array<{ name: string; node: ts.Node | null }> = [];
  const push = (name: string, node: ts.Node | null) => {
    if (routeFile ? !ROUTE_METHODS.has(name) : false) return;
    out.push({ name, node });
  };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && hasExport(s)) push(hasDefault(s) ? "default" : (s.name?.text ?? "default"), s);
    else if (ts.isVariableStatement(s) && hasExport(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        // In a server-action file only functions are actions; a route file exports config consts too, filtered by name.
        if (!routeFile && !(d.initializer && (isFunctionLike(d.initializer) || ts.isCallExpression(d.initializer)))) continue;
        push(d.name.text, d.initializer ?? null);
      }
    } else if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      if (s.moduleSpecifier) {
        if (!s.exportClause) push("*", null);
        else if (ts.isNamedExports(s.exportClause)) {
          for (const el of s.exportClause.elements) {
            if (!el.isTypeOnly) push(el.name.text, null);
          }
        }
      } else if (s.exportClause && ts.isNamedExports(s.exportClause)) {
        for (const el of s.exportClause.elements) if (!el.isTypeOnly) push(el.name.text, locals.get((el.propertyName ?? el.name).text) ?? null);
      }
    } else if (ts.isExportAssignment(s)) push("default", s.expression);
  }
  return out;
}

const isUseServer = (sf: ts.SourceFile) => {
  const first = sf.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
};

export function censusPaths(root: string): PathEntry[] {
  const entries: PathEntry[] = [];
  const files = ["app", "lib", "components"].flatMap((d) => {
    try {
      return walk(join(root, d), (n) => /\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n));
    } catch {
      return [];
    }
  });
  for (const full of files.sort()) {
    const file = full.slice(root.length + 1);
    const text = readFileSync(full, "utf8");
    const routeFile = /(^|\/)route\.ts$/.test(file);
    if (!routeFile && !text.includes("use server")) continue;
    const sf = parse(full, text);
    if (!routeFile && !isUseServer(sf)) continue;
    for (const { name, node } of exportsOf(sf, routeFile)) {
      entries.push({ id: `${file}#${name}`, kind: routeFile ? "route" : "action", file, name, evidence: node ? evidenceOf(root, file, node) : null });
    }
  }
  return entries;
}

export type RpcCall = { name: string; file: string };

/** Every database command the app calls by name. A non-literal name is reported as `<dynamic>` and must be decided. */
export function censusRpcs(root: string): RpcCall[] {
  const out: RpcCall[] = [];
  for (const d of ["app", "lib", "components"]) {
    let files: string[] = [];
    try {
      files = walk(join(root, d), (n) => /\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n));
    } catch {
      continue;
    }
    for (const full of files) {
      const text = readFileSync(full, "utf8");
      if (!text.includes("rpc")) continue;
      const file = full.slice(root.length + 1);
      const sf = parse(full, text);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "rpc") {
          const a = n.arguments[0];
          out.push({ name: a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : "<dynamic>", file });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
// One short string per entry, `<kind>[(<detail>)][+admin]`:
//   observed(keys)      asks the permission engine (observe only today) and is otherwise gated as below
//   owner(helper|self)  refuses a non-owner at the top of its body; the guard is its own or the named helper's, and
//                       a helper's guard throws, so it aborts the entry. Anything before the guard may run for anyone.
//   owner?(helper)      the helper only RETURNS a refusal value for a non-owner; the entry is owner-gated if it checks
//                       that value, which this census does not verify. Read the entry before relying on it.
//   staff               reaches the practitioner-and-studio helper: any ACTIVE PRACTITIONER of the studio, no role
//                       distinction, and a receptionist is not one. The engine is not asked yet.
//   not_staff(class)    no staff session by design; the class says which kind of caller (checked against the path)
//   unresolved(reason)  nothing found and no class fits. A ratchet in the test: it may only shrink.
//   +admin              also uses a service-role client, which bypasses row security
export const NOT_STAFF_CLASSES: Record<string, RegExp> = {
  auth: /^app\/\(auth\)\/|^app\/\(app\)\/dashboard\/actions\.ts$/,
  platform_admin: /^app\/admin\/|^app\/api\/admin\//,
  public_booking: /^app\/book\/|^app\/actions\//,
  portal: /^app\/portal\//,
  token_link: /\[token\]/,
  cron: /^app\/api\/cron\//,
  webhook: /^app\/api\/(stripe|twilio)\/|^app\/api\/billing\/webhook\/route\.ts$/,
  // Public sign-in establishes the actor before the app can resolve membership.
  signup: /^app\/signup\/actions\.ts$/,
  oauth: /^app\/api\/google-calendar\//,
  // The front desk (lib/desk): a signed-in RECEPTIONIST by design, so it never reaches the practitioner-and-studio helper. Its one server action
  // re-reads the caller's active receptionist rows in the same request before it writes anything (a selected-studio cookie, nothing else).
  // NARROW on purpose: only that one file. A new server action anywhere else under lib/desk resolves as `unresolved(no gate found)` until someone
  // reads it and decides, instead of inheriting this class by directory.
  desk: /^lib\/desk\/choose-actions\.ts$/,
  telemetry: /^app\/(ingest|monitoring)\//,
};

export function notStaffClass(file: string): string | null {
  for (const [cls, re] of Object.entries(NOT_STAFF_CLASSES)) if (re.test(file)) return cls;
  return null;
}

export function decisionOf(entry: PathEntry): string {
  const ev = entry.evidence;
  if (!ev) return "unresolved(export has no analysable body)";
  const admin = ev.adminClient ? "+admin" : "";
  if (ev.observed.length) return `observed(${[...new Set(ev.observed)].join(",")})${admin}`;
  if (ev.ownerGuard) {
    // A guard of its own, or a helper that throws, aborts the entry. A helper that only RETURNS a refusal value
    // (a null studio id, say) is owner-gated only if the caller checks that value, which is not verified here.
    if (ev.ownerVia === null) return `owner(self)${admin}`;
    return ev.ownerKind === "throws" ? `owner(${ev.ownerVia})${admin}` : `owner?(${ev.ownerVia})${admin}`;
  }
  if (ev.staffHelper.length) return `staff${admin}`;
  if (ev.receptionistGuard) return `receptionist(selected_studio)${admin}`;
  const cls = notStaffClass(entry.file);
  return cls ? `not_staff(${cls})${admin}` : `unresolved(no gate found)${admin}`;
}
