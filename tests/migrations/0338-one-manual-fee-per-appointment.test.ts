import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isRepoMax } from "./helpers/migration-state";

// Source contract for 0338 (one manual fee per appointment, enforced by the database). The behavioural proof is
// tests/db/one-fee-per-appointment.db.test.ts, run on a fresh database.
const ROOT = path.resolve(__dirname, "../..");
const SQL = readFileSync(path.join(ROOT, "supabase/migrations/0338_one_manual_fee_per_appointment.sql"), "utf8");
const DOWN = readFileSync(path.join(ROOT, "supabase/rollbacks/0338_one_manual_fee_per_appointment.down.sql"), "utf8");
const code = (s: string) => s.replace(/--.*$/gm, "");

describe("0338 source contract", () => {
  const body = code(SQL);
  it("is the current maximum migration (only the max may assert this)", () => {
    expect(isRepoMax("0338")).toBe(true);
  });
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    const i = {
      begin: body.search(/^\s*begin;/m),
      lock: body.search(/set local lock_timeout = '5s';/),
      idx: body.search(/create unique index/),
      commit: body.search(/^\s*commit;/m),
    };
    expect(i.begin).toBeGreaterThanOrEqual(0);
    expect(i.lock).toBeGreaterThan(i.begin);
    expect(i.idx).toBeGreaterThan(i.lock);
    expect(i.commit).toBeGreaterThan(i.idx);
  });
  it("creates exactly one unique index with the exact key and the exact status set", () => {
    const m = body.match(/create unique index payment_charge_attempts_one_fee_per_appointment_uniq\s+on public\.payment_charge_attempts \(appointment_id, stripe_livemode\)\s+where ([\s\S]*?);/);
    expect(m).not.toBeNull();
    const pred = m![1].replace(/\s+/g, " ");
    expect(pred).toContain("appointment_id is not null");
    expect(pred).toContain("charge_reason in ('late_cancellation_fee', 'no_show_fee')");
    expect(pred).toContain("status in ('ready', 'pending_stripe', 'succeeded')");
    expect(pred).not.toMatch(/failed|cancelled|blocked|session_payment/);
    expect((body.match(/create (unique )?index/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/concurrently/i);
  });
  it("writes no data and changes no column, trigger, policy, grant or function", () => {
    expect(body).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from|truncate|alter\s+table|create\s+(or\s+replace\s+)?(function|trigger|policy)|grant\s|revoke\s|drop\s+(table|column|function|trigger|policy))\b/i);
  });
  it("fails closed on existing duplicates, with a plain message and no data change", () => {
    expect(body).toMatch(/having count\(\*\) > 1/);
    expect(body).toMatch(/raise exception '0338:/);
  });
  it("the down file drops the index and nothing else, inside its own transaction", () => {
    const d = code(DOWN);
    expect(d).toMatch(/drop index if exists public\.payment_charge_attempts_one_fee_per_appointment_uniq;/);
    expect(d).toMatch(/begin;[\s\S]*set local lock_timeout[\s\S]*drop index[\s\S]*commit;/);
    expect(d).not.toMatch(/\b(delete|update|insert|truncate|alter|drop\s+(table|column|function|trigger))\b/i);
  });
});
