import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0237_machine_native_text_readings.sql", "utf8");
describe("0237 additive native text contract (static, not DB proof)", () => {
  it("owns only its allocated number and transaction", () => {
    expect(countVersion("0237")).toBe(1);
    expect(fileForVersion("0237")).toBe("0237_machine_native_text_readings.sql");
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';/);
    expect(sql.trim()).toMatch(/commit;$/);
    expect(sql).not.toMatch(/\b(drop table|disable row level security|disable trigger|truncate|cascade)\b/i);
  });
  it("retains exactly one observation, text metadata and the governed writer", () => {
    expect(sql).toContain("num_nonnulls(value_numeric, value_text, absence_reason) = 1");
    expect(sql).toContain("v_text := v_item->>'value_text'");
    expect(sql).toContain("jsonb_typeof(v_item->'value_text') <> 'string'");
    expect(sql).toContain("v_choices @> jsonb_build_array(v_text)");
    expect(sql).toContain("v_kind <> 'number' and v_value is not null");
    expect(sql).toContain("'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric");
    expect(sql).not.toMatch(/update public\.(treatment_setup_readings|machine_profile_field_contract)/i);
  });
  it("keeps type/choices in BOTH immutable comparison directions and read projections", () => {
    expect(sql.match(/c\.quantity, c\.optional, c\.value_kind, c\.choices/g)).toHaveLength(2);
    expect(sql.match(/coalesce\(f->>'value_kind', 'number'\) as value_kind/g)).toHaveLength(2);
    expect(sql.match(/'value_text', r.value_text/g)).toHaveLength(2);
  });
  it("does not add a callable API or widen privileges", () => {
    expect([...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1])).toEqual([
      "sync_machine_profile_contract", "record_setup_group_in_scope", "setup_readings_for_block", "latest_setup_for_client",
    ]);
    for (const name of ["sync_machine_profile_contract", "record_setup_group_in_scope", "setup_readings_for_block", "latest_setup_for_client"]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${name}\\([^;]+ from ${role};`));
    }
    expect(sql).not.toMatch(/grant execute on function public\.record_setup_group_in_scope/);
    expect(sql).not.toMatch(/insert into public\.machine_profile_(mode|field)_contract[^;]*dectro-apilus/s);
  });
});
