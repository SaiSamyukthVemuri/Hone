import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #171 patch. Migration 0074 corrects a hidden inconsistency
// in 0073: the session_id FK was declared ON DELETE SET NULL but
// the same migration's payment_charge_attempts_reason_shape_check
// requires session_payment rows to have a non-null session_id.
// SET NULL would have caused a check_violation on parent-session
// delete, which is functionally a confusing hidden RESTRICT.
// 0074 makes the declaration honest: drop the FK and re-create
// it with ON DELETE RESTRICT.
//
// These tests pin that 0074 does only the FK ALTER and nothing
// else. The corrected effective state for the 0073 + 0074 stack
// is verified by the matching test in
// tests/migrations/0073-payment-charge-attempts.test.ts.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0074_payment_charge_attempts_session_fk_restrict.sql",
);
const SOURCE = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0074: corrects session_id FK to ON DELETE RESTRICT", () => {
  it("drops the existing session_id FK by its 0073-assigned auto-name", () => {
    expect(SOURCE).toMatch(
      /drop constraint if exists payment_charge_attempts_session_id_fkey/i,
    );
  });

  it("re-adds the FK with the same name", () => {
    expect(SOURCE).toMatch(
      /add constraint payment_charge_attempts_session_id_fkey/i,
    );
  });

  it("the re-added FK references sessions(id) ON DELETE RESTRICT", () => {
    expect(SOURCE).toMatch(
      /foreign key \(session_id\) references public\.sessions\(id\)\s*\n?\s*on delete restrict/i,
    );
  });

  it("does NOT execute any new SET NULL FK declaration", () => {
    // The header comment legitimately quotes the old 0073 SET
    // NULL declaration as part of the rationale. What we forbid
    // is an actual `add constraint ... on delete set null` or
    // an `alter column ... on delete set null` statement that
    // would re-introduce the bug. We anchor on the ADD CONSTRAINT
    // shape so commentary that mentions SET NULL does not trip
    // the assertion.
    expect(SOURCE).not.toMatch(
      /add constraint[\s\S]{0,400}on delete set null/i,
    );
    expect(SOURCE).not.toMatch(/alter column[\s\S]{0,200}set null/i);
  });

  it("does NOT declare ON DELETE CASCADE on the corrected FK", () => {
    // Defense-in-depth: the only acceptable rule here is RESTRICT.
    expect(SOURCE).not.toMatch(
      /foreign key \(session_id\)[\s\S]{0,80}on delete cascade/i,
    );
  });
});

describe("migration 0074: scope is FK-only (no other schema or runtime change)", () => {
  it("does NOT add any new column", () => {
    expect(SOURCE).not.toMatch(/^\s*add column/im);
  });

  it("does NOT add or modify any CHECK constraint", () => {
    expect(SOURCE).not.toMatch(/check_check/);
    expect(SOURCE).not.toMatch(
      /add constraint[^\n]*(reason_shape_check|livemode_false_check)/i,
    );
    expect(SOURCE).not.toMatch(
      /drop constraint if exists payment_charge_attempts_reason_shape_check/i,
    );
    expect(SOURCE).not.toMatch(
      /drop constraint if exists payment_charge_attempts_livemode_false_check/i,
    );
  });

  it("does NOT create any new index", () => {
    expect(SOURCE).not.toMatch(/create (unique )?index/i);
  });

  it("does NOT modify the RLS policy", () => {
    expect(SOURCE).not.toMatch(/policy/i);
  });

  it("does NOT touch manual_fee_charge_attempts", () => {
    // The patched PR #171 prompt: leave existing manual_fee path
    // untouched. This migration is FK-only on the new table and
    // must not reference the legacy table at all.
    expect(SOURCE).not.toMatch(/manual_fee_charge_attempts/);
  });

  it("does NOT relax any live-mode guard", () => {
    expect(SOURCE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    expect(SOURCE).not.toMatch(
      /drop constraint if exists\s+\w*livemode_false_check/i,
    );
  });

  it("does NOT add a paymentIntents.create or refunds.create reference", () => {
    expect(SOURCE).not.toMatch(/paymentIntents/i);
    expect(SOURCE).not.toMatch(/refunds\.create/i);
  });
});

describe("migration 0074: documentation", () => {
  it("the header explains the SET NULL vs RESTRICT contradiction", () => {
    expect(SOURCE).toMatch(/SET NULL/);
    expect(SOURCE).toMatch(/RESTRICT/);
    expect(SOURCE).toMatch(/reason_shape_check/);
  });

  it("the header names PR #171 and explains the layered-correction discipline", () => {
    expect(SOURCE).toMatch(/PR #171/);
    expect(SOURCE).toMatch(/0073/);
  });

  it("the header notes the dormant-row precondition (no data change)", () => {
    expect(SOURCE).toMatch(/dormant|0 rows|No row.{0,10}data change/i);
  });
});
