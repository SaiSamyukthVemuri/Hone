import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// PR #322 / PR A. Migration 0101 makes payment_charge_attempts CAPABLE of
// storing live rows and lets the claim RPC claim them — while runtime + env keep
// live charges disabled (inert). Source-grep the migration's shape; the
// behavioral proof is tests/db/livemode-ledger-readiness.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0101_live_payment_charge_attempts_db_readiness.sql";
const SOURCE = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
// Comments stripped, to assert on actual DDL not prose.
const CODE = SOURCE.replace(/--.*$/gm, "");

describe("0101: migration number + scope", () => {
  it("is numbered 0101 (immediately after 0100)", () => {
    const nums = readdirSync(MIGRATIONS_DIR)
      .map((f) => /^(\d{4})_/.exec(f)?.[1])
      .filter(Boolean)
      .map((n) => Number(n));
    // 0101 exists and 0100 precedes it; the global-max tripwire lives in the
    // newest migration's test, so this does not re-break when later migrations
    // land.
    expect(nums).toContain(101);
    expect(nums).toContain(100);
    expect(FILE).toMatch(/^0101_/);
  });

  it("touches ONLY payment_charge_attempts + its claim RPC (no other table/env/RLS)", () => {
    expect(CODE).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(CODE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    // No other business table is altered.
    expect(CODE).not.toMatch(/alter table public\.(?!payment_charge_attempts)/i);
  });
});

describe("0101: CHECK replacement", () => {
  it("drops the old payment_charge_attempts_livemode_false_check", () => {
    expect(CODE).toMatch(
      /drop constraint if exists\s+payment_charge_attempts_livemode_false_check/i,
    );
  });

  it("adds the account-requiring structural CHECK", () => {
    expect(CODE).toMatch(
      /add constraint\s+payment_charge_attempts_live_requires_account_check\s+check\s*\(\s*stripe_livemode\s*=\s*false\s+or\s+stripe_account_id\s+is\s+not\s+null\s*\)/i,
    );
  });

  it("does NOT change the stripe_livemode column default (stays false)", () => {
    expect(CODE).not.toMatch(/alter column\s+stripe_livemode/i);
    expect(CODE).not.toMatch(/stripe_livemode\s+.*default\s+true/i);
  });

  it("does NOT touch the legacy manual_fee_charge_attempts CHECK", () => {
    expect(CODE).not.toMatch(/manual_fee_charge_attempts_livemode_false_check/i);
    expect(CODE).not.toMatch(/alter table public\.manual_fee_charge_attempts/i);
  });

  it("does NOT touch the reason-shape CHECK or lineage FKs", () => {
    expect(CODE).not.toMatch(/reason_shape_check/i);
    expect(CODE).not.toMatch(/drop constraint[^\n]*_fk\b/i);
  });
});

describe("0101: claim RPC relaxation", () => {
  it("CREATE OR REPLACEs claim_session_payment_charge_attempt", () => {
    expect(CODE).toMatch(
      /create or replace function public\.claim_session_payment_charge_attempt\(/i,
    );
  });

  it("removes ONLY the live-mode refusal (no `stripe_livemode <> false` remains)", () => {
    expect(CODE).not.toMatch(/stripe_livemode\s*<>\s*false/);
  });

  it("keeps the other RPC guards (reason / status / authorization / PI-id)", () => {
    expect(CODE).toMatch(
      /charge_reason not in \('session_payment', 'no_show_fee', 'late_cancellation_fee'\)/,
    );
    expect(CODE).toMatch(/'not_authorized'::text/);
    expect(CODE).toMatch(/v_row\.status <> 'ready'/);
    expect(CODE).toMatch(/v_row\.stripe_payment_intent_id is not null/);
    // Still transitions ready -> pending_stripe on claim.
    expect(CODE).toMatch(/set status\s*=\s*'pending_stripe'/);
  });

  it("preserves the service_role-only execute grant (no broadening)", () => {
    expect(CODE).toMatch(
      /revoke execute on function public\.claim_session_payment_charge_attempt\(uuid, uuid, text\)\s*\n?\s*from public, anon, authenticated/i,
    );
    expect(CODE).toMatch(
      /grant execute on function public\.claim_session_payment_charge_attempt\(uuid, uuid, text\)\s*\n?\s*to service_role/i,
    );
  });
});
