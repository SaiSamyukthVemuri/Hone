import { createHash } from "node:crypto";
import { E2E_DB_URL, E2E_SUPABASE_URL, assertSameStackPair } from "../../../e2e/helpers/local-env";
import { adminQuery, resolveLocalDbUrl } from "./harness";

// CATALOG GUARD for DB tests that change the schema (a migration's down file, then its up file) on the stack they run against.
//
// WHY. A down and up of an EARLIER migration strips what a LATER migration added to the same objects: a down and up of 0325 drops and recreates
// the tables 0326 indexed and puts back 0325's two reads, so 0326's two indexes and two function bodies are gone and nothing reports it. CI
// starts from a fresh stack, so it never noticed; a long-lived local stack silently stops matching the hosted catalog.
//
// WHAT. `captureCatalog()` takes a fingerprint of the `public` schema: relations (kind, owner, RLS enabled and forced flags, storage options such as a view's security_invoker, privileges), columns
// (type, nullability, default, generation, column privileges), view and materialized-view definitions, indexes, constraints, triggers (definition
// and enabled state), policies, and functions (full definition, owner, security and settings) with their privileges.
// `restoreCatalog(before)` re-creates what it can from the captured definitions, in dependency order: functions (with their privileges) first,
// then indexes, then triggers. `assertCatalogUnchanged(before)` fails the file with the first differences, and is the check that also catches
// future cases.
//
// WHAT IT DOES NOT DO (stated so nobody reads it as more than it is).
//  - REPORTED, NOT RESTORED: relation and column privileges, policies, constraints, columns, views, RLS flags, storage options, owners and trigger enabled state.
//    If a suite changes one of these the assertion fails and names it; nothing here puts it back.
//  - Constraint-backed indexes (primary key, unique constraint) are NOT restored as plain indexes: they come back with their constraint, if at all.
//  - NOT IN THE FINGERPRINT: types and enums, extensions, default privileges, comments, sequences' state, and DATA. A 0325 down then up also loses the
//    rows of the tables it drops and recreates; this guard does not see that and cannot bring them back.
//  - Restore is NOT atomic: it runs statement by statement and can stop half-way; the assertion then reports what is still different.
//  - NOT FOR PARALLEL USE: a snapshot taken while another file creates or drops objects in the same schema fails for the wrong reason. The DB lane
//    runs files one at a time (fileParallelism: false in vitest.db.config.ts); do not use this helper from files that run concurrently.
// Use it in the suite's own hooks: capture after any deliberate setup, restore in the test's `finally`, assert in `afterAll` before the pool closes.

// restoreCatalog DROPS and CREATES objects on whatever stack the pool points at, so every entry point first re-proves the run-scoped target:
// importing local-env already ran the paired API/SQL guard (#879); this repeats it and requires the pool to be the validated SQL endpoint.
function requireOwnedTarget(): void {
  assertSameStackPair(E2E_SUPABASE_URL, E2E_DB_URL);
  if (resolveLocalDbUrl() !== E2E_DB_URL) {
    throw new Error("catalog guard refuses to run: the database pool is not the validated HONE_LOCAL_DB_URL of this run.");
  }
}

export type CatalogEntry = { key: string; hash: string; restore?: string };
export type CatalogSnapshot = { entries: CatalogEntry[]; fingerprint: string };

const q = async (text: string) => (await adminQuery(text, [])).rows as Array<Record<string, string>>;

const digest = (s: string) => createHash("md5").update(s).digest("hex");

export async function captureCatalog(): Promise<CatalogSnapshot> {
  requireOwnedTarget();
  const entries: CatalogEntry[] = [];
  const add = (key: string, body: string, restore?: string) => entries.push({ key, hash: digest(body), restore });

  for (const r of await q(`
    select c.relname, c.relkind::text as kind, coalesce(c.relacl::text, '') as acl, c.relowner::regrole::text as owner,
           c.relrowsecurity::text as rls, c.relforcerowsecurity::text as forced, coalesce(c.reloptions::text, '') as opts
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','S')
      order by c.relname`)) add(`rel|${r.relname}|${r.kind}`, `acl=${r.acl}|owner=${r.owner}|rls=${r.rls}|forced=${r.forced}|options=${r.opts}`);

  for (const r of await q(`
    select c.relname, a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull::text as nn,
           coalesce(pg_get_expr(d.adbin, d.adrelid), '') as def, a.attgenerated::text as gen, coalesce(a.attacl::text, '') as cacl
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
     order by c.relname, a.attname`)) add(`col|${r.relname}.${r.attname}`, `${r.type}|${r.nn}|${r.def}|${r.gen}|acl=${r.cacl}`);

  for (const r of await q(`
    select c.relname, pg_get_viewdef(c.oid, true) as def from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m') order by c.relname`)) add(`view|${r.relname}`, r.def);

  for (const r of await q(`
    select i.indexname, i.tablename, i.indexdef from pg_indexes i where i.schemaname = 'public' order by i.indexname`))
    add(`idx|${r.tablename}.${r.indexname}`, r.indexdef, r.indexdef);

  for (const r of await q(`
    select c.relname, k.conname, pg_get_constraintdef(k.oid) as def from pg_constraint k join pg_class c on c.oid = k.conrelid
     where c.relnamespace = 'public'::regnamespace order by c.relname, k.conname`)) add(`con|${r.relname}.${r.conname}`, r.def);

  for (const r of await q(`
    select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled::text as en from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal order by c.relname, t.tgname`))
    add(`trg|${r.relname}.${r.tgname}`, `${r.def}|enabled=${r.en}`, r.def);

  for (const r of await q(`
    select tablename, policyname, cmd, permissive, roles::text as roles, coalesce(qual, '') as qual, coalesce(with_check, '') as wc
      from pg_policies where schemaname = 'public' order by tablename, policyname`))
    add(`pol|${r.tablename}.${r.policyname}`, `${r.cmd}|${r.permissive}|${r.roles}|${r.qual}|${r.wc}`);

  const fns = await q(`
    select p.oid::regprocedure::text as ident, pg_get_functiondef(p.oid) as def, p.proowner::regrole::text as owner,
           (select string_agg(x.grantee_name || ':' || x.privilege_type, ',' order by x.grantee_name, x.privilege_type)
              from (select coalesce(nullif(a.grantee, 0)::regrole::text, 'public') as grantee_name, a.privilege_type
                      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee <> p.proowner) x) as acl
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') order by 1`);
  for (const r of fns) {
    const grants = (r.acl ?? "").split(",").filter(Boolean);
    const restore =
      `${r.def};\n` +
      `revoke all on function ${r.ident} from public, anon, authenticated, service_role;\n` +
      grants.map((g) => {
        const [role, priv] = g.split(":");
        return `grant ${priv} on function ${r.ident} to ${role === "public" ? "public" : `"${role}"`};`;
      }).join("\n");
    add(`fn|${r.ident}`, `${r.def}|owner=${r.owner}|acl=${r.acl ?? ""}`, restore);
  }

  return { entries, fingerprint: digest(entries.map((e) => `${e.key}=${e.hash}`).join("\n")) };
}

export function catalogDiff(before: CatalogSnapshot, after: CatalogSnapshot): string[] {
  const b = new Map(before.entries.map((e) => [e.key, e.hash]));
  const a = new Map(after.entries.map((e) => [e.key, e.hash]));
  const out: string[] = [];
  for (const k of b.keys()) if (!a.has(k)) out.push(`missing after: ${k}`);
  for (const k of a.keys()) if (!b.has(k)) out.push(`added: ${k}`);
  for (const [k, h] of b) if (a.has(k) && a.get(k) !== h) out.push(`changed: ${k}`);
  return out.sort();
}

// Re-create what a schema-changing test removed or altered, from the definitions captured before it ran. Only functions (with their
// privileges), indexes and triggers can be put back this way; anything else it changed is reported by `assertCatalogUnchanged`.
export async function restoreCatalog(before: CatalogSnapshot): Promise<void> {
  requireOwnedTarget();
  const now = await captureCatalog();
  const had = new Map(now.entries.map((e) => [e.key, e.hash]));
  // Dependency order: a trigger or an expression index can call a function, so functions first, then indexes, then triggers.
  const ORDER = ["fn", "idx", "trg"];
  const todo = before.entries.filter((e) => e.restore && had.get(e.key) !== e.hash);
  for (const prefix of ORDER) {
    for (const e of todo.filter((x) => x.key.startsWith(`${prefix}|`))) {
      if (prefix === "fn") {
        await adminQuery(e.restore as string, []);
        continue;
      }
      const [table, name] = e.key.slice(prefix.length + 1).split(".");
      if (had.has(e.key)) {
        await adminQuery(prefix === "idx" ? `drop index if exists public."${name}"` : `drop trigger if exists "${name}" on public."${table}"`, []);
      }
      await adminQuery(e.restore as string, []);
    }
  }
}

export async function assertCatalogUnchanged(before: CatalogSnapshot, label = "this suite"): Promise<void> {
  const after = await captureCatalog();
  const diff = catalogDiff(before, after);
  if (diff.length > 0) {
    throw new Error(
      `${label} left the stack's catalog different from how it found it (${diff.length} difference${diff.length === 1 ? "" : "s"}); a down/up of an earlier migration strips what a later one added. First differences:\n  ` +
        diff.slice(0, 15).join("\n  "),
    );
  }
}
