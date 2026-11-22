import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isRepoMax } from "./helpers/migration-state";

// Source contract for the access-event record (restore audit): the up file, the down file, and the single droppable block that records removals.

const UP = readFileSync("supabase/migrations/0370_practitioner_access_events.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0370_practitioner_access_events.down.sql", "utf8");
const OLD = readFileSync("supabase/migrations/0150_single_row_schedule_writers_locked.sql", "utf8");

const FN = "create or replace function public.set_practitioner_active_locked(";
const bodyOf = (sql: string) => {
  const from = sql.indexOf(FN);
  expect(from).toBeGreaterThan(-1);
  const open = sql.indexOf("as $$", from) + "as $$".length;
  return sql.slice(open, sql.indexOf("$$;", open));
};
const headOf = (sql: string) => sql.slice(sql.indexOf(FN), sql.indexOf("as $$", sql.indexOf(FN)));
const BEGIN = "-- REMOVAL-RECORD BEGIN";
const END = "-- REMOVAL-RECORD END";

describe("0370 source contract", () => {
  it("is the current maximum migration (only the max may assert this)", () => {
    expect(isRepoMax("0370")).toBe(true);
  });

  it("opens its own transaction with a lock timeout inside it, and ends with commit", () => {
    expect(UP).toMatch(/^begin;\s*\nset local lock_timeout = '5s';/m);
    expect(UP.trimEnd().endsWith("commit;")).toBe(true);
    expect(DOWN).toMatch(/^begin;\s*\nset local lock_timeout = '5s';/m);
    expect(DOWN.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("names no migration number in its comments", () => {
    expect(UP).not.toMatch(/\b0[0-9]{3}\b/);
    expect(DOWN).not.toMatch(/\b0[0-9]{3}\b/);
  });

  it("keeps the signature, language, security setting and search_path of the function it replaces", () => {
    expect(headOf(UP)).toBe(headOf(OLD));
  });

  it("the new table has no client data column, RLS enabled and forced, no policy, and every grant stripped by name", () => {
    const table = UP.slice(UP.indexOf("create table public.practitioner_access_events"), UP.indexOf(");", UP.indexOf("create table public.practitioner_access_events")));
    const cols = table.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    expect(cols).toEqual(["id", "studio_id", "actor_practitioner_id", "target_practitioner_id", "action", "created_at"]);
    expect(UP).toContain("alter table public.practitioner_access_events enable row level security;");
    expect(UP).toContain("alter table public.practitioner_access_events force row level security;");
    expect(UP).not.toMatch(/create policy/i);
    expect(UP).toContain("revoke all on table public.practitioner_access_events from public, anon, authenticated, service_role;");
    expect(UP).toContain("grant select on table public.practitioner_access_events to service_role;");
    expect(UP).toContain("check (action in ('removed', 'restored'))");
  });

  it("restates the function's revoke by name for all four roles and grants service_role only", () => {
    expect(UP).toContain("revoke execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;");
    expect(UP).toContain("grant execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) to service_role;");
    const code = UP.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bgrant\b[^;]*\bto (anon|authenticated|public)\b/i);
  });

  it("reads the stored value under the same row lock that guards the write, and records only when it differs", () => {
    const body = bodyOf(UP);
    const lock = body.indexOf("for update;");
    const update = body.indexOf("update public.practitioners");
    const firstInsert = body.indexOf("insert into public.practitioner_access_events");
    expect(body).toMatch(/select pr\.role, pr\.active into v_target_role, v_old_active/);
    expect(lock).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(lock);
    expect(firstInsert).toBeGreaterThan(update);
    expect(body).toContain("if v_old_active is distinct from v_new_active then");
    expect((body.match(/insert into public\.practitioner_access_events/g) ?? []).length).toBe(2);
    expect(body).not.toMatch(/\bnow\(\)|clock_timestamp|random\(/); // the time comes from the column default, nothing else is invented
  });

  it("the only table written besides the audit table is practitioners.active, with the same lock call and the same refusal codes as before", () => {
    const body = bodyOf(UP);
    const old = bodyOf(OLD);
    for (const must of ["public.lock_studio_and_assert_owner(p_studio_id, p_actor_practitioner_id)", "return 'invalid_practitioner';", "return 'cannot_modify_owner';"]) {
      expect(old).toContain(must);
      expect(body).toContain(must);
    }
    expect((body.match(/\bupdate\s+public\.(\w+)/g) ?? [])).toEqual(["update public.practitioners"]);
    expect(body).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("removals are recorded in exactly one marked block, and dropping that block leaves a valid, restores-only migration", () => {
    const body = bodyOf(UP);
    const a = body.indexOf(BEGIN);
    const b = body.indexOf(END);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const block = body.slice(a, b + END.length);
    expect((block.match(/'removed'/g) ?? []).length).toBe(1);
    expect((body.match(/'removed'/g) ?? []).length).toBe(1); // nowhere else in the body
    const dropped = UP.slice(0, UP.indexOf(BEGIN)) + UP.slice(UP.indexOf(END) + END.length);
    const dbody = bodyOf(dropped);
    expect(dbody).not.toContain("'removed'");
    expect(dbody).toContain("'restored'");
    expect((dbody.match(/insert into public\.practitioner_access_events/g) ?? []).length).toBe(1);
    expect(dropped).toContain("check (action in ('removed', 'restored'))"); // the table still allows both, so the choice can be reversed later
  });

  it("the down file restores the previous body byte for byte and drops the table", () => {
    expect(bodyOf(DOWN)).toBe(bodyOf(OLD));
    expect(headOf(DOWN)).toBe(headOf(OLD));
    expect(DOWN).toContain("drop table public.practitioner_access_events;");
    expect(DOWN).toContain("revoke execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;");
    expect(DOWN).toContain("grant execute on function public.set_practitioner_active_locked(uuid, uuid, uuid, boolean) to service_role;");
  });
});
