import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0150_single_row_schedule_writers_locked.sql"),
  "utf8",
);

const COMMANDS = [
  "lock_studio_and_assert_owner",
  "validate_schedule_scope",
  "upsert_availability_day_locked",
  "delete_availability_day_locked",
  "upsert_availability_override_locked",
  "delete_availability_override_locked",
  "set_service_practitioner_eligibility_locked",
  "set_practitioner_active_locked",
];

describe("0150 — single-row schedule writers locked", () => {
  it("defines every command as SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of COMMANDS) {
      expect(SQL).toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
    expect((SQL.match(/security definer/g) ?? []).length).toBe(COMMANDS.length);
    expect((SQL.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(COMMANDS.length);
  });
  it("the shared preamble takes the lock order: studios row FOR UPDATE, then advisory", () => {
    const rowLock = SQL.indexOf("from public.studios s where s.id = p_studio_id for update");
    const advisory = SQL.indexOf("acquire_studio_capacity_lock");
    expect(rowLock).toBeGreaterThan(0);
    expect(advisory).toBeGreaterThan(rowLock);
    expect(SQL).toMatch(/v_role is distinct from 'owner'/); // active-owner assertion
  });
  it("scoped writes require capacity ON + an active same-studio target", () => {
    expect(SQL).toMatch(/studio_capacity_enabled\(p_studio_id\)/);
    expect(SQL).toMatch(/return 'capacity_disabled'/);
    expect(SQL).toMatch(/return 'invalid_practitioner'/);
  });
  it("the practitioner-active command cannot modify the owner and preserves appointments", () => {
    expect(SQL).toMatch(/return 'cannot_modify_owner'/);
    expect(SQL).toMatch(/set active = coalesce\(p_active, false\)/);
    // No appointment/reservation mutation in the deactivation path.
    expect(SQL).not.toMatch(/update public\.appointments/);
  });
  it("grants every command to service_role only (browser roles revoked)", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(SQL).toMatch(new RegExp(`revoke execute on function %s from ${role}`));
    }
    expect(SQL).toMatch(/grant execute on function %s to service_role/);
  });
});
