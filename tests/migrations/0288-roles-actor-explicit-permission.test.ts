import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0288 section 1 (held): the actor-explicit permission function (Q-1). Source contract only; behaviour is proved by
// tests/db/permission-actor-explicit.db.test.ts (NOT RUN until an owned isolated stack exists with 0287 and 0288 applied).
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0288")}`, "utf8");
const code = () => sql().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("0288 section 1: shape", () => {
  it("is one file, opens its own transaction and arms lock_timeout inside it", () => {
    expect(countVersion("0288")).toBe(1);
    expect(code().trim()).toMatch(/^begin;/);
    expect(code()).toContain("set local lock_timeout = '5s';");
    expect(code().trim()).toMatch(/commit;$/);
  });
  it("every function is SECURITY DEFINER with a pinned empty search_path", () => {
    const fns = code().match(/create or replace function public\.\w+/g) ?? [];
    expect(fns.sort()).toEqual([
      "create or replace function public.has_studio_permission",
      "create or replace function public.has_studio_permission_for_target",
      "create or replace function public.perm_actor",
      "create or replace function public.perm_actor_of",
      "create or replace function public.perm_decide",
    ]);
    expect((code().match(/security definer/g) ?? []).length).toBe(fns.length);
    expect((code().match(/set search_path = ''/g) ?? []).length).toBe(fns.length);
  });
});

describe("0288 section 1: the explicit function", () => {
  it("takes no studio argument, derives the studio from the target, and uses no dynamic SQL", () => {
    const c = code();
    const sig = c.slice(c.indexOf("function public.has_studio_permission_for_target("), c.indexOf("returns boolean", c.indexOf("function public.has_studio_permission_for_target(")));
    expect(sig).toMatch(/p_user uuid/);
    expect(sig).not.toMatch(/p_studio/);
    expect(c).not.toMatch(/\bexecute\s+(format|'|\$)/i);
    expect(c).not.toMatch(/\bformat\(/i);
  });
  it("is closed over four target kinds and answers false for anything else", () => {
    const c = code();
    for (const k of ["appointment", "session", "attempt", "client"]) expect(c).toContain(`p_target_kind = '${k}'`);
    expect(c).toMatch(/else\s+return false;/);
  });
  it("is service_role only: every function revoked from public, anon, authenticated AND service_role by name, one grant", () => {
    const c = code();
    expect(c).toContain("revoke all on function public.has_studio_permission_for_target(uuid, text, text, uuid) from public, anon, authenticated, service_role;");
    expect(c).toContain("revoke all on function public.perm_actor_of(uuid, uuid) from public, anon, authenticated, service_role;");
    expect(c).toContain("revoke all on function public.perm_decide(uuid, text, uuid, text, uuid, uuid, uuid) from public, anon, authenticated, service_role;");
    const grants = c.match(/grant execute on function[^;]*;/g) ?? [];
    expect(grants).toEqual(["grant execute on function public.has_studio_permission_for_target(uuid, text, text, uuid) to service_role;"]);
  });
});

describe("0288 section 1: one implementation", () => {
  it("has_studio_permission and the explicit function both delegate the decision to perm_decide, and perm_actor to perm_actor_of", () => {
    const c = code();
    expect((c.match(/public\.perm_decide\(/g) ?? []).length).toBeGreaterThanOrEqual(3); // definition + two callers
    expect(c).toContain("public.perm_actor_of(p_studio, auth.uid())");
    expect(c).toContain("public.perm_actor_of(v_studio, p_user)");
    // The decision logic lives in perm_decide only: neither entry point reads the catalog or the appointments itself.
    const pub = c.slice(c.indexOf("function public.has_studio_permission("), c.indexOf("function public.has_studio_permission_for_target"));
    expect(pub).not.toMatch(/permission_catalog|perm_effective_scope/);
  });
  it("keeps has_studio_permission's 0287 signature, so its ACL is kept (create or replace)", () => {
    const base = readFileSync(`supabase/migrations/${fileForVersion("0287")}`, "utf8");
    expect(base).toMatch(/function public\.has_studio_permission\(\s*p_studio uuid,\s*p_key text,\s*p_client uuid default null,\s*p_appointment uuid default null,\s*p_practitioner uuid default null\s*\)/);
    expect(code()).toMatch(/function public\.has_studio_permission\(\s*p_studio uuid,\s*p_key text,\s*p_client uuid default null,\s*p_appointment uuid default null,\s*p_practitioner uuid default null\s*\)/);
  });
  it("edits no earlier migration", () => {
    expect(countVersion("0287")).toBe(1);
  });
});
