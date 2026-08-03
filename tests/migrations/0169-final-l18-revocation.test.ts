import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// L18 FINAL — migration 0169 source contract.
//
// This is a privilege CUTOVER, so the contract is mostly about what the file
// must NOT contain. Everything asserted here is a byte-level property of the
// migration; behaviour lives in tests/db/l18-final-revocation.db.test.ts.
// ===========================================================================

const FILE = "supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql";
const SQL = readFileSync(FILE, "utf8");
const FLAT = SQL.replace(/\s+/g, " ");
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const CODE_FLAT = CODE.replace(/\s+/g, " ");

const TABLES = [
  "sessions",
  "session_blocks",
  "session_block_areas",
  "electrolysis_entries",
  "laser_entries",
  "treatment_images",
] as const;

describe("0169 — migration state", () => {
  it("is the current repository maximum", () => {
    expect(isRepoMax("0169")).toBe(true);
    expect(versionsAbove("0169")).toEqual([]);
  });
});

describe("0169 — exactly six authenticated table revocations", () => {
  it("revokes INSERT, UPDATE and DELETE on each of the six tables, by name", () => {
    for (const t of TABLES) {
      expect(SQL, `${t} must be revoked`).toContain(
        `revoke insert, update, delete on table public.${t} from authenticated;`,
      );
    }
  });

  it("contains exactly six REVOKE statements and no more", () => {
    const revokes = CODE.match(/^revoke /gm) ?? [];
    expect(revokes).toHaveLength(6);
  });

  it("every revocation names all three privileges", () => {
    for (const line of (CODE.match(/^revoke [^;]+;/gm) ?? [])) {
      expect(line, line).toMatch(/insert/);
      expect(line, line).toMatch(/update/);
      expect(line, line).toMatch(/delete/);
    }
  });

  it("targets ONLY the six clinical tables", () => {
    const targets = [...CODE.matchAll(/on table public\.(\w+)/g)].map((m) => m[1]).sort();
    expect(targets).toEqual([...TABLES].sort());
  });

  it("never uses REVOKE ALL", () => {
    // REVOKE ALL would take SELECT with it and would silently absorb any future
    // privilege type instead of naming the three this cutover is about.
    expect(CODE_FLAT).not.toMatch(/revoke\s+all/i);
  });

  it("never revokes SELECT", () => {
    for (const line of (CODE.match(/^revoke [^;]+;/gm) ?? [])) {
      expect(line, line).not.toMatch(/select/i);
    }
    expect(CODE_FLAT).not.toMatch(/revoke[^;]*select/i);
  });
});

describe("0169 — touches nothing else", () => {
  it("mutates no other role's privileges", () => {
    // Match the GRANTEE position only — `public.` in `on table public.x` is a
    // schema qualifier, not a role, and must not be mistaken for one.
    for (const role of ["service_role", "anon", "public"]) {
      expect(CODE_FLAT, `${role} must not be a grantee`).not.toMatch(
        new RegExp(`(from|to)\\s+${role}\\s*;`, "i"),
      );
    }
    // Every revocation targets `authenticated`.
    const froms = [...CODE.matchAll(/from (\w+);/g)].map((m) => m[1]);
    expect(new Set(froms)).toEqual(new Set(["authenticated"]));
  });

  it("contains NO grant statement at all", () => {
    expect(CODE_FLAT).not.toMatch(/\bgrant\b/i);
  });

  it("revokes no function EXECUTE", () => {
    expect(CODE_FLAT).not.toMatch(/on function/i);
    expect(CODE_FLAT).not.toMatch(/execute/i);
  });

  it("makes no policy, trigger, table, column, index or ownership change", () => {
    for (const forbidden of [
      /create table/i,
      /alter table/i,
      /drop table/i,
      /create trigger/i,
      /drop trigger/i,
      /alter trigger/i,
      /create policy/i,
      /drop policy/i,
      /alter policy/i,
      /create index/i,
      /drop index/i,
      /owner to/i,
      /create or replace function/i,
      /drop function/i,
    ]) {
      expect(CODE_FLAT, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("changes no data", () => {
    for (const forbidden of [/\binsert into\b/i, /\bupdate .* set\b/i, /\bdelete from\b/i, /\btruncate\b/i]) {
      expect(CODE_FLAT, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("opens its own transaction with an armed lock_timeout", () => {
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/^set local lock_timeout/m);
    expect(SQL).toMatch(/^commit;/m);
  });

  it("documents the session_block_areas no-op and the rollback path", () => {
    const prose = SQL.split("\n").filter((l) => l.trimStart().startsWith("--")).join(" ");
    expect(prose).toMatch(/NO-OP/i);
    expect(prose).toMatch(/session_block_areas/);
    expect(prose).toMatch(/ROLLBACK/i);
    expect(prose).toMatch(/SELECT is RETAINED/i);
  });
});

describe("0169 — the writer census it depends on is still zero", () => {
  // The revocation is only safe because no runtime code writes these tables.
  // If a writer ever comes back, this fails BEFORE the privilege change ships.
  const ROOTS = ["app", "lib", "components"];

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${name.name}`;
        if (name.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name.name)) out.push(p);
      }
    };
    for (const r of ROOTS) walk(r);
    return out;
  }

  function writerCount(table: string): number {
    let n = 0;
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      const re = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        let i = m.index + m[0].length;
        let depth = 0;
        let chain = "";
        while (i < src.length) {
          const ch = src[i];
          if ("([{".includes(ch)) depth++;
          else if (")]}".includes(ch)) depth--;
          else if (ch === ";" && depth <= 0) break;
          chain += ch;
          i++;
        }
        if (/\.(insert|update|delete|upsert)\s*\(/.test(chain)) n++;
      }
    }
    return n;
  }

  for (const t of TABLES) {
    it(`${t} has zero runtime direct writers`, () => {
      expect(writerCount(t)).toBe(0);
    });
  }

  it("the writer-guard exception list is still empty", () => {
    const guard = readFileSync("tests/security/entry-direct-dml-guard.test.ts", "utf8");
    expect(guard).toMatch(
      /const EXCEPTIONS: ReadonlyArray<\{ file: string; fn: string \}> = \[\];/,
    );
  });
});
