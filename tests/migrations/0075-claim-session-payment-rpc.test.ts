import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #173. Migration 0075 adds the atomic claim RPC for
// payment_charge_attempts session_payment execution. The RPC is the
// load-bearing safety primitive: it lets runSessionPaymentCharge
// transition status='ready' -> 'pending_stripe' and stamp the
// deterministic idempotency key in one transaction before any
// Stripe call. These tests pin the RPC shape so a future refactor
// that drops a guard fails CI.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0075_claim_session_payment_charge_attempt.sql",
);
const SOURCE = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0075: RPC signature", () => {
  it("creates a function named claim_session_payment_charge_attempt", () => {
    expect(SOURCE).toMatch(
      /create or replace function public\.claim_session_payment_charge_attempt\s*\(/i,
    );
  });

  it("takes exactly three parameters: attempt_id, practitioner_id, idempotency_key", () => {
    expect(SOURCE).toMatch(/p_attempt_id\s+uuid/);
    expect(SOURCE).toMatch(/p_practitioner_id\s+uuid/);
    expect(SOURCE).toMatch(/p_idempotency_key\s+text/);
  });

  it("returns the session-payment-specific columns (charge_reason, session_id, signature)", () => {
    expect(SOURCE).toMatch(/session_id\s+uuid/);
    expect(SOURCE).toMatch(/charge_reason\s+text/);
    expect(SOURCE).toMatch(/card_authorization_signature_id\s+uuid/);
    expect(SOURCE).toMatch(/stripe_payment_intent_id\s+text/);
    expect(SOURCE).toMatch(/stripe_idempotency_key\s+text/);
    expect(SOURCE).toMatch(/status_before_claim\s+text/);
  });
});

describe("migration 0075: claim atomicity + guards", () => {
  it("takes a row-level FOR UPDATE lock on the target row", () => {
    expect(SOURCE).toMatch(
      /from public\.payment_charge_attempts pca[\s\S]{0,200}for update/i,
    );
  });

  it("conditionally updates only when status = 'ready'", () => {
    expect(SOURCE).toMatch(
      /update public\.payment_charge_attempts[\s\S]{0,400}set status\s*=\s*'pending_stripe'[\s\S]{0,200}where[\s\S]{0,200}status\s*=\s*'ready'/i,
    );
  });

  it("stamps the deterministic idempotency key on the row at claim time", () => {
    expect(SOURCE).toMatch(/stripe_idempotency_key\s*=\s*p_idempotency_key/);
  });

  it("guards against non-session_payment rows (reason guard)", () => {
    expect(SOURCE).toMatch(/v_row\.charge_reason\s*<>\s*'session_payment'/);
  });

  it("guards against stripe_livemode != false rows", () => {
    expect(SOURCE).toMatch(/v_row\.stripe_livemode\s*<>\s*false/);
  });

  it("guards against a non-null stripe_payment_intent_id at claim time", () => {
    expect(SOURCE).toMatch(
      /v_row\.stripe_payment_intent_id\s+is\s+not\s+null/i,
    );
  });
});

describe("migration 0075: claim result vocabulary", () => {
  const REQUIRED_RESULT_TOKENS = [
    "'claimed'",
    "'already_succeeded'",
    "'already_pending'",
    "'not_found'",
    "'not_authorized'",
    "'not_ready'",
  ];
  for (const tok of REQUIRED_RESULT_TOKENS) {
    it(`returns ${tok}`, () => {
      expect(SOURCE).toContain(tok);
    });
  }
});

describe("migration 0075: practitioner authorization gate", () => {
  it("requires the practitioner to be active in the row's studio", () => {
    expect(SOURCE).toMatch(
      /select pr\.role into v_role[\s\S]{0,400}from public\.practitioners pr[\s\S]{0,400}pr\.studio_id\s*=\s*v_row\.studio_id[\s\S]{0,200}pr\.active\s*=\s*true/i,
    );
  });
});

describe("migration 0075: grants", () => {
  it("revokes EXECUTE from public, anon, authenticated", () => {
    expect(SOURCE).toMatch(
      /revoke execute on function public\.claim_session_payment_charge_attempt\(uuid, uuid, text\)\s*\n?\s*from public, anon, authenticated/i,
    );
  });

  it("grants EXECUTE to service_role", () => {
    expect(SOURCE).toMatch(
      /grant execute on function public\.claim_session_payment_charge_attempt\(uuid, uuid, text\)\s*\n?\s*to service_role/i,
    );
  });
});

describe("migration 0075: safety invariants", () => {
  it("uses SECURITY DEFINER so the RPC bypasses RLS but is still EXECUTE-restricted", () => {
    expect(SOURCE).toMatch(/security definer/i);
  });

  it("pins search_path to pg_catalog, pg_temp", () => {
    expect(SOURCE).toMatch(/set search_path = pg_catalog, pg_temp/i);
  });

  it("does NOT run any DDL / DML against the legacy manual_fee_charge_attempts table", () => {
    // The header comment legitimately references the legacy table
    // by name to document the boundary; the load-bearing check is
    // that the RPC body never reads, writes, or alters that table.
    expect(SOURCE).not.toMatch(/from\s+public\.manual_fee_charge_attempts/i);
    expect(SOURCE).not.toMatch(/update\s+public\.manual_fee_charge_attempts/i);
    expect(SOURCE).not.toMatch(/insert\s+into\s+public\.manual_fee_charge_attempts/i);
    expect(SOURCE).not.toMatch(/delete\s+from\s+public\.manual_fee_charge_attempts/i);
    expect(SOURCE).not.toMatch(/alter\s+table\s+public\.manual_fee_charge_attempts/i);
  });

  it("does NOT invoke any Stripe SDK or extension function", () => {
    // Column names like stripe_account_id are legitimate; what we
    // forbid is an actual function call into a Stripe-named
    // helper (which would imply external network IO from inside
    // the RPC, which is not supported in Postgres SECURITY
    // DEFINER context anyway).
    expect(SOURCE).not.toMatch(/perform\s+stripe[._a-z]/i);
    expect(SOURCE).not.toMatch(/select\s+stripe_[a-z_]+\s*\(/i);
    expect(SOURCE).not.toMatch(/payment_intent_create/i);
  });
});
