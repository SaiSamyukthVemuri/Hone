import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

const FILE = "0278_practitioner_own_working_hours.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const chain0150 = readFileSync("supabase/migrations/0150_single_row_schedule_writers_locked.sql", "utf8");
const chain0149 = readFileSync("supabase/migrations/0149_save_weekly_availability_atomic.sql", "utf8");

function fn(source: string, name: string): string {
  const i = source.indexOf(`create or replace function public.${name}(`);
  expect(i, name).toBeGreaterThan(-1);
  return source.slice(i, source.indexOf("\n$$;", i) + 4);
}
const norm = (t: string) => t.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").trim();

describe("0278 practitioner own working hours: shape", () => {
  it("uses its reserved filename once, in one bounded transaction", () => {
    expect(countVersion("0278")).toBe(1);
    expect(fileForVersion("0278")).toBe(FILE);
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
    expect(isRepoMax("0278")).toBe(true);
  });

  it("each replaced command is 0150's text with ONLY the gate call swapped", () => {
    for (const name of ["upsert_availability_day_locked", "delete_availability_day_locked", "upsert_availability_override_locked"]) {
      const was = norm(fn(chain0150, name)).replace(
        "public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id)",
        "public.authorize_schedule_writer(p_studio_id, p_actor_practitioner_id, p_scope_practitioner_id)",
      );
      expect(norm(fn(code, name)), name).toBe(was);
    }
  });

  it("delete-by-row-id resolves the row's own scope; a missing or studio-wide row is never a non-owner's", () => {
    const d = fn(code, "delete_availability_override_locked");
    expect(d).toMatch(/select o\.practitioner_id into v_row_scope/);
    expect(d).toMatch(/authorize_schedule_writer\(p_studio_id, p_actor_practitioner_id, v_row_scope\)/);
  });

  it("the gate: owner any scope; non-owner only a non-null scope equal to themselves; active members only", () => {
    const g = fn(code, "authorize_schedule_writer");
    expect(g).toMatch(/pr\.active = true/);
    expect(g).toMatch(/if v_role = 'owner' then\s*return 'ok';/);
    expect(g).toMatch(/p_scope_practitioner_id is not null and p_scope_practitioner_id = p_actor_practitioner_id/);
    expect(g.indexOf("for update")).toBeLessThan(g.indexOf("acquire_studio_capacity_lock"));
  });

  it("the new weekly save is 0149's loop behind the same gate; 0149's function is not redefined", () => {
    const w = fn(code, "save_weekly_availability_as");
    const loopOf = (t: string) => norm(t.slice(t.indexOf("for v_day in"), t.indexOf("end loop;") + 9));
    expect(loopOf(w)).toBe(loopOf(fn(chain0149, "save_weekly_availability")));
    expect(code).not.toMatch(/create or replace function public\.save_weekly_availability\(/);
    expect(code).not.toMatch(/create or replace function public\.lock_studio_and_assert_owner\(/);
  });

  it("revokes by name (public, anon, authenticated, service_role) then grants back to service_role, for all six", () => {
    for (const f of [
      "authorize_schedule_writer(uuid, uuid, uuid)",
      "upsert_availability_day_locked(uuid, uuid, uuid, integer, boolean, time, time)",
      "delete_availability_day_locked(uuid, uuid, uuid, integer)",
      "upsert_availability_override_locked(uuid, uuid, uuid, date, boolean, time, time, text)",
      "delete_availability_override_locked(uuid, uuid, uuid, uuid, date)",
      "save_weekly_availability_as(uuid, uuid, uuid, jsonb)",
    ]) expect(code).toContain(`'public.${f}'`);
    for (const r of ["public", "anon", "authenticated", "service_role"]) expect(code).toContain(`revoke execute on function %s from ${r}`);
    expect(code).toContain("grant execute on function %s to service_role");
    expect(code).not.toMatch(/grant execute[^;]*to (anon|authenticated|public)/);
  });

  it("touches no table, policy, trigger or column and drops nothing", () => {
    expect(code).not.toMatch(/alter table|create policy|drop policy|create trigger|drop trigger|add column|create table/i);
    expect(code).not.toMatch(/drop\s+(table|column|function)/i);
  });
});
