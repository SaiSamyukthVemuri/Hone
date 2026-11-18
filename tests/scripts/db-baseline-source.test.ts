import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { ACL_SQL, EXTENSIONS_SQL, TRIGGERS_SQL } from "../../scripts/db-baseline/sql.mjs";

const cli = readFileSync(path.join(process.cwd(), "scripts/db-baseline/cli.mjs"), "utf8");

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
    expect(cli).toMatch(/\^supabase_db_/);
    expect(cli).not.toMatch(/linked|--db-url|supabase\.co|db execute/);
  });
});

describe("the generated replays cover what pg_dump does not carry", () => {
  it("ACLs: every object is revoked from everyone first, then granted exactly the chain's, from aclexplode", () => {
    expect(ACL_SQL).toMatch(/aclexplode/);
    expect(ACL_SQL).toMatch(/acldefault/);
    expect(ACL_SQL.indexOf("revoke all on")).toBeGreaterThan(-1);
    for (const kind of ["'TABLE'", "'SEQUENCE'", "'ROUTINE'", "'SCHEMA'"]) expect(ACL_SQL).toContain(kind);
    expect(ACL_SQL).toMatch(/revoke all \(%I\)/); // column ACLs
    expect(ACL_SQL).toMatch(/alter default privileges for role/);
  });

  it("extensions are created before the dump is loaded, and triggers on auth are replayed", () => {
    expect(EXTENSIONS_SQL).toMatch(/create extension if not exists/);
    expect(TRIGGERS_SQL).toMatch(/pg_get_triggerdef/);
    expect(TRIGGERS_SQL).toMatch(/'auth'/);
    expect(cli.indexOf("extensions.sql")).toBeLessThan(cli.indexOf('"pg_restore", "-U"'));
  });
});
