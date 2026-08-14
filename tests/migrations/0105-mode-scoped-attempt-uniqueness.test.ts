import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Migration 0105: mode-scope the active payment-attempt duplicate protection.
// The 0073 partial uniques (session_payment per session; fees per
// (appointment, reason)) gain stripe_livemode, so a test attempt no longer
// blocks a live attempt (and vice versa) while same-mode duplicate protection
// is preserved. Behavioral proof: tests/db/attempt-uniqueness-per-mode.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0105_mode_scoped_active_attempt_uniqueness.sql";
const SOURCE = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const CODE = SOURCE.replace(/--.*$/gm, "");

describe("0105: migration number + scope", () => {
  it("is migration 0105 (the repo-max tripwire now lives in the newest migration's test, 0106)", () => {
    expect(FILE).toMatch(/^0105_/);
  });

  it("touches ONLY the two indexes, no tables, RPCs, policies, data, or env", () => {
    expect(CODE).not.toMatch(/alter table|create table|create policy|drop policy|function|insert into|update |delete from|truncate/i);
    expect(CODE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    // Untouched: Stripe-id-keyed uniques + the legacy manual-fee table.
    expect(CODE).not.toMatch(/idempotency_uniq|pi_uniq|refund_id_uniq|manual_fee_charge_attempts/);
  });
});

describe("0105: index rescopes", () => {
  it("session_payment active unique becomes (session_id, stripe_livemode) with the unchanged predicate", () => {
    expect(CODE).toMatch(/drop index if exists public\.payment_charge_attempts_active_session_payment_uniq/);
    expect(CODE).toMatch(
      /create unique index payment_charge_attempts_active_session_payment_uniq\s*\n?\s*on public\.payment_charge_attempts \(session_id, stripe_livemode\)\s*\n?\s*where session_id is not null\s*\n?\s*and charge_reason = 'session_payment'\s*\n?\s*and status in \('ready', 'pending_stripe', 'succeeded'\)/,
    );
  });

  it("fee active unique becomes (appointment_id, charge_reason, stripe_livemode) with the unchanged predicate", () => {
    expect(CODE).toMatch(/drop index if exists public\.payment_charge_attempts_active_fee_per_appointment_uniq/);
    expect(CODE).toMatch(
      /create unique index payment_charge_attempts_active_fee_per_appointment_uniq\s*\n?\s*on public\.payment_charge_attempts \(appointment_id, charge_reason, stripe_livemode\)\s*\n?\s*where appointment_id is not null\s*\n?\s*and charge_reason in \('late_cancellation_fee', 'no_show_fee'\)\s*\n?\s*and status in \('ready', 'pending_stripe', 'succeeded'\)/,
    );
  });
});

describe("0105 companions: eligibility existing-attempt reads are mode-scoped", () => {
  function read(rel: string): string {
    return readFileSync(path.resolve(__dirname, "../../", rel), "utf8");
  }
  it("session eligibility reads attempts for the current mode only (variable, no literal)", () => {
    const src = read("lib/billing/session-payment-eligibility.ts");
    const block = src.slice(src.indexOf('.from("payment_charge_attempts")'));
    expect(block).toMatch(/\.eq\("charge_reason", "session_payment"\)\s*\n?\s*\.eq\("stripe_livemode", livemode\)/);
    expect(src).not.toMatch(/\.eq\("stripe_livemode", (true|false)\)/);
  });
  it("fee eligibility reads BOTH ledgers for the current mode only", () => {
    const src = read("lib/billing/manual-fee-eligibility.ts");
    const canonical = src.slice(src.indexOf('.from("payment_charge_attempts")'));
    expect(canonical).toMatch(/\.in\("charge_reason", \["no_show_fee", "late_cancellation_fee"\]\)\s*\n?\s*\.eq\("stripe_livemode", livemode\)/);
    const legacy = src.slice(src.indexOf('.from("manual_fee_charge_attempts")'));
    expect(legacy.slice(0, 600)).toMatch(/\.eq\("stripe_livemode", livemode\)/);
    expect(src).not.toMatch(/\.eq\("stripe_livemode", (true|false)\)/);
  });
});
