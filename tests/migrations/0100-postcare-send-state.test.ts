import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #311. SQL-text pin for migration 0100 (postcare send-state correctness).
// The db-integration lane applies it + regenerates types; this pins the shape.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0100_postcare_send_state.sql"),
  "utf8",
);
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0100 adds the 4 nullable postcare send-state columns", () => {
  for (const col of [
    "postcare_email_claimed_at",
    "postcare_email_failed_at",
    "postcare_email_last_error",
    "postcare_email_last_attempt_at",
  ]) {
    it(`adds ${col} (additive/backfill-safe, nullable)`, () => {
      expect(SQL).toMatch(new RegExp(`add column if not exists ${col}\\b`));
      // Never NOT NULL (would break existing rows).
      expect(CODE).not.toMatch(new RegExp(`${col}[^,;]*not null`, "i"));
    });
  }

  it("the two timestamptz columns + text error column have the right types", () => {
    expect(SQL).toMatch(/postcare_email_claimed_at\s+timestamptz/);
    expect(SQL).toMatch(/postcare_email_failed_at\s+timestamptz/);
    expect(SQL).toMatch(/postcare_email_last_error\s+text/);
    expect(SQL).toMatch(/postcare_email_last_attempt_at\s+timestamptz/);
  });
});

describe("0100 is safe: additive only, no RLS/enum/trigger/destructive", () => {
  it("only alters appointments, additively", () => {
    expect(SQL).toMatch(/alter table public\.appointments/);
    expect(SQL).toMatch(/add column if not exists/);
  });
  it("no RLS / policy / grant change", () => {
    expect(CODE).not.toMatch(/create policy|alter policy|drop policy|enable row level|grant |revoke /i);
  });
  it("no enum / type change", () => {
    expect(CODE).not.toMatch(/create type|alter type|drop type/i);
  });
  it("no trigger / function change", () => {
    expect(CODE).not.toMatch(/create trigger|drop trigger|create (or replace )?function/i);
  });
  it("no destructive DDL", () => {
    expect(CODE).not.toMatch(/drop column|drop table|drop index|alter column .* type|rename/i);
  });
});
