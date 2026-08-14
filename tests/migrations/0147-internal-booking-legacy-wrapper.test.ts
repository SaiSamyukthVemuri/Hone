import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0147_internal_booking_legacy_wrapper.sql"),
  "utf8",
);

describe("0147: old create_internal_appointment is a safe wrapper around v2", () => {
  it("delegates to v2 and never bypasses hours (outside=false)", () => {
    expect(SQL).toMatch(/create or replace function public\.create_internal_appointment\(/);
    expect(SQL).toMatch(/public\.create_internal_appointment_v2\(/);
    expect(SQL).toMatch(/false\s*(--[^\n]*)?\s*-- p_allow_outside_availability|false\s+-- p_allow_outside_availability/);
  });
  it("classifies duration against the current default, never trusting a forged length", () => {
    expect(SQL).toMatch(/p_duration_minutes = v_default/);
    // default read → normal booking; any other value becomes the owner-only v2 override
    expect(SQL).toMatch(/v_override := p_duration_minutes/);
  });
  it("is SECURITY DEFINER, pinned search_path, service_role-only", () => {
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
    expect(SQL).toMatch(/grant execute on function public\.create_internal_appointment\([^)]*\)[^;]*to service_role/);
    for (const role of ["public", "anon", "authenticated"]) {
      expect(SQL).toMatch(new RegExp(`revoke execute on function public\\.create_internal_appointment\\([^)]*\\)[^;]*from ${role}`));
    }
  });
});
