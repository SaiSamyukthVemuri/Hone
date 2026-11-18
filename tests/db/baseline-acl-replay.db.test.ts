import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { closePool, resolveLocalDbUrl } from "./helpers/harness";
// @ts-expect-error - .mjs utility ships without type declarations
import { ACL_SQL } from "../../scripts/db-baseline/sql.mjs";

// The baseline restore replays explicit grants generated from the chain (scripts/db-baseline/sql.mjs, ACL_SQL).
// Proven here on the real stack, over EVERY table, view, sequence, function, type and the schemas (public and supabase_migrations, incl. the migration history's tables) and column ACLs:
//   1. the full replay changes nothing on the chain it was generated from (aclexplode identical before and after);
//   2. after extra access is given to an owner-only table, a function and the schema (what a target's default
//      privileges do to an object whose ACL equals the built-in default), the replay returns EVERY ACL to the
//      chain's, so no role keeps an extra grant. Negative control: the extra grants are visible before the replay.
// Each case runs in a transaction that is rolled back.

const superPool = new Pool({ connectionString: resolveLocalDbUrl().replace("//postgres:", "//supabase_admin:") });
afterAll(async () => {
  await superPool.end();
  await closePool();
});

const SNAPSHOT = `
  select x from (
    select 'rel|' || c.relname || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(a.grantee::regrole::text, 'PUBLIC') || '|' || a.privilege_type || '|' || a.is_grantable::text as x
      from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 'S' else 'r' end, c.relowner))) a
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
    union all
    select 'fn|' || p.oid::regprocedure::text || '|' || coalesce(a.grantee::regrole::text, 'PUBLIC') || '|' || a.privilege_type || '|' || a.is_grantable::text
      from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.pronamespace = 'public'::regnamespace
    union all
    select 'nsp|' || n.nspname || '|' || coalesce(a.grantee::regrole::text, 'PUBLIC') || '|' || a.privilege_type || '|' || a.is_grantable::text
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname in ('public', 'supabase_migrations')
    union all
    select 'migrel|' || c.relname || '|' || coalesce(a.grantee::regrole::text, 'PUBLIC') || '|' || a.privilege_type || '|' || a.is_grantable::text
      from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 'S' else 'r' end, c.relowner))) a
     where c.relnamespace = 'supabase_migrations'::regnamespace and c.relkind in ('r','p','v','m','f','S')
    union all
    select 'type|' || t.typname || '|' || coalesce(a.grantee::regrole::text, 'PUBLIC') || '|' || a.privilege_type || '|' || a.is_grantable::text
      from pg_type t, lateral aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) a
     where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','d','r','m')
    union all
    select 'col|' || c.relname || '|' || t.attname || '|' || coalesce(a.grantee::regrole::text, 'PUBLIC') || '|' || a.privilege_type
      from pg_attribute t join pg_class c on c.oid = t.attrelid, lateral aclexplode(t.attacl) a
     where c.relnamespace = 'public'::regnamespace and t.attacl is not null
  ) s order by x`;

class Rollback extends Error {}

async function inRolledBackTx(fn: (q: (t: string) => Promise<Record<string, unknown>[]>) => Promise<void>) {
  const client = await superPool.connect();
  try {
    await client.query("begin");
    await fn(async (t) => (await client.query(t)).rows);
    throw new Rollback();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

const lines = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.x));
const script = (rows: Record<string, unknown>[]) => rows.map((r) => String(Object.values(r)[0])).join("\n");

describe("baseline ACL replay: no role gains access", () => {
  it("replaying the chain's own script changes no table, function or schema ACL", async () => {
    await inRolledBackTx(async (q) => {
      const before = lines(await q(SNAPSHOT));
      expect(before.length).toBeGreaterThan(1000);
      const gen = script(await q(ACL_SQL));
      await q(gen);
      const after = lines(await q(SNAPSHOT));
      expect(after.filter((x) => !before.includes(x)), "grants the replay ADDED").toEqual([]);
      expect(before.filter((x) => !after.includes(x)), "grants the replay REMOVED").toEqual([]);
    });
  });

  it("returns every ACL to the chain's after extra access was given, and the extra access was real", async () => {
    await inRolledBackTx(async (q) => {
      const before = lines(await q(SNAPSHOT));
      const gen = script(await q(ACL_SQL));
      const t = (await q(`select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                            and coalesce(c.relacl::text, '') !~ 'anon=' and coalesce(c.relacl::text, '') !~ 'authenticated=' order by c.relname limit 1`))[0];
      expect(t, "need an owner-only table to prove the replay on").toBeTruthy();
      const f = (await q(`select p.oid::regprocedure::text as f from pg_proc p where p.pronamespace = 'public'::regnamespace and coalesce(p.proacl::text, '') !~ 'anon=' and pg_get_userbyid(p.proowner) = 'postgres' limit 1`))[0];
      expect(f, "need a function without anon execute").toBeTruthy();
      await q(`grant all on table public.${String(t.relname)} to anon, authenticated`);
      await q(`grant execute on function ${String(f.f)} to anon`);
      await q(`grant create on schema public to anon`);
      const leaked = lines(await q(SNAPSHOT));
      expect(leaked.filter((x) => !before.includes(x)).length, "negative control: the extra grants must exist before the replay").toBeGreaterThan(0);
      await q(gen);
      const after = lines(await q(SNAPSHOT));
      expect(after.filter((x) => !before.includes(x)), "EXTRA GRANTS still present after the replay").toEqual([]);
      expect(before.filter((x) => !after.includes(x)), "grants the replay lost").toEqual([]);
    });
  });
});
