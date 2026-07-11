import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Willow P1-B, migration 0123: the atomic aggregate soft-delete RPC for removing
// a treatment area. Static SQL pins: SECURITY DEFINER + authenticated-only grant,
// finalized/void reject, reason gate, soft-delete (never hard-delete) of the
// block + its passes + its images, an audit row, and no destructive/DDL drops.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0123_soft_delete_session_area.sql"),
  "utf8",
);

describe("0123 — soft_delete_session_area RPC", () => {
  it("is a SECURITY DEFINER function with a pinned search_path", () => {
    expect(SQL).toMatch(/create or replace function public\.soft_delete_session_area/);
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("is executable by authenticated only (revoked from anon/public)", () => {
    expect(SQL).toMatch(/revoke all on function public\.soft_delete_session_area\(uuid, uuid, text\) from public/);
    expect(SQL).toMatch(/revoke all on function public\.soft_delete_session_area\(uuid, uuid, text\) from anon/);
    expect(SQL).toMatch(/grant execute on function public\.soft_delete_session_area\(uuid, uuid, text\) to authenticated/);
  });

  it("derives tenancy from the row (is_studio_member) + an active practitioner", () => {
    expect(SQL).toMatch(/public\.is_studio_member\(b\.studio_id\)/);
    expect(SQL).toMatch(/from public\.practitioners p[\s\S]{0,120}p\.user_id = auth\.uid\(\)[\s\S]{0,80}p\.active = true/);
    expect(SQL).toMatch(/for update of b/);
  });

  it("rejects finalized/void records and short reasons", () => {
    expect(SQL).toMatch(/if v_status in \('finalized', 'void'\) then/);
    expect(SQL).toMatch(/Finalized records cannot be edited/);
    expect(SQL).toMatch(/length\(btrim\(p_reason\)\) < 10/);
  });

  it("SOFT-deletes the block + its passes + its images (never a hard delete)", () => {
    expect(SQL).toMatch(/update public\.session_blocks\s*\n?\s*set deleted_at = now\(\), deleted_by = v_actor, delete_reason/);
    expect(SQL).toMatch(/update public\.electrolysis_entries\s*\n?\s*set deleted_at = now\(\), deleted_by = v_actor/);
    expect(SQL).toMatch(/update public\.treatment_images\s*\n?\s*set deleted_at = now\(\), deleted_by = v_actor/);
    // block-scoped children only.
    expect(SQL).toMatch(/where block_id = p_block_id and deleted_at is null/);
    expect(SQL).toMatch(/where session_block_id = p_block_id and deleted_at is null/);
    // NEVER a hard delete of clinical rows.
    expect(SQL).not.toMatch(/delete from public\.(session_blocks|electrolysis_entries|treatment_images)/i);
  });

  it("writes an explicit area-removed audit event", () => {
    expect(SQL).toMatch(/insert into public\.session_audit/);
    expect(SQL).toMatch(/'area_removed'/);
  });

  it("is additive-only (no table drops / no schema-destroying DDL)", () => {
    expect(SQL).not.toMatch(/drop table/i);
    expect(SQL).not.toMatch(/drop column/i);
    expect(SQL).not.toMatch(/alter table/i);
  });
});
