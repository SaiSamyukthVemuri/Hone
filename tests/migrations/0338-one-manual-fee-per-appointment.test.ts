import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 0338 (one manual fee per appointment, enforced by the database). The behavioural proof is
// tests/db/one-fee-per-appointment.db.test.ts. This file pins the rollback file and the module that handles the 23505.
const ROOT = path.resolve(__dirname, "../..");
const DOWN = readFileSync(path.join(ROOT, "supabase/rollbacks/0338_one_manual_fee_per_appointment.down.sql"), "utf8");
const code = (s: string) => s.replace(/--.*$/gm, "");

describe("0338 rollback and application handling", () => {
  it("the down file drops the index and nothing else, inside its own transaction", () => {
    const d = code(DOWN);
    expect(d).toMatch(/drop index if exists public\.payment_charge_attempts_one_fee_per_appointment_uniq;/);
    expect(d).toMatch(/begin;[\s\S]*set local lock_timeout[\s\S]*drop index[\s\S]*commit;/);
    expect(d).not.toMatch(/\b(delete|update|insert|truncate|alter|drop\s+(table|column|function|trigger))\b/i);
  });
  it("D2: the one-fee module documents that reviving a failed/cancelled fee row must handle the 0338 23505", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/billing/manual-fee-one-per-appointment.ts"), "utf8");
    expect(src).toContain("payment_charge_attempts_one_fee_per_appointment_uniq");
    expect(src).toMatch(/23505[\s\S]*handled deliberately/);
  });
});
