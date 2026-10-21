import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion } from "./helpers/migration-state";
const sql = readFileSync("supabase/migrations/0240_provider_refund_status.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const action = readFileSync("lib/billing/payment-refund.ts", "utf8");
const route = readFileSync("app/api/stripe/webhook/route.ts", "utf8");
describe("0240 actual provider refund status", () => {
  it("is allocated once and adds nullable evidence without a default/backfill", () => {
    expect(countVersion("0240")).toBe(1);
    expect(code).toContain("set local lock_timeout = '5s'");
    expect(code).toContain("add column stripe_refund_status text");
    expect(code).toContain("add column stripe_refund_event_created bigint");
    expect(code).toContain("add column stripe_refund_event_id text");
    const top = code.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(top).not.toMatch(/\bdefault\b|^\s*(update|insert|delete)\b/gim);
  });
  it("retains the service-only API and original identity/money authority", () => {
    expect(code).toMatch(/revoke all privileges[\s\S]+from public, anon, authenticated, service_role/);
    expect(code).toContain("to service_role;");
    for (const field of ["stripe_account_id", "stripe_customer_id", "stripe_payment_intent_id", "stripe_charge_id", "amount_cents", "currency"]) expect(code).toContain(`v_row.${field}`);
    expect(code.indexOf("pg_advisory_xact_lock")).toBeLessThan(code.indexOf("for update;"));
  });
  it("allowlists real statuses and maps only succeeded to completion", () => {
    expect(code).toContain("('pending','requires_action','succeeded','failed','canceled')");
    expect(code).toContain("when v_status='succeeded' then 'succeeded'");
    expect(code).toContain("when v_status in ('failed','canceled') then 'failed' else 'pending_stripe'");
    expect(code).toContain("refunded_at=case when v_status='succeeded' then coalesce(a.refunded_at,now()) else null end");
  });
  it("guards duplicate, older and terminal evidence before updating", () => {
    expect(code).toContain("v_row.stripe_refund_event_id=p_event_id");
    expect(code).toContain("v_event_created<v_row.stripe_refund_event_created");
    expect(code).toContain("v_row.stripe_refund_status in ('succeeded','failed','canceled')");
    expect(code).toContain("v_row.refund_status='succeeded' and v_status is distinct from 'succeeded'");
    expect(code).toContain("v_event_created is null or");
  });
  it("requires signed event provenance or explicit action-response evidence", () => {
    expect(code).toContain("p_object->>'evidence_kind' is distinct from 'signed_event'");
    expect(code).toContain("p_object->>'evidence_kind' is distinct from 'action_response'");
    expect(code).toContain("stripe_refund_event_created is not null and stripe_refund_event_created>=0");
  });
  it("routes action outcomes through the command and reads committed completion", () => {
    expect(action).toContain('p_event_type: "refund.observed"');
    expect(action).toContain('evidence_kind: "action_response"');
    expect(action).toContain('saved?.refund_status !== "succeeded"');
    expect(action).toContain("providerCharge !== attempt.stripe_charge_id");
    expect(action).toContain("providerIntent !== attempt.stripe_payment_intent_id");
  });
  it("handles signed status events without initiating provider refunds", () => {
    for (const type of ["refund.created", "refund.updated", "refund.failed"]) expect(route).toContain(`case "${type}":`);
    expect(route).toContain("handleRefundStatusEvent(event, ctx)");
  });
});
