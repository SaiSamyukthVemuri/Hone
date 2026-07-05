import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0105: rescope payment_charge_attempts active duplicate indexes to
// include stripe_livemode. Behavioral proof runs against the real migrated DB in
// tests/db/payment-attempts-per-mode.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0105_mode_scoped_payment_attempt_duplicates.sql";
const SOURCE = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const CODE = SOURCE.replace(/--.*$/gm, "");

describe("0105: migration number + scope", () => {
  it("is the repo migration max", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_/.exec(f)?.[1])
        .filter(Boolean)
        .map((n) => Number(n)),
    );
    expect(maxNum).toBe(105);
    expect(FILE).toMatch(/^0105_/);
  });

  it("touches only payment_charge_attempts indexes", () => {
    expect(CODE).not.toMatch(/alter table|create table|create policy|drop policy|create or replace function|drop function/i);
    expect(CODE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    expect(CODE).not.toMatch(/insert into|update |delete from|truncate/i);
    expect(CODE).toMatch(/drop index if exists public\.payment_charge_attempts_active_fee_per_appointment_uniq/);
    expect(CODE).toMatch(/drop index if exists public\.payment_charge_attempts_active_session_payment_uniq/);
  });
});

describe("0105: index rescope", () => {
  it("keeps manual-fee duplicate protection but scopes it per Stripe mode", () => {
    expect(CODE).toMatch(
      /create unique index payment_charge_attempts_active_fee_per_appointment_uniq\s*\n\s*on public\.payment_charge_attempts \(appointment_id, charge_reason, stripe_livemode\)/,
    );
    expect(CODE).toMatch(/charge_reason in \('late_cancellation_fee', 'no_show_fee'\)/);
    expect(CODE).toMatch(/status in \('ready', 'pending_stripe', 'succeeded'\)/);
  });

  it("keeps session-payment duplicate protection but scopes it per Stripe mode", () => {
    expect(CODE).toMatch(
      /create unique index payment_charge_attempts_active_session_payment_uniq\s*\n\s*on public\.payment_charge_attempts \(session_id, stripe_livemode\)/,
    );
    expect(CODE).toMatch(/charge_reason = 'session_payment'/);
    expect(CODE).toMatch(/status in \('ready', 'pending_stripe', 'succeeded'\)/);
  });
});
