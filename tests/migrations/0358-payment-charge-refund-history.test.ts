import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0358: STATIC contract only. The behaviour of the command is specified in docs and proved against a real database before any apply
// (a database test needs a local stack and is run under a slot).

const root = join(__dirname, "..", "..");
const NAME = "0358_payment_charge_refund_history";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const RAW = readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8");
const E = exec(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
const DOWN_RAW = readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8");
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0358: shape", () => {
  it("consumes exactly one number", () => {
    expect(countVersion("0358")).toBe(1);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(E.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(E.trim().endsWith("commit;")).toBe(true);
  });
  it("adds only the four summary columns to the attempt, with the established-together and bound checks", () => {
    expect(E.match(/add column if not exists (\w+)/g)).toEqual([
      "add column if not exists refund_history_event_id",
      "add column if not exists refund_history_event_created",
      "add column if not exists refunds_succeeded_cents",
      "add column if not exists refunds_inflight_count",
    ]);
    expect(E).toMatch(/refunds_inflight_count integer not null default 0/);
    expect(E).toMatch(/payment_charge_attempts_refund_history_check/);
    expect(E).toMatch(/refunds_succeeded_cents <= amount_cents/);
  });
  it("adds each new CHECK as NOT VALID and validates it in a separate statement", () => {
    for (const c of ["refund_history_check", "refunds_succeeded_bound_check", "refunds_inflight_check"]) {
      expect(E).toMatch(new RegExp(`validate constraint payment_charge_attempts_${c};`));
    }
    expect(E.match(/\) not valid/g) ?? []).toHaveLength(3);
    expect(E).toMatch(/refunds_inflight_count >= 0\) not valid/);
  });
  it("changes no existing value: no update of old columns, no backfill, no insert outside the command", () => {
    expect(E).not.toMatch(/update\s+public\.payment_charge_attempts\s+set\s+(refund_status|refund_amount_cents|stripe_)/);
    expect(E).not.toMatch(/ops_alerts/);
    expect(E.match(/\binsert into public\.payment_charge_refunds\b/g)).toHaveLength(1);
  });
});

describe("0358: the table", () => {
  it("one row per refund id per attempt, positive amounts, closed status set, no cascade delete", () => {
    expect(E).toMatch(/constraint payment_charge_refunds_attempt_refund_key unique \(attempt_id, stripe_refund_id\)/);
    expect(E).toMatch(/amount_cents integer not null check \(amount_cents > 0\)/);
    expect(E).toMatch(/status in \('pending', 'requires_action', 'succeeded', 'failed', 'canceled'\)/);
    expect(E).toMatch(/attempt_id uuid not null references public\.payment_charge_attempts\(id\) on delete restrict/);
    expect(E).not.toMatch(/on delete cascade/);
  });
  it("row level security on, one owner SELECT policy, no write grant to any role", () => {
    expect(E).toMatch(/alter table public\.payment_charge_refunds enable row level security/);
    expect(E.match(/create policy "payment_charge_refunds: owners read"/g)).toHaveLength(1);
    expect(E).toMatch(/for select to authenticated\s+using \(public\.is_studio_owner\(studio_id\)\)/);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(E).toMatch(new RegExp(`revoke all on public\\.payment_charge_refunds from ${role};`));
    }
    expect(E).toMatch(/grant select on public\.payment_charge_refunds to authenticated;/);
    expect(E).toMatch(/grant select on public\.payment_charge_refunds to service_role;/);
    expect(E).not.toMatch(/grant (insert|update|delete|all)[^;]*on public\.payment_charge_refunds/);
  });
  it("the guard trigger forbids delete, identity/amount/currency change and any change of a terminal status", () => {
    expect(E).toMatch(/before update or delete on public\.payment_charge_refunds/);
    expect(E).toMatch(/rows are never deleted/);
    expect(E).toMatch(/a terminal refund status never changes/);
  });
});

describe("0358: the command", () => {
  it("is security definer with a pinned search_path and EXECUTE for service_role only, revoked by name from the other three", () => {
    expect(E).toMatch(/function public\.record_charge_refund_history\([\s\S]*?security definer\s+set search_path = pg_catalog, pg_temp/);
    expect(E).toMatch(/revoke all privileges on function public\.record_charge_refund_history\(uuid, text, text, uuid, text, boolean, jsonb\)\s+from public, anon, authenticated, service_role;/);
    expect(E).toMatch(/grant execute on function public\.record_charge_refund_history\(uuid, text, text, uuid, text, boolean, jsonb\) to service_role;/);
    expect(E).not.toMatch(/grant execute on function public\.record_charge_refund_history[^;]*to (anon|authenticated|public)/);
  });
  it("trigger function: EXECUTE revoked from all four roles by name", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(E).toMatch(new RegExp(`revoke execute on function public\\.payment_charge_refunds_guard\\(\\) from ${role};`));
    }
  });
  it("takes the appointment advisory lock before the attempt row lock (the 0187/0240 order)", () => {
    const adv = E.indexOf("pg_advisory_xact_lock(public.appointment_settlement_lock_key");
    const row = E.indexOf("from public.payment_charge_attempts a where a.id = p_attempt_id for update");
    expect(adv).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(adv);
  });
  it("accepts only signed-event evidence of the four refund event types and binds every stored identity field", () => {
    expect(E).toMatch(/p_event_type not in \('charge\.refunded','refund\.created','refund\.updated','refund\.failed'\)/);
    // Two kinds only: the signed event's own list, and the same signed event whose complete list the server read from the provider.
    // IS DISTINCT FROM has no ANY/ALL form (invalid SQL); the valid spelling is a null test plus <> ALL.
    expect(E).toMatch(/\(p_object->>'evidence_kind'\) is null\s+or \(p_object->>'evidence_kind'\) <> all \(array\['signed_event','signed_event_with_authenticated_list'\]\)/);
    expect(E).not.toMatch(/is distinct from all/);
    expect(E.match(/signed_event_with_authenticated_list/g)!.length).toBeGreaterThanOrEqual(2);
    for (const f of ["p_studio_id", "p_stripe_account_id", "p_livemode", "'customer_id'", "'payment_intent_id'", "'amount_cents'", "'currency'", "v_charge"]) {
      expect(E).toContain(f);
    }
    expect(E).toMatch(/'identity_mismatch'/);
  });
  it("validates everything before writing anything (two passes) and refuses rather than raising", () => {
    // Every refusal and both total checks come BEFORE the first row is written.
    const firstInsert = E.indexOf("insert into public.payment_charge_refunds\n");
    expect(firstInsert).toBeGreaterThan(0);
    for (const marker of ["'terminal_refund_mismatch'", "v_merged_succeeded > v_row.amount_cents", "v_charge_refunded < v_event_succeeded"]) {
      expect(E.indexOf(marker)).toBeGreaterThan(0);
      expect(E.indexOf(marker)).toBeLessThan(firstInsert);
    }
    for (const r of ["'refund_evidence_refused'", "'terminal_refund_mismatch'", "'invalid_input'", "'not_found'", "'already_recorded'", "'recorded'"]) {
      expect(E).toContain(r);
    }
    expect(E).not.toMatch(/\braise exception\b[^$]*refund_evidence/);
  });
  it("never lets succeeded refunds exceed the charge and cross-checks a complete list against the charge's own total", () => {
    expect(E).toMatch(/v_merged_succeeded > v_row\.amount_cents/);
    expect(E).toMatch(/v_charge_refunded < v_event_succeeded/);
    expect(E).toMatch(/v_charge_refunded > v_event_succeeded \+ v_event_inflight_amount/);
  });
  it("each refund row records how it was established (a closed set, never null) and the guard makes it immutable", () => {
    expect(E).toMatch(/evidence_kind text not null check \(evidence_kind in \('signed_event', 'signed_event_with_authenticated_list'\)\)/);
    expect(E).toMatch(/or new\.evidence_kind is distinct from old\.evidence_kind/);
    // The insert writes the kind of the evidence that first established the refund; no update statement ever sets it.
    expect(E).toMatch(/last_event_created, evidence_kind\)\s+values \(.*p_object->>'evidence_kind'\)/);
    expect(E).not.toMatch(/set\s+[^;]*evidence_kind\s*=/);
  });
  it("a list the server read may be AHEAD of the signed total but never BEHIND it; the authenticated kind is for a complete charge.refunded list only", () => {
    // Ahead (succeeded sum above the signed total) is refused only for the in-event kind.
    expect(E).toMatch(/\(v_charge_refunded < v_event_succeeded and p_object->>'evidence_kind' = 'signed_event'\)/);
    // Behind (the total counts money the list lacks) is refused for both kinds, with no kind condition.
    expect(E).toMatch(/or v_charge_refunded > v_event_succeeded \+ v_event_inflight_amount/);
    // The authenticated kind is accepted only for charge.refunded and only with the complete-list claim.
    expect(E).toMatch(/p_object->>'evidence_kind' = 'signed_event_with_authenticated_list'\s+and \(p_event_type <> 'charge\.refunded' or p_object->'charge_refund_list_complete' is distinct from 'true'::jsonb\)/);
  });
  it("recomputes the summary from the rows, never from the event, and marks the history established only from a complete list", () => {
    expect(E).toMatch(/if v_complete and not v_established then/);
    expect(E).toMatch(/refunds_succeeded_cents = v_merged_succeeded::integer/);
    expect(E).toMatch(/refund_history_event_id = coalesce\(a\.refund_history_event_id, p_event_id\)/);
  });
  it("does not touch the older refund columns or the 0240 command", () => {
    expect(E).not.toMatch(/create or replace function public\.reconcile_bound_payment_event/);
    expect(E).not.toMatch(/set\s+refund_status\s*=|set\s+stripe_refund_status\s*=|stripe_charge_refund_event_id\s*=/);
  });
});

describe("0358: rollback", () => {
  it("removes every object the migration added, inside its own transaction", () => {
    for (const re of [
      /drop function if exists public\.record_charge_refund_history\(uuid, text, text, uuid, text, boolean, jsonb\)/,
      /drop trigger if exists payment_charge_refunds_guard on public\.payment_charge_refunds/,
      /drop function if exists public\.payment_charge_refunds_guard\(\)/,
      /drop table if exists public\.payment_charge_refunds/,
      /drop constraint if exists payment_charge_attempts_refund_history_check/,
      /drop column if exists refund_history_event_id/, /drop column if exists refund_history_event_created/,
      /drop column if exists refunds_succeeded_cents/, /drop column if exists refunds_inflight_count/,
    ]) expect(DOWN).toMatch(re);
    expect(DOWN).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
  });
});

function grab(src: string, name: string): string {
  const i = src.indexOf(`create or replace function public.${name}(`);
  expect(i, name).toBeGreaterThanOrEqual(0);
  const j = src.indexOf("\n$$;", i);
  return src.slice(i, j + 4);
}
const ORIGINALS = [
  ["initialize_studio_payment_jurisdiction_from_history", "supabase/migrations/0214_studio_payment_jurisdiction.sql"],
  ["initialize_studio_payment_jurisdiction_from_history_v2", "supabase/migrations/0257_studio_payment_jurisdiction_failed_attempt_ack.sql"],
] as const;

describe("0358: the two jurisdiction initialisers change by exactly one list entry", () => {
  for (const [name, file] of ORIGINALS) {
    const original = grab(readFileSync(join(root, file), "utf8"), name);
    it(`${name}: identical to its original except 'payment_charge_refunds' in c_money_universe`, () => {
      const redone = grab(RAW, name);
      expect(redone).not.toBe(original);
      expect(redone.replace("'payment_charge_attempts', 'payment_charge_refunds', 'payment_recovery_tokens',", "'payment_charge_attempts', 'payment_recovery_tokens',")).toBe(original);
      expect(redone.match(/'payment_charge_refunds'/g)).toHaveLength(1);
    });
    it(`${name}: the rollback restores the original text exactly`, () => {
      expect(grab(DOWN_RAW, name)).toBe(original);
    });
  }
  it("grants on the two initialisers are not touched by 0358 (CREATE OR REPLACE keeps them)", () => {
    expect(E).not.toMatch(/(grant|revoke)[^;]*initialize_studio_payment_jurisdiction_from_history/);
  });
});
