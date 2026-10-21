import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0241_session_appointment_coalesce_identity.sql", "utf8");
const previous = readFileSync("supabase/migrations/0181_multi_studio_command_authority.sql", "utf8");
const body = (source: string) => source.slice(source.indexOf("create or replace function public.start_session("), source.indexOf("$$;", source.indexOf("create or replace function public.start_session(")) + 3);
const executable = (source: string) => source.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
function assertIdentityContract(source: string) {
  const patched = body(source)
    .replace(/\s+-- A requested appointment[\s\S]*?or s\.appointment_id is null\)/, "")
    .replace(/\s+-- Prefer an exact appointment[\s\S]*?s\.started_at desc/, "\n   order by s.started_at desc");
  expect(executable(patched)).toBe(executable(body(previous)));
  expect(source).toContain("and (p_appointment_id is null\n          or s.appointment_id = p_appointment_id\n          or s.appointment_id is null)");
  expect(source).toMatch(/order by case when p_appointment_id is not null\s+and s.appointment_id = p_appointment_id then 0 else 1 end,\s+s.started_at desc/);
}

describe("0241 appointment coalesce identity (source only; DB proof separate)", () => {
  it("owns one allocated file and an atomic bounded transaction", () => {
    expect(countVersion("0241")).toBe(1);
    expect(fileForVersion("0241")).toBe("0241_session_appointment_coalesce_identity.sql");
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';/);
    expect(sql.trim()).toMatch(/commit;$/);
  });
  it("changes only eligibility/order in the effective 0181 body", () => {
    assertIdentityContract(sql);
  });
  // Source-detector controls, NOT SQL execution or a concurrency result.
  it.each([
    ["no-appointment lookup silently narrowed", "and (p_appointment_id is null", "and (p_appointment_id is not null"],
    ["exact-B preference lost to newer NULL", "then 0 else 1 end", "then 1 else 0 end"],
    ["window widened into global appointment idempotency", "coalesce(p_coalesce_minutes, 90)", "coalesce(p_coalesce_minutes, 90000)"],
    ["appointment made part of coarse lock", "v_practitioner::text || ':' || p_modality,", "v_practitioner::text || ':' || p_modality || ':' || coalesce(p_appointment_id::text, ''),"],
  ])("rejects a concrete source mutant: %s", (_name, before, after) => {
    expect(sql.split(before)).toHaveLength(2);
    const mutant = sql.replace(before, after);
    expect(mutant).not.toBe(sql);
    expect(() => assertIdentityContract(mutant)).toThrow();
  });
  it("retains lock-before-lookup, NULL-only promotion, and wrapper/signature authority", () => {
    expect(sql.indexOf("pg_advisory_xact_lock")).toBeLessThan(sql.indexOf("select s.id, s.appointment_id"));
    expect(sql).toContain("if p_appointment_id is not null and v_existing_appt is null then");
    expect(sql).toContain("and s.appointment_id is null;");
    expect(sql.match(/create or replace function/g)).toHaveLength(1);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql).toContain(`revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from ${role};`);
    }
    expect(sql.match(/grant execute[^;]+;/g)).toEqual(["grant execute on function public.start_session(uuid, text, uuid, integer, uuid) to authenticated;"]);
    expect(sql).not.toMatch(/alter table|create table|drop function|disable trigger|update public\.appointments/i);
  });
});
