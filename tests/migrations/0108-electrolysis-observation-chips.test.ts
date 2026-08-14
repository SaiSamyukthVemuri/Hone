import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0108_electrolysis_observation_chips.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0108: number", () => {
  it("is migration 0108 (repo-max tripwire now lives in the newest migration test, 0109)", () => {
    expect(FILE).toMatch(/^0108_/);
  });
});

describe("0108: structured observation_chips column", () => {
  it("adds a jsonb column defaulting to an empty array (additive, legacy-safe)", () => {
    expect(SQL).toMatch(
      /add column if not exists observation_chips jsonb not null default '\[\]'::jsonb/,
    );
  });

  it("constrains the column to a JSON array", () => {
    expect(SQL).toMatch(/jsonb_typeof\(observation_chips\) = 'array'/);
    expect(SQL).toMatch(/electrolysis_entries_observation_chips_is_array/);
  });

  it("is additive only: does NOT drop/alter comments or touch RLS policies", () => {
    expect(SQL).not.toMatch(/drop column/i);
    expect(SQL).not.toMatch(/\bcomments\b\s*(text|drop|alter|=)/i);
    expect(SQL).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(SQL).not.toMatch(/update public\.electrolysis_entries set/i); // no backfill
  });

  it("documents no-backfill + preserved comments in the column comment", () => {
    expect(SQL).toMatch(/No backfill/i);
    expect(SQL).toMatch(/comment on column public\.electrolysis_entries\.observation_chips/);
  });
});
