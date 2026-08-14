import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B 3E: migration 0139 (scoped conflict lookup + recurring-rule guard).
// Structural proof that the migration is ATOMIC and locks each SECURITY DEFINER
// reader down IMMEDIATELY (in the same transaction), so there is never a
// committed window where a reader exists but is still world-executable. The
// behavioural proof (anon/authenticated denied, service_role allowed, atomic
// rollback leaves no partial state) is in tests/db/scoped-conflict-and-guard.db.test.ts.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0139_scoped_conflict_lookup_and_rule_guard.sql"),
  "utf8",
);
// Executable statements only (strip -- comment lines).
const CODE = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

const idx = (needle: string) => SQL.indexOf(needle);

describe("0139: explicit atomic transaction", () => {
  it("opens with begin; and closes with commit; (does not rely on CLI wrapping)", () => {
    const firstStmt = CODE.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    expect(firstStmt).toBe("begin;");
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
    expect((CODE.match(/^\s*begin;\s*$/gm) ?? []).length).toBe(1);
    expect((CODE.match(/^\s*commit;\s*$/gm) ?? []).length).toBe(1);
  });

  it("no longer defers lockdown to a trailing DO-block", () => {
    expect(CODE).not.toMatch(/do\s*\$\$[\s\S]*foreach/i);
  });
});

describe("0139: each reader is service_role-only, revoked IMMEDIATELY after its definition", () => {
  const readers = [
    "public.find_scoped_calendar_conflict(uuid, uuid, timestamptz, timestamptz, text, uuid)",
    "public.find_recurring_break_conflict(uuid, uuid, integer[], time, time, date, uuid)",
  ];

  it("revokes public/anon/authenticated and grants service_role for BOTH readers", () => {
    for (const fn of readers) {
      expect(SQL).toContain(`revoke execute on function ${fn} from public;`);
      expect(SQL).toContain(`revoke execute on function ${fn} from anon;`);
      expect(SQL).toContain(`revoke execute on function ${fn} from authenticated;`);
      expect(SQL).toContain(`grant execute on function ${fn} to service_role;`);
    }
  });

  it("the first reader's revoke precedes the second reader's definition (no cross-function window)", () => {
    const revoke1 = idx("revoke execute on function public.find_scoped_calendar_conflict");
    const def2 = idx("create or replace function public.find_recurring_break_conflict");
    expect(revoke1).toBeGreaterThan(0);
    expect(def2).toBeGreaterThan(0);
    expect(revoke1).toBeLessThan(def2); // scoped reader locked down before the next is defined
  });

  it("every revoke/grant sits inside the begin/commit block", () => {
    const begin = idx("\nbegin;");
    const commit = SQL.lastIndexOf("commit;");
    for (const kw of ["revoke execute on function public.find_", "grant execute on function public.find_"]) {
      let from = SQL.indexOf(kw);
      expect(from).toBeGreaterThan(begin);
      while (from !== -1) {
        expect(from).toBeGreaterThan(begin);
        expect(from).toBeLessThan(commit);
        from = SQL.indexOf(kw, from + 1);
      }
    }
  });
});

describe("0139: hardening invariants", () => {
  it("both readers are SECURITY DEFINER with a pinned search_path", () => {
    expect((SQL.match(/security definer/g) ?? []).length).toBeGreaterThanOrEqual(3); // guard + 2 readers
    expect((SQL.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the recurring-rule guard trigger is re-pointed at the rule-specific function", () => {
    expect(SQL).toMatch(/drop trigger if exists studio_recurring_break_rules_scope_guard_trg/);
    expect(SQL).toMatch(/execute function public\.guard_scoped_recurring_rule_capacity\(\)/);
  });
});
