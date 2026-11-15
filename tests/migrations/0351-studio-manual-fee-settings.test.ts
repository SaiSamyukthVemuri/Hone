import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax } from "./helpers/migration-state";

// 0351: STATIC contract only. Behaviour is proved against a real database in tests/db/studio-manual-fee-settings.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0351_studio_manual_fee_settings";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0351: shape", () => {
  it("consumes exactly one number and is no longer the maximum (0352 follows it)", () => {
    expect(countVersion("0351")).toBe(1);
    expect(isRepoMax("0351")).toBe(false);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(E.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(E.trim().endsWith("commit;")).toBe(true);
  });
  it("adds the two switches (NOT NULL DEFAULT false), the two modes (default fixed) and the two nullable percentages to studios", () => {
    expect(E).toMatch(/late_cancel_fee_enabled boolean not null default false/);
    expect(E).toMatch(/no_show_fee_enabled boolean not null default false/);
    expect(E).toMatch(/late_cancel_fee_mode text not null default 'fixed'/);
    expect(E).toMatch(/no_show_fee_mode text not null default 'fixed'/);
    expect(E).toMatch(/late_cancel_fee_percent_bp integer,/);
    expect(E).toMatch(/no_show_fee_percent_bp integer\b/);
    expect(E.match(/add column if not exists (late_cancel|no_show)_fee_(enabled|mode|percent_bp)/g)).toHaveLength(6);
  });
  it("CHECKs: mode is fixed or percent; the percentage is 1..10000 basis points or NULL", () => {
    expect(E).toMatch(/late_cancel_fee_mode in \('fixed', 'percent'\)/);
    expect(E).toMatch(/no_show_fee_mode in \('fixed', 'percent'\)/);
    expect(E).toMatch(/late_cancel_fee_percent_bp is null or late_cancel_fee_percent_bp between 1 and 10000/);
    expect(E).toMatch(/no_show_fee_percent_bp is null or no_show_fee_percent_bp between 1 and 10000/);
  });
  it("seeds NO studio-specific value, enables nothing, and touches no existing row", () => {
    expect(E).not.toMatch(/\b(insert into|delete from)\s+public\.studios\b|\bupdate\s+public\.studios\b/);
    expect(E).not.toMatch(/set\s+(late_cancel|no_show)_fee_(enabled|mode|percent_bp|cents)\s*=/);
    expect(E).not.toMatch(/default true/);
  });
  it("attempt basis columns are nullable with a consistency CHECK, and immutable once written", () => {
    expect(E).toMatch(/add column if not exists calc_mode text,\s*add column if not exists basis_cents integer,\s*add column if not exists percent_bp integer/);
    expect(E).toMatch(/\(calc_mode is null and basis_cents is null and percent_bp is null\)/);
    expect(E).toMatch(/calc_mode = 'fixed' and basis_cents is null and percent_bp is null/);
    expect(E).toMatch(/calc_mode = 'percent' and basis_cents > 0 and percent_bp between 1 and 10000/);
    expect(E).toMatch(/before update of calc_mode, basis_cents, percent_bp on public\.payment_charge_attempts/);
    expect(E).toMatch(/raise exception[\s\S]*calc_mode, basis_cents and percent_bp are fixed/);
  });
  it("the change record is append-only: owner SELECT only, every default privilege revoked by name, trigger-written", () => {
    expect(E).toMatch(/create table if not exists public\.studio_manual_fee_setting_changes/);
    expect(E).toMatch(/enable row level security/);
    expect(E).toMatch(/for select to authenticated\s+using \(public\.is_studio_owner\(studio_id\)\)/);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(E).toMatch(new RegExp(`revoke all on public\\.studio_manual_fee_setting_changes from ${role};`));
    }
    expect(E).toMatch(/grant select on public\.studio_manual_fee_setting_changes to authenticated;/);
    expect(E).toMatch(/grant select on public\.studio_manual_fee_setting_changes to service_role;/);
    expect(E).not.toMatch(/grant (insert|update|delete|all)[^;]*studio_manual_fee_setting_changes/);
  });
  it("the audit trigger function is SECURITY DEFINER, pins search_path, and is revoked from every role by name", () => {
    expect(E).toMatch(/function public\.studios_manual_fee_setting_audit\(\)[\s\S]*?security definer\s+set search_path = pg_catalog, public, pg_temp/);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(E).toMatch(new RegExp(`revoke execute on function public\\.studios_manual_fee_setting_audit\\(\\) from ${role};`));
    }
    expect(E).toMatch(/after update of late_cancel_fee_enabled, no_show_fee_enabled, late_cancel_fee_mode, no_show_fee_mode,\s*late_cancel_fee_percent_bp, no_show_fee_percent_bp, late_cancel_fee_cents, no_show_fee_cents\s+on public\.studios/);
  });
  it("adds no policy on studios and no function other than the two guards", () => {
    expect(E.match(/create or replace function public\.(\w+)/g)).toEqual([
      "create or replace function public.payment_charge_attempts_calc_basis_immutable",
      "create or replace function public.studios_manual_fee_setting_audit",
    ]);
    expect(E).not.toMatch(/create policy "studios/);
    expect(E).not.toMatch(/drop policy[^;]*on public\.studios\b/);
  });
  it("rollback removes every object the migration added", () => {
    for (const re of [
      /drop trigger if exists studios_manual_fee_setting_audit on public\.studios/,
      /drop function if exists public\.studios_manual_fee_setting_audit\(\)/,
      /drop table if exists public\.studio_manual_fee_setting_changes/,
      /drop trigger if exists payment_charge_attempts_calc_basis_immutable/,
      /drop function if exists public\.payment_charge_attempts_calc_basis_immutable\(\)/,
      /drop constraint if exists payment_charge_attempts_calc_basis_check/,
      /drop column if exists calc_mode/, /drop column if exists basis_cents/, /drop column if exists percent_bp/,
      /drop column if exists late_cancel_fee_enabled/, /drop column if exists no_show_fee_enabled/,
      /drop column if exists late_cancel_fee_mode/, /drop column if exists no_show_fee_mode/,
      /drop column if exists late_cancel_fee_percent_bp/, /drop column if exists no_show_fee_percent_bp/,
    ]) expect(DOWN).toMatch(re);
    expect(DOWN).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
  });
});
