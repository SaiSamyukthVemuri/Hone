import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// 0397 (HON-126): SOURCE contract for the migration and its down file. Behaviour is the authority and is proved on a real database by
// tests/db/ops-alerts-operator-only-0397.db.test.ts; this file pins what a database run cannot see in a diff.

const UP = readFileSync("supabase/migrations/0397_ops_alerts_operator_only.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0397_ops_alerts_operator_only.down.sql", "utf8");
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const U = code(UP);
const D = code(DOWN);

describe("0397 is shaped like a sealed migration", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    for (const f of [UP, DOWN]) {
      expect(f).toMatch(/^begin;$/m);
      expect(f).toMatch(/^commit;$/m);
      expect(f.indexOf("begin;")).toBeLessThan(f.indexOf("set local lock_timeout = '5s'"));
    }
  });
  // The current maximum's own test may pin this; it is the one place, and it moves on with the next migration (CLAUDE.md section 2).
  it("is the repository maximum while nothing sits above it", () => {
    expect(isRepoMax("0397")).toBe(true);
  });
});

describe("0397 up", () => {
  it("guards first: RLS on and exactly the 0067 policy, before anything changes", () => {
    expect(U.indexOf("refuses to run")).toBeGreaterThan(-1);
    expect(U.indexOf("refuses to run")).toBeLessThan(U.indexOf("drop policy"));
    expect(U).toContain("((studio_id IS NOT NULL) AND is_studio_member(studio_id))");
  });
  it("drops only the member-read policy and revokes ALL from public, anon and authenticated by name, never service_role", () => {
    expect(U).toMatch(/drop policy ops_alerts_member_read on public\.ops_alerts;/);
    for (const r of ["public", "anon", "authenticated"]) expect(U).toMatch(new RegExp(`revoke all on table public\\.ops_alerts from ${r};`));
    expect(U).not.toMatch(/revoke[^;]*service_role/);
    expect(U).not.toMatch(/grant /);
    expect(U).not.toMatch(/disable row level security/i);
  });
  it("cannot commit a half state: after-checks on policies, RLS, anon/authenticated table and column privileges, and service_role", () => {
    const after = U.slice(U.indexOf("$after$"));
    for (const needle of ["still has a policy", "row-level security is not on", "still holds %", "column-level", "service_role lost"]) expect(after).toContain(needle);
    for (const v of ["'select'", "'insert'", "'update'", "'delete'", "'truncate'", "'references'", "'trigger'", "'maintain'"]) expect(after).toContain(v);
  });
  it("touches no function: the four definer functions are not redefined", () => {
    expect(U).not.toMatch(/create (or replace )?function/i);
    expect(U).not.toMatch(/alter function/i);
  });
});

describe("0397 down (emergency only)", () => {
  it("warns that it re-opens member read of historic money and ids, and says emergency", () => {
    expect(DOWN.slice(0, 900)).toMatch(/EMERGENCY ONLY/);
    expect(DOWN.slice(0, 900)).toMatch(/RE-OPENS member read/);
    expect(DOWN.slice(0, 900)).toMatch(/money, client ids/);
  });
  it("restores the exact 0067 policy and the captured grants, behind guards and with an after-check", () => {
    expect(D).toMatch(/create policy "ops_alerts_member_read"\s+on public\.ops_alerts\s+for select\s+using \(\s+studio_id is not null\s+and public\.is_studio_member\(studio_id\)\s+\);/);
    expect(D).toMatch(/grant all on table public\.ops_alerts to anon;/);
    expect(D).toMatch(/grant all on table public\.ops_alerts to authenticated;/);
    expect(D.indexOf("refuses to run")).toBeLessThan(D.indexOf("grant all"));
    expect(D).toContain("refuses to commit");
    expect(DOWN).toContain("anon=arwdDxtm/postgres");
  });
});
