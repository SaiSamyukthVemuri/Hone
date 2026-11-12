import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0332 corrects one helper of the APPLIED migration 0287 by create-or-replace. 0287's bytes stay frozen; 0331 is not edited.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0332")}`, "utf8");
const code = () => sql().replace(/--.*$/gm, "");

describe("0332 activation hash includes the ship gates (source)", () => {
  it("exists exactly once", () => {
    expect(countVersion("0332")).toBe(1);
  });
  it("0287 is byte-identical to the applied version (f302e7ba…)", () => {
    expect(createHash("sha256").update(readFileSync("supabase/migrations/0287_roles_permission_engine.sql")).digest("hex").startsWith("f302e7ba")).toBe(true);
  });
  it("opens its own begin/commit with set local lock_timeout inside", () => {
    expect(code()).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
    expect(code().trim().endsWith("commit;")).toBe(true);
  });
  it("replaces exactly perm_activation_hash and nothing else; restates the revoke; grants nothing", () => {
    const creates = [...code().matchAll(/create (?:or replace )?(\w+(?: \w+)?) (?:public\.)?(\w+)/gi)].map((m) => `${m[1]} ${m[2]}`.toLowerCase());
    expect(creates).toEqual(["function perm_activation_hash"]);
    expect(code()).not.toMatch(/\b(create table|alter table|drop |insert into|update public|delete from|create policy|create trigger)\b/i);
    expect(code()).toContain("revoke all on function public.perm_activation_hash(uuid, text[]) from public, anon, authenticated, service_role;");
    expect(code()).not.toMatch(/\bgrant\b/i);
  });
  it("the fingerprint reads both gate columns of the catalog and the studio's gate state, absent = not met", () => {
    expect(code()).toMatch(/c\.gate_practitioner, c\.gate_receptionist/);
    expect(code()).toMatch(/permission_ship_gates g\s+where g\.studio_id = p_studio and g\.gate = gt\.gate\), false\)/);
  });
});
