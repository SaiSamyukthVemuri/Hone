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
   * The ONE array expression this test owns: the `unnest(array[...])` list the
   * revoke loop iterates. Sliced by bracket balance so nothing outside it — no
   * function body, no comment elsewhere in the file, no other string literal —
   * can influence the result.
   */
  function revokeArrayExpression(): string {
    const open = SQL.indexOf("unnest(array[");
    expect(open, "0150 must still drive its ACL from unnest(array[...])").toBeGreaterThan(-1);
    // Exactly one, so "the array" is unambiguous.
    expect(SQL.indexOf("unnest(array[", open + 1)).toBe(-1);

    const start = SQL.indexOf("[", open);
    let depth = 0;
    for (let i = start; i < SQL.length; i += 1) {
      if (SQL[i] === "[") depth += 1;
      else if (SQL[i] === "]") {
        depth -= 1;
        if (depth === 0) return SQL.slice(start + 1, i);
      }
    }
    throw new Error("0150's unnest(array[...]) is unterminated");
  }

  /**
   * The ACTIVE signatures in that array.
   *
   * A commented-out entry is NOT in the revoke loop, so counting it was the
   * same defect in a new place as the `%s` assertion this file already fixed:
   * reading text that looks like the contract instead of the contract that
   * executes. Commenting one line out removed a command from the loop while
   * this test stayed green.
   *
   * `--` runs to end of line, and inside THIS slice — a list of quoted
   * signatures — there is nothing else it could mean. That is the whole of the
   * lexical handling; this test parses one array expression, never SQL.
   */
  function revokeLoopFunctions(): string[] {
    const active = revokeArrayExpression()
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    return [...active.matchAll(/'public\.(\w+)\s*\(/g)].map((m) => m[1]).sort();
  }

  /**
   * Every function the migration defines. Comment-stripped for the same reason
   * and by the same rule: a commented-out `create or replace function` defines
   * nothing, and counting it would fail this contract in the mirror direction.
   */
  function definedFunctions(): string[] {
    const active = SQL.split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    return [...active.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi)]
      .map((m) => m[1])
      .sort();
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
