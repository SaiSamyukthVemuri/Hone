import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// A parsed model of what the migration chain actually grants and revokes.
// ===========================================================================
//
// This exists because the original clinical-RPC grant guard read the chain
// through two regexes that were each narrower than the repository:
//
//   * it classified a command as "authenticated-only" ONLY when the body
//     carried a literal inline `if auth.uid() is null then`. Almost every
//     command in this repo delegates that check to a helper
//     (assert_session_writable, session_actor_practitioner, is_studio_member,
//     own_practitioner_in_studio...), which is the BETTER design and was
//     invisible to the guard;
//
//   * it detected a revoke ONLY as `revoke execute on function public.f(...)
//     from <role>`. The chain also uses `revoke all on function`, `revoke all
//     privileges on function`, comma separated role lists (`from public,
//     anon`), and DO-blocks that loop
//     `execute format('revoke execute on function %s from public', fn)` over
//     an array of signatures.
//
// Both had to widen together. Widening the classifier alone would have
// reported correctly-revoked commands as unprotected; widening the detector
// alone would have changed nothing.

const MIG_DIR = join(process.cwd(), "supabase/migrations");

export type FnDef = {
  fn: string;
  file: string;
  body: string;
  isTrigger: boolean;
  isDefiner: boolean;
  /** literal `if auth.uid() is null then` in this body */
  gatesInline: boolean;
  /** any mention of auth.uid() in this body */
  mentionsAuthUid: boolean;
  /** other public functions this body calls */
  calls: Set<string>;
};

export type Acl = {
  /** role -> true when EXECUTE is revoked from it, by any supported form */
  revoked: Set<string>;
  /** role -> true when EXECUTE is granted to it */
  granted: Set<string>;
};

export function migrationFiles(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

/** SQL line comments carry example statements; they must never count as ACL. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

function readAll(): Array<{ file: string; code: string }> {
  return migrationFiles().map((file) => ({
    file,
    code: stripComments(readFileSync(join(MIG_DIR, file), "utf8")),
  }));
}

/** Every function the chain defines, latest definition winning. */
export function functionDefs(): Map<string, FnDef> {
  const out = new Map<string, FnDef>();
  const names = new Set<string>();
  const raw: Array<Omit<FnDef, "calls">> = [];

  for (const { file, code } of readAll()) {
    const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const after = code.slice(re.lastIndex);
      const next = /create\s+(?:or\s+replace\s+)?function\s+public\./i.exec(after);
      const body = next ? after.slice(0, next.index) : after;
      const fn = m[1];
      names.add(fn);
      raw.push({
        fn,
        file,
        body,
        isTrigger: /\breturns\s+trigger\b/i.test(body),
        isDefiner: /security\s+definer/i.test(body),
        gatesInline: /if\s+auth\.uid\(\)\s+is\s+null\s+then/i.test(body),
        mentionsAuthUid: /auth\.uid\(\)/i.test(body),
      });
    }
  }
  for (const d of raw) {
    const calls = new Set<string>();
    for (const other of names) {
      if (other === d.fn) continue;
      if (new RegExp(`\\b(?:public\\.)?${other}\\s*\\(`).test(d.body)) calls.add(other);
    }
    // Later definitions replace earlier ones, matching `create or replace`.
    out.set(d.fn, { ...d, calls });
  }
  return out;
}

const ROLES = ["public", "anon", "authenticated", "service_role"] as const;

/**
 * ACL per function, across EVERY supported statement form:
 *   revoke {all|execute} on function public.f(...) from a, b, c;
 *   grant  execute       on function public.f(...) to   a, b;
 *   do $$ ... execute format('revoke execute on function %s from <role>', fn) ... $$;
 *
 * A revoke recorded anywhere in the chain counts: a later repair migration is
 * exactly how 0130 and 0165 fixed 0129 and 0164.
 */
export function aclByFunction(): Map<string, Acl> {
  const acl = new Map<string, Acl>();
  const ensure = (fn: string): Acl => {
    let a = acl.get(fn);
    if (!a) {
      a = { revoked: new Set(), granted: new Set() };
      acl.set(fn, a);
    }
    return a;
  };

  for (const { code } of readAll()) {
    const flat = code.replace(/\s+/g, " ");

    // Literal statements. `[^;]*` spans the newlines the chain wraps at.
    const lit =
      /\b(revoke|grant)\s+(?:all\s+privileges|all|execute)\s+on\s+function\s+public\.(\w+)\s*\([^)]*\)\s*(from|to)\s+([a-z_,\s]+?)\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = lit.exec(flat)) !== null) {
      const [, verb, fn, , roleList] = m;
      const roles = roleList
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter((r) => (ROLES as readonly string[]).includes(r));
      const a = ensure(fn);
      for (const r of roles) (verb.toLowerCase() === "revoke" ? a.revoked : a.granted).add(r);
    }

    // Dynamic DO-block loops: the roles come from the format() templates, the
    // functions from the signature array the loop iterates.
    for (const doBlock of code.matchAll(/do\s*\$\$([\s\S]*?)\$\$/gi)) {
      const blk = doBlock[1];
      const revokeRoles = [
        ...blk.matchAll(
          /format\(\s*'revoke\s+(?:all\s+privileges|all|execute)\s+on\s+function\s+%s\s+from\s+(\w+)'/gi,
        ),
      ].map((x) => x[1].toLowerCase());
      const grantRoles = [
        ...blk.matchAll(
          /format\(\s*'grant\s+(?:all\s+privileges|all|execute)\s+on\s+function\s+%s\s+to\s+(\w+)'/gi,
        ),
      ].map((x) => x[1].toLowerCase());
      if (revokeRoles.length === 0 && grantRoles.length === 0) continue;
      const fns = [...blk.matchAll(/'public\.(\w+)\s*\(/g)].map((x) => x[1]);
      for (const fn of fns) {
        const a = ensure(fn);
        for (const r of revokeRoles) a.revoked.add(r);
        for (const r of grantRoles) a.granted.add(r);
      }
    }
  }
  return acl;
}

/**
 * Functions whose actor authority resolves to auth.uid(), directly or through
 * any chain of helpers. This is the shape the repository actually uses and the
 * one the original guard could not see.
 */
export function actorGated(defs: Map<string, FnDef>): Set<string> {
  const reach = new Set<string>();
  for (const [fn, d] of defs) if (d.mentionsAuthUid) reach.add(fn);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fn, d] of defs) {
      if (reach.has(fn)) continue;
      for (const callee of d.calls) {
        if (reach.has(callee)) {
          reach.add(fn);
          changed = true;
          break;
        }
      }
    }
  }
  return reach;
}
