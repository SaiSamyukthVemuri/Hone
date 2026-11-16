import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0352: STATIC contract only. Behaviour (the stamp, immutability, no other transition stamps, session payments identical, and
// the claim RPC's result) is proved against a real database in tests/db/payment-charge-attempt-claimed-at.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0352_payment_charge_attempt_claimed_at";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0352: shape", () => {
  it("consumes exactly one number", () => {
    expect(countVersion("0352")).toBe(1);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(E.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(E.trim().endsWith("commit;")).toBe(true);
  });
  it("adds one nullable column with no default and no backfill", () => {
    expect(E.match(/add column if not exists/g)).toHaveLength(1);
    expect(E).toMatch(/add column if not exists claimed_at timestamptz;/);
    expect(E).not.toMatch(/claimed_at timestamptz[^;]*(default|not null)/);
    expect(E).not.toMatch(/\bupdate\s+public\.payment_charge_attempts\b|\binsert into\b|\bdelete from\b/);
  });
  it("the trigger stamps only ready -> pending_stripe with a null claimed_at, and otherwise preserves the old value", () => {
    expect(E).toMatch(/old\.status = 'ready' and new\.status = 'pending_stripe' and old\.claimed_at is null\s+then\s+new\.claimed_at := now\(\)/);
    expect(E).toMatch(/else\s+new\.claimed_at := old\.claimed_at;/);
    expect(E).toMatch(/tg_op = 'INSERT' then\s+new\.claimed_at := null/);
    expect(E).toMatch(/before insert or update on public\.payment_charge_attempts/);
  });
  it("pins search_path and revokes EXECUTE from public, anon, authenticated and service_role by name", () => {
    expect(E).toMatch(/payment_charge_attempts_claimed_at_guard\(\)[\s\S]*?set search_path = pg_catalog, pg_temp/);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(E).toMatch(new RegExp(`revoke execute on function public\\.payment_charge_attempts_claimed_at_guard\\(\\) from ${role};`));
    }
    expect(E).not.toMatch(/grant execute/);
  });
  it("leaves the claim RPC, the touch trigger and the 0214 triggers untouched", () => {
    expect(E).not.toMatch(/claim_session_payment_charge_attempt|payment_charge_attempts_touch_updated_at|payment_charge_attempts_money_immutable|payment_charge_attempts_jurisdiction_guard/);
  });
  it("rollback drops the trigger, the function and the column", () => {
    expect(DOWN).toMatch(/drop trigger if exists payment_charge_attempts_claimed_at_guard on public\.payment_charge_attempts/);
    expect(DOWN).toMatch(/drop function if exists public\.payment_charge_attempts_claimed_at_guard\(\)/);
    expect(DOWN).toMatch(/drop column if exists claimed_at/);
    expect(DOWN).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
  });
});
