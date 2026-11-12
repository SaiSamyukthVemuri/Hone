import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Roles clinical-read gating, I5 standing rule. A clin.view_records SELECT policy on `sessions` (0333) means a loader that is gated by
// ownership (`viewerIsOwner`) or by a payment/record-keeping key (`pay.*`, `records.*`) but reads `sessions` through the USER client would read ZERO
// rows for a role that holds that key without clin.view_records. When a reader moves from owner-only to permission keys, its sessions
// (price/payment/appointment link) reads must go through the admin client behind that key, or a definer projection.
//
// This guard fails when a source file (a) reads `sessions` (from("sessions") or an embed `sessions(`/`sessions!`) through the RLS client, (b) is gated by
// viewerIsOwner, a pay.* / records.* permission key, and (c) does NOT also gate on clin.view_records, unless it is listed in EXEMPT with a reason.
// An EXEMPT entry that no longer matches the rule is itself a failure (a stale exemption would hide a future regression).
//
// What counts as a gate: viewerIsOwner / isOwner / actorIsOwner, `<x>.role === "owner"` or `!== "owner"`, and a pay.* / records.* key string.
// The clin.view_records gate must be a requirePermission(...) call INSIDE the same top-level function that reads sessions (not a string elsewhere in the file).
// KNOWN LIMIT: CROSS-FILE reads are NOT covered. A loader gated in one file that reads sessions in a helper imported from another file is invisible
// here (Team mutation M5); review such a helper by hand. This is a tripwire for the standing rule, not a proof of it.

type Hit = { file: string; why: string };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(text: string): string {
  const sf = ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n) || ts.isIdentifier(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return parts.join(" ");
}

type UnitInfo = { reads: boolean; usesAdmin: boolean; ownerOrPay: boolean; clin: boolean };

const isOwnerLiteral = (n: ts.Node) => ts.isStringLiteralLike(n) && n.text === "owner";

/** One top-level function / variable / default export: what it reads and which gates appear INSIDE it. */
function unitInfo(sf: ts.SourceFile, unit: ts.Node): UnitInfo {
  const info: UnitInfo = { reads: false, usesAdmin: false, ownerOrPay: false, clin: false };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === "sessions") info.reads = true;
      // the clin gate is a requirePermission(...) CALL that names the key, not a string that merely appears
      if (ts.isIdentifier(n.expression) && n.expression.text === "requirePermission" && n.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === "clin.view_records")) info.clin = true;
    }
    if (ts.isTemplateExpression(n)) {
      // a select built from a template (`...sessions(...)${x}`): judge the literal parts
      const text = n.head.text + n.templateSpans.map((sp) => sp.literal.text).join(" ");
      if (/\bsessions\s*[(!]/.test(text)) info.reads = true;
    }
    if (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (/\bsessions\s*[(!]/.test(n.text)) info.reads = true; // an embed in a select string
      if (/^(pay|records)\.[a-z_]+$/.test(n.text)) info.ownerOrPay = true;
    }
    if (ts.isIdentifier(n)) {
      if (n.text === "viewerIsOwner" || n.text === "isOwner" || n.text === "actorIsOwner") info.ownerOrPay = true;
      if (n.text === "createAdminClient") info.usesAdmin = true;
    }
    // role === "owner" / role !== "owner" (also x.role, x?.role)
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      const side = (e: ts.Node) => (ts.isPropertyAccessExpression(e) && e.name.text === "role") || (ts.isIdentifier(e) && e.text === "role");
      if ((side(n.left) && isOwnerLiteral(n.right)) || (side(n.right) && isOwnerLiteral(n.left))) info.ownerOrPay = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(unit);
  return info;
}

export function classify(file: string, text: string): { readsSessionsViaUserClient: boolean; ownerOrPayGated: boolean; clinGated: boolean } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const units = sf.statements.filter((st) => !ts.isImportDeclaration(st) && !ts.isTypeAliasDeclaration(st) && !ts.isInterfaceDeclaration(st)).map((st) => unitInfo(sf, st));
  // The gate (owner / pay / records) is judged for the whole FILE: a loader may gate in one function and read in a same-file helper.
  const ownerOrPayGated = units.some((u) => u.ownerOrPay);
  // The clin.view_records gate must sit in the SAME top-level function that reads sessions through the user client (F-I5-3).
  const readers = units.filter((u) => u.reads && (!u.usesAdmin || /createClient/.test(text)));
  return { readsSessionsViaUserClient: readers.length > 0, ownerOrPayGated, clinGated: readers.length > 0 && readers.every((u) => u.clin) };
}

export function scan(files: Array<{ file: string; text: string }>, exempt: Record<string, string>): Hit[] {
  const out: Hit[] = [];
  for (const { file, text } of files) {
    const c = classify(file, text);
    const matches = c.readsSessionsViaUserClient && c.ownerOrPayGated && !c.clinGated;
    if (matches && !exempt[file]) out.push({ file, why: "owner/pay/records-gated loader reads sessions through the user client with no documented exemption" });
    if (!matches && exempt[file]) out.push({ file, why: "stale exemption: this file no longer matches the rule" });
  }
  return out;
}

// Each entry is a documented exemption: the reader refuses every non-owner BEFORE any read, and an owner passes has_studio_permission (true for owner)
// so the 0333 policy cannot hide a row from it. If one of these moves to pay.*/records.* keys it must first read through the admin client or a projection.
export const EXEMPT: Record<string, string> = {
  "lib/dashboard/practice-metrics.ts": "getPracticeDashboardMetrics is owner-only (`viewer.viewerIsOwner !== true` refuses before the sessions read); the clin.view_records gate in this file belongs to getProcedureActionMetrics. Owner passes the clin policy",
  "app/(app)/settings/data/page.tsx": "owner-only by design: `practitioner.role !== \"owner\"` returns OwnerOnlyNotice before the studio-wide totals are read; owner passes the clin policy",
  "app/(app)/settings/data/actions.ts": "owner-only export actions: they refuse a non-owner before reading; owner passes the clin policy",
  "app/(app)/calendar/check-practitioner/page.tsx": "owner-only by design (`role !== \"owner\"` is notFound); embeds sessions in the review select; owner passes the clin policy. Stays owner-only until a separately reviewed decision",
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts": "assertSessionVisible is a same-file helper called only AFTER the caller's requirePermission(clin.view_records) (its single caller, line ~234-237); the owner-only price action is a different function",
  "app/(app)/global-search-actions.ts": "the sessions embed is a module-level select string; every query that uses it runs inside runGlobalSearch behind `canViewRecords` (requirePermission clin.view_records). A new unguarded use in this file would not be seen by the guard; review by hand",
  "lib/billing/appointment-payment-state.ts": "owner-only: `if (!viewerIsOwner)` returns 'unavailable' before any query; owner passes the clin policy",
  "lib/billing/authoritative-session-payment.ts": "owner-only: `viewerIsOwner !== true` is a closed refusal before any read; owner passes the clin policy",
  "lib/billing/quick-checkout.ts": "owner-only via getAuthoritativeSessionPaymentAmount and the settlement loader (viewerIsOwner); owner passes the clin policy",
  "lib/dashboard/unpaid-attention.ts": "owner-only: `!viewerIsOwner` returns before any query; owner passes the clin policy",
};

const FILES = ["app", "lib", "components"].flatMap((r) => sourceFiles(r)).map((file) => ({ file, text: readFileSync(file, "utf8") }));

describe("owner/pay-gated loaders do not read sessions through the user client without an exemption", () => {
  it("the real tree has no undocumented or stale case", () => {
    const hits = scan(FILES, EXEMPT);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  }, 60_000);

  it("the exemptions are real: every listed file exists and is a user-client sessions reader", () => {
    for (const f of Object.keys(EXEMPT)) {
      const entry = FILES.find((x) => x.file === f);
      expect(entry, `${f} exists`).toBeDefined();
      expect(classify(f, entry!.text).readsSessionsViaUserClient, f).toBe(true);
    }
  });

  describe("negative fixtures: each of these is refused", () => {
    const user = (gate: string) => `import { createClient } from "@/lib/supabase/server";\nexport async function f(viewerIsOwner: boolean){ ${gate}; const s = await createClient(); return s.from("sessions").select("id"); }`;
    it("a viewerIsOwner-gated user-client sessions read", () => {
      expect(scan([{ file: "x.ts", text: user("if(!viewerIsOwner) return null") }], {}).map((h) => h.why).join()).toMatch(/no documented exemption/);
    });
    it("a pay.* keyed user-client sessions read", () => {
      expect(scan([{ file: "x.ts", text: user('await requirePermission(s, id, "pay.record_external")') }], {}).length).toBe(1);
    });
    it("a records.* keyed read through an embed", () => {
      const t = `import { createClient } from "@/lib/supabase/server";\nexport async function f(){ await requirePermission(a,b,"records.view_sterilisation_disinfection"); const s = await createClient(); return s.from("appointments").select("id, sessions(id)"); }`;
      expect(scan([{ file: "x.ts", text: t }], {}).length).toBe(1);
    });
    it("a stale exemption is refused", () => {
      expect(scan([{ file: "x.ts", text: "export const a = 1;" }], { "x.ts": "was owner-only" }).map((h) => h.why).join()).toMatch(/stale/);
    });
    it("M2: a role === / !== \"owner\" gate and isOwner / actorIsOwner gates are recognised", () => {
      const mk = (g: string) => `import { createClient } from "@/lib/supabase/server";\nexport async function f(practitioner: any, isOwner: boolean, actorIsOwner: boolean){ ${g}; const s = await createClient(); return s.from("sessions").select("id"); }`;
      for (const g of ['if (practitioner.role !== "owner") return null', 'if (practitioner.role === "owner") {}', "if (!isOwner) return null", "if (!actorIsOwner) return null"]) {
        expect(scan([{ file: "x.ts", text: mk(g) }], {}).length, g).toBe(1);
      }
    });
    it("M3: a clin.view_records gate in ANOTHER function of the same file does not excuse an owner-gated sessions reader", () => {
      const t = `import { createClient } from "@/lib/supabase/server";
export async function ownerLoader(viewerIsOwner: boolean){ if(!viewerIsOwner) return null; const s = await createClient(); return s.from("sessions").select("id"); }
export async function otherLoader(){ await requirePermission(await createClient(), "s", "clin.view_records"); return 1; }`;
      expect(scan([{ file: "x.ts", text: t }], {}).length).toBe(1);
      // control: the gate inside the reading function itself is accepted
      const ok = `import { createClient } from "@/lib/supabase/server";
export async function ownerLoader(viewerIsOwner: boolean){ if(!viewerIsOwner) return null; const s = await createClient(); await requirePermission(s, "s", "clin.view_records"); return s.from("sessions").select("id"); }`;
      expect(scan([{ file: "x.ts", text: ok }], {})).toEqual([]);
    });
    it("a sessions embed inside a template-literal select is seen", () => {
      const t = "import { createClient } from \"@/lib/supabase/server\";\nexport async function f(viewerIsOwner: boolean){ if(!viewerIsOwner) return; const s = await createClient(); return s.from(\"appointments\").select(`id, name:${'x'}, sessions(id)`); }";
      expect(scan([{ file: "x.ts", text: t }], {}).length).toBe(1);
    });
    it("M5 KNOWN LIMIT (documented, not caught): the gate in one file and the sessions read in a helper in ANOTHER file", () => {
      const gated = 'import { readSessions } from "./helper";\nexport async function f(viewerIsOwner: boolean){ if(!viewerIsOwner) return null; return readSessions(); }';
      const helper = 'import { createClient } from "@/lib/supabase/server";\nexport async function readSessions(){ const s = await createClient(); return s.from("sessions").select("id"); }';
      expect(scan([{ file: "gated.ts", text: gated }, { file: "helper.ts", text: helper }], {})).toEqual([]);
    });
    it("controls: clin.view_records-gated, admin-only and ungated-by-owner readers are accepted", () => {
      expect(scan([{ file: "a.ts", text: user('await requirePermission(s, id, "clin.view_records"); const o = viewerIsOwner') }], {})).toEqual([]);
      expect(scan([{ file: "b.ts", text: `import { createAdminClient } from "@/lib/supabase/admin-server";\nexport async function f(viewerIsOwner:boolean){ if(!viewerIsOwner) return; return createAdminClient().from("sessions").select("id"); }` }], {})).toEqual([]);
      expect(scan([{ file: "c.ts", text: 'import { createClient } from "@/lib/supabase/server";\nexport async function f(){ const s = await createClient(); return s.from("sessions").select("id"); }' }], {})).toEqual([]);
    });
  });
});
