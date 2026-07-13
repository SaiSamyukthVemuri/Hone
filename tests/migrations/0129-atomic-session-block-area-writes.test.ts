import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Static proof of migration 0129 — atomic create/update of a settings block + its
// structured area set (fixes the delete-then-insert data-loss risk). Behavioural
// proof (atomic replacement, rollback-on-conflict, cross-studio denial) is in
// tests/db/session-block-areas.db.test.ts. Carries the repo migration-max tripwire.

const MIG_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILES = readdirSync(MIG_DIR);
const FILE = FILES.find((f) => f.startsWith("0129_"));
const SQL = FILE ? readFileSync(path.join(MIG_DIR, FILE), "utf8") : "";

describe("0129 — file + repo-max tripwire", () => {
  it("is the single 0129 migration (atomic session-block-area writes)", () => {
    expect(FILE).toMatch(/^0129_atomic_session_block_area_writes\.sql$/);
  });
  it("is immediately followed by 0130 (the anon-revoke hardening; repo-max tripwire now lives there)", () => {
    // 0130 (revoke the residual anon EXECUTE on these RPCs) now advances the repo
    // max; the authoritative repo-max tripwire lives in the 0130 test.
    for (const n of ["0125", "0126", "0127", "0128", "0130"]) {
      expect(FILES.some((f) => f.startsWith(`${n}_`))).toBe(true);
    }
  });
  it("does NOT modify migration 0128 or its table", () => {
    expect(SQL).not.toMatch(/alter table public\.session_block_areas/i);
    expect(SQL).not.toMatch(/drop (table|policy|trigger)/i);
    expect(SQL).not.toMatch(/create table/i);
  });
});

describe("0129 — atomic create + update functions", () => {
  it("defines both a create and an update function", () => {
    expect(SQL).toMatch(/create or replace function public\.create_session_block_with_areas\(/);
    expect(SQL).toMatch(/create or replace function public\.update_session_block_with_areas\(/);
  });

  it("the UPDATE replaces the area set as delete + insert in ONE function/transaction", () => {
    const upd = SQL.slice(SQL.indexOf("function public.update_session_block_with_areas"));
    expect(upd).toMatch(/delete from public\.session_block_areas where session_block_id = p_block_id/);
    expect(upd).toMatch(/insert into public\.session_block_areas/);
    // The delete precedes the insert INSIDE the same plpgsql body (atomic).
    expect(upd.indexOf("delete from public.session_block_areas")).toBeLessThan(
      upd.indexOf("insert into public.session_block_areas"),
    );
  });

  it("the CREATE inserts the block AND its areas in one function/transaction", () => {
    const cre = SQL.slice(
      SQL.indexOf("function public.create_session_block_with_areas"),
      SQL.indexOf("function public.update_session_block_with_areas"),
    );
    expect(cre).toMatch(/insert into public\.session_blocks/);
    expect(cre).toMatch(/insert into public\.session_block_areas/);
    // No application-side compensating soft-delete pattern in SQL.
    expect(cre).not.toMatch(/deleted_at = now\(\)/);
  });
});

describe("0129 — authorization + hardening", () => {
  it("both functions are SECURITY DEFINER with a pinned search_path", () => {
    expect((SQL.match(/security definer/g) ?? []).length).toBe(2);
    expect((SQL.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(2);
  });
  it("both authorize the caller via is_studio_member + a same-studio block/session check", () => {
    expect((SQL.match(/is_studio_member\(p_studio_id\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // create checks the session is in the studio; update locks + checks the block.
    expect(SQL).toMatch(/from public\.sessions\s*\n?\s*where id = p_session_id and studio_id = p_studio_id/);
    expect(SQL).toMatch(/where id = p_block_id[\s\S]{0,120}studio_id = p_studio_id[\s\S]{0,120}session_id = p_session_id/);
  });

  it("the update locks the target block (FOR UPDATE) + enforces an optimistic-concurrency token", () => {
    const upd = SQL.slice(SQL.indexOf("function public.update_session_block_with_areas"));
    expect(upd).toMatch(/for update/);
    expect(upd).toMatch(/p_expected_updated_at timestamptz default null/);
    expect(upd).toMatch(/v_current <> p_expected_updated_at/);
    expect(upd).toMatch(/stale_block_version/);
  });

  it("only allow-listed columns are written — studio/session/id are never read from p_block", () => {
    const upd = SQL.slice(SQL.indexOf("function public.update_session_block_with_areas"));
    // The update set-list assigns from r.<col> for the allow-listed fields only;
    // it must NOT assign studio_id/session_id/id/sort_order/deleted_at from r.
    expect(upd).not.toMatch(/studio_id = r\./);
    expect(upd).not.toMatch(/session_id = r\./);
    expect(upd).not.toMatch(/\bid = r\./);
    expect(upd).not.toMatch(/sort_order = r\./);
    expect(upd).not.toMatch(/deleted_at = r\./);
  });
  it("grants EXECUTE to authenticated + service_role; revokes from public (0130 revokes the residual anon default-privilege grant)", () => {
    // NOTE: 0129 revokes only from PUBLIC and never grants "to anon" — but Supabase
    // default privileges grant anon EXECUTE at create-time, so the deployed anon
    // grant survived. Migration 0130 revokes it explicitly; see that test.
    expect((SQL.match(/revoke all on function public\.(create|update)_session_block_with_areas[\s\S]{0,120} from public/g) ?? []).length).toBe(2);
    expect((SQL.match(/grant execute on function public\.(create|update)_session_block_with_areas[\s\S]{0,120} to authenticated/g) ?? []).length).toBe(2);
    // 0129 itself never grants to anon (the stray grant is from default privileges).
    expect(SQL).not.toMatch(/to anon/i);
  });
});
