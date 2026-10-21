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
    const readerStart = action.indexOf("async function verifiedSavedRefundTimestamp(");
    expect(readerStart).toBeGreaterThan(-1);
    const reader = action.slice(readerStart, action.indexOf("const { data: observationRows", readerStart));
    expect(reader).toContain("!savedError && saved &&");
    expect(reader).toContain('saved.refund_status === "succeeded"');
    expect(reader).toContain("saved.stripe_refund_id === refundId");
    expect(reader).toContain("saved.refund_amount_cents === refundAmountCents");
    expect(reader).toContain("Number.isFinite(Date.parse(saved.refunded_at))");
    expect(action).toContain("const refundedAtIso = await verifiedSavedRefundTimestamp(attempt, refund.id)");
    expect(action).toMatch(/if \(!refundedAtIso\) \{[\s\S]*?outcome: "needs_manual_review"/);
    expect(action).toContain("providerCharge !== attempt.stripe_charge_id");
    expect(action).toContain("providerIntent !== attempt.stripe_payment_intent_id");
  });
  it("handles signed status events without initiating provider refunds", () => {
    for (const type of ["refund.created", "refund.updated", "refund.failed"]) expect(route).toContain(`case "${type}":`);
    expect(route).toContain("handleRefundStatusEvent(event, ctx)");
  });
});


describe("0240 separate cumulative charge truth", () => {
  it("stores separate nullable cumulative provenance without rewriting actual single-refund evidence", () => {
    expect(code).toContain("add column stripe_charge_refund_event_created bigint");
    expect(code).toContain("add column stripe_charge_refund_event_id text");
    const start = code.indexOf("elsif p_event_type='charge.refunded' and p_object ? 'charge_refund_components'");
    expect(start).toBeGreaterThan(-1);
    const aggregate = code.slice(start, code.indexOf("\n  else\n", start));
    expect(aggregate).not.toMatch(/set[\s\S]*stripe_refund_(id|status|event_id|event_created)=/);
    expect(aggregate).toContain("v_total<>v_row.amount_cents");
    expect(aggregate).toContain("v_component->>'refund_id'=any(v_component_ids)");
    expect(aggregate).toContain("v_component_amount>9007199254740991");
    expect(aggregate).toContain("v_component->>'refund_status'='succeeded'");
  });
  it("requires complete signed captured charge plus original-bound component set", () => {
    for (const token of ["charge_refund_list_complete", "charge_amount_captured", "charge_amount_refunded", "charge_livemode",
      "v_component->>'charge_id' is distinct from v_row.stripe_charge_id",
      "v_component->>'payment_intent_id' is distinct from v_row.stripe_payment_intent_id",
      "v_component->>'currency' is distinct from v_row.currency",
      "v_component->>'customer_id' is distinct from v_row.stripe_customer_id"]) expect(code).toContain(token);
  });
  it("all later single-refund/action writes stop before they can regress cumulative full truth", () => {
    const gate = code.lastIndexOf("if v_row.stripe_charge_refund_event_id is not null then");
    expect(gate).toBeGreaterThan(-1);
    const guard = code.indexOf("elsif v_row.status<>'succeeded' or v_row.stripe_charge_id is null");
    expect(guard).toBeGreaterThan(gate);
    expect(code.slice(gate, guard)).toContain("v_result:='already_refunded'");
  });
});
