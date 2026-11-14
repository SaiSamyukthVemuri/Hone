import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0342 (Roles S2): deactivate / reactivate staff through the permission core. Source contract only; the behaviour is proved by
// tests/db/permission-staff-deactivate-0342.db.test.ts. 0287, 0331 and 0332 are frozen and not edited.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0342")}`, "utf8");
const code = () => sql().replace(/--.*$/gm, "");
const fn = (name: string): string => {
  const i = code().indexOf(`create or replace function public.${name}(`);
  expect(i, name).toBeGreaterThanOrEqual(0);
  return code().slice(i, code().indexOf("\n$$;", i) + 4);
};

describe("0342 staff deactivate through the core (source)", () => {
  it("exists exactly once and is the current repo maximum", () => {
    expect(countVersion("0342")).toBe(1);
    expect(isRepoMax("0342")).toBe(true);
  });
  it("0287 is byte-identical to the applied version (f302e7ba…)", () => {
    expect(createHash("sha256").update(readFileSync("supabase/migrations/0287_roles_permission_engine.sql")).digest("hex").startsWith("f302e7ba")).toBe(true);
  });
  it("opens its own begin/commit with set local lock_timeout inside", () => {
    expect(code()).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
    expect(code().trim().endsWith("commit;")).toBe(true);
  });
  it("creates exactly the switch, the two commands and the replaced change_staff_role, and no table/policy/trigger/data", () => {
    const creates = [...code().matchAll(/create or replace function public\.(\w+)/gi)].map((m) => m[1]);
    expect(creates).toEqual(["perm_upcoming_policy", "deactivate_staff_member", "reactivate_staff_member", "change_staff_role"]);
    expect(code()).not.toMatch(/\b(create table|create policy|create trigger|delete from|drop table)\b/i);
    expect(code()).not.toMatch(/\bupdate public\.(?!practitioners\b|studio_receptionists\b)/i);
  });
  it("widens the audit kinds by exactly two and keeps the five existing ones", () => {
    expect(code()).toMatch(/add constraint permission_audit_kind_check\s+check \(kind in \('role_permissions_saved', 'defaults_adopted', 'role_reset', 'staff_role_changed', 'permissions_activated', 'staff_deactivated', 'staff_reactivated'\)\)/);
  });
  it("every command is SECURITY DEFINER with an empty search_path, and checks the owner FIRST", () => {
    for (const n of ["deactivate_staff_member", "reactivate_staff_member"]) {
      const b = fn(n);
      expect(b, n).toMatch(/security definer\s+set search_path = ''/);
      expect(b.indexOf("perm_actor(p_studio)"), n).toBeGreaterThan(0);
      expect(b.indexOf("perm_actor(p_studio)"), n).toBeLessThan(b.indexOf("perm_fail('unknown_role')"));
      expect(b, n).toMatch(/a\.role <> 'owner' then return public\.perm_fail\('refused'\)/);
    }
  });
  it("deactivate has NO ship gate; reactivate is behind staff_role_change", () => {
    expect(fn("deactivate_staff_member")).not.toMatch(/permission_ship_gates/);
    expect(fn("reactivate_staff_member")).toMatch(/g\.gate = 'staff_role_change'\), false\)/);
  });
  it("refuses an owner target, self, an inactive target and a missing reason; the reason is checked AFTER the membership", () => {
    for (const n of ["deactivate_staff_member", "reactivate_staff_member"]) {
      const b = fn(n);
      expect(b, n).toContain("perm_fail('owner_role_fixed')");
      expect(b, n).toContain("perm_fail('self_change')");
      expect(b, n).toContain("perm_fail('reason_required')");
      expect(b.indexOf("perm_fail('self_change')"), n).toBeLessThan(b.indexOf("perm_fail('reason_required')"));
    }
    expect(fn("deactivate_staff_member")).toContain("perm_fail('not_active')");
    expect(fn("reactivate_staff_member")).toContain("perm_fail('already_active')");
    expect(fn("reactivate_staff_member")).toContain("perm_fail('other_membership_active')");
  });
  it("RF-1: the capacity lock is taken BEFORE the upcoming-appointments count in all three commands", () => {
    for (const n of ["deactivate_staff_member", "change_staff_role"]) {
      const b = fn(n);
      const lock = b.indexOf("acquire_studio_capacity_lock(p_studio)");
      expect(lock, n).toBeGreaterThan(0);
      expect(lock, n).toBeLessThan(b.indexOf("select count(*) into v_upcoming"));
    }
    expect(fn("reactivate_staff_member")).toContain("acquire_studio_capacity_lock(p_studio)");
  });
  it("the upcoming-appointments rule is ONE switch: block ships; keep skips the count; reassign refuses with its own code", () => {
    expect(fn("perm_upcoming_policy")).toMatch(/select 'block'::text/);
    const b = fn("deactivate_staff_member");
    expect(b).toContain("public.perm_upcoming_policy()");
    expect(b).toMatch(/if v_policy <> 'keep' then/);
    expect(b).toContain("'reassign_required'");
    expect(b).toContain("'has_upcoming_appointments'");
    expect(b).toMatch(/ap\.status <> 'cancelled' and ap\.starts_at > now\(\)\s+for update/);
  });
  it("change_staff_role is 0287's body with the lock added and nothing else changed", () => {
    const old = readFileSync("supabase/migrations/0287_roles_permission_engine.sql", "utf8");
    const oi = old.indexOf("create or replace function public.change_staff_role(");
    const oldBody = old.slice(oi, old.indexOf("\n$$;", oi) + 4).replace(/--.*$/gm, "");
    const strip = (t: string) => t.replace(/\s+/g, " ").replace(/ ?perform public\.acquire_studio_capacity_lock\(p_studio\); ?/, " ").trim();
    expect(strip(fn("change_staff_role"))).toBe(strip(oldBody));
  });
  it("one audit row per command, with the reason, and the active flag is the only thing flipped", () => {
    expect(fn("deactivate_staff_member")).toMatch(/'staff_deactivated'/);
    expect(fn("reactivate_staff_member")).toMatch(/'staff_reactivated'/);
    expect(fn("deactivate_staff_member")).toMatch(/update public\.practitioners set active = false where id = p_membership/);
    expect(fn("deactivate_staff_member")).toMatch(/update public\.studio_receptionists set active = false, deactivated_at = now\(\) where id = p_membership/);
  });
  it("revokes by name from public, anon, authenticated AND service_role, then grants the three commands to authenticated only", () => {
    for (const sig of ["perm_upcoming_policy()", "deactivate_staff_member(uuid, uuid, text, text)", "reactivate_staff_member(uuid, uuid, text, text)", "change_staff_role(uuid, uuid, text, text, text)"]) {
      expect(code()).toContain(`revoke all on function public.${sig} from public, anon, authenticated, service_role;`);
    }
    const grants = [...code().matchAll(/grant execute on function public\.(\w+)\([^)]*\) to (\w+);/g)].map((m) => `${m[1]}->${m[2]}`);
    expect(grants).toEqual(["deactivate_staff_member->authenticated", "reactivate_staff_member->authenticated", "change_staff_role->authenticated"]);
  });
});
