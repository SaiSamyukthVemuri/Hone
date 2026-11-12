import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0331 corrects two helpers of the APPLIED migration 0287 by create-or-replace. 0287's bytes stay frozen.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0331")}`, "utf8");
const code = () => sql().replace(/--.*$/gm, "");

describe("0331 stored denial before default (source)", () => {
  it("exists exactly once (0332 is the repo maximum now; only the maximum asserts isRepoMax)", () => {
    expect(countVersion("0331")).toBe(1);
  });
  it("0287 is byte-identical to the applied version (f302e7ba…), so the correction can only be forward", () => {
    const h = createHash("sha256").update(readFileSync("supabase/migrations/0287_roles_permission_engine.sql")).digest("hex");
    expect(h.startsWith("f302e7ba")).toBe(true);
  });
  it("opens its own begin/commit with set local lock_timeout inside", () => {
    expect(code()).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
    expect(code().trim().endsWith("commit;")).toBe(true);
  });
  it("replaces exactly perm_base_scope and perm_scope_source and nothing else", () => {
    const creates = [...code().matchAll(/create (?:or replace )?(\w+(?: \w+)?) (?:public\.)?(\w+)/gi)].map((m) => `${m[1]} ${m[2]}`.toLowerCase());
    expect(creates).toEqual(["function perm_base_scope", "function perm_scope_source"]);
    expect(code()).not.toMatch(/\b(create table|alter table|drop |insert into|update public|delete from|create policy|create trigger)\b/i);
  });
  it("revokes both from public, anon, authenticated and service_role by name and grants nothing", () => {
    for (const fn of ["perm_base_scope", "perm_scope_source"]) {
      expect(code()).toContain(`revoke all on function public.${fn}(uuid, text, text) from public, anon, authenticated, service_role;`);
    }
    expect(code()).not.toMatch(/\bgrant\b/i);
  });
  it("applies a stored denial against the new-studio default, in both helpers", () => {
    expect(code()).toMatch(/if v_stored is not null and public\.perm_rank\(v_stored\) < public\.perm_rank\(v_cand\) then return v_stored; end if;/);
    expect(code()).toMatch(/v_basis = 'new_studio' and v_basis_at >= v_rel\.released_at and public\.perm_rank\(v_stored\) < public\.perm_rank\(v_cand\)/);
  });
});
