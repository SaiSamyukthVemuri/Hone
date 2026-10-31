import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// SOURCE CONTRACT, NOT DB PROOF. The behaviour is proved by
// tests/db/machine-range-confirmation.db.test.ts in the CI DB lane.
const sql = readFileSync(
  "supabase/migrations/0267_range_confirmation_recorded_with_capture.sql",
  "utf8",
);
const executable = sql.replace(/--[^\n]*/g, "");

describe("0267 range confirmation source contract", () => {
  it("owns its reserved file, atomic and additive", () => {
    expect(countVersion("0267")).toBe(1);
    expect(fileForVersion("0267")).toBe(
      "0267_range_confirmation_recorded_with_capture.sql",
    );
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';/);
    expect(sql.trim()).toMatch(/commit;$/);
    expect(executable).not.toMatch(
      /drop (table|function|column)|alter table public\.treatment_setup_(readings|captures)|create or replace function public\.(record_treatment|record_setup_group|record_setup_submission|setup_readings|latest_setup)/i,
    );
  });

  it("is append-only and closes every writer by name", () => {
    expect(sql).toContain("before update on public.treatment_setup_range_confirmations");
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql).toContain(
        `revoke all on public.treatment_setup_range_confirmations from ${role};`,
      );
      expect(sql).toContain(
        `revoke execute on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) from ${role};`,
      );
    }
    expect(sql).toContain(
      "grant select on public.treatment_setup_range_confirmations to authenticated;",
    );
    expect(sql).toContain(
      "grant execute on function public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid) to authenticated;",
    );
    expect(executable).not.toMatch(/grant (insert|update|delete|all)/i);
  });

  it("proves scope and authorship before it writes, and never claims to know the range", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.record_setup_range_confirmations"));
    expect(body.indexOf("assert_setup_scope")).toBeLessThan(body.indexOf("insert into"));
    expect(body.indexOf("recorded_by_practitioner_id is distinct from")).toBeLessThan(body.indexOf("insert into"));
    expect(body).toContain("interval '10 minutes'");
    expect(body).toContain("r.value_numeric = v_value");
    // The database holds no ranges, so it must not pretend to check one.
    expect(executable).not.toMatch(/documented_range|min_value|max_value|machine_profile_field_contract/i);
    expect(sql).toContain("'outside_published_specification'");
    expect(sql).toContain("'recommended_protocol_only'");
    expect(sql).toContain("'documentation_discrepancy'");
    expect(sql).not.toContain("outside_hardware_limit");
  });

  it("revokes EXECUTE on EVERY function it creates from public, anon, authenticated and service_role (Privacy C1)", () => {
    const created = [...executable.matchAll(/create (?:or replace )?function\s+(public\.[a-z_]+)\s*\(([^)]*)\)/gi)];
    expect(created.map((m) => m[1]).sort()).toEqual([
      "public.record_setup_range_confirmations",
      "public.refuse_range_confirmation_update",
    ]);
    for (const m of created) {
      const sig = m[1] === "public.refuse_range_confirmation_update"
        ? "public.refuse_range_confirmation_update()"
        : "public.record_setup_range_confirmations(uuid, jsonb, uuid, uuid)";
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(sql).toContain(`revoke execute on function ${sig} from ${role};`);
      }
    }
    // The trigger function is granted to nobody; the command only to authenticated.
    expect(executable).not.toMatch(/grant execute on function public\.refuse_range_confirmation_update/i);
    expect(executable.match(/grant execute on function/gi)?.length).toBe(1);
  });

  it("stores the reading's value and trims keys like the capture command (Insurance K1, K2); records K3", () => {
    expect(sql).toContain("v_stored, v_code");
    expect(sql).not.toMatch(/v_scope\.o_studio, p_capture_id, v_cap\.session_block_id, v_stage, v_field,\s*v_value/);
    expect(sql).toContain("v_stage := nullif(btrim(coalesce(v_item->>'stage_key', '')), '');");
    expect(sql).toContain("v_field := btrim(v_item->>'field_key');");
    expect(sql).toContain("stage_key = btrim(stage_key)");
    expect(sql).toContain("field_key = btrim(field_key)");
    expect(sql).toMatch(/ACCEPTED IN WRITING[\s\S]*FINAL: a caller must not retry/);
  });
});
