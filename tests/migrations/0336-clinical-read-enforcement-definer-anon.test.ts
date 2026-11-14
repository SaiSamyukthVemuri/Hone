import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0336 (I4) source contract. The behaviour is proved against a database in tests/db/clin-read-enforcement-definer-anon.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0336")}`, "utf8");
const code = () => sql().replace(/--[^\n]*/g, "");
const TABLES = ["sessions", "session_blocks", "session_block_areas", "session_copy_operations", "treatment_area_create_claims", "treatment_setup_captures", "treatment_setup_readings", "treatment_setup_submissions", "imported_treatment_memories", "imported_treatment_memory_audit_events", "treatment_reading_change_events", "treatment_images", "photos", "electrolysis_entries", "laser_entries", "session_audit", "client_intake_forms", "client_consent_signatures", "appointment_policy_acknowledgements", "treatment_plans", "treatment_plan_stages", "treatment_goals", "client_clinical_notes", "client_pinned_notes", "client_personal_notes", "client_budget_context", "clinical_audit_events", "clinical_record_snapshots", "clinical_record_amendments"];

describe("0336 clinical-read enforcement, definer gate and anon grants (source)", () => {
  it("exists exactly once (0343 is the repo maximum now; only the maximum asserts isRepoMax)", () => {
    expect(countVersion("0336")).toBe(1);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code();
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });
  it("(a) the descriptor asks clin.view_records AFTER the membership check, with the same HN001 refusal, and is re-granted by name", () => {
    const c = code();
    const fn = /create or replace function public\.whole_session_copy_source_descriptor[\s\S]*?\n\$\$;/.exec(c)![0];
    const member = fn.indexOf("is_studio_member(p_studio_id)");
    const key = fn.indexOf("clin_key_studios('clin.view_records')");
    expect(member).toBeGreaterThan(0);
    expect(key).toBeGreaterThan(member);
    expect(key).toBeLessThan(fn.indexOf("from public.sessions"));
    expect((fn.match(/HN001/g) ?? []).length).toBe(2);
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path = ''/);
    expect(c).toMatch(/revoke all on function public\.whole_session_copy_source_descriptor\(uuid, uuid\) from public, anon, authenticated, service_role;/);
    expect(c).toMatch(/grant execute on function public\.whole_session_copy_source_descriptor\(uuid, uuid\) to authenticated, service_role;/);
  });
  it("(b) revokes every privilege from public and anon on exactly the listed clinical tables, and touches neither authenticated nor service_role", () => {
    const c = code();
    const seen = [...c.matchAll(/revoke all on table public\.(\w+) from public, anon;/g)].map((m) => m[1]).sort();
    expect(seen).toEqual([...TABLES].sort());
    expect(c).not.toMatch(/on table[^;]*from[^;]*\b(authenticated|service_role)\b/);
    expect(c).not.toMatch(/grant [^;]* on table/i);
  });
  it("(b) every listed table exists in an earlier migration", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const text = readdirSync("supabase/migrations").filter((n: string) => n < fileForVersion("0336") && n.endsWith(".sql")).map((n: string) => readFileSync(`supabase/migrations/${n}`, "utf8")).join("\n");
    for (const t of TABLES) expect(text, t).toMatch(new RegExp(`create table (if not exists )?public\\.${t}[ (]`));
  });
  it("(c) session_is_visible is revoked from public, anon and service_role by name and kept for authenticated", () => {
    const c = code();
    expect(c).toMatch(/revoke all on function public\.session_is_visible\(uuid\) from public, anon, authenticated, service_role;/);
    expect(c).toMatch(/grant execute on function public\.session_is_visible\(uuid\) to authenticated;/);
  });
  it("changes no policy, no table grant to any role, does not gate record_clinical_records_audit, and leaves last_visit and the G8 write grants alone", () => {
    const c = code();
    expect(c).not.toMatch(/alter policy|create policy|drop policy/i);
    expect(c).not.toMatch(/record_clinical_records_audit|receptionist_client_directory|last_visit/);
    expect(c).not.toMatch(/on table public\.(photos|treatment_images)[^;]*(insert|update|delete)/i);
  });
});
