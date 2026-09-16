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

  // -------------------------------------------------------------------------
  // ONE scanner, two consumers.
  //
  // Each revision of this helper handled one lexical state and review found the
  // next: a commented entry counted, then a block comment, then a bracket in a
  // literal, then nested block comments and dollar quoting. They were never
  // separate bugs — they are the states a scanner must carry to tell CODE from
  // COMMENT from STRING. It is written once, here, and used for both things
  // this file asserts.
  //
  // It is not a SQL parser. It classifies four things and blanks the rest:
  //   * `--` to end of line;
  //   * `/* ... */`, WITH PostgreSQL's nesting (`/* a /* b */ c */`);
  //   * `'...'`, including the doubled-quote escape;
  //   * `$tag$ ... $tag$` dollar quoting.
  //
  // `code` is the same length as the scanned region with every comment and
  // string body replaced by spaces, so offsets stay meaningful and a `--`, `[`
  // or `]` inside a string or comment is structurally invisible.
  // -------------------------------------------------------------------------

  type Lexed = {
    /** Same-length projection: non-code blanked to spaces. */
    code: string;
    /** Every string literal found, with its offset in the ORIGINAL source. */
    strings: Array<{ value: string; start: number }>;
  };

  /**
   * `stopAtArrayClose` bounds the scan to a single bracketed expression.
   *
   * Without it the array scan would run to EOF and meet the enclosing
   * `do $$ ... $$` body's CLOSING delimiter with no partner after it, then
   * report an unterminated dollar-quoted string. The array's own closing
   * bracket is the natural stop, and stopping there also means nothing beyond
   * the expression is ever read.
   */
  function lexFrom(
    src: string,
    from: number,
    opts: { stopAtArrayClose?: boolean } = {},
  ): Lexed {
    const code: string[] = [];
    const strings: Lexed["strings"] = [];
    const blank = (n: number) => {
      for (let k = 0; k < n; k += 1) code.push(" ");
    };
    let i = from;
    let depth = 0;

    while (i < src.length) {
      // line comment
      if (src.startsWith("--", i)) {
        const nl = src.indexOf("\n", i);
        const stop = nl === -1 ? src.length : nl;
        blank(stop - i);
        i = stop;
        continue;
      }
      // block comment, nested
      if (src.startsWith("/*", i)) {
        let depth = 0;
        const begin = i;
        while (i < src.length) {
          if (src.startsWith("/*", i)) {
            depth += 1;
            i += 2;
          } else if (src.startsWith("*/", i)) {
            depth -= 1;
            i += 2;
            if (depth === 0) break;
          } else {
            i += 1;
          }
        }
        if (depth !== 0) throw new Error("unterminated block comment in 0150");
        blank(i - begin);
        continue;
      }
      // dollar-quoted string
      const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 64));
      if (dollar) {
        const tag = dollar[0];
        const begin = i;
        const close = src.indexOf(tag, i + tag.length);
        if (close === -1) throw new Error(`unterminated dollar-quoted string ${tag} in 0150`);
        strings.push({ value: src.slice(i + tag.length, close), start: begin });
        i = close + tag.length;
        blank(i - begin);
        continue;
      }
      // single-quoted string
      if (src[i] === "'") {
        const begin = i;
        let j = i + 1;
        let value = "";
        for (;;) {
          if (j >= src.length) throw new Error("unterminated string literal in 0150");
          if (src[j] === "'") {
            if (src[j + 1] === "'") {
              value += "'";
              j += 2;
              continue;
            }
            j += 1;
            break;
          }
          value += src[j];
          j += 1;
        }
        strings.push({ value, start: begin });
        blank(j - begin);
        i = j;
        continue;
      }
      if (opts.stopAtArrayClose) {
        if (src[i] === "[") depth += 1;
        else if (src[i] === "]") {
          depth -= 1;
          if (depth === 0) {
            code.push(src[i]);
            return { code: code.join(""), strings };
          }
        }
      }
      code.push(src[i]);
      i += 1;
    }
    if (opts.stopAtArrayClose) throw new Error("0150's unnest(array[...]) is unterminated");
    return { code: code.join(""), strings };
  }

  /**
   * The ACTIVE elements of migration 0150's single `unnest(array[...])`.
   *
   * The array lives INSIDE the `do $$ ... $$` body, so this scans from the raw
   * array position rather than from a whole-file projection — a projection
   * would blank the DO body and the array with it. Depth is taken from the code
   * projection, so only brackets in code close the array.
   *
   * Dollar-quoted elements are collected like any other string, so an active
   * `$$public.f(uuid)$$` entry is SEEN rather than silently dropped.
   */
  function activeArrayLiterals(): string[] {
    const open = SQL.indexOf("unnest(array[");
    expect(open, "0150 must still drive its ACL from unnest(array[...])").toBeGreaterThan(-1);
    expect(SQL.indexOf("unnest(array[", open + 1)).toBe(-1);

    const bracket = SQL.indexOf("[", open);
    const { code, strings } = lexFrom(SQL, bracket, { stopAtArrayClose: true });

    // The scan stopped at the array's own closing bracket, so every string it
    // collected is inside the expression by construction.
    expect(code.endsWith("]"), "array scan did not stop at a closing bracket").toBe(true);
    return strings.map((s) => s.value);
  }

  /** The signatures the revoke loop actually iterates, by function name. */
  function revokeLoopFunctions(): string[] {
    return activeArrayLiterals()
      .map((lit) => /^public\.(\w+)\s*\(/.exec(lit)?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
  }

  /**
   * Every function the migration declares, counted only where the declaration
   * is CODE.
   *
   * Uses the same scanner over the whole file. A `--` inside a string no longer
   * suppresses a following declaration (`select '--'; create or replace
   * function ...` is still seen), and a declaration named inside a comment or a
   * function body is not counted.
   */
  function definedFunctions(): string[] {
    const { code } = lexFrom(SQL, 0);
    return [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi)]
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
