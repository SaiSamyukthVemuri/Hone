import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #156. The migration is the source of truth for the schema
// invariants the rest of the codebase relies on. Pin the contract
// textually so a refactor that loosens the FK or adds a unique
// constraint by accident is caught by `npm test`.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0068_sessions_appointment_link.sql",
);
const SOURCE = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0068 adds the sessions.appointment_id FK", () => {
  it("adds a nullable appointment_id column referencing appointments(id)", () => {
    expect(SOURCE).toMatch(/add column if not exists appointment_id uuid/i);
    expect(SOURCE).toMatch(/references public\.appointments\(id\)/);
  });

  it("uses on delete set null (preserves the clinical record)", () => {
    expect(SOURCE).toMatch(/on delete set null/i);
  });

  it("does NOT add a unique constraint on appointment_id", () => {
    // One appointment may legitimately have multiple session rows.
    expect(SOURCE).not.toMatch(/unique\s*\([^)]*appointment_id[^)]*\)/i);
    expect(SOURCE).not.toMatch(/add constraint[^;]*unique[^;]*appointment_id/i);
  });

  it("does NOT run an UPDATE backfill on historical rows", () => {
    // A wrong session-to-appointment backfill would silently corrupt
    // the treatment memory this column exists to protect. Backfill,
    // if it ever ships, will be a separate supervised PR.
    expect(SOURCE).not.toMatch(/update\s+public\.sessions\s+set/i);
  });

  it("creates the lookup index sessions_appointment_id_idx", () => {
    expect(SOURCE).toMatch(
      /create index if not exists sessions_appointment_id_idx[\s\S]*on public\.sessions\(appointment_id\)/i,
    );
  });

  it("creates the compound index sessions_studio_appointment_idx", () => {
    expect(SOURCE).toMatch(
      /create index if not exists sessions_studio_appointment_idx[\s\S]*on public\.sessions\(studio_id, appointment_id\)/i,
    );
  });

  it("partials both indexes on appointment_id is not null", () => {
    // Keeps the indexes small while most rows are null (this PR ships
    // with zero linked rows; growth is gradual as new appointment-
    // context session creation runs).
    const partialMatches = SOURCE.match(/where appointment_id is not null/gi) ?? [];
    expect(partialMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT alter any RLS policy on sessions", () => {
    // Sessions RLS already covers the new column via the existing
    // studio-membership policy from migration 0001; the server action
    // enforces lineage on the write path. No RLS change should ship
    // in this PR.
    expect(SOURCE).not.toMatch(/create\s+policy/i);
    expect(SOURCE).not.toMatch(/drop\s+policy/i);
    expect(SOURCE).not.toMatch(/alter\s+policy/i);
  });

  it("documents the verification SQL the operator should run", () => {
    // The migration header carries a short verification recipe so the
    // operator can confirm the column / FK / indexes landed without
    // hunting through docs/12.
    expect(SOURCE).toMatch(/information_schema\.columns/);
    expect(SOURCE).toMatch(/pg_constraint/);
    expect(SOURCE).toMatch(/pg_indexes/);
    expect(SOURCE).toMatch(/linked_sessions/);
    expect(SOURCE).toMatch(/unlinked_sessions/);
  });
});
