import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #178. Source-grep tests pin the load-bearing shape of the
// refund-columns migration. A future re-edit cannot silently widen
// scope, change CHECK semantics, or drop a partial unique.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0078_payment_charge_attempts_refund_columns.sql",
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");

describe("0078 migration: columns are present and nullable", () => {
  it("adds refund_status text", () => {
    expect(MIGRATION).toMatch(/add column if not exists refund_status text/);
  });

  it("adds refund_amount_cents integer", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists refund_amount_cents integer/,
    );
  });

  it("adds refunded_at timestamptz", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists refunded_at timestamptz/,
    );
  });

  it("adds stripe_refund_id text", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists stripe_refund_id text/,
    );
  });

  it("adds refund_failure_code text", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists refund_failure_code text/,
    );
  });

  it("adds refund_failure_message_safe text", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists refund_failure_message_safe text/,
    );
  });

  it("adds refund_internal_note text", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists refund_internal_note text/,
    );
  });

  it("adds refund_idempotency_key text", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists refund_idempotency_key text/,
    );
  });

  it("adds refund_initiated_by_practitioner_id uuid", () => {
    expect(MIGRATION).toMatch(
      /add column if not exists refund_initiated_by_practitioner_id uuid/,
    );
  });

  it("every ADD COLUMN uses IF NOT EXISTS", () => {
    const addColumns =
      MIGRATION.match(/^\s*add column[^\n]+/gim) ?? [];
    // 9 columns; sanity check.
    expect(addColumns.length).toBe(9);
    for (const line of addColumns) {
      expect(line).toMatch(/if not exists/i);
    }
  });
});

describe("0078 migration: CHECK constraints", () => {
  it("refund_status CHECK accepts null or {pending_stripe, succeeded, failed}", () => {
    expect(MIGRATION).toMatch(
      /payment_charge_attempts_refund_status_check[\s\S]{0,400}refund_status is null[\s\S]{0,300}'pending_stripe'[\s\S]{0,80}'succeeded'[\s\S]{0,80}'failed'/,
    );
  });

  it("refund_amount_cents CHECK enforces > 0 AND <= amount_cents", () => {
    expect(MIGRATION).toMatch(
      /payment_charge_attempts_refund_amount_bounds_check[\s\S]{0,400}refund_amount_cents is null[\s\S]{0,200}refund_amount_cents > 0[\s\S]{0,200}refund_amount_cents <= amount_cents/,
    );
  });

  it("refund_failure_code length capped at 100", () => {
    expect(MIGRATION).toMatch(
      /payment_charge_attempts_refund_failure_code_check[\s\S]{0,400}char_length\(refund_failure_code\) <= 100/,
    );
  });

  it("refund_failure_message_safe length capped at 1000", () => {
    expect(MIGRATION).toMatch(
      /payment_charge_attempts_refund_failure_message_safe_check[\s\S]{0,400}char_length\(refund_failure_message_safe\) <= 1000/,
    );
  });

  it("refund_internal_note length capped at 500", () => {
    expect(MIGRATION).toMatch(
      /payment_charge_attempts_refund_internal_note_check[\s\S]{0,400}char_length\(refund_internal_note\) <= 500/,
    );
  });

  it("every CHECK constraint uses DROP IF EXISTS then ADD (re-runnable)", () => {
    const constraintNames = [
      "payment_charge_attempts_refund_status_check",
      "payment_charge_attempts_refund_amount_bounds_check",
      "payment_charge_attempts_refund_failure_code_check",
      "payment_charge_attempts_refund_failure_message_safe_check",
      "payment_charge_attempts_refund_internal_note_check",
    ];
    for (const name of constraintNames) {
      expect(MIGRATION).toMatch(
        new RegExp(
          `drop constraint if exists ${name}[\\s\\S]{0,400}add constraint ${name}`,
        ),
      );
    }
  });
});

describe("0078 migration: indexes", () => {
  it("creates partial unique on stripe_refund_id", () => {
    expect(MIGRATION).toMatch(
      /create unique index if not exists payment_charge_attempts_refund_id_uniq[\s\S]{0,400}where stripe_refund_id is not null/,
    );
  });

  it("creates partial unique on refund_idempotency_key", () => {
    expect(MIGRATION).toMatch(
      /create unique index if not exists payment_charge_attempts_refund_idempotency_uniq[\s\S]{0,400}where refund_idempotency_key is not null/,
    );
  });

  it("creates partial index for pending-refund operator dashboard", () => {
    expect(MIGRATION).toMatch(
      /create index if not exists payment_charge_attempts_refund_pending_idx[\s\S]{0,400}where refund_status = 'pending_stripe'/,
    );
  });
});

describe("0078 migration: forbidden operations", () => {
  it("does NOT relax the livemode CHECK", () => {
    expect(MIGRATION).not.toMatch(/drop constraint[\s\S]{0,200}livemode_false_check/i);
    expect(MIGRATION).not.toMatch(/stripe_livemode\s*=\s*true/i);
  });

  it("does NOT touch manual_fee_charge_attempts", () => {
    expect(MIGRATION).not.toMatch(
      /update public\.manual_fee_charge_attempts|insert into public\.manual_fee_charge_attempts|delete from public\.manual_fee_charge_attempts|alter table public\.manual_fee_charge_attempts/i,
    );
  });

  it("does NOT UPDATE / DELETE existing rows", () => {
    expect(MIGRATION).not.toMatch(
      /update public\.payment_charge_attempts\s|delete from public\.payment_charge_attempts/i,
    );
  });

  it("does NOT add a new RLS policy", () => {
    expect(MIGRATION).not.toMatch(/create policy|alter table[\s\S]{0,200}enable row level security/i);
  });
});

describe("0078 migration: audit trail", () => {
  it("references the migration ledger advance (0077 -> 0078) in the header", () => {
    expect(MIGRATION).toMatch(/0077[\s\S]{0,400}0078/);
  });

  it("documents the v1 partial-refund posture", () => {
    expect(MIGRATION).toMatch(/full refund only/i);
  });

  it("documents the idempotency posture (re-runnable, partial uniques)", () => {
    expect(MIGRATION).toMatch(/re-runnable/i);
  });
});
