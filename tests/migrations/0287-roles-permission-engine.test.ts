import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

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
    expect(isRepoMax("0287")).toBe(true);
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
    expect(granted).toEqual(["activate_released_permissions", "adopt_new_defaults", "change_staff_role", "effective_access", "get_role_permissions", "has_studio_permission", "list_permission_audit", "preview_activation", "preview_adopt_new_defaults", "preview_reset", "preview_role_changes", "reset_role_to_defaults", "save_role_permissions"]);
    expect(code).not.toMatch(/grant execute[^;]*\bto\b[^;]*\b(anon|service_role|public)\b/i);
  });

  it("every table has row level security on and every API role privilege revoked", () => {
    const tables = [...code.matchAll(/create table public\.(\w+)/g)].map((m) => m[1]!);
    expect(tables.sort()).toEqual(["permission_audit", "permission_catalog", "permission_key_activation", "permission_key_release", "permission_narrowings", "permission_ship_gates", "studio_permission_policy", "studio_role_permissions"]);
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

// Activation rule (Sam, 3 Nov). Source contract; behaviour is proved by tests/db/permission-activation.db.test.ts (NOT RUN until the slot).
const fnBodies = () => code.split(/(?=create or replace function public\.)/).map((b) => [b.split("\n$$;")[0], b.match(/^create or replace function public\.(\w+)/)?.[1]] as const).filter(([, n]) => n).map(([b, n]) => Object.assign([b, n] as string[], {}));

describe("0287 activation rule: source contract", () => {
  it("every key the catalog marks enforced is in the release seed", async () => {
    const { CATALOG, enforcementOf } = await import("@/lib/permissions/catalog");
    const seeded = [...(code.match(/insert into public\.permission_key_release[\s\S]*?;/)![0]).matchAll(/\('([a-z_.]+)', null, 'R1-R2', '(?:full|narrow)'\)/g)].map((m) => m[1]).sort();
    const enforced = (CATALOG as readonly { key: string }[]).filter((d) => enforcementOf(d.key) === "enforced").map((d) => d.key).sort();
    // Every enforced key MUST be released, or its owner-stored values would be inert forever. (Released but not yet enforced is harmless.)
    expect(enforced.filter((k) => !seeded.includes(k))).toEqual([]);
  });

  it("only the owner commands write studio_role_permissions, the activation table and the release table (no other writer exists)", () => {
    const writes = (table: string) => [...code.matchAll(new RegExp(`(insert into|update|delete from)\\s+public\\.${table}\\b`, "g"))].length;
    // role permissions: save (upsert), reset (delete) only
    const rolePermWriters = fnBodies()
      .filter((m) => /(insert into|update|delete from)\s+public\.studio_role_permissions\b/.test(m[0]))
      .map((m) => m[1]).sort();
    expect(rolePermWriters).toEqual(["perm_run_basis", "perm_run_changes"]);
    const activationWriters = fnBodies()
      .filter((m) => /(insert into|update|delete from)\s+public\.permission_key_activation\b/.test(m[0]))
      .map((m) => m[1]);
    expect(activationWriters).toEqual(["perm_run_activation"]);
    const releaseWriters = fnBodies()
      .filter((m) => /(insert into|update|delete from)\s+public\.permission_key_release\b/.test(m[0]));
    // the operator-only command is the one function that writes it; it is granted to no API role (see the grant test)
    expect(releaseWriters.map((m) => m[1])).toEqual(["mark_permissions_released"]);
    expect(writes("permission_key_release")).toBe(3); // the seed, plus the two updates inside mark_permissions_released
  });

  it("no application code and no other migration writes these tables", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const f = `${d}/${n}`; if (n === "node_modules" || n === ".next" || n === ".git") continue; statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx|sql|mjs)$/.test(n) && files.push(f); } };
    for (const d of ["app", "lib", "components", "scripts", "supabase/migrations"]) walk(d);
    const re = /(insert\s+into|update|delete\s+from)\s+(public\.)?(studio_role_permissions|permission_key_activation|permission_key_release)\b|\.from\(\s*["'](studio_role_permissions|permission_key_activation|permission_key_release)["']\s*\)/;
    const hits = files.filter((f) => !f.endsWith(FILE) && re.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the resolver treats a missing release row as today's snapshot (fail closed) and a studio basis_at / stored set_at gate the intended values", () => {
    expect(code).toMatch(/if not found or v_rel\.released_at is null then return v_snap; end if;/);
    expect(code).toContain("v_stored_at >= v_rel.released_at");
    expect(code).toContain("v_basis_at >= v_rel.released_at");
    expect(code).toContain("'inactive_until_activated'");
  });

  it("releases are seeded PENDING; the six deny_only keys are narrow releases; observe keys are not released (AA-4, AH1)", () => {
    const seed = code.match(/insert into public\.permission_key_release[\s\S]*?;/)![0];
    const rows = [...seed.matchAll(/\('([a-z_.]+)', (null|now\(\)[^,]*), '([^']+)', '(full|narrow)'\)/g)].map((m) => ({ key: m[1], at: m[2], kind: m[4] }));
    expect(rows.length).toBe(13);
    expect(rows.every((r) => r.at === "null")).toBe(true);
    expect(rows.filter((r) => r.kind === "narrow").map((r) => r.key).sort()).toEqual(["appt.book", "appt.move", "appt.reassign", "avail.manage_others", "avail.manage_own", "avail.manage_studio_hours"]);
    expect(rows.map((r) => r.key)).not.toContain("appt.complete");
  });

  it("every key the catalog marks deny_only is a NARROW release; no observe or not_yet key is released (AH1)", async () => {
    const { CATALOG, enforcementOf } = await import("@/lib/permissions/catalog");
    const seed = code.match(/insert into public\.permission_key_release[\s\S]*?;/)![0];
    const narrow = [...seed.matchAll(/\('([a-z_.]+)', null, '[^']+', 'narrow'\)/g)].map((m) => m[1]).sort();
    const all = [...seed.matchAll(/\('([a-z_.]+)', null, '[^']+', '(?:full|narrow)'\)/g)].map((m) => m[1]);
    const keys = (CATALOG as readonly { key: string }[]).map((d) => d.key);
    const denyOnly = keys.filter((k) => enforcementOf(k) === "deny_only").sort();
    // vacuous before the enforcement branch sets the field; the literal list above pins the six either way
    expect(denyOnly.filter((k) => !narrow.includes(k))).toEqual([]);
    expect(all.filter((k) => ["observe", "not_yet"].includes(enforcementOf(k)))).toEqual([]);
  });

  it("activation requires an explicit non-empty key list and a preview hash; mark_permissions_released is granted to no API role (AA-1, AA-4)", () => {
    expect(code).toContain("perm_fail('keys_required')");
    expect(code).toContain("perm_fail('preview_required')");
    expect(code).toContain("perm_fail('stale_preview'");
    expect(code).toMatch(/revoke all on function public\.mark_permissions_released\(text\[\], text, text\) from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant execute on function public\.mark_permissions_released/);
    expect(code).not.toMatch(/grant execute on function public\.perm_activation_hash/);
  });

  it("adopt, reset and activation require sensitive_confirmed when their result newly enables a sensitive key (Insurance PY-1)", () => {
    for (const fn of ["reset_role_to_defaults", "adopt_new_defaults", "activate_released_permissions"])
      expect(code, fn).toMatch(new RegExp(`function public\\.${fn}\\([^)]*p_sensitive_confirmed boolean default false\\)`));
    expect(code.match(/message = public\.perm_fail\('sensitive_unconfirmed'\)/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
