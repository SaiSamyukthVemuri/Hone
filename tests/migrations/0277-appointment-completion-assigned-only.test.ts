import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

const FILE = "0277_appointment_completion_assigned_only.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const chain0175 = readFileSync("supabase/migrations/0175_appointment_transition_integrity.sql", "utf8");

function fn(source: string, name: string): string {
  const i = source.indexOf(`create or replace function public.${name}(`);
  expect(i, name).toBeGreaterThan(-1);
  return source.slice(i, source.indexOf("\n$$;", i) + 4);
}
const norm = (t: string) => t.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").trim();

describe("0277 appointment completion, assigned-only: shape", () => {
  it("uses its reserved filename once, in one bounded transaction", () => {
    expect(countVersion("0277")).toBe(1);
    expect(fileForVersion("0277")).toBe(FILE);
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
    expect(isRepoMax("0277")).toBe(true);
  });

  it("the replaced command is 0175's text plus ONLY the role read and the assignment check", () => {
    const now = fn(code, "mark_appointment_complete");
    const added = [
      /v_role text;\s*v_assigned uuid;/,
      /select p\.role into v_role\s+from public\.practitioners p\s+where p\.id = p_practitioner_id and p\.studio_id = p_studio_id and p\.active = true;\s+if v_role is null then/,
      /, a\.practitioner_id into v_status, v_starts_at, v_assigned/,
      /if v_role is distinct from 'owner' and v_assigned is distinct from p_practitioner_id then\s*raise exception 'appointment is not assigned to this practitioner'\s*using errcode = '42501';\s*end if;/,
    ];
    for (const a of added) expect(now).toMatch(a);
    // the pieces 0175 had, unchanged
    const before = norm(fn(chain0175, "mark_appointment_complete"));
    for (const keep of [
      "if v_status <> 'confirmed' then",
      "if v_starts_at > now() then",
      "set status = 'completed', updated_at = now()",
      "'marked_complete'",
      "language plpgsql security definer set search_path = pg_catalog, pg_temp",
    ]) {
      expect(before).toContain(keep);
      expect(norm(now)).toContain(keep);
    }
  });

  it("revokes by name from public, anon, authenticated AND service_role, then grants back to service_role only", () => {
    for (const r of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(`revoke execute on function public.mark_appointment_complete(uuid, uuid, uuid) from ${r};`);
    }
    expect(code).toContain("grant execute on function public.mark_appointment_complete(uuid, uuid, uuid) to service_role;");
    expect(code).not.toMatch(/grant execute[^;]*to (anon|authenticated|public)/);
  });

  it("touches no payment object and drops nothing", () => {
    expect(code).not.toMatch(/settlement|payment_|manual_fee|client_pricing|price/i);
    expect(code).not.toMatch(/drop\s+(table|column|function)/i);
    expect(code).not.toMatch(/alter table/i);
  });
});
