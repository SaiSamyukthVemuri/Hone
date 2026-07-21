import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 (migration 0146) — Item 2 authoritative duration + Item 3 the shared
// availability validator. Structure invariants the db lane is slow to catch.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0146_authoritative_duration_and_availability_validator.sql"),
  "utf8",
);

describe("0146 — availability validator", () => {
  it("is SECURITY DEFINER with a pinned search_path and service_role-only grants", () => {
    expect(SQL).toMatch(/create or replace function public\.validate_appointment_availability/);
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
    expect(SQL).toMatch(/grant execute on function public\.validate_appointment_availability[^;]*to service_role/);
    for (const role of ["public", "anon", "authenticated"]) {
      expect(SQL).toMatch(new RegExp(`revoke execute on function public\\.validate_appointment_availability[^;]*from ${role}`));
    }
  });
  it("Legacy (capacity OFF) short-circuits to ok; the owner bypass only skips working hours", () => {
    expect(SQL).toMatch(/if not v_cap then\s*\n\s*return 'ok';/);
    // Blockout check is OUTSIDE the `if not p_allow_outside_availability` guard.
    const blockoutIdx = SQL.indexOf("studio_blockouts");
    const bypassIdx = SQL.indexOf("if not p_allow_outside_availability");
    expect(blockoutIdx).toBeGreaterThan(0);
    expect(bypassIdx).toBeGreaterThan(blockoutIdx); // blockout enforced before (outside) the bypass guard
  });
  it("resolves practitioner-specific windows over studio-wide (order by practitioner_id not null desc)", () => {
    expect(SQL).toMatch(/order by \(o\.practitioner_id is not null\) desc/);
    expect(SQL).toMatch(/order by \(d\.practitioner_id is not null\) desc/);
  });
});

describe("0146 — v2 booking command", () => {
  it("derives duration from the LOCKED service row, never a caller length", () => {
    expect(SQL).toMatch(/create or replace function public\.create_internal_appointment_v2/);
    // The v2 signature has no p_duration_minutes parameter (only the owner-only
    // p_duration_override_minutes). Any p_duration_minutes text is header prose.
    expect(SQL).not.toMatch(/p_duration_minutes +integer/);
    expect(SQL).toMatch(/select sv\.default_duration_minutes into v_service_dur[\s\S]*?for update/);
  });
  it("gates the custom-duration override AND the availability bypass to owners, server-side", () => {
    expect(SQL).toMatch(/v_actor_role <> 'owner'\s*\n\s*and \(p_duration_override_minutes is not null or p_allow_outside_availability\)/);
    expect(SQL).toMatch(/p_duration_override_minutes < 15 or p_duration_override_minutes > 360/);
    expect(SQL).toMatch(/\(p_duration_override_minutes % 15\) <> 0/);
  });
  it("routes every booking through the shared validator and does NOT catch the GiST 23P01", () => {
    expect(SQL).toMatch(/v_avail := public\.validate_appointment_availability\(/);
    // No EXCEPTION handler — an interval collision (23P01) must roll the whole
    // transaction back and reach the adapter, not be swallowed here.
    expect(SQL).not.toMatch(/exception\s+when/i);
  });
});
