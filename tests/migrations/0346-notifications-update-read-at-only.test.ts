import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0346 source contract. The behaviour is proved against a database in tests/db/notifications-update-read-at-only-0346.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0346")}`, "utf8");
const down = () => readFileSync(`supabase/rollbacks/${fileForVersion("0346").replace(/\.sql$/, ".down.sql")}`, "utf8");
const code = (t: string) => t.replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const T = "public.practitioner_notifications";

describe("0346 notifications: members may only mark read (source)", () => {
  it("exists exactly once and is the current repo maximum", () => {
    expect(countVersion("0346")).toBe(1);
    expect(isRepoMax("0346")).toBe(true);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code(sql());
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });

  it("revokes UPDATE by name from public, anon and authenticated, at table AND column level", () => {
    const c = norm(code(sql()));
    expect(c).toContain(`revoke update on table ${T} from public, anon, authenticated;`);
    expect(c).toContain(`revoke update (%I) on table ${T} from public, anon, authenticated`);
    // The column loop covers every live column of the table, not a fixed list.
    expect(c).toMatch(/from pg_catalog\.pg_attribute a where a\.attrelid = 'public\.practitioner_notifications'::regclass and a\.attnum > 0 and not a\.attisdropped/);
  });

  it("grants exactly one thing: UPDATE (read_at) to authenticated", () => {
    const c = code(sql());
    // Statement-start GRANTs only (the word also appears inside a guard's error message).
    expect((c.match(/(^|;)\s*grant\s/gim) ?? []).length).toBe(1);
    expect(norm(c)).toContain(`grant update (read_at) on table ${T} to authenticated;`);
    expect(c).not.toMatch(/format\(\s*'\s*grant\b/i);
  });

  it("carries a guard that fails the migration on any other updatable column, a missing read_at grant, or a PUBLIC grant", () => {
    const c = norm(code(sql()));
    expect(c).toContain(`has_table_privilege('anon', '${T}', 'UPDATE')`);
    expect(c).toContain(`has_table_privilege('authenticated', '${T}', 'UPDATE')`);
    expect(c).toContain(`has_column_privilege('anon', '${T}', v_column, 'UPDATE')`);
    expect(c).toMatch(/v_column <> 'read_at' and has_column_privilege\('authenticated'/);
    expect(c).toContain(`not has_column_privilege('authenticated', '${T}', 'read_at', 'UPDATE')`);
    expect(c).toMatch(/a\.grantee = 0 and a\.privilege_type = 'UPDATE'/); // PUBLIC, table-level and column-level
    expect((c.match(/raise exception/g) ?? []).length).toBe(5);
  });

  it("is privilege-only: no policy, function, trigger, table or column change, no data statement, and nothing about service_role", () => {
    const c = code(sql());
    expect(c).not.toMatch(/create (or replace )?function|create trigger|create table|alter table|drop table|add column|drop column|create index/i);
    expect(c).not.toMatch(/create policy|alter policy|drop policy/i);
    expect(c).not.toMatch(/^\s*(update|delete\s+from|insert\s+into|truncate)\s/im);
    expect(c).not.toMatch(/service_role|security definer/i);
  });

  it("states the rule, and the unchanged parts, in its header", () => {
    expect(sql()).toMatch(/THE RULE\./);
    expect(sql()).toMatch(/members may only mark notifications read/);
    expect(sql()).toMatch(/UNCHANGED ON PURPOSE/);
    expect(sql()).toMatch(/NOT APPLIED/);
  });

  it("has a rollback that restores only the table-level UPDATE grant to authenticated", () => {
    const d = code(down());
    expect(norm(d)).toContain(`grant update on table ${T} to authenticated;`);
    expect((d.match(/\bgrant\b/gi) ?? []).length).toBe(1);
    expect(d).not.toMatch(/\brevoke\b|policy|service_role/i);
    expect(d.trim().endsWith("commit;")).toBe(true);
    expect(d).toMatch(/set local lock_timeout/);
  });

  it("targets the table 0070 created and leaves its two policies alone", () => {
    const o = readFileSync(`supabase/migrations/${fileForVersion("0070")}`, "utf8");
    expect(o).toMatch(/create table if not exists public\.practitioner_notifications/);
    expect(o).toMatch(/practitioner_notifications_member_update/);
    expect(code(sql())).not.toMatch(/practitioner_notifications_member/);
  });
});
