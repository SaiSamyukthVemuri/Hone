import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0289 (held): edit-record protections (NQ-11/12). Source contract only; behaviour is proved by
// tests/db/edit-record-protections-0289.db.test.ts (NOT RUN until an owned isolated stack and the heavy slot exist).
const FILE = "0289_roles_edit_record_protections.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const down = readFileSync("supabase/rollbacks/0289_roles_edit_record_protections.down.sql", "utf8");
const TABLES = ["sessions", "session_blocks", "session_block_areas", "electrolysis_entries", "laser_entries", "treatment_plans", "treatment_plan_stages", "client_clinical_notes"];

describe("0289 edit-record protections: shape", () => {
  it("uses its claimed filename once, in one bounded transaction", () => {
    expect(countVersion("0289")).toBe(1);
    expect(fileForVersion("0289")).toBe(FILE);
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
    expect(isRepoMax("0289")).toBe(true);
  });

  it("covers all eight chart tables, and its down file removes what it creates", () => {
    for (const t of TABLES) expect(sql).toContain(`'${t}'`);
    for (const f of ["chart_write_guard", "chart_revision_write", "chart_revision_image", "chart_attribution_guard", "chart_scope", "chart_lineage_guard", "chart_revisions_append_only", "correct_session_performer"])
      expect(down).toContain(f);
    expect(down).toContain("drop table if exists public.chart_revisions");
    expect(down).toContain("create or replace function public.set_session_performer(");
  });

  it("every function it creates is security definer with an empty search_path and revoked from public, anon, authenticated and service_role by name", () => {
    // set_session_performer is an APPLIED command re-created with the same signature and grant (revoked by name, one statement per role, then granted)
    const fns = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]).filter((f) => f !== "set_session_performer");
    expect(fns.length).toBeGreaterThanOrEqual(6);
    for (const f of fns) {
      const body = code.slice(code.indexOf(`function public.${f}(`));
      const header = body.slice(0, body.indexOf("$$"));
      expect(header, f).toMatch(/security definer/);
      expect(header, f).toMatch(/set search_path = ''/);
      expect(code, f).toMatch(new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
  });

  it("refuses a stage or area whose studio differs from its parent's, before the edit-key guard runs", () => {
    for (const t of ["treatment_plan_stages", "session_block_areas"])
      expect(code).toContain(`create trigger zz_chart_lineage_guard_trg before insert or update on public.${t}`);
    for (const t of ["treatment_plans", "session_blocks"])
      expect(code).toContain(`create trigger zz_chart_lineage_guard_trg before update of studio_id on public.${t}`);
    expect("zz_chart_lineage_guard_trg" < "zz_chart_write_guard_trg").toBe(true); // BEFORE triggers fire in name order
    expect(down).toContain("zz_chart_lineage_guard_trg");
  });

  it("history tables are append-only and never granted write access", () => {
    expect(code).toMatch(/revoke all on public\.chart_revisions from public, anon, authenticated, service_role;/);
    expect(code).toMatch(/revoke all on public\.session_performer_corrections from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant (insert|update|delete)[^;]*chart_revisions/);
    expect(code).toContain("before update or delete on public.chart_revisions");
    expect(code).toContain("before truncate on public.chart_revisions");
  });

  it("asks the engine for clin.edit_records with the client, and keeps the catalog untouched (not_yet)", () => {
    expect(code).toContain("has_studio_permission(v_studio, 'clin.edit_records', v_client)");
    expect(code).toContain("has_studio_permission(v_studio, 'clin.edit_records', p_client_id)");
    expect(readFileSync("lib/permissions/catalog.ts", "utf8")).not.toMatch(/clin\.edit_records[\s\S]{0,400}enforcement:\s*"enforced"/);
  });

  it("keeps set_session_performer's signature and authenticated-only grant (applied contract) and only allows the first attribution", () => {
    expect(code).toMatch(/grant execute on function public\.set_session_performer\(uuid, uuid, uuid\) to authenticated;/);
    expect(code).toContain("Use correct_session_performer to change an existing performer.");
    expect(down).toContain("create or replace function public.set_session_performer(");
  });
});
