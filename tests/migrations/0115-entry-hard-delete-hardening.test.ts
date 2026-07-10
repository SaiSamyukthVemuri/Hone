import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0115: remove authenticated hard-delete authority on treatment
// passes (electrolysis_entries / laser_entries) so removals go only through the
// audited soft-delete UPDATE path (0114 / PR #391). Carries the repo-max
// tripwire (moved here from the 0114 test) plus the migration's guarantees.
// The behavioral proof (member DELETE blocked, soft-delete UPDATE still works,
// cross-studio still blocked) lives in tests/db/clinical-delete-posture.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0115_entry_hard_delete_hardening.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
// Comment-stripped view for "must NOT contain X" / count guards, so the
// migration's own explanatory prose (which names grant/service_role/drop policy)
// never trips a negative assertion. Presence checks use the raw SQL.
const SQL_CODE = SQL.replace(/--.*$/gm, "");

describe("0115 — number", () => {
  it("0115 exists; the repo-max tripwire now lives in the 0116 test", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    // 0115 is no longer newest (0116 dropped the raw calendar-feed token).
    expect(maxNum).toBeGreaterThanOrEqual(115);
    expect(FILE).toMatch(/^0115_/);
  });
});

describe("0115 — entry hard-delete hardening", () => {
  it("drops the authenticated DELETE policy on BOTH pass tables", () => {
    expect(SQL).toMatch(
      /drop policy if exists "electrolysis_entries: members delete" on public\.electrolysis_entries;/,
    );
    expect(SQL).toMatch(
      /drop policy if exists "laser_entries: members delete" on public\.laser_entries;/,
    );
  });

  it("revokes DELETE + TRUNCATE from anon and authenticated on BOTH tables", () => {
    expect(SQL).toMatch(
      /revoke truncate, delete on public\.electrolysis_entries from anon, authenticated;/,
    );
    expect(SQL).toMatch(
      /revoke truncate, delete on public\.laser_entries from anon, authenticated;/,
    );
  });

  it("does NOT touch service_role (maintenance path preserved)", () => {
    // service_role bypasses RLS and keeps its grant; it must not be a revoke target.
    expect(SQL_CODE).not.toMatch(/service_role/i);
  });

  it("makes NO other RLS/schema/data change (hardening only, not weakening)", () => {
    // No new/replaced policies, no grants, no select/insert/update policy churn.
    expect(SQL_CODE).not.toMatch(/create policy/i);
    expect(SQL_CODE).not.toMatch(/\bgrant\b/i);
    expect(SQL_CODE).not.toMatch(/for (select|insert|update)/i);
    // No schema or data mutation.
    expect(SQL_CODE).not.toMatch(/alter table/i);
    expect(SQL_CODE).not.toMatch(/add column|drop column/i);
    expect(SQL_CODE).not.toMatch(/^\s*update\s/im);
    expect(SQL_CODE).not.toMatch(/^\s*delete\s+from/im);
    expect(SQL_CODE).not.toMatch(/^\s*insert\s+into/im);
  });

  it("is idempotent (drop-if-exists; revoke is inherently idempotent)", () => {
    const drops = SQL_CODE.match(/drop policy/gi) ?? [];
    const guarded = SQL_CODE.match(/drop policy if exists/gi) ?? [];
    expect(guarded.length).toBe(drops.length);
    expect(drops.length).toBe(2);
  });
});
