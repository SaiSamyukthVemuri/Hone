import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #175. Migration 0076 adds the receipt-state columns on
// public.payment_charge_attempts so the practitioner UI can show
// the already-sent state across page refreshes and so the
// sendPaymentChargeReceipt helper can use an atomic
// receipt_status null -> sending -> sent/failed claim for
// race-protection. These tests pin the load-bearing schema shape.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0076_payment_charge_attempts_receipt_columns.sql",
);
const SOURCE = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0076: columns added", () => {
  const REQUIRED_COLUMNS = [
    { name: "receipt_status", type: "text" },
    { name: "receipt_sent_at", type: "timestamptz" },
    { name: "receipt_email_to", type: "text" },
    { name: "receipt_failure_code", type: "text" },
    { name: "receipt_failure_message_safe", type: "text" },
  ];
  for (const col of REQUIRED_COLUMNS) {
    it(`adds ${col.name} as nullable ${col.type}`, () => {
      const pattern = new RegExp(
        `add column if not exists ${col.name}\\s+${col.type}\\b`,
        "i",
      );
      expect(SOURCE).toMatch(pattern);
    });
  }

  it("every ADD COLUMN uses IF NOT EXISTS (idempotent)", () => {
    // Scope to actual ALTER TABLE ... ADD COLUMN statements so
    // commentary mentioning "ADD COLUMN" doesn't trip the
    // regex.
    const adds = SOURCE.match(/^\s*add column[^\n]+/gim) ?? [];
    expect(adds.length).toBeGreaterThanOrEqual(5);
    for (const stmt of adds) {
      expect(stmt.toLowerCase()).toMatch(/if not exists/);
    }
  });

  it("no column is declared NOT NULL", () => {
    // Existing rows (0 in prod today) must remain valid; every
    // new column must default to null so a re-apply on a
    // populated table does not require a backfill.
    const adds = SOURCE.match(/^\s*add column[^;]+/gim) ?? [];
    for (const stmt of adds) {
      expect(stmt.toLowerCase()).not.toMatch(/not null/);
    }
  });
});

describe("migration 0076: CHECK constraints", () => {
  it("receipt_status CHECK restricts to null / sending / sent / failed", () => {
    expect(SOURCE).toMatch(
      /add constraint payment_charge_attempts_receipt_status_check[\s\S]{0,400}receipt_status is null[\s\S]{0,200}receipt_status in \('sending', 'sent', 'failed'\)/,
    );
  });

  it("receipt_failure_code CHECK bounds length to 100", () => {
    expect(SOURCE).toMatch(
      /add constraint payment_charge_attempts_receipt_failure_code_check[\s\S]{0,400}char_length\(receipt_failure_code\) <= 100/,
    );
  });

  it("receipt_failure_message_safe CHECK bounds length to 1000", () => {
    expect(SOURCE).toMatch(
      /add constraint payment_charge_attempts_receipt_failure_message_safe_check[\s\S]{0,400}char_length\(receipt_failure_message_safe\) <= 1000/,
    );
  });

  it("every CHECK is DROP+ADD so the migration is safe to re-run", () => {
    for (const name of [
      "payment_charge_attempts_receipt_status_check",
      "payment_charge_attempts_receipt_failure_code_check",
      "payment_charge_attempts_receipt_failure_message_safe_check",
    ]) {
      const drop = new RegExp(`drop constraint if exists ${name}`);
      const add = new RegExp(`add constraint ${name}`);
      expect(SOURCE).toMatch(drop);
      expect(SOURCE).toMatch(add);
    }
  });
});

describe("migration 0076: partial index for stuck-sending dashboards", () => {
  it("creates payment_charge_attempts_receipt_sending_idx", () => {
    expect(SOURCE).toMatch(
      /create index if not exists payment_charge_attempts_receipt_sending_idx/,
    );
  });

  it("the index is partial on receipt_status = 'sending'", () => {
    expect(SOURCE).toMatch(
      /payment_charge_attempts_receipt_sending_idx[\s\S]{0,400}where receipt_status = 'sending'/,
    );
  });
});

describe("migration 0076: safety invariants", () => {
  it("does NOT relax any live-mode CHECK on the row", () => {
    expect(SOURCE).not.toMatch(/livemode_false_check/);
    expect(SOURCE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("does NOT touch manual_fee_charge_attempts", () => {
    expect(SOURCE).not.toMatch(/manual_fee_charge_attempts/);
  });

  it("does NOT modify any RLS policy", () => {
    expect(SOURCE).not.toMatch(/create policy/i);
    expect(SOURCE).not.toMatch(/drop policy/i);
    expect(SOURCE).not.toMatch(/alter policy/i);
  });

  it("does NOT add any DML (no UPDATE / DELETE / INSERT)", () => {
    expect(SOURCE).not.toMatch(/^\s*update\s+public\.payment_charge_attempts/im);
    expect(SOURCE).not.toMatch(/^\s*delete\s+from\s+public\.payment_charge_attempts/im);
    expect(SOURCE).not.toMatch(/^\s*insert\s+into\s+public\.payment_charge_attempts/im);
  });

  it("does NOT invoke any Stripe function (Postgres extension or otherwise)", () => {
    expect(SOURCE).not.toMatch(/paymentIntents/);
    expect(SOURCE).not.toMatch(/charges\.create/);
  });
});

describe("migration 0076: documentation comments", () => {
  it("the file header names PR #175", () => {
    expect(SOURCE).toMatch(/PR #175/);
  });

  it("each receipt column has a COMMENT ON COLUMN entry", () => {
    for (const col of [
      "receipt_status",
      "receipt_sent_at",
      "receipt_email_to",
    ]) {
      const pattern = new RegExp(
        `comment on column public\\.payment_charge_attempts\\.${col} is`,
      );
      expect(SOURCE).toMatch(pattern);
    }
  });
});
