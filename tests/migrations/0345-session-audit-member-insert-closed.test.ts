import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0345 (Untangle M1-04) source contract. The behaviour is proved against a database in tests/db/session-audit-member-insert-closed-0345.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0345")}`, "utf8");
const down = () => readFileSync(`supabase/rollbacks/${fileForVersion("0345").replace(/\.sql$/, ".down.sql")}`, "utf8");
const code = (t: string) => t.replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();

const policy = (t: string) => {
  const m = /create policy "session_audit_studio_member_insert"([\s\S]*?);/.exec(code(t));
  expect(m, "policy text").not.toBeNull();
  return norm(m![1]);
};

describe("0345 session_audit member INSERT closed (source)", () => {
  it("exists exactly once and is the current repo maximum", () => {
    expect(countVersion("0345")).toBe(1);
    expect(isRepoMax("0345")).toBe(true);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code(sql());
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });

  it("drops the member INSERT policy by name and creates no policy", () => {
    const c = code(sql());
    expect(c).toMatch(/drop policy if exists "session_audit_studio_member_insert" on public\.session_audit;/);
    expect(c).not.toMatch(/create policy|alter policy/i);
  });

  it("revokes INSERT by name from public, anon and authenticated, at table AND column level", () => {
    const c = norm(code(sql()));
    expect(c).toContain("revoke insert on table public.session_audit from public, anon, authenticated;");
    expect(c).toContain("revoke insert (%I) on table public.session_audit from public, anon, authenticated");
    // The column loop covers every live column of the table, not a fixed list.
    expect(c).toMatch(/from pg_catalog\.pg_attribute a where a\.attrelid = 'public\.session_audit'::regclass and a\.attnum > 0 and not a\.attisdropped/);
  });

  it("carries a guard that fails the migration on any remaining INSERT path or INSERT policy, and on a missing SELECT policy", () => {
    const c = norm(code(sql()));
    for (const role of ["anon", "authenticated"]) {
      expect(c).toContain(`has_table_privilege('${role}', 'public.session_audit', 'INSERT')`);
      expect(c).toContain(`has_any_column_privilege('${role}', 'public.session_audit', 'INSERT')`);
    }
    expect(c).toMatch(/a\.grantee = 0 and a\.privilege_type = 'INSERT'/); // PUBLIC, table-level and column-level
    expect(c).toMatch(/p\.polcmd in \('a', '\*'\)/);
    expect(c).toMatch(/p\.polcmd = 'r'/);
    expect((c.match(/raise exception/g) ?? []).length).toBe(4);
  });

  it("is privilege-only: no grant, no function, no trigger, no table or column change, no data statement, and nothing about service_role", () => {
    const c = code(sql());
    // A GRANT statement (at a statement start, or built by format()), not the word inside a guard's error message.
    expect(c).not.toMatch(/(^|;)\s*grant\s/im);
    expect(c).not.toMatch(/format\(\s*'\s*grant\b/i);
    expect(c).not.toMatch(/create (or replace )?function|create trigger|create table|alter table|drop table|add column|drop column|create index/i);
    expect(c).not.toMatch(/^\s*(update|delete\s+from|insert\s+into|truncate)\s/im);
    expect(c).not.toMatch(/service_role/);
    expect(c).not.toMatch(/\bsecurity definer\b/i);
  });

  it("states the rule, and the unchanged parts, in its header", () => {
    expect(sql()).toMatch(/THE RULE\./);
    expect(sql()).toMatch(/UNCHANGED ON PURPOSE/);
    expect(sql()).toMatch(/NOT APPLIED/);
  });

  it("has a rollback that restores the EXACT 0117 policy and the authenticated table grant, and nothing else", () => {
    const d = code(down());
    const original = readFileSync(`supabase/migrations/${fileForVersion("0117")}`, "utf8");
    expect(policy(down())).toBe(policy(original));
    expect(norm(d)).toContain("grant insert on table public.session_audit to authenticated;");
    // Only authenticated is re-granted; anon/public stay denied (0336) and the policy can never pass for them.
    expect(d).not.toMatch(/grant[^;]*\bto\b[^;]*\b(anon|public|service_role)\b/i);
    expect(d).not.toMatch(/\brevoke\b/i);
    expect(d.trim().endsWith("commit;")).toBe(true);
    expect(d).toMatch(/set local lock_timeout/);
  });

  it("0117 stays frozen history and 0242's pattern is the one mirrored (same column-level loop and role list)", () => {
    const p = readFileSync(`supabase/migrations/${fileForVersion("0242")}`, "utf8");
    expect(norm(code(p))).toContain("revoke insert on table public.audit_logs from public, anon, authenticated;");
    expect(norm(code(p))).toContain("revoke insert (%I) on table public.audit_logs from public, anon, authenticated");
  });
});
