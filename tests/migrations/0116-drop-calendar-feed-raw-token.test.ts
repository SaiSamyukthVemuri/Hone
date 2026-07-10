import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0116: drop the raw practitioners.calendar_feed_token column so the
// calendar-feed credential is HASH-ONLY at rest. Carries the repo-max tripwire
// (moved here from the 0115 test) plus the migration's guarantees. The
// behavioral proof (column dropped, hash remains) lives in
// tests/db/calendar-feed-hash-only.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0116_drop_calendar_feed_raw_token.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const SQL_CODE = SQL.replace(/--.*$/gm, "");

describe("0116 — number (repo-max tripwire)", () => {
  it("is the repo migration max", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    expect(maxNum).toBe(116);
    expect(FILE).toMatch(/^0116_/);
  });
});

describe("0116 — drop raw calendar-feed token", () => {
  it("drops the raw calendar_feed_token column (idempotent)", () => {
    expect(SQL_CODE).toMatch(
      /alter table public\.practitioners\s+drop column if exists calendar_feed_token\b/,
    );
  });

  it("drops the raw-token partial unique index", () => {
    expect(SQL_CODE).toMatch(
      /drop index if exists public\.practitioners_calendar_feed_token_uniq/,
    );
  });

  it("does NOT drop or alter the hash column (feed keeps working by hash)", () => {
    expect(SQL_CODE).not.toMatch(/drop column if exists calendar_feed_token_hash/);
    expect(SQL_CODE).not.toMatch(/drop index[^;]*token_hash/);
  });

  it("makes NO other schema/data/RLS change (drop-only)", () => {
    expect(SQL_CODE).not.toMatch(/create policy|drop policy/i);
    expect(SQL_CODE).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(SQL_CODE).not.toMatch(/add column/i);
    expect(SQL_CODE).not.toMatch(/^\s*update\s/im);
    expect(SQL_CODE).not.toMatch(/^\s*delete\s+from/im);
    expect(SQL_CODE).not.toMatch(/^\s*insert\s+into/im);
    // Only the raw column + its index are dropped (two drops total).
    const drops = SQL_CODE.match(/drop (column|index)/gi) ?? [];
    expect(drops.length).toBe(2);
  });
});
