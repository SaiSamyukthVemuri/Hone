import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Privacy (HON-122 v1): a refund observed in the Stripe dashboard is recorded by exactly ONE statement, and the only thing ever written to its `reason` is a
// fixed Hone sentence (not Stripe text, not staff text). Readers show it as a fixed label, never as user text, and it never reaches exports or logs.
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const FIXED = "Refunded in the Stripe dashboard";
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(join(ROOT, dir))) {
    if (n === "node_modules" || n === ".next") continue;
    const rel = join(dir, n);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out); else if (/\.(ts|tsx|sql)$/.test(n)) out.push(rel);
  }
  return out;
}

describe("the reason of a Stripe-dashboard refund row", () => {
  it("only resolve_payment_refund_review writes source 'stripe_dashboard', and its reason is the fixed literal", () => {
    const sqlFiles = walk("supabase/migrations").filter((f) => f.endsWith(".sql"));
    const observedInserts = sqlFiles.flatMap((f) => [...read(f).matchAll(/insert into public\.payment_refunds[\s\S]*?;\n/g)].map((m) => ({ f, t: m[0] })).filter((x) => /'stripe_dashboard'/.test(x.t)));
    // exactly ONE statement in the whole migration chain, and it is resolve_payment_refund_review's
    expect(observedInserts.map((x) => x.f)).toEqual(["supabase/migrations/0394_visit_payment_commands.sql"]);
    // and no application code writes the table at all with that source
    for (const f of [...walk("app"), ...walk("lib")]) expect(/from\("payment_refunds"\)\s*\.(insert|upsert|update)/.test(read(f)), f).toBe(false);
    const inserts = observedInserts.map((x) => x.t);
    expect(inserts[0]).toContain(`'${FIXED}'`);
    // No parameter, column or expression other than the literal fills the reason slot: the values list has no `v.` or `p_` reference in the reason position.
    const values = inserts[0].slice(inserts[0].indexOf("values"));
    expect(values.split(",")[6].trim()).toBe(`'${FIXED}'`);
  });

  it("the readers never select, store or display a refund's reason: observed rows carry a fixed label instead", () => {
    const loader = read("lib/billing/visit-payments.ts");
    const select = /from\("payment_refunds"\)\.select\("([^"]+)"\)/.exec(loader)?.[1] ?? "";
    expect(select.length).toBeGreaterThan(0);
    expect(select.split(",").map((c) => c.trim())).not.toContain("reason");
    expect(loader).not.toMatch(/reason:\s*String\(r\.reason/);
    const core = read("lib/billing/visit-payments-core.ts");
    expect(core).toContain(`OBSERVED_REFUND_LABEL = "${FIXED}"`);
    for (const f of ["components/split-visit-payments.tsx", "lib/finance/statement-money-read.ts", "lib/billing/billed-visits.ts"]) {
      expect(/\.reason\b/.test(read(f)) && /refund/i.test(read(f)) && /r\.reason|refund\.reason/.test(read(f)), f).toBe(false);
    }
  });

  it("the reviews table and the reason constant stay out of the CSV export until the field review, and out of every log call", () => {
    const reg = read("lib/export/resource-registry.ts");
    const at = reg.indexOf("payment_refund_reviews: {");
    expect(at).toBeGreaterThan(-1);
    expect(reg.slice(at, at + 900)).toMatch(/NOT included in this CSV export yet/);
    for (const f of [...walk("app"), ...walk("lib")]) {
      const src = read(f);
      if (!src.includes(FIXED)) continue;
      expect(f, "the fixed sentence is code in the ledger helper only").toBe("lib/billing/visit-payments-core.ts");
    }
  });
});
