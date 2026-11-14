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
    for (const f of ["chart_write_guard", "chart_revision_write", "chart_attribution_guard", "chart_scope", "chart_lineage_guard", "chart_revisions_append_only", "correct_session_performer"])
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
    expect(code).toContain("create trigger zz_chart_lineage_guard_trg before update of studio_id on public.treatment_plans");
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

  it("option A: chart_revisions is metadata only (no value column, no image, no image function) and the finalized snapshots are not touched", () => {
    const create = /create table public\.chart_revisions \(([\s\S]*?)\n\);/.exec(code)![1];
    expect(create).not.toMatch(/\bjsonb?\b|\bbytea\b|before_image|after_image/i);
    const cols = [...create.matchAll(/^\s*(\w+)\s+(\w+(?:\[\])?)/gm)].filter((m) => !["constraint", "primary"].includes(m[1]));
    expect(cols.filter((m) => m[2] === "text").map((m) => m[1]).sort()).toEqual(["op", "table_name"]);
    expect(create).toContain("changed_columns text[]");
    expect(create).toContain("version_no");
    expect(code).not.toContain("chart_revision_image");
    expect(down).not.toContain("chart_revision_image");
    expect(code).not.toMatch(/before_image|after_image/);
    // the writer stores names, never values: its INSERT lists exactly the metadata columns
    const insert = /insert into public\.chart_revisions \(([^)]*)\)/.exec(code)![1].replace(/\s+/g, " ");
    expect(insert).toBe("studio_id, client_id, table_name, row_id, op, changed_by, changed_columns, version_no");
    // 0119/0120 finalized snapshots, amendments and audit events are outside this migration
    expect(code).not.toMatch(/clinical_record_snapshots|clinical_record_amendments|clinical_audit_events/);
  });
});
