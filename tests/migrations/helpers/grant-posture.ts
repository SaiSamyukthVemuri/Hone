/**
 * EXACT grant posture for one function signature.
 *
 * WHY THIS EXISTS. The posture tests across this repository were written as
 * "the intended grant is present, and these two named roles are not granted":
 *
 *   expect(sql).toContain(`grant execute on function public.f(a) to service_role;`);
 *   for (const role of ["anon", "authenticated"]) {
 *     expect(sql).not.toContain(`grant execute on function public.f(a) to ${role};`);
 *   }
 *
 * That confirms what is present without excluding what is not, so a stray grant
 * to ANY role outside the hand-written deny list left every assertion green.
 * `public` is the one that matters most and was missing from every list: a file
 * may legitimately `revoke execute ... from public;` -- all of them do -- and a
 * later `grant execute ... to public;` would satisfy the revoke assertion, the
 * service_role assertion AND the anon/authenticated exclusions simultaneously,
 * while granting the function to every role in the database. `postgres` and
 * `authenticator` (the PostgREST login role) are the same shape.
 *
 * CLAUDE.md section 5 records this class going wrong twice already in the
 * product -- 0129 missed `anon`, 0164 missed `service_role` -- so the guard
 * against it should not itself depend on remembering a list.
 *
 * Cross-lane: found by the History lane (0223) on its own posture loop. Shared
 * here rather than re-implemented per file, because two parsers answering one
 * question is how they drift.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Squash whitespace, then collapse it around `( ) , ;`.
 *
 * WITHOUT THIS THE "EXACT" CHECK WAS STILL EVADABLE, which the History lane
 * measured and I then reproduced: the matcher tolerated `\s+` between KEYWORDS
 * but matched the argument list as an escaped literal, so the separator had to
 * be exactly `, `. Every one of these spellings is legal SQL for the same
 * function, and each one hid a grant:
 *
 *   public.f(uuid,uuid,timestamptz)        -- no space after the comma
 *   public.f(uuid,  uuid,  timestamptz)    -- two spaces
 *   public.f(\n  uuid,\n  uuid\n)            -- signature across lines
 *
 * Reformatting a signature is the most ordinary edit there is, so binding the
 * check to one spelling of it reopened the original hole from another door.
 * Normalising BOTH the source and the needle removes the spelling from the
 * question entirely.
 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\s*([(),;])\s*/g, "$1");
}

/**
 * Every role granted anything on `public.<fn>(<args>)`, lower-cased and sorted.
 *
 * Deliberately matches ANY privilege word (`execute`, `all`, `all privileges`)
 * and splits a comma-separated role list, so `grant execute on function f(a) to
 * service_role, anon;` reports both roles rather than slipping past a matcher
 * built for one role per statement.
 *
 * Pass COMMENT-STRIPPED source. A commented-out grant is not a grant, and these
 * files carry long prose about grants that would otherwise match.
 */
export function grantedRoles(
  executableSql: string,
  fn: string,
  args: string,
): string[] {
  // Both sides normalised, so no spelling of the signature can hide a grant.
  const haystack = normalizeSql(executableSql);
  const re = new RegExp(
    `grant\\s+[a-z ,]+?\\s+on\\s+function\\s+public\\.${escape(fn)}\\(${escape(
      normalizeSql(args),
    )}\\)\\s*to\\s*([^;]+);`,
    "gi",
  );
  const roles: string[] = [];
  for (const m of haystack.matchAll(re)) {
    for (const role of m[1].split(",")) {
      const clean = role.trim().toLowerCase().replace(/^"|"$/g, "");
      if (clean) roles.push(clean);
    }
  }
  return roles.sort();
}

/**
 * A BLANKET grant bypasses any per-signature check: `grant execute on all
 * functions in schema public to anon;` grants the function under test without
 * ever naming it, so `grantedRoles` would report nothing amiss. Asserted
 * separately, because the per-function parser structurally cannot see it.
 */
export const BLANKET_FUNCTION_GRANT =
  /grant\s+[a-z ,]+?\s+on\s+all\s+functions\s+in\s+schema/i;
