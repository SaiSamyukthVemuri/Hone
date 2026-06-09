import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #182. Source-grep tests pin the load-bearing shape of the
// calendar feed token hash migration. The migration must add the
// hash column + CHECK + partial unique + backfill from existing
// raw tokens, all without dropping the raw column or touching
// payment tables / RLS.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0079_calendar_feed_token_hash.sql",
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");

describe("0079 migration: column", () => {
  it("adds calendar_feed_token_hash as nullable text via IF NOT EXISTS", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.practitioners\s+add column if not exists calendar_feed_token_hash text;/,
    );
  });
});

describe("0079 migration: CHECK constraint", () => {
  it("enforces 64 lowercase hex chars or NULL", () => {
    expect(MIGRATION).toMatch(
      /practitioners_calendar_feed_token_hash_check[\s\S]{0,400}calendar_feed_token_hash is null[\s\S]{0,200}calendar_feed_token_hash ~ '\^\[a-f0-9\]\{64\}\$'/,
    );
  });

  it("uses DROP+ADD so the migration is re-runnable", () => {
    expect(MIGRATION).toMatch(
      /drop constraint if exists practitioners_calendar_feed_token_hash_check[\s\S]{0,800}add constraint practitioners_calendar_feed_token_hash_check/,
    );
  });
});

describe("0079 migration: partial unique index", () => {
  it("creates a unique partial index on the hash column", () => {
    expect(MIGRATION).toMatch(
      /create unique index if not exists practitioners_calendar_feed_token_hash_uniq[\s\S]{0,400}on public\.practitioners \(calendar_feed_token_hash\)[\s\S]{0,200}where calendar_feed_token_hash is not null/,
    );
  });
});

describe("0079 migration: backfill from raw tokens", () => {
  it("uses encode(extensions.digest(...)) so the route hash + DB hash match", () => {
    expect(MIGRATION).toMatch(
      /encode\(extensions\.digest\(calendar_feed_token, 'sha256'\), 'hex'\)/,
    );
  });

  it("filters on calendar_feed_token IS NOT NULL so practitioners without a token are not touched", () => {
    expect(MIGRATION).toMatch(
      /update public\.practitioners[\s\S]{0,800}where calendar_feed_token is not null[\s\S]{0,200}and calendar_feed_token_hash is null/,
    );
  });

  it("is idempotent (re-run is a no-op because the filter also requires hash IS NULL)", () => {
    expect(MIGRATION).toMatch(/and calendar_feed_token_hash is null/);
  });
});

describe("0079 migration: phase-1 safety contracts", () => {
  it("does NOT drop the raw calendar_feed_token column (phase 1 keeps it for rollout safety)", () => {
    expect(MIGRATION).not.toMatch(
      /alter table public\.practitioners\s+drop column[\s\S]{0,200}calendar_feed_token\b/i,
    );
  });

  it("does NOT null out the raw column (the existing settings UI still reads it)", () => {
    expect(MIGRATION).not.toMatch(
      /update public\.practitioners[\s\S]{0,800}set calendar_feed_token = null/i,
    );
  });

  it("does NOT touch any payment table", () => {
    expect(MIGRATION).not.toMatch(
      /payment_charge_attempts|manual_fee_charge_attempts|stripe_payment_audit|stripe_refunds|stripe_refund_attempts/,
    );
  });

  it("does NOT relax the livemode_false_check on payment tables", () => {
    expect(MIGRATION).not.toMatch(/livemode_false_check/i);
    expect(MIGRATION).not.toMatch(/stripe_livemode\s*=\s*true/i);
  });

  it("does NOT add a new RLS policy or enable RLS on a different table", () => {
    expect(MIGRATION).not.toMatch(/create policy|enable row level security/i);
  });

  it("does NOT re-create the pgcrypto extension (already exists in migration 0001)", () => {
    // The header comment mentions pgcrypto by name; the negative
    // regex targets the SQL statement specifically, ignoring the
    // comment context.
    const code = MIGRATION.split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    expect(code).not.toMatch(/create extension[\s\S]{0,200}pgcrypto/i);
  });
});

describe("0079 migration: audit trail", () => {
  it("references PR #182 + the phase-1 posture", () => {
    expect(MIGRATION).toMatch(/PR #182 phase 1/);
  });

  it("references the migration ledger advance (0078 -> 0079)", () => {
    expect(MIGRATION).toMatch(/0078[\s\S]{0,200}0079/);
  });

  it("documents the phase-2 plan", () => {
    expect(MIGRATION).toMatch(/Phase 2/);
  });
});
