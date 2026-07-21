import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 — migration 0144 structural contract (Item 1 + Item 3). Behaviour
// is proven in tests/db/move-target-integrity.db.test.ts.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0144_move_target_integrity_and_legacy_wrapper.sql"),
  "utf8",
);
const CODE = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("0144 — final-target integrity on every move (Item 1)", () => {
  it("validates the target under `if v_cap then` (NOT gated on v_reassign) with the reassignment-required code", () => {
    expect(SQL).toMatch(/create or replace function public\.move_or_reassign_appointment\(/);
    // The final-target check is inside a capacity gate, not a reassign gate.
    expect(SQL).toMatch(/if v_cap then\s*\n\s*if p_target_practitioner_id is null/);
    expect(SQL).toMatch(/practitioner_reassignment_required/);
    // A time-only move (not v_reassign) maps an invalid target to reassignment-required.
    expect(SQL).toMatch(/case when v_reassign then 'invalid_practitioner' else 'practitioner_reassignment_required' end/);
    expect(SQL).toMatch(/case when v_reassign then 'not_eligible' else 'practitioner_reassignment_required' end/);
  });
  it("a null service_id is not eligibility-gated (documented policy)", () => {
    expect(SQL).toMatch(/v_appt\.service_id is not null and not exists/);
  });
});

describe("0144 — 0133 compatibility wrapper (Item 3)", () => {
  it("redefines practitioner_move_appointment as a delegate that keeps the old 6-column shape", () => {
    expect(SQL).toMatch(/create or replace function public\.practitioner_move_appointment\(/);
    // Old return shape (no practitioner columns).
    expect(SQL).toMatch(/returns table \(\s*result text,\s*appointment_id uuid,\s*previous_starts_at timestamptz/);
    // Resolves the CURRENT practitioner and delegates (target = current).
    expect(SQL).toMatch(/select a\.practitioner_id into v_current/);
    expect(SQL).toMatch(/public\.move_or_reassign_appointment\(\s*\n\s*p_appointment_id, p_studio_id, p_practitioner_id,\s*\n\s*coalesce\(v_current, p_practitioner_id\)/);
  });
  it("both functions are SECURITY DEFINER, pinned search_path, service_role only", () => {
    expect((SQL.match(/security definer/g) ?? []).length).toBe(2);
    expect((SQL.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(2);
    expect(SQL).toMatch(/grant execute on function public\.move_or_reassign_appointment\([^)]*\) to service_role;/);
    expect(SQL).toMatch(/grant execute on function public\.practitioner_move_appointment\([^)]*\) to service_role;/);
  });
  it("is one atomic begin;/commit;", () => {
    expect(CODE.split("\n").map((l) => l.trim()).find((l) => l.length > 0)).toBe("begin;");
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });
});
