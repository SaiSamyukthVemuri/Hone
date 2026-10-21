import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";
import { EXPORT_RESOURCE_REGISTRY, exportedResources } from "../../lib/export/resource-registry";
const sql = readFileSync("supabase/migrations/0244_treatment_reading_change_history.sql", "utf8");
const executable = sql.replace(/--[^\n]*/g, "");
describe("0244 routine history source contract, not DB proof", () => {
  it("owns allocated max and bounded atomic additive source", () => {
    expect(countVersion("0244")).toBe(1);
    expect(fileForVersion("0244")).toBe("0244_treatment_reading_change_history.sql");
    expect(isRepoMax("0244")).toBe(true);
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';/);
    expect(sql.trim()).toMatch(/commit;$/);
    expect(executable).not.toMatch(/cascade|set null|disable trigger|clinical_record_snapshots|clinical_audit_events|clinical_corrections_enabled/i);
  });
  it("keeps raw supported leaves, absent/null, no-op and actor-before-insert", () => {
    expect(sql).toContain("v_path := string_to_array(v_key,'.')");
    expect(sql).toContain("v_before is not distinct from v_after");
    expect(sql).toContain("jsonb_typeof(v_value) <> 'number'");
    expect(sql).toContain("v_value #>> '{}' in ('NaN','Infinity','-Infinity')");
    expect(sql).toContain("jsonb_typeof(v_value) <> 'boolean'");
    expect(sql).toContain("jsonb_typeof(v_value) <> 'string'");
    expect(sql).toContain("'present',v_before is not null");
    expect(sql.indexOf("cardinality(v_changed) = 0")).toBeLessThan(sql.indexOf("v_actor := public.session_actor_practitioner(v_studio)"));
    expect(sql.indexOf("v_actor := public.session_actor_practitioner(v_studio)")).toBeLessThan(sql.indexOf("insert into public.treatment_reading_change_events"));
    expect(sql).not.toMatch(/p_actor|current_setting|p_metadata|p_changes/);
    for (const key of ["comments", "observation_notes", "ejection_results", "reaction_notes", "caution_note", "numbing_notes", "block_notes"]) {
      expect(executable).not.toContain(`'${key}'`);
    }
    expect(sql).toContain("array['session_number','equipment_params.fluence','equipment_params.pulse_width','equipment_params.spot_size']");
  });
  it("inherits actual parent RLS and active practitioner, not a definer visibility helper", () => {
    const policy = sql.slice(sql.indexOf("create policy"), sql.indexOf("create or replace function"));
    for (const fragment of ["public.sessions s", "public.clients c", "public.practitioners p", "p.user_id=auth.uid() and p.active", "c.id=treatment_reading_change_events.client_id"]) expect(policy).toContain(fragment);
    expect(policy).not.toMatch(/is_studio_member|security definer/);
    expect(sql.match(/on delete restrict/g)).toHaveLength(3);
  });
  it("closes all transport writers and guards owner writes/truncation", () => {
    expect(sql).toContain("revoke all on public.treatment_reading_change_events from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant select on public.treatment_reading_change_events to authenticated;");
    expect(sql.match(/grant /g)).toHaveLength(1);
    for (const name of ["capture_treatment_reading_change", "guard_treatment_reading_history_immutable"]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) expect(sql).toContain(`revoke execute on function public.${name}() from ${role};`);
    }
    expect(sql).toContain("before update or delete");
    expect(sql).toContain("before truncate");
  });
  it("registers clinical diffs PENDING field review without export emission", () => {
    expect(EXPORT_RESOURCE_REGISTRY.treatment_reading_change_events).toMatchObject({ kind: "pending", fieldReviewRequired: true, tier: 1 });
    expect(exportedResources().some(row => row.resource === "treatment_reading_change_events")).toBe(false);
  });
  it("preserves the existing clearable block link and snapshots its prior context", () => {
    // 0160 permits clearing an entry block link; history must not introduce
    // a second, stricter lineage rule while recording a reading correction.
    expect(sql).not.toContain("tg_table_name='electrolysis_entries' and v_old->>'block_id' is distinct from v_new->>'block_id'");
    expect(sql).toContain("coalesce((v_new->>'block_id')::uuid,(v_old->>'block_id')::uuid)");
    expect(sql).toContain("v_old->>'session_id'");
  });
  it("adds only its own trigger functions, never a signed/native workflow replacement", () => {
    expect([...executable.matchAll(/create or replace function public\.(\w+)/g)].map(match => match[1])).toEqual([
      "capture_treatment_reading_change", "guard_treatment_reading_history_immutable",
    ]);
    for (const source of ["session_blocks", "electrolysis_entries", "laser_entries"]) {
      expect(sql).toContain(`after update on public.${source}`);
    }
    for (const untouched of ["public.treatment_setup_", "public.machine_profile_", "public.clinical_record_", "public.guard_retired_"]) {
      expect(executable).not.toContain(untouched);
    }
  });
});
