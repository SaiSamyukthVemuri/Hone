import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRepoMax } from "./helpers/migration-state";

// 0355 is a forward redefinition of perm_run_changes (0287 is applied and frozen). Source contract: the rollback restores the HOSTED body byte for
// byte, the up body differs from it only in the listed lines, and the migration carries its own transaction and lock timeout.

const UP = readFileSync("supabase/migrations/0355_roles_save_inert_denial.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0355_roles_save_inert_denial.down.sql", "utf8");
const OLD = readFileSync("supabase/migrations/0287_roles_permission_engine.sql", "utf8");
const HOSTED_BODY_MD5 = "7d8924fbb394838f60d9e6cf89235e82"; // c04_function-bodies of the 0287 apply record, perm_run_changes

const bodyOf = (sql: string) => {
  const from = sql.indexOf("create or replace function public.perm_run_changes(");
  const open = sql.indexOf("as $$", from) + "as $$".length;
  return sql.slice(open, sql.indexOf("$$;", open));
};
const headOf = (sql: string) => sql.slice(sql.indexOf("create or replace function public.perm_run_changes("), sql.indexOf("as $$", sql.indexOf("create or replace function public.perm_run_changes(")));

describe("0355 source contract", () => {
  it("is the current maximum migration (only the max may assert this)", () => {
    expect(isRepoMax("0355")).toBe(true);
  });

  it("opens its own transaction with a lock timeout inside it", () => {
    expect(UP).toMatch(/^begin;\s*\nset local lock_timeout = '5s';/m);
    expect(UP.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("the 0287 body is the hosted body (md5 from the apply record), and the rollback restores it exactly", () => {
    expect(createHash("md5").update(bodyOf(OLD)).digest("hex")).toBe(HOSTED_BODY_MD5);
    expect(createHash("md5").update(bodyOf(DOWN)).digest("hex")).toBe(HOSTED_BODY_MD5);
  });

  it("keeps the 0287 signature, language, volatility, security setting and search_path", () => {
    expect(headOf(UP)).toBe(headOf(OLD));
  });

  it("changes the body in exactly three places: declarations, the basis read, and the apply condition", () => {
    const before = bodyOf(OLD).split("\n");
    const after = bodyOf(UP).split("\n");
    const removed = before.filter((l) => !after.includes(l));
    const added = after.filter((l) => !before.includes(l));
    expect(removed.map((l) => l.trim())).toEqual([
      "if v_scope <> v_base or (v_stored_prev is not null and v_stored_prev <> v_scope) then",
      "v_apply := v_apply || jsonb_build_array(jsonb_build_object('role', v_role, 'key', v_key, 'scope', v_scope, 'base', coalesce(v_stored_prev, v_base)));",
    ]);
    expect(added.some((l) => l.includes("or v_scope <> v_shown then"))).toBe(true);
    // the condition is ADDITIVE: the old test is still a disjunct
    expect(bodyOf(UP)).toContain("v_scope <> v_base or (v_stored_prev is not null and v_stored_prev <> v_scope) or v_scope <> v_shown");
    // access resolution is not touched
    expect(UP).not.toMatch(/create or replace function public\.perm_(base_scope|effective_scope|scope_source)/);
  });

  it("its only write to the permission tables is the same single insert as 0287's perm_run_changes", () => {
    const writes = (sql: string) => (sql.match(/(insert\s+into|update|delete\s+from)\s+(public\.)?(studio_role_permissions|permission_key_activation|permission_key_release)\b/g) ?? []).length;
    expect(writes(bodyOf(UP))).toBe(writes(bodyOf(OLD)));
    expect(writes(UP.replace(bodyOf(UP), ""))).toBe(0);
  });
});
