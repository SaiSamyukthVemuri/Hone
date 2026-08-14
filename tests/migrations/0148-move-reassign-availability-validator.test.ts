import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0148_move_reassign_availability_validator.sql"),
  "utf8",
);

describe("0148: move/reassign wires the shared availability validator", () => {
  it("drops the 7-arg signature and recreates an 8-arg one with a defaulted outside flag", () => {
    expect(SQL).toMatch(/drop function if exists public\.move_or_reassign_appointment\(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz\)/);
    expect(SQL).toMatch(/p_allow_outside_availability boolean default false/);
  });
  it("calls the validator on the FINAL target + resulting interval and returns its code", () => {
    expect(SQL).toMatch(/v_avail := public\.validate_appointment_availability\(\s*\n\s*p_studio_id, v_target,/);
    expect(SQL).toMatch(/if v_avail <> 'ok' then/);
  });
  it("re-authorizes the outside bypass to owners server-side (member cannot forge)", () => {
    expect(SQL).toMatch(/if p_allow_outside_availability and v_actor_role <> 'owner' then/);
  });
  it("keeps the GiST as the final authority (no 23P01 exception handler)", () => {
    expect(SQL).not.toMatch(/exception\s+when/i);
  });
  it("is SECURITY DEFINER, pinned search_path, service_role-only", () => {
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
    expect(SQL).toMatch(/grant execute on function public\.move_or_reassign_appointment\([^)]*boolean\)[^;]*to service_role/);
  });
});
