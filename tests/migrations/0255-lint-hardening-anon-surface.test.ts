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

  it("asserts the form policies by catalog at apply time, and refuses to retarget a restrictive policy (Privacy F1, F3)", () => {
    expect(code).toContain("exactly one INSERT-capable policy");
    expect(code).toContain("still has a permissive always-true INSERT policy");
    expect(code).toContain("read, update or delete policy applying to a browser role");
    expect(code).toContain("not v_pol.polpermissive");
    expect(code).toContain("pol.polpermissive");
  });

  it("is re-runnable: constraints are dropped if present before they are added", () => {
    expect([...code.matchAll(/drop constraint if exists/g)]).toHaveLength(4);
  });
});

// Privacy PEER-1128 F2/F5: the operator preflight and validate scripts.
const norm = (text: string) => text.replace(/\s+/g, " ").trim();
const preflight = readFileSync("supabase/preflight/0255-lint-hardening.preflight.sql", "utf8");
const validate = readFileSync("supabase/preflight/0255-lint-hardening.validate.sql", "utf8");
const pre = preflight.replace(/^\s*--.*$/gm, "");
const val = validate.replace(/^\s*--.*$/gm, "");

describe("0255 S1 preflight and validate scripts", () => {
  const constraints = [...code.matchAll(/add constraint (\w+)\s+check \(([\s\S]*?)\) not valid/g)].map((m) => [m[1], norm(m[2])]);

  it("reads the same four constraint expressions the migration adds, so the two cannot drift", () => {
    expect(constraints.map(([n]) => n).sort()).toEqual([
      "demo_requests_email_format_chk",
      "demo_requests_field_length_chk",
      "waitlist_email_format_chk",
      "waitlist_field_length_chk",
    ]);
    for (const [name, expression] of constraints) {
      expect(norm(pre), `preflight ${name}`).toContain(`(${expression}) is false`);
      expect(norm(val), `validate ${name}`).toContain(expression);
    }
  });

  it("the preflight is read-only: SELECT statements only, and only counts from the two form tables", () => {
    const statements = pre.split(";").map((x) => x.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThanOrEqual(7);
    for (const statement of statements) expect(statement).toMatch(/^select\b/i);
    expect(pre).not.toMatch(/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|copy)\b/i);
    for (const statement of statements.filter((x) => /from public\.(waitlist|demo_requests)\b/.test(x))) {
      expect(statement).toMatch(/^select '\w+' as constraint_name, count\(\*\) as violating_rows\s+from public\.(waitlist|demo_requests)\s+where/);
    }
  });

  it("the preflight lists all 21 functions, their owner, definer flag, config and ACL, and the BYPASSRLS flag of every grantee", () => {
    const sigs = [...pre.matchAll(/'(public\.\w+\([a-z]*\))'/g)].map((m) => m[1]);
    expect(new Set(sigs).size).toBe(21);
    for (const field of ["proowner", "prosecdef", "proconfig", "proacl", "rolbypassrls"]) expect(pre).toContain(field);
    for (const table of ["waitlist", "demo_requests", "studio_timed_blocks", "payment_charge_attempts"]) expect(pre).toContain(`'${table}'`);
    expect(pre).toContain("pg_policy");
  });

  it("the preflight's function list is exactly the functions the migration alters or revokes", () => {
    const alters = [...code.matchAll(/alter function (public\.\w+\(\)) set search_path/g)].map((m) => m[1]);
    const revokes = [...code.matchAll(/revoke execute on function (public\.\w+\([a-z]*\)) from/g)].map((m) => m[1]);
    const sigs = [...pre.matchAll(/'(public\.\w+\([a-z]*\))'/g)].map((m) => m[1]);
    expect([...new Set([...alters, ...revokes])].sort()).toEqual([...sigs].sort());
  });

  it("the validate script validates only what has zero violations and never aborts or deletes", () => {
    expect(val).toMatch(/begin;/);
    expect(val).toContain("set local lock_timeout = '5s';");
    expect(val).toMatch(/commit;\s*$/);
    expect(val).toContain("is false");
    expect(val).toMatch(/if v_n = 0 then[\s\S]*validate constraint[\s\S]*else[\s\S]*raise warning/);
    expect(val).not.toMatch(/\b(delete|update|insert|drop|truncate)\b/i);
  });
});
