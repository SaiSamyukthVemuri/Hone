import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0352: rollback file contract. Behaviour (the stamp, immutability, no other transition stamps, session payments identical, and
// the claim RPC's result) is proved against a real database in tests/db/payment-charge-attempt-claimed-at.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0352_payment_charge_attempt_claimed_at";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0352: rollback", () => {
  it("rollback drops the trigger, the function and the column", () => {
    expect(DOWN).toMatch(/drop trigger if exists payment_charge_attempts_claimed_at_guard on public\.payment_charge_attempts/);
    expect(DOWN).toMatch(/drop function if exists public\.payment_charge_attempts_claimed_at_guard\(\)/);
    expect(DOWN).toMatch(/drop column if exists claimed_at/);
    expect(DOWN).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
  });
});
