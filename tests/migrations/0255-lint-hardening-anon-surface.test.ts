import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0255_lint_hardening_anon_surface.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

describe("0255 LINT hardening: shape and boundaries", () => {
  it("uses its reserved filename once, in one bounded transaction", () => {
    expect(countVersion("0255")).toBe(1);
    expect(fileForVersion("0255")).toBe("0255_lint_hardening_anon_surface.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
  });

  it("pins search_path on exactly the 13 advisor functions, by ALTER, never by redefining a body", () => {
    const alters = [...code.matchAll(/alter function public\.(\w+)\(\) set search_path = pg_catalog, pg_temp;/g)].map((m) => m[1]);
    expect(alters).toHaveLength(13);
    expect(new Set(alters).size).toBe(13);
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(code).not.toMatch(/drop\s+function/i);
  });

  it("revokes by name, never schema-wide or ALL FUNCTIONS, and never touches service_role", () => {
    expect(code).not.toMatch(/all\s+functions/i);
    for (const m of code.matchAll(/revoke execute on function [^;]+;/gi)) {
      expect(m[0]).not.toMatch(/service_role/);
      expect(m[0]).toMatch(/function public\.\w+\(/);
    }
  });

  it("leaves the platform and Sam-owned rows alone", () => {
    expect(code).not.toMatch(/rls_auto_enable/);
    expect(code).not.toMatch(/btree_gist|create\s+extension|alter\s+extension/i);
    expect(code).not.toMatch(/ensure_rls/);
  });

  it("retargets predicate policies before revoking anon, and aborts rather than rewriting an anon-named policy", () => {
    expect(code.indexOf("alter policy %I on %I.%I to authenticated")).toBeGreaterThan(-1);
    expect(code.indexOf("alter policy")).toBeLessThan(code.indexOf("revoke execute on function public.is_studio_member(uuid) from public, anon;"));
    expect(code).toContain("names anon and calls an RLS predicate");
  });

  it("keeps the two marketing forms insert-only and adds NOT VALID constraints (no scan of existing rows)", () => {
    expect(code).toContain("grant insert on table public.waitlist to anon, authenticated;");
    expect(code).toContain("grant insert on table public.demo_requests to anon, authenticated;");
    expect(code).not.toMatch(/grant\s+(select|update|delete|all)\b/i);
    expect([...code.matchAll(/\) not valid/g)]).toHaveLength(4);
    expect(code).not.toMatch(/validate\s+constraint/i);
    expect(code).not.toMatch(/with check \(true\)/i);
  });

  it("the two form actions insert without RETURNING, because anon holds no SELECT after 0255", () => {
    for (const file of ["app/actions/waitlist.ts", "app/actions/demo.ts"]) {
      const src = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
      const insert = src.slice(src.indexOf(".insert("));
      const statement = insert.slice(0, insert.indexOf(";"));
      expect(statement, file).toContain(".insert(");
      expect(statement, file).not.toMatch(/\.select\(|\.upsert\(|onConflict|\.single\(|\.maybeSingle\(/);
    }
  });

  it("the admin console reads both tables with the service-role client, never the session client", () => {
    const page = readFileSync("app/admin/page.tsx", "utf8");
    expect(page).toMatch(/admin\s*\.from\("waitlist"\)/);
    expect(page).toMatch(/admin\s*\.from\("demo_requests"\)/);
    const actions = readFileSync("app/admin/actions.ts", "utf8");
    expect(actions).toMatch(/admin\s*\.from\("demo_requests"\)/);
    expect(actions).toContain("createAdminClient()");
  });
});
