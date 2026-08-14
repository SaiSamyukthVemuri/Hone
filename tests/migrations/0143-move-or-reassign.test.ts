import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4: migration 0143 (atomic move + reassignment). Structural contract;
// behaviour is proven in tests/db/move-reassign-appointment.db.test.ts.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0143_move_or_reassign_appointment.sql"),
  "utf8",
);
const CODE = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const idx = (n: string) => SQL.indexOf(n);
const SIG = "public.move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz)";

describe("0143: atomic + service_role-only", () => {
  it("wraps in one begin;/commit;", () => {
    expect(CODE.split("\n").map((l) => l.trim()).find((l) => l.length > 0)).toBe("begin;");
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });
  it("defines move_or_reassign_appointment, SECURITY DEFINER + pinned search_path, service_role only", () => {
    expect(SQL).toMatch(/create or replace function public\.move_or_reassign_appointment\(/);
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
    expect(SQL).toContain(`revoke execute on function ${SIG} from public;`);
    expect(SQL).toContain(`revoke execute on function ${SIG} from anon;`);
    expect(SQL).toContain(`revoke execute on function ${SIG} from authenticated;`);
    expect(SQL).toContain(`grant execute on function ${SIG} to service_role;`);
  });
});

describe("0143: the transaction contract", () => {
  it("locks the studios ROW before the advisory lock (0138 order), then locks the appointment", () => {
    const studioFor = idx("from public.studios s");
    const advisory = idx("acquire_studio_capacity_lock");
    const apptFor = idx("from public.appointments a");
    expect(studioFor).toBeGreaterThan(0);
    expect(studioFor).toBeLessThan(advisory);
    expect(advisory).toBeLessThan(apptFor);
    expect(SQL).toMatch(/for update/);
  });
  it("enforces member move-own-only + no-reassign, and owner-assigns-eligible", () => {
    expect(SQL).toMatch(/v_actor_role <> 'owner'/);
    expect(SQL).toMatch(/v_appt\.practitioner_id is distinct from p_actor_practitioner_id or v_reassign/);
    expect(SQL).toMatch(/not_authorized/);
    expect(SQL).toMatch(/service_practitioners/);
    expect(SQL).toMatch(/not_eligible/);
    expect(SQL).toMatch(/invalid_practitioner/);
  });
  it("rejects any paused move/reassign, preserves duration, and never RAISEs raw detail", () => {
    expect(SQL).toMatch(/if v_cap and not v_book then/);
    expect(SQL).toMatch(/booking_paused/);
    expect(SQL).toMatch(/make_interval\(mins => v_appt\.duration_minutes\)/); // duration preserved
    expect(SQL).not.toMatch(/raise exception/i);
  });
  it("optimistic concurrency on both endpoints (stale_appointment), no time from the caller for the end", () => {
    expect(SQL).toMatch(/v_appt\.starts_at is distinct from p_expected_starts_at/);
    expect(SQL).toMatch(/v_appt\.ends_at is distinct from p_expected_ends_at/);
    expect(SQL).toMatch(/stale_appointment/);
  });
});
