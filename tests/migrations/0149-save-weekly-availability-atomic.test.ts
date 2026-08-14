import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0149_save_weekly_availability_atomic.sql"),
  "utf8",
);

describe("0149: atomic weekly availability save", () => {
  it("takes the lock order (studios row FOR UPDATE, then the advisory lock)", () => {
    const rowLock = SQL.indexOf("from public.studios s where s.id = p_studio_id for update");
    const advisory = SQL.indexOf("acquire_studio_capacity_lock");
    expect(rowLock).toBeGreaterThan(0);
    expect(advisory).toBeGreaterThan(rowLock); // advisory AFTER the row lock
  });
  it("writes all days in ONE loop/transaction (no per-day round trip) and validates the scope", () => {
    expect(SQL).toMatch(/for v_day in select jsonb_array_elements\(p_days\)/);
    expect(SQL).toMatch(/on conflict on constraint studio_availability_default_scope_key/);
    expect(SQL).toMatch(/p_scope_practitioner_id is not null and not exists/);
    expect(SQL).toMatch(/return 'invalid_practitioner'/);
  });
  it("is SECURITY DEFINER, pinned search_path, service_role-only", () => {
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
    expect(SQL).toMatch(/grant execute on function public\.save_weekly_availability\([^)]*\)[^;]*to service_role/);
    for (const role of ["public", "anon", "authenticated"]) {
      expect(SQL).toMatch(new RegExp(`revoke execute on function public\\.save_weekly_availability\\([^)]*\\)[^;]*from ${role}`));
    }
  });
});
