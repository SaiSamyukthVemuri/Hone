import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0248_intake_protected_write_enforcement.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const additive = readFileSync("supabase/migrations/0243_intake_revision_cas_and_profile_sync.sql", "utf8").replace(/^\s*--.*$/gm, "");
const guard = code.slice(code.indexOf("create or replace function public.advance_intake_revision"), code.indexOf("do $$"));

describe("0248 separately gated protected intake enforcement", () => {
  it("uses its sole OPS allocation without inventing the held0247 dependency", () => {
    expect(countVersion("0248")).toBe(1);
    expect(fileForVersion("0248")).toBe("0248_intake_protected_write_enforcement.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code.trim()).toMatch(/commit;$/);
    expect(code).toContain("set local lock_timeout = '5s'");
    expect(code).not.toMatch(/(?:alter|create) table|create trigger|grant\s|revoke\s|drop\s/i);
  });
  it("replaces only the existing invoker guard, retaining metadata and revision semantics", () => {
    expect(code.match(/create or replace function/g)).toHaveLength(1);
    expect(guard).toContain("security invoker set search_path = ''");
    expect(guard).toContain("current_user is distinct from pg_catalog.pg_get_userbyid(v_writer_owner)");
    expect(guard).toContain("public.write_intake_revision(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.int8,pg_catalog.jsonb,pg_catalog.int4,pg_catalog.text,pg_catalog.jsonb)");
    for (const field of ["responses", "current_step", "submitted_at", "status"]) expect(guard).toContain(`new.${field} is distinct from old.${field}`);
    expect(guard).toContain("old.status = 'submitted' and new.status = 'reviewed'");
    expect(guard).toContain("new.revision := old.revision + 1");
    expect(guard).not.toMatch(/current_setting|session_user|pg_trigger_depth|auth\.uid/);
  });
  it("revalidates the complete reviewed owner, delegate and non-grantable ACL at closure", () => {
    // Exact same preflight must run AGAIN at closure, not rely on older setup.
    expect(code.slice(code.indexOf("do $$"), code.lastIndexOf("commit;"))).toBe(
      additive.slice(additive.lastIndexOf("do $$"), additive.lastIndexOf("commit;")),
    );
    expect(code).toContain("a.grantee <> p.proowner and a.is_grantable");
    expect(code).toContain("a.grantee <> v_owner and a.is_grantable");
    expect(code).toContain("helper.proowner = p.proowner and helper.prosecdef");
    expect(code).toContain("pg_catalog.pg_has_role(v_role.oid, v_owner, 'SET')");
    expect(code).toContain(") is not true");
  });
});
