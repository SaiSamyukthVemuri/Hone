import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { chainProblems, parseFingerprint } from "../../scripts/db-baseline/verify.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { ACL_SQL, EXTENSIONS_SQL, FINGERPRINT_SQL, TRIGGERS_SQL } from "../../scripts/db-baseline/sql.mjs";

const cli = readFileSync(path.join(process.cwd(), "scripts/db-baseline/cli.mjs"), "utf8");
const guardSrc = readFileSync(path.join(process.cwd(), "scripts/db-baseline/guard.mjs"), "utf8");
const keySrc = readFileSync(path.join(process.cwd(), "scripts/db-baseline/key.mjs"), "utf8");
const readme = readFileSync(path.join(process.cwd(), "scripts/db-baseline/README.md"), "utf8");

describe("the restore path is the strict one", () => {
  it("restores with --no-acl and replays explicit grants, so the target's default privileges can never add access", () => {
    expect(cli).toMatch(/"--no-acl"/);
    expect(cli).toMatch(/acl\.sql/);
  });

  it("any restore error is fatal, in one transaction", () => {
    expect(cli).toMatch(/"-1", "--exit-on-error"/);
  });

  it("a restore that does not match its fingerprints clears the database and exits non-zero", () => {
    expect(cli).toMatch(/restore REFUSED/);
    expect(cli).toMatch(/wipe\(\);\s*\n\s*fail\(`restore REFUSED/);
  });

  it("verifies against BOTH the chain fingerprint and the sealed verification restore", () => {
    expect(cli).toMatch(/chainProblems\(/);
    expect(cli).toMatch(/drift\(/);
  });

  it("only ever addresses a local stack's database container", () => {
    expect(cli).not.toMatch(/linked|--db-url|supabase\.co|db execute/);
    expect(guardSrc).toMatch(/\^supabase_db_/);
  });

  it("the ownership guard runs before anything is dropped, and a failed restore verification clears the stack", () => {
    for (const cmd of ["seal", "restore"]) {
      const at = cli.indexOf(`cmd === "${cmd}"`);
      expect(at).toBeGreaterThan(-1);
      expect(cli.slice(at).indexOf("need({ destructive: true })")).toBeGreaterThan(-1);
      expect(cli.slice(at).indexOf("need({ destructive: true })")).toBeLessThan(cli.slice(at).indexOf("restoreInto("));
    }
    expect(cli).toMatch(/restore is DESTRUCTIVE/);
  });

  it("build checks the data is synthetic before it caches anything", () => {
    const at = cli.indexOf('cmd === "build"');
    expect(cli.slice(at).indexOf("syntheticProblems(")).toBeLessThan(cli.slice(at).indexOf('"baseline.dump"'));
  });

  it("no private path is named in the scripts or the README", () => {
    expect(cli + guardSrc + keySrc + readme).not.toMatch(/\/srv\/|\/home\//);
  });
});

describe("the fingerprint compares effective ACLs, not their spelling", () => {
  it("every ACL fact is a SORTED set of (grantee, privilege, grantable) tuples from aclexplode, with the object's default for a NULL acl, so order and NULL-versus-explicit-default cannot cause a false refusal (Codex P1 r4621516265)", () => {
    // No category may serialise a raw ACL array any more.
    expect(FINGERPRINT_SQL).not.toMatch(/(relacl|proacl|nspacl|typacl|attacl|defaclacl)::text/);
    expect(FINGERPRINT_SQL).not.toMatch(/coalesce\([a-z]\.(relacl|proacl|nspacl|typacl)::text/);
    for (const col of ["relacl", "proacl", "nspacl", "typacl", "attacl", "defaclacl"]) {
      expect(FINGERPRINT_SQL, col).toMatch(new RegExp(`aclexplode\\([^)]*${col}`));
    }
    expect(FINGERPRINT_SQL).toMatch(/string_agg\([^]*? order by /);
    // NULL means the object's default for its kind: tables/sequences, functions, schemas, types.
    for (const kind of ["'f'", "'n'", "'T'"]) expect(FINGERPRINT_SQL).toContain(`acldefault(${kind},`);
    expect(FINGERPRINT_SQL).toMatch(/acldefault\(\(case when c\.relkind='S'/);
  });

  it("each serialised item carries the grantee, the privilege AND the grantable marker (dropping the grant option or the grantee must fail this test)", () => {
    const n = (FINGERPRINT_SQL.match(/string_agg\(/g) ?? []).length;
    expect(n).toBeGreaterThan(8);
    // one grantee term, one privilege term and one grantable marker per aggregate, in the item AND in its ordering.
    expect((FINGERPRINT_SQL.match(/coalesce\(nullif\(ax\.grantee::regrole::text,'-'\),'PUBLIC'\) \|\| '=' \|\| ax\.privilege_type \|\| case when ax\.is_grantable then '\*' else '' end/g) ?? []).length).toBe(n);
    expect((FINGERPRINT_SQL.match(/order by coalesce\(nullif\(ax\.grantee::regrole::text,'-'\),'PUBLIC'\), ax\.privilege_type, ax\.is_grantable\)/g) ?? []).length).toBe(n);
  });

  it("a restore that differs ONLY in the grantee, or ONLY in the grant option, is refused (the comparison is on content)", () => {
    const chain = parseFingerprint("grants:rel|t|authenticated=SELECT,postgres=DELETE|postgres");
    const onlyGrantee = parseFingerprint("grants:rel|t|anon=SELECT,postgres=DELETE|postgres");
    const onlyOption = parseFingerprint("grants:rel|t|authenticated=SELECT*,postgres=DELETE|postgres");
    const same = parseFingerprint("grants:rel|t|authenticated=SELECT,postgres=DELETE|postgres");
    expect(chainProblems(chain, same)).toEqual([]);
    expect(chainProblems(chain, onlyGrantee).join("\n")).toMatch(/EXTRA GRANT/);
    expect(chainProblems(chain, onlyOption).join("\n")).toMatch(/EXTRA GRANT/);
  });

  it("the extra-grant control still bites: a tuple the chain lacks is reported by name", () => {
    const chain = ["grants:rel|t|authenticated=SELECT,postgres=DELETE|postgres"].join("\n");
    const restored = ["grants:rel|t|PUBLIC=SELECT,authenticated=SELECT,postgres=DELETE|postgres"].join("\n");
    const problems = chainProblems(parseFingerprint(chain), parseFingerprint(restored));
    expect(problems.join("\n")).toMatch(/EXTRA GRANT/);
  });
});

describe("the fingerprint is one line per fact", () => {
  it("every category collapses whitespace, because a column default or constraint expression can span lines (a continuation line is not a fact)", () => {
    // Found on the first stack run: a multi-line value parsed as a category-less line ("CASE").
    for (const cat of ["migrations", "catalog", "grants", "platform", "extensions", "outside", "data"]) {
      const at = FINGERPRINT_SQL.indexOf(`'${cat}:'`);
      expect(at, cat).toBeGreaterThan(-1);
      expect(FINGERPRINT_SQL.slice(at, at + 160), cat).toContain("regexp_replace(");
    }
  });
});

describe("the generated replays cover what pg_dump does not carry", () => {
  it("ACLs: every object is revoked from everyone first, then granted exactly the chain's, from aclexplode", () => {
    expect(ACL_SQL).toMatch(/aclexplode/);
    expect(ACL_SQL).toMatch(/acldefault/);
    expect(ACL_SQL.indexOf("revoke all on")).toBeGreaterThan(-1);
    for (const kind of ["'TABLE'", "'SEQUENCE'", "'ROUTINE'", "'SCHEMA'", "'DOMAIN'", "'TYPE'"]) expect(ACL_SQL).toContain(kind);
    expect(ACL_SQL).toContain("supabase_migrations.%I"); // the migration history's own tables
    expect(ACL_SQL).toMatch(/revoke all \(%I\)/); // column ACLs
    expect(ACL_SQL).toMatch(/alter default privileges for role/);
  });

  it("extensions are created before the dump is loaded, and triggers on auth are replayed", () => {
    expect(EXTENSIONS_SQL).toMatch(/create extension if not exists/);
    expect(TRIGGERS_SQL).toMatch(/pg_get_triggerdef/);
    // The platform's own triggers already exist on a stack: a plain CREATE TRIGGER failed the first seal on realtime.subscription.
    expect(TRIGGERS_SQL).toMatch(/CREATE OR REPLACE TRIGGER/);
    expect(TRIGGERS_SQL).toMatch(/tgconstraint = 0/);
    expect(TRIGGERS_SQL).toMatch(/'auth'/);
    expect(cli.indexOf("extensions.sql")).toBeLessThan(cli.indexOf('"pg_restore", "-U"'));
  });
});
