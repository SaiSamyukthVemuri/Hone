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
// An EXEMPT entry that no longer matches the rule is itself a failure (a stale exemption would hide a future regression). A tripwire, not a proof.

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

export function classify(file: string, text: string): { readsSessionsViaUserClient: boolean; ownerOrPayGated: boolean; clinGated: boolean } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let readsSessions = false;
  let usesAdmin = false;
  let ownerOrPay = false;
  let clin = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === "sessions") readsSessions = true;
    // an embed in a select string: sessions( or sessions!
    if (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (/\bsessions\s*[(!]/.test(n.text)) readsSessions = true;
      if (/^(pay|records)\.[a-z_]+$/.test(n.text)) ownerOrPay = true;
      if (n.text === "clin.view_records") clin = true;
    }
    if (ts.isIdentifier(n)) {
      if (n.text === "viewerIsOwner") ownerOrPay = true;
      if (n.text === "createAdminClient") usesAdmin = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // a file that reads sessions only through the admin client is out of scope; a file that mixes both is judged as a user-client reader (conservative)
  return { readsSessionsViaUserClient: readsSessions && (!usesAdmin || /createClient/.test(text)), ownerOrPayGated: ownerOrPay, clinGated: clin };
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
    it("controls: clin.view_records-gated, admin-only and ungated-by-owner readers are accepted", () => {
      expect(scan([{ file: "a.ts", text: user('await requirePermission(s, id, "clin.view_records"); const o = viewerIsOwner') }], {})).toEqual([]);
      expect(scan([{ file: "b.ts", text: `import { createAdminClient } from "@/lib/supabase/admin-server";\nexport async function f(viewerIsOwner:boolean){ if(!viewerIsOwner) return; return createAdminClient().from("sessions").select("id"); }` }], {})).toEqual([]);
      expect(scan([{ file: "c.ts", text: 'import { createClient } from "@/lib/supabase/server";\nexport async function f(){ const s = await createClient(); return s.from("sessions").select("id"); }' }], {})).toEqual([]);
    });
  });
});
