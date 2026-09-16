import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0150_single_row_schedule_writers_locked.sql"),
  "utf8",
);

const COMMANDS = [
  "lock_studio_and_assert_owner",
  "validate_schedule_scope",
  "upsert_availability_day_locked",
  "delete_availability_day_locked",
  "upsert_availability_override_locked",
  "delete_availability_override_locked",
  "set_service_practitioner_eligibility_locked",
  "set_practitioner_active_locked",
];

describe("0150 — single-row schedule writers locked", () => {
  it("defines every command as SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of COMMANDS) {
      expect(SQL).toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
    expect((SQL.match(/security definer/g) ?? []).length).toBe(COMMANDS.length);
    expect((SQL.match(/set search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(COMMANDS.length);
  });
  it("the shared preamble takes the lock order: studios row FOR UPDATE, then advisory", () => {
    const rowLock = SQL.indexOf("from public.studios s where s.id = p_studio_id for update");
    const advisory = SQL.indexOf("acquire_studio_capacity_lock");
    expect(rowLock).toBeGreaterThan(0);
    expect(advisory).toBeGreaterThan(rowLock);
    expect(SQL).toMatch(/v_role is distinct from 'owner'/); // active-owner assertion
  });
  it("scoped writes require capacity ON + an active same-studio target", () => {
    expect(SQL).toMatch(/studio_capacity_enabled\(p_studio_id\)/);
    expect(SQL).toMatch(/return 'capacity_disabled'/);
    expect(SQL).toMatch(/return 'invalid_practitioner'/);
  });
  it("the practitioner-active command cannot modify the owner and preserves appointments", () => {
    expect(SQL).toMatch(/return 'cannot_modify_owner'/);
    expect(SQL).toMatch(/set active = coalesce\(p_active, false\)/);
    // No appointment/reservation mutation in the deactivation path.
    expect(SQL).not.toMatch(/update public\.appointments/);
  });
  // -------------------------------------------------------------------------
  // ACL. (#705 P2-02.)
  //
  // This assertion used to read:
  //
  //   expect(SQL).toMatch(new RegExp(`revoke execute on function %s from ${role}`));
  //
  // with `%s` left unsubstituted, so it matched the literal format() TEMPLATE
  // inside the DO-block and could never fail. It proved only that the file
  // contains a loop of roughly that shape — never WHICH functions the loop
  // iterates. A ninth command added to this migration and omitted from the
  // array was undetectable, which is precisely the regression an ACL test
  // exists to catch.
  //
  // The repair reads the loop's actual signature array and compares it against
  // the functions the migration actually defines. Migration 0150 is frozen and
  // is not modified; only this test changed.
  // -------------------------------------------------------------------------

  /**
   * The ACTIVE signatures inside migration 0150's single `unnest(array[...])`.
   *
   * One left-to-right scan over ONE expression, carrying the four states that
   * decide whether a character is structural: line comment, block comment,
   * single-quoted string, or code. Each earlier revision of this helper fixed
   * one of those states in isolation and Codex found the next — a commented
   * entry still counted, then a block comment, then a bracket inside a literal.
   * They are not four bugs; they are one scanner that was missing, so it is
   * written once here.
   *
   * Consequently, INSIDE THIS EXPRESSION ONLY:
   *   - `--` to end of line contributes no signature and no bracket;
   *   - `/* ... *\/` contributes no signature and no bracket;
   *   - a quoted signature is consumed whole, so `[` or `]` in a type such as
   *     `smallint[]` never moves the array depth;
   *   - only brackets in code move the depth, so the array's end is found
   *     correctly even when a comment contains `]`.
   *
   * It stops at the matching `]`. Nothing outside the expression is read, and
   * no general SQL parsing happens: this lexes one array literal.
   */
  function activeArrayLiterals(): string[] {
    const open = SQL.indexOf("unnest(array[");
    expect(open, "0150 must still drive its ACL from unnest(array[...])").toBeGreaterThan(-1);
    // Exactly one, so "the array" is unambiguous.
    expect(SQL.indexOf("unnest(array[", open + 1)).toBe(-1);

    const start = SQL.indexOf("[", open);
    const literals: string[] = [];
    let i = start + 1;
    let depth = 1;

    while (i < SQL.length) {
      const two = SQL.slice(i, i + 2);

      if (two === "--") {
        const nl = SQL.indexOf("\n", i);
        i = nl === -1 ? SQL.length : nl + 1;
        continue;
      }
      if (two === "/*") {
        const close = SQL.indexOf("*/", i + 2);
        expect(close, "unterminated block comment inside 0150's revoke array").toBeGreaterThan(-1);
        i = close + 2;
        continue;
      }
      if (SQL[i] === "'") {
        let j = i + 1;
        let value = "";
        for (;;) {
          expect(j, "unterminated string inside 0150's revoke array").toBeLessThan(SQL.length);
          if (SQL[j] === "'") {
            if (SQL[j + 1] === "'") {
              value += "'"; // SQL's doubled-quote escape
              j += 2;
              continue;
            }
            j += 1;
            break;
          }
          value += SQL[j];
          j += 1;
        }
        literals.push(value);
        i = j;
        continue;
      }
      if (SQL[i] === "[") depth += 1;
      else if (SQL[i] === "]") {
        depth -= 1;
        if (depth === 0) return literals;
      }
      i += 1;
    }
    throw new Error("0150's unnest(array[...]) is unterminated");
  }

  /** The signatures the revoke loop actually iterates, by function name. */
  function revokeLoopFunctions(): string[] {
    return activeArrayLiterals()
      .map((lit) => /^public\.(\w+)\s*\(/.exec(lit)?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
  }

  /**
   * Every function the migration defines.
   *
   * Comment handling is LINE-LOCAL by design: a `create or replace function`
   * match is ignored when `--` precedes it on its own line. An earlier revision
   * stripped `--` across the whole file, which would corrupt a string literal
   * that legitimately contains a double hyphen. This looks only at the line the
   * match starts on and rewrites nothing.
   */
  function definedFunctions(): string[] {
    const out: string[] = [];
    for (const m of SQL.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi)) {
      const lineStart = SQL.lastIndexOf("\n", m.index!) + 1;
      const before = SQL.slice(lineStart, m.index!);
      if (before.includes("--")) continue; // commented-out declaration
      out.push(m[1]);
    }
    return out.sort();
  }

  it("the revoke loop covers EXACTLY the commands this migration defines", () => {
    // Adding a command without adding it to the array, or listing a command the
    // file does not define, fails here. This is the assertion the `%s` version
    // could not make.
    expect(revokeLoopFunctions()).toEqual(definedFunctions());
    expect(definedFunctions()).toEqual([...COMMANDS].sort());
  });

  it("the loop revokes every browser role and grants only service_role", () => {
    const block = /do\s*\$\$([\s\S]*?)\$\$/i.exec(SQL)![1];
    for (const role of ["public", "anon", "authenticated"]) {
      expect(
        block,
        `the loop must revoke EXECUTE from ${role}`,
      ).toMatch(new RegExp(`execute\\s+format\\('revoke execute on function %s from ${role}'`, "i"));
    }
    expect(block).toMatch(/execute\s+format\('grant execute on function %s to service_role'/i);
    // service_role is the ONLY role granted back.
    const grantedRoles = [...block.matchAll(/format\('grant execute on function %s to (\w+)'/gi)].map(
      (m) => m[1],
    );
    expect(grantedRoles).toEqual(["service_role"]);
  });

  it("the loop's array and the file's declarations cannot drift apart", () => {
    // The two halves of 0150's source contract, stated as one identity. A
    // command added to the file but not the array, or listed in the array but
    // never defined, fails here.
    //
    // This test is deliberately SELF-CONTAINED. Repo-wide final-ACL truth lives
    // in tests/db/rpc-acl-oracle.db.test.ts, which reads PostgreSQL. What the
    // database cannot see is THIS defect: if some other migration happened to
    // revoke the omitted command, the catalog would look correct while 0150's
    // own contract was broken. Source is the only witness for that, and only
    // for this file — which is why the two are not merged.
    const loop = revokeLoopFunctions();
    const declared = definedFunctions();
    expect(loop).toEqual(declared);
    expect(new Set(loop).size, "a signature appears twice in the array").toBe(loop.length);
  });
});
