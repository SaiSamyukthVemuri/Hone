import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0287 (held): the permission engine. Source contract only; behaviour is proved by tests/db/permission-engine.db.test.ts
// (NOT RUN until an owned isolated stack and the heavy slot exist).
const FILE = "0287_roles_permission_engine.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

describe("0287 permission engine: shape", () => {
  it("uses its claimed filename once, in one bounded transaction", () => {
    expect(countVersion("0287")).toBe(1);
    expect(fileForVersion("0287")).toBe(FILE);
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
  });

  it("is additive: it drops no column or table and edits no earlier migration", () => {
    expect(code).not.toMatch(/\bdrop\s+(column|table)\b/i);
    expect(code).not.toMatch(/\balter\s+table\s+public\.(practitioners|studio_receptionists|appointments|clients|studios)\b/i);
    expect(readdirSync("supabase/migrations").filter((f) => f.startsWith("0287"))).toEqual([FILE]);
  });

  it("every function is SECURITY DEFINER or immutable, with an empty search_path", () => {
    const fns = code.split(/create or replace function /).slice(1);
    expect(fns.length).toBeGreaterThanOrEqual(24);
    for (const f of fns) {
      const name = f.slice(0, f.indexOf("("));
      expect(f.slice(0, f.indexOf("$$")), name).toMatch(/set search_path = ''/);
      if (!/\bimmutable\b/.test(f.slice(0, f.indexOf("$$")))) expect(f.slice(0, f.indexOf("$$")), name).toMatch(/security definer/);
    }
  });

  it("revokes every function from public, anon, authenticated AND service_role by name, and grants only the API to authenticated", () => {
    const created = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    for (const n of new Set(created)) expect(code, n).toMatch(new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    const granted = [...code.matchAll(/grant execute on function public\.(\w+)\(/g)].map((m) => m[1]!).sort();
    expect(granted).toEqual(["adopt_new_defaults", "change_staff_role", "effective_access", "get_role_permissions", "has_studio_permission", "list_permission_audit", "preview_adopt_new_defaults", "preview_reset", "preview_role_changes", "reset_role_to_defaults", "save_role_permissions"]);
    expect(code).not.toMatch(/grant execute[^;]*\bto\b[^;]*\b(anon|service_role|public)\b/i);
  });

  it("every table has row level security on and every API role privilege revoked", () => {
    const tables = [...code.matchAll(/create table public\.(\w+)/g)].map((m) => m[1]!);
    expect(tables.sort()).toEqual(["permission_audit", "permission_catalog", "permission_narrowings", "permission_ship_gates", "studio_permission_policy", "studio_role_permissions"]);
    for (const t of tables) {
      expect(code, t).toMatch(new RegExp(`alter table public\\.${t} enable row level security;`));
      expect(code, t).toMatch(new RegExp(`revoke all on public\\.${t} from public, anon, authenticated, service_role;`));
    }
    expect(code).not.toMatch(/create policy/i);
  });

  it("the audit is append-only (update, delete and truncate refuse) and has no foreign key to studios", () => {
    expect(code).toMatch(/before update or delete on public\.permission_audit/);
    expect(code).toMatch(/before truncate on public\.permission_audit/);
    const audit = code.slice(code.indexOf("create table public.permission_audit"), code.indexOf("create index permission_audit_studio_idx"));
    expect(audit).not.toMatch(/references/);
  });

  it("the own client scope reads the CURRENT appointment assignment, excludes cancelled appointments and stays in the studio", () => {
    const fn = code.slice(code.indexOf("create or replace function public.has_studio_permission"));
    const client = fn.slice(fn.indexOf("own_kind = 'client'"), fn.indexOf("own_kind = 'practitioner'"));
    expect(client).toMatch(/ap\.studio_id = p_studio/);
    expect(client).toMatch(/ap\.practitioner_id = a\.membership_id/);
    expect(client).toMatch(/ap\.status <> 'cancelled'/);
  });

  it("the reason rule has no length constant", () => {
    const fn = code.slice(code.indexOf("create or replace function public.perm_reason_ok"), code.indexOf("create or replace function public.perm_actor"));
    expect(fn).not.toMatch(/length\(|char_length\(/);
    expect(fn).toMatch(/count\(distinct ch\)/);
  });
});
