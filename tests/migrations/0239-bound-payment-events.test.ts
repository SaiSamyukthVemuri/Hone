import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion } from "./helpers/migration-state";
const sql = readFileSync("supabase/migrations/0239_bound_payment_event_reconciliation.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const runtime = readFileSync("lib/billing/payment-webhook-reconciliation.ts", "utf8").replace(/^\s*\/\/.*$/gm, "");
describe("0239 bound payment-event authority", () => {
  it("is allocated once, transactional and bounded", () => {
    expect(countVersion("0239")).toBe(1);
    expect(code).toMatch(/begin;[\s\S]*set local lock_timeout = '5s';/);
    expect(code.trim().endsWith("commit;")).toBe(true);
  });
  it("closes the prior unbound service entry point", () => {
    expect(code).toMatch(/revoke all privileges on function public.reconcile_card_payment_succeeded\(uuid,text,text\)\s+from public, anon, authenticated, service_role;/);
    expect(runtime).not.toMatch(/rpc\(\s*["']reconcile_card_payment_succeeded["']/);
  });
  it("exposes only the bound command to service_role", () => {
    expect(code).toContain("set search_path = pg_catalog, pg_temp");
    expect(code).toMatch(/revoke all privileges on function public.reconcile_bound_payment_event\(uuid,text,text,uuid,text,boolean,jsonb\)\s+from public, anon, authenticated, service_role;/);
    expect(code).toMatch(/grant execute on function public.reconcile_bound_payment_event\(uuid,text,text,uuid,text,boolean,jsonb\)\s+to service_role;/);
  });
  it("takes the existing appointment mutex before the attempt lock", () => {
    expect(code.indexOf("pg_advisory_xact_lock")).toBeLessThan(code.indexOf("for update;"));
    expect(code.indexOf("for update;")).toBeLessThan(code.indexOf("'identity_mismatch'"));
    expect(code.indexOf("'identity_mismatch'")).toBeLessThan(code.indexOf("update public.payment_charge_attempts"));
  });
  it("requires every durable identity and exact money before any mutation", () => {
    for (const field of ["studio_id", "stripe_account_id", "stripe_livemode", "stripe_customer_id", "stripe_payment_intent_id", "stripe_charge_id", "amount_cents", "currency"]) {
      expect(code).toContain(`v_row.${field}`);
    }
    expect(code).toContain("nullif(v_row.stripe_payment_intent_id,'') is null");
    expect(code).toContain("nullif(v_row.stripe_customer_id,'') is null");
    expect(code).toContain("p_object->>'amount_cents' is distinct from v_row.amount_cents::text");
  });
  it("routes every runtime event mutation through the new command", () => {
    expect(runtime).toContain('rpc("reconcile_bound_payment_event"');
    expect(runtime).not.toMatch(/\.update\(/);
    for (const field of ["p_studio_id", "p_stripe_account_id", "p_livemode", "p_event_id", "p_event_type", "p_object"]) expect(runtime).toContain(field);
  });
  it("retains settlement authority and refuses unproven refunds", () => {
    expect(code).toContain("public.reconcile_card_payment_succeeded(");
    expect(code).toContain("p_object->>'refund_status' is distinct from 'succeeded'");
    expect(code).toContain("p_object->>'refund_charge_id' is distinct from v_row.stripe_charge_id");
    expect(code).toContain("v_row.stripe_refund_id<>v_refund");
  });
  it("does not backfill, rewrite historical migrations or add provider effects", () => {
    const top = code.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(top).not.toMatch(/^\s*(update|insert|delete|truncate)\b/gim);
    expect(code).not.toMatch(/grant .* to (anon|authenticated)/i);
  });
});
