import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0359: STATIC contract. The behaviour is proved against a real database (tests/db/refund-list-kind-reconcile.db.test.ts, run under a slot).

const root = join(__dirname, "..", "..");
const NAME = "0359_reconcile_accepts_authenticated_refund_list";
const read = (p: string) => readFileSync(join(root, p), "utf8");
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const UP_RAW = read(`supabase/migrations/${NAME}.sql`);
const DOWN_RAW = read(`supabase/rollbacks/${NAME}.down.sql`);
const UP = exec(UP_RAW);
const DOWN = exec(DOWN_RAW);
const ORIGINAL = read("supabase/migrations/0240_provider_refund_status.sql");
const FN_START = "create or replace function public.reconcile_bound_payment_event(";
const fnOf = (sql: string) => { const i = sql.indexOf(FN_START); return sql.slice(i, sql.indexOf("\n$$;\n", i) + "\n$$;\n".length); };
const GRANTS = (sql: string) => { const k = sql.indexOf("revoke all privileges on function public.reconcile_bound_payment_event"); return sql.slice(k, sql.indexOf("\n", sql.indexOf("grant execute on function public.reconcile_bound_payment_event", k)) + 1); };

describe("0359: shape", () => {
  it("consumes exactly one number and opens its own transaction with lock_timeout inside it", () => {
    expect(countVersion("0359")).toBe(1);
    expect(UP.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(UP.trim().endsWith("commit;")).toBe(true);
    expect(DOWN.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(DOWN.trim().endsWith("commit;")).toBe(true);
  });
  it("changes no table, column, constraint or data: only the one function and its grants", () => {
    for (const sql of [UP, DOWN]) {
      expect(sql).not.toMatch(/\b(alter table|create table|drop table|insert into|delete from|add column|drop column)\b/i);
      expect(sql).not.toMatch(/\bupdate\s+public\.payment_charge_attempts\s+set\b[\s\S]*\bfrom\b[\s\S]*\bbackfill/i);
    }
    expect(UP.match(/create or replace function/g)).toHaveLength(1);
  });
});

describe("0359: the function is 0240's, byte for byte, but for three stated edits", () => {
  const up = fnOf(UP_RAW);
  const orig = fnOf(ORIGINAL);
  const lines = (s: string) => s.split("\n");
  it("differs from 0240 only by the added lines below (nothing removed except the two replaced conditions)", () => {
    const o = lines(orig); const u = lines(up);
    const removed = o.filter((l) => !u.includes(l));
    const added = u.filter((l) => !o.includes(l));
    expect(removed.map((l) => l.trim())).toEqual([
      "and p_object->>'evidence_kind'='signed_event'",
      "if p_object->>'evidence_kind' is distinct from 'signed_event'",
      "or jsonb_typeof(p_object) is distinct from 'object' then",
    ].filter((x) => removed.map((l) => l.trim()).includes(x)).sort((a, b) => removed.map((l) => l.trim()).indexOf(a) - removed.map((l) => l.trim()).indexOf(b)));
    expect(removed).toHaveLength(3);
    expect(added.length).toBeGreaterThanOrEqual(6);
  });
  it("accepts the new kind for charge.refunded only, and for a single full refund also demands the complete-list claim", () => {
    expect(up).toMatch(/p_object->>'evidence_kind'='signed_event_with_authenticated_list' and p_event_type<>'charge\.refunded'/);
    // IS DISTINCT FROM has no ANY/ALL form (invalid SQL); the valid spelling is a null test plus <> ALL.
    expect(up).toMatch(/\(p_object->>'evidence_kind'\) is null\s+or \(p_object->>'evidence_kind'\) <> all \(array\['signed_event','signed_event_with_authenticated_list'\]\)/);
    expect(up).not.toMatch(/is distinct from all/);
    expect(up).toMatch(/evidence_kind'='signed_event_with_authenticated_list'\s+and p_object->'charge_refund_list_complete' is distinct from 'true'::jsonb/);
    expect(up).toMatch(/p_object->>'evidence_kind' in \('signed_event','signed_event_with_authenticated_list'\)/);
  });
  it("keeps every identity and full-refund rule of 0240 (a full refund only: succeeded parts add up to exactly the charge)", () => {
    for (const marker of ["identity_mismatch", "refund_evidence_refused", "v_total<>v_row.amount_cents", "p_object->>'charge_amount_refunded'=v_row.amount_cents::text",
      "pg_advisory_xact_lock(public.appointment_settlement_lock_key", "for update;"]) {
      expect(up).toContain(marker);
    }
  });
});

describe("0359: grants and rollback", () => {
  it("revokes from public, anon, authenticated and service_role by name, then grants EXECUTE to service_role only", () => {
    const g = GRANTS(UP_RAW);
    expect(g).toMatch(/revoke all privileges on function public\.reconcile_bound_payment_event\(uuid,text,text,uuid,text,boolean,jsonb\)\s+from public, anon, authenticated, service_role;/);
    expect(g).toMatch(/grant execute on function public\.reconcile_bound_payment_event\(uuid,text,text,uuid,text,boolean,jsonb\) to service_role;/);
    expect(UP).not.toMatch(/grant execute on function [^;]*\bto\s+(anon|authenticated|public)\b/i);
  });
  it("the rollback restores 0240's function and grants EXACTLY", () => {
    expect(fnOf(DOWN_RAW)).toBe(fnOf(ORIGINAL));
    expect(GRANTS(DOWN_RAW)).toBe(GRANTS(ORIGINAL));
    expect(DOWN).not.toMatch(/signed_event_with_authenticated_list/);
  });
  it("the rollback warns about the release order (revert the application change first)", () => {
    expect(DOWN_RAW).toMatch(/revert the application change/i);
  });
});
