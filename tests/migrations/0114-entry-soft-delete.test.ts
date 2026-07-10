import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0114: audited soft-delete for treatment passes
// (electrolysis_entries / laser_entries). Carries the repo-max tripwire (moved
// here from the 0113 test) plus the migration's structural guarantees.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0114_entry_soft_delete.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0114 — number", () => {
  it("0114 exists; the repo-max tripwire now lives in the 0115 test", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    // 0114 is no longer newest (0115 added the entry hard-delete hardening).
    expect(maxNum).toBeGreaterThanOrEqual(114);
    expect(FILE).toMatch(/^0114_/);
  });
});

describe("0114 — entry soft-delete columns", () => {
  it("adds deleted_at/deleted_by/delete_reason to BOTH pass tables", () => {
    for (const tbl of ["electrolysis_entries", "laser_entries"]) {
      const chunk = SQL.slice(SQL.indexOf(`alter table public.${tbl}`));
      expect(chunk, tbl).toMatch(
        /add column if not exists deleted_at\s+timestamptz/,
      );
      expect(chunk, tbl).toMatch(
        /add column if not exists deleted_by\s+uuid references public\.practitioners\(id\) on delete set null/,
      );
      expect(chunk, tbl).toMatch(/add column if not exists delete_reason text/);
    }
  });

  it("adds active partial indexes", () => {
    expect(SQL).toMatch(
      /electrolysis_entries_active_idx[\s\S]*?where deleted_at is null/,
    );
    expect(SQL).toMatch(
      /laser_entries_active_idx[\s\S]*?where deleted_at is null/,
    );
  });

  it("is additive: no backfill, no RLS/policy change, no destructive statements", () => {
    expect(SQL).not.toMatch(/^\s*update\s/im);
    expect(SQL).not.toMatch(/^\s*delete\s+from/im);
    expect(SQL).not.toMatch(/drop\s+(table|column|policy|constraint)/i);
    expect(SQL).not.toMatch(/create\s+policy/i);
    expect(SQL).not.toMatch(/enable row level security/i);
  });

  it("is idempotent (if not exists everywhere)", () => {
    // Every add-column + create-index guarded.
    const adds = SQL.match(/add column/gi) ?? [];
    const guardedAdds = SQL.match(/add column if not exists/gi) ?? [];
    expect(guardedAdds.length).toBe(adds.length);
    const idx = SQL.match(/create index/gi) ?? [];
    const guardedIdx = SQL.match(/create index if not exists/gi) ?? [];
    expect(guardedIdx.length).toBe(idx.length);
  });
});
