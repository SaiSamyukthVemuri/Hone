import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #167. Migration 0072 adds public.consent_form_templates.is_live
// to gate client-portal visibility separately from the practitioner
// status enum. These tests pin the load-bearing properties so a
// future migration that reverts or weakens any of them is caught
// by `npm test`. We test the migration file content directly
// rather than spinning up a DB; the prior pattern in
// tests/migrations/0070-practitioner-notifications.test.ts is the
// reference shape.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0072_consent_templates_is_live.sql",
);
const SOURCE = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0072: column shape", () => {
  it("adds is_live as boolean NOT NULL DEFAULT FALSE", () => {
    expect(SOURCE).toMatch(
      /ADD COLUMN IF NOT EXISTS is_live BOOLEAN NOT NULL DEFAULT FALSE/i,
    );
  });

  it("DEFAULT is explicitly FALSE, not TRUE", () => {
    // The safety property is that a freshly inserted row cannot
    // land in the client portal by accident. A DEFAULT TRUE would
    // reverse that property, so we pin it.
    expect(SOURCE).not.toMatch(/DEFAULT TRUE/i);
  });

  it("targets the consent_form_templates table, not signatures or another table", () => {
    expect(SOURCE).toMatch(
      /ALTER TABLE public\.consent_form_templates/,
    );
    expect(SOURCE).not.toMatch(/ALTER TABLE public\.client_consent_signatures/);
  });
});

describe("migration 0072: backfill predicate", () => {
  it("backfills is_live = TRUE for status='active' rows", () => {
    // The audit-defined "what reaches clients today" predicate is
    // exactly status='active'. The UPDATE in the migration must
    // mirror that or studios will lose live templates after
    // deploy.
    expect(SOURCE).toMatch(
      /UPDATE public\.consent_form_templates[\s\S]*?SET is_live = TRUE[\s\S]*?WHERE status = 'active'/i,
    );
  });

  it("does NOT flip rows that were status='draft' or 'archived' to live", () => {
    // A sloppy backfill (e.g. UPDATE ... SET is_live = TRUE
    // unconditionally) would silently expose every draft. Pin
    // the obvious anti-patterns; the positive predicate test
    // above already enforces the safe predicate.
    expect(SOURCE).not.toMatch(/SET is_live = TRUE\s*WHERE TRUE/i);
    expect(SOURCE).not.toMatch(/SET is_live = TRUE\s*;/);
    expect(SOURCE).not.toMatch(/SET is_live = TRUE\s*WHERE 1\s*=\s*1/i);
  });
});

describe("migration 0072: CHECK constraint", () => {
  it("adds a CHECK that is_live=true implies status='active'", () => {
    // The structural backstop. Without this, a future direct UPDATE
    // could leave a row in (is_live=true, status='archived'), which
    // would surface archived legal text on the portal.
    expect(SOURCE).toMatch(
      /CHECK\s*\(\s*NOT is_live OR status = 'active'\s*\)/i,
    );
  });

  it("the constraint name names the intent so a future migration can find it", () => {
    expect(SOURCE).toMatch(
      /consent_form_templates_live_requires_active_check/,
    );
  });

  it("DROP CONSTRAINT IF EXISTS precedes ADD CONSTRAINT so the migration is idempotent", () => {
    const dropIdx = SOURCE.search(
      /DROP CONSTRAINT IF EXISTS consent_form_templates_live_requires_active_check/i,
    );
    const addIdx = SOURCE.search(
      /ADD CONSTRAINT consent_form_templates_live_requires_active_check/i,
    );
    expect(dropIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });
});

describe("migration 0072: idempotency + safety", () => {
  it("uses ADD COLUMN IF NOT EXISTS so a re-run is safe", () => {
    expect(SOURCE).toMatch(/ADD COLUMN IF NOT EXISTS is_live/);
  });

  it("does not run any DDL or DML against the client_consent_signatures table", () => {
    // Historical signatures are immutable + snapshot-based; the
    // migration must not run any data-modifying or schema-
    // modifying statement against them. The migration body DOES
    // mention the table by name in the rationale comments
    // (documenting non-impact), so we pin only the actual
    // statement keywords against the table.
    expect(SOURCE).not.toMatch(/ALTER TABLE[^\n]*client_consent_signatures/i);
    expect(SOURCE).not.toMatch(/UPDATE[^\n]*client_consent_signatures/i);
    expect(SOURCE).not.toMatch(/DELETE[^\n]*client_consent_signatures/i);
    expect(SOURCE).not.toMatch(/INSERT INTO[^\n]*client_consent_signatures/i);
    expect(SOURCE).not.toMatch(/DROP TABLE[^\n]*client_consent_signatures/i);
    expect(SOURCE).not.toMatch(/TRUNCATE[^\n]*client_consent_signatures/i);
  });

  it("does not modify the status enum or its CHECK", () => {
    expect(SOURCE).not.toMatch(/ALTER COLUMN status/);
    expect(SOURCE).not.toMatch(/consent_form_templates_status_check/);
  });

  it("does not introduce any RLS policy change", () => {
    expect(SOURCE).not.toMatch(/CREATE POLICY/i);
    expect(SOURCE).not.toMatch(/DROP POLICY/i);
    expect(SOURCE).not.toMatch(/ALTER POLICY/i);
  });

  it("does not introduce any new index", () => {
    // The audit deferred the partial index to a future PR if the
    // query plan regresses. A new index here would be scope creep.
    expect(SOURCE).not.toMatch(/CREATE INDEX/i);
    expect(SOURCE).not.toMatch(/CREATE UNIQUE INDEX/i);
  });
});

describe("migration 0072: documentation", () => {
  it("carries a COMMENT ON COLUMN that names the contract", () => {
    expect(SOURCE).toMatch(
      /COMMENT ON COLUMN public\.consent_form_templates\.is_live IS/,
    );
  });

  it("the rationale comment block names PR #167 and Chloe's report", () => {
    expect(SOURCE).toMatch(/PR #167/);
    expect(SOURCE).toMatch(/Chloe/);
  });
});
