import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";

// Migration 0116: the calendar-feed credential is HASH-ONLY at rest. Proven on
// the REAL migrated local DB: the raw practitioners.calendar_feed_token column
// is gone, the hash column + its partial unique index remain (so existing
// subscription URLs still resolve by hash), and there is no raw credential left
// for a same-studio peer to read.

afterAll(async () => {
  await closePool();
});

describe("0116: calendar-feed credential is hash-only at rest", () => {
  it("the raw calendar_feed_token column is dropped; the hash column remains", async () => {
    const res = await adminQuery(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'practitioners'
          and column_name in ('calendar_feed_token', 'calendar_feed_token_hash')`,
    );
    const cols = res.rows.map((r) => r.column_name);
    expect(cols).not.toContain("calendar_feed_token");
    expect(cols).toContain("calendar_feed_token_hash");
  });

  it("the hash partial unique index still exists (feed lookup by hash intact)", async () => {
    const res = await adminQuery(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'practitioners'
          and indexname = 'practitioners_calendar_feed_token_hash_uniq'`,
    );
    expect(res.rowCount).toBe(1);
  });

  it("the raw-token unique index is gone with the column", async () => {
    const res = await adminQuery(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'practitioners'
          and indexname = 'practitioners_calendar_feed_token_uniq'`,
    );
    expect(res.rowCount).toBe(0);
  });
});
