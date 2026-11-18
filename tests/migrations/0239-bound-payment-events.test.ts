import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const sql = readFileSync("supabase/migrations/0239_bound_payment_event_reconciliation.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const runtime = readFileSync("lib/billing/payment-webhook-reconciliation.ts", "utf8").replace(/^\s*\/\/.*$/gm, "");
describe("0239 bound payment-event authority", () => {
  it("closes the prior unbound service entry point", () => {
    expect(code).toMatch(/revoke all privileges on function public.reconcile_card_payment_succeeded\(uuid,text,text\)\s+from public, anon, authenticated, service_role;/);
    expect(runtime).not.toMatch(/rpc\(\s*["']reconcile_card_payment_succeeded["']/);
  });
  it("routes every runtime event mutation through the new command", () => {
    expect(runtime).toContain('rpc("reconcile_bound_payment_event"');
    expect(runtime).not.toMatch(/\.update\(/);
    for (const field of ["p_studio_id", "p_stripe_account_id", "p_livemode", "p_event_id", "p_event_type", "p_object"]) expect(runtime).toContain(field);
  });
});
