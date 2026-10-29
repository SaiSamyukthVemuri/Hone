import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";
import { grantedRoles, normalizeSql } from "./helpers/grant-posture";

// 0269 / HON-59. Source contract; the behaviour is proved on a real database in
// tests/db/appointment-participants.db.test.ts.
const sql = readFileSync("supabase/migrations/0269_appointment_participants.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const prev = readFileSync("supabase/migrations/0241_session_appointment_coalesce_identity.sql", "utf8").replace(/^\s*--.*$/gm, "");

const startFn = (s: string) =>
  s.slice(s.indexOf("create or replace function public.start_session("), s.indexOf("comment on function public.start_session"));

describe("0269 appointment participants", () => {
  it("is one allocated transaction", () => {
    expect(countVersion("0269")).toBe(1);
    expect(fileForVersion("0269")).toBe("0269_appointment_participants.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s'");
    expect(code.trim()).toMatch(/commit;$/);
  });

  it("the table is same-studio by composite keys, one row per practitioner per visit, and carries no money", () => {
    expect(code).toContain("references public.appointments (id, studio_id)");
    expect(code).toContain("references public.practitioners (id, studio_id)");
    expect(code).toContain("unique (appointment_id, practitioner_id)");
    const table = code.slice(code.indexOf("create table public.appointment_participants"), code.indexOf("create index"));
    expect(table).not.toMatch(/bill|unit|charge|price|amount|cents|minutes|duration/i);
  });

  it("no runtime role can write the table; members can read it", () => {
    expect(code).toContain("alter table public.appointment_participants enable row level security");
    for (const r of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(`revoke all on public.appointment_participants from ${r};`);
    }
    expect(code).toMatch(/grant select on public\.appointment_participants to authenticated;/);
    expect(code).not.toMatch(/grant\s+(insert|update|delete|all)[^;]*appointment_participants/i);
    expect(code).toContain("for select to authenticated");
  });

  it("the command is authenticated-only and has exactly one owner predicate", () => {
    expect(grantedRoles(code, "add_appointment_participant", "uuid, uuid, uuid")).toEqual(["authenticated"]);
    expect([...code.matchAll(/is_studio_owner\(/g)]).toHaveLength(1);
    expect(code).toContain("security definer");
    expect(code).toContain("set search_path = ''");
  });

  it("start_session is the 0241 body with ONLY the participant condition added", () => {
    const widened = normalizeSql(startFn(code));
    const old = normalizeSql(startFn(prev));
    const cond = normalizeSql(`and not exists (
         select 1 from public.appointment_participants ap
          where ap.appointment_id = p_appointment_id
            and ap.studio_id = v_studio_id
            and ap.practitioner_id = v_practitioner
       )`);
    expect(widened).toContain(cond);
    expect(widened.replace(cond, "")).toBe(old);
  });

  it("start_session keeps authenticated-only execution", () => {
    expect(grantedRoles(code, "start_session", "uuid, text, uuid, integer, uuid")).toEqual(["authenticated"]);
  });
});
