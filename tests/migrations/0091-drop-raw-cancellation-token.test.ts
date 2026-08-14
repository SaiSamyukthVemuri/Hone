import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #264. Source-grep tests pin the load-bearing shape of the migration
// that drops the legacy raw appointments.cancellation_token column. The
// migration must: re-create both token-verifying RPCs HASH-ONLY (drop the
// deploy-window `OR cancellation_token = ...` branches + the raw-column
// INSERT), drop the deploy-window hashing trigger + its function, drop the
// dead 2-arg cancel RPC, and drop the raw column, WITHOUT touching the
// canonical cancellation_token_hash column / CHECK / unique index, any
// payment table, RLS, or the live-mode posture.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0091_drop_raw_cancellation_token.sql",
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");

// Whole-file matcher that ignores the leading comment block, used for the
// "no raw reference survives" assertions so a SQL statement (not a comment
// describing the old behavior) is what we test.
const CODE = MIGRATION.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("0091 migration: drops the raw column + its 0025 constraint/index", () => {
  it("drops the raw cancellation_token column (IF EXISTS, re-runnable)", () => {
    expect(CODE).toMatch(
      /alter table public\.appointments\s+drop column if exists cancellation_token;/,
    );
  });
  it("drops the 0025 unique constraint and partial index", () => {
    expect(CODE).toMatch(
      /drop constraint if exists appointments_cancellation_token_unique/,
    );
    expect(CODE).toMatch(
      /drop index if exists public\.appointments_cancellation_token_idx/,
    );
  });
});

describe("0091 migration: drops the deploy-window trigger + function", () => {
  it("drops the trigger and its function (IF EXISTS)", () => {
    expect(CODE).toMatch(
      /drop trigger if exists appointments_hash_cancellation_token_trg\s+on public\.appointments;/,
    );
    expect(CODE).toMatch(
      /drop function if exists public\.appointments_hash_cancellation_token\(\);/,
    );
  });
});

describe("0091 migration: cancel RPC is hash-only", () => {
  it("re-creates the 5-arg public_cancel_appointment_with_token", () => {
    expect(CODE).toMatch(
      /create or replace function public\.public_cancel_appointment_with_token\(\s*p_token\s+text,/,
    );
  });
  it("matches cancellation_token_hash and NOT the raw column", () => {
    expect(CODE).toMatch(/where a\.cancellation_token_hash = p_token/);
    // The deploy-window raw branch is gone.
    expect(CODE).not.toMatch(/or a\.cancellation_token = p_token/);
  });
  it("drops the dead 2-arg cancel RPC (it referenced the raw column)", () => {
    expect(CODE).toMatch(
      /drop function if exists public\.public_cancel_appointment_with_token\(text, text\);/,
    );
  });

  it("drops the dead finalize_card_required_public_booking fn (it INSERTed the raw column)", () => {
    expect(CODE).toMatch(
      /drop function if exists public\.finalize_card_required_public_booking\(\s*text, uuid, text, text, text\s*\);/,
    );
  });
});

describe("0091 migration: reschedule RPC is hash-only", () => {
  it("re-creates reschedule_appointment matching by hash only", () => {
    expect(CODE).toMatch(
      /and cancellation_token_hash = p_current_cancellation_token/,
    );
    expect(CODE).not.toMatch(/or cancellation_token = p_current_cancellation_token/);
  });
  it("inserts the new token as hash only (no raw column, no shape routing)", () => {
    // The new row's INSERT column list no longer includes the raw column.
    const insertBlock =
      CODE.match(/insert into public\.appointments \([\s\S]*?\)\s*values/)?.[0] ??
      "";
    expect(insertBlock).toMatch(/cancellation_token_hash/);
    expect(insertBlock).not.toMatch(/[^_]cancellation_token\b/);
    // No 64-hex shape-routing CASE survives.
    expect(CODE).not.toMatch(/case when p_new_cancellation_token ~ '\^\[a-f0-9\]/);
  });
});

describe("0091 migration: no raw column reference survives in code", () => {
  it("never reads/writes the raw cancellation_token column (only _hash + drop/2-arg-drop)", () => {
    // Allowed mentions in CODE: the DROP COLUMN, the constraint/index drop,
    // and the 2-arg function drop signature. Everything else must be the
    // _hash column. Strip those allowed lines, then assert no bare
    // cancellation_token remains.
    const residual = CODE.split("\n")
      .filter(
        (l) =>
          !/drop column if exists cancellation_token/.test(l) &&
          !/appointments_cancellation_token_unique/.test(l) &&
          !/appointments_cancellation_token_idx/.test(l) &&
          !/public_cancel_appointment_with_token\(text, text\)/.test(l),
      )
      .join("\n");
    expect(residual).not.toMatch(/[^_]cancellation_token\b/);
  });
});

describe("0091 migration: keeps the canonical hash column untouched", () => {
  it("does NOT drop cancellation_token_hash, its CHECK, or its unique index", () => {
    expect(CODE).not.toMatch(/drop column if exists cancellation_token_hash/);
    expect(CODE).not.toMatch(/drop constraint if exists appointments_cancellation_token_hash_check/);
    expect(CODE).not.toMatch(/drop index if exists public\.appointments_cancellation_token_hash_uniq/);
  });
});

describe("0091 migration: safety negatives", () => {
  it("touches no payment table and no Stripe/live-mode gate", () => {
    expect(CODE).not.toMatch(/payment_charge_attempts|paymentIntents|refunds\.create|stripe_livemode|STRIPE_ALLOW_LIVE_MODE/i);
  });
  it("makes no RLS change", () => {
    expect(CODE).not.toMatch(/enable row level security|create policy|alter policy|drop policy/i);
  });
  it("does not re-create pgcrypto", () => {
    expect(CODE).not.toMatch(/create extension[^;]*pgcrypto/i);
  });
  it("RPCs remain SECURITY DEFINER, service_role-only", () => {
    expect(CODE).toMatch(/security definer/);
    expect(CODE).toMatch(/grant execute on function public\.reschedule_appointment[\s\S]{0,120}to service_role/);
    expect(CODE).toMatch(/grant execute on function public\.public_cancel_appointment_with_token[\s\S]{0,160}to service_role/);
  });
});
