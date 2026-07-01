import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #307. SQL-text pin for migration 0099 (per-photo practitioner note). The
// db-integration lane applies it + regenerates types; this pins the shape so it
// can't regress into an RLS/trigger/destructive change.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0099_treatment_image_notes.sql"),
  "utf8",
);
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0099 adds a nullable practitioner_note text column", () => {
  it("adds practitioner_note text (additive/backfill-safe, no NOT NULL)", () => {
    expect(SQL).toMatch(/add column if not exists practitioner_note text/);
    expect(CODE).not.toMatch(/practitioner_note text[^;]*not null/i);
  });

  it("makes no RLS / policy / grant change", () => {
    expect(CODE).not.toMatch(/create policy|alter policy|drop policy|enable row level|grant |revoke /i);
  });

  it("makes no trigger / function change", () => {
    expect(CODE).not.toMatch(/create trigger|drop trigger|create (or replace )?function|enforce_treatment_image_integrity/i);
  });

  it("makes no enum change and no destructive DDL", () => {
    expect(CODE).not.toMatch(/create type|alter type|drop type/i);
    expect(CODE).not.toMatch(/drop column|drop table|drop index|alter column .* type|rename/i);
  });

  it("touches no storage / bucket / path / token / sanitizer", () => {
    expect(CODE).not.toMatch(/storage|bucket|storage_path|token|sanitiz/i);
  });

  it("only touches treatment_images (additive)", () => {
    expect(SQL).toMatch(/alter table public\.treatment_images/);
    expect(SQL).toMatch(/add column if not exists/);
  });
});
