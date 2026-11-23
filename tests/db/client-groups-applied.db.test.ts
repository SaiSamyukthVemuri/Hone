import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// The proposal installed FOR REAL (committed), so commands can race on separate
// connections. The teardown runs DOWN.sql and requires the WHOLE public catalog to
// equal its state before. A database that already carries the groups tables is
// refused and left exactly as found (the transactional suite covers that case).
const UP = readFileSync(new URL("../../docs/proposals/client-groups/UP.sql", import.meta.url), "utf8");
const DOWN = readFileSync(new URL("../../docs/proposals/client-groups/DOWN.sql", import.meta.url), "utf8");
const COMMANDS = ["create_client_group", "rename_client_group", "set_client_group_membership"];

const present = async () =>
  (await adminQuery("select to_regclass('public.client_groups') is not null or to_regclass('public.client_group_memberships') is not null as p")).rows[0].p as boolean;

// One fingerprint of everything in public that a migration could change.
async function fingerprint(): Promise<string> {
  const q = `
    select md5(string_agg(x, E'\\n' order by x)) as h, count(*)::int as n from (
      select 'rel|'||c.relname||'|'||c.relkind::text||'|'||coalesce(c.relacl::text,'')||'|'||c.relrowsecurity||'|'||c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      union all select 'col|'||c.relname||'|'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull||'|'||coalesce(a.attacl::text,'') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0 and not a.attisdropped and c.relkind in ('r','p','v','m')
      union all select 'fn|'||p.oid::regprocedure::text||'|'||p.proowner::regrole::text||'|'||coalesce(p.proacl::text,'')||'|'||coalesce(p.proconfig::text,'')||'|'||md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      union all select 'pol|'||schemaname||'|'||tablename||'|'||policyname||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') from pg_policies where schemaname='public'
      union all select 'con|'||conrelid::regclass::text||'|'||conname||'|'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
      union all select 'idx|'||tablename||'|'||indexname||'|'||indexdef from pg_indexes where schemaname='public'
      union all select 'typ|'||t.typname||'|'||t.typtype::text from pg_type t where t.typnamespace='public'::regnamespace
      union all select 'trg|'||c.relname||'|'||tg.tgname from pg_trigger tg join pg_class c on c.oid=tg.tgrelid where c.relnamespace='public'::regnamespace and not tg.tgisinternal
    ) s(x)`;
  const r = (await adminQuery(q)).rows[0];
  return `${r.n}:${r.h}`;
}

let applied = false;
// true only when THIS suite installed the tables: a refused run must leave the database untouched
let owns = false;
let before = "";
let afterUp = "";
async function apply() { await adminQuery(UP); applied = true; }
async function down() { await adminQuery(DOWN); applied = false; }

type Owner = { s: SeededStudio };
let a: Owner, b: Owner;
let memberA: { userId: string };

const call = (userId: string, sql: string, args: unknown[]) => asUser(userId, async (q) => (await q(`select ${sql} as r`, args)).rows[0].r.status as string);
const createAs = (userId: string, studio: string, name: string) => call(userId, "public.create_client_group($1,$2)", [studio, name]);
const groupRow = async (studio: string, name: string) =>
  (await adminQuery("select id,name,updated_at::text as updated_at from public.client_groups where studio_id=$1 and name_key=lower($2)", [studio, name])).rows[0];
const count = async (studio: string) => Number((await adminQuery("select count(*) from public.client_groups where studio_id=$1", [studio])).rows[0].count);
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
// Every concurrent case must finish with a status. A deadlock (40P01) or lock timeout would reject instead.
const settled = async (ps: Promise<string>[]) => {
  const r = await Promise.allSettled(ps);
  const errs = r.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason?.code ?? String((x as PromiseRejectedResult).reason));
  expect(errs).toEqual([]);
  return r.map((x) => (x as PromiseFulfilledResult<string>).value);
};

beforeAll(async () => {
  if (await present()) throw new Error("the client groups tables are already present on this database; refusing to run the applied suite");
  before = await fingerprint();
  await apply();
  owns = true;
  afterUp = await fingerprint();
  a = { s: await seedStudio("groups-a") };
  b = { s: await seedStudio("groups-b") };
  memberA = await seedMember(a.s, "groups-member");
}, 120_000);

afterAll(async () => {
  try {
    if (!owns) return;
    if (applied || (await present())) {
      // the tables did not exist before this suite, so every row in them is this suite's
      await adminQuery("delete from public.client_group_memberships").catch(() => undefined);
      await adminQuery("delete from public.client_groups").catch(() => undefined);
      await down();
    }
    expect(await fingerprint()).toBe(before);
  } finally { await closePool(); }
}, 120_000);

describe("client groups proposal, installed for real", () => {
  it("privileges are exact, by role name", async () => {
    const roles = ["anon", "authenticated", "service_role"] as const;
    const privs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    for (const t of ["client_groups", "client_group_memberships"]) {
      for (const role of roles) for (const p of privs) {
        expect((await adminQuery("select has_table_privilege($1,$2,$3) as ok", [role, `public.${t}`, p])).rows[0].ok, `${role} table ${p} ${t}`).toBe(false);
      }
      // PUBLIC holds nothing either
      expect((await adminQuery("select count(*)::int as n from pg_class c, aclexplode(c.relacl) e where c.oid=$1::regclass and e.grantee=0", [`public.${t}`])).rows[0].n).toBe(0);
    }
    const cols = async (t: string, role: string, p: string) =>
      (await adminQuery("select string_agg(attname,',' order by attname) as c from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped and has_column_privilege($2,attrelid,attnum,$3)", [`public.${t}`, role, p])).rows[0].c as string | null;
    expect(await cols("client_groups", "authenticated", "SELECT")).toBe("created_at,id,name,studio_id,updated_at"); // name_key is not granted
    expect(await cols("client_group_memberships", "authenticated", "SELECT")).toBe("client_id,created_at,group_id,studio_id");
    for (const t of ["client_groups", "client_group_memberships"]) for (const p of ["INSERT", "UPDATE", "REFERENCES"]) expect(await cols(t, "authenticated", p), `${t} ${p}`).toBeNull();
    for (const t of ["client_groups", "client_group_memberships"]) for (const role of ["anon", "service_role"]) expect(await cols(t, role, "SELECT")).toBeNull();
    const fns = (await adminQuery("select p.oid::regprocedure::text as sig, p.proacl::text as acl, p.prosecdef, p.proconfig from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any($1)", [COMMANDS])).rows;
    expect(fns).toHaveLength(3);
    for (const f of fns) {
      expect(f.prosecdef).toBe(true);
      expect(f.proconfig).toEqual(expect.arrayContaining(["search_path=pg_catalog, pg_temp", "lock_timeout=5s"]));
      const grantees = (await adminQuery("select coalesce(nullif(e.grantee::regrole::text,'-'),'PUBLIC') as g from pg_proc p, aclexplode(p.proacl) e where p.oid=$1::regprocedure order by 1", [f.sig])).rows.map((r) => r.g);
      expect(grantees.filter((g) => g !== "postgres"), f.sig).toEqual(["authenticated"]);
    }
    for (const role of ["anon", "service_role"] as const) {
      await asRole(role, async (q) => {
        for (const sql of ["select public.create_client_group($1,'x')", "select public.rename_client_group($1,$1,'x','x',now())", "select public.set_client_group_membership($1,$1,$1,true)"]) {
          await q("savepoint s");
          await expect(q(sql, [randomUUID()])).rejects.toMatchObject({ code: "42501" });
          await q("rollback to savepoint s");
        }
      });
    }
  });

  it("RLS is on, and only an active owner of the studio can read", async () => {
    const rls = (await adminQuery("select relname,relrowsecurity from pg_class where oid in ('public.client_groups'::regclass,'public.client_group_memberships'::regclass)")).rows;
    expect(rls.every((r) => r.relrowsecurity === true)).toBe(true);
    await createAs(a.s.userId, a.s.studioId, "Alpha only");
    expect(await asUser(a.s.userId, async (q) => (await q("select id from public.client_groups where studio_id=$1", [a.s.studioId])).rows.length)).toBe(1);
    expect(await asUser(b.s.userId, async (q) => (await q("select id from public.client_groups")).rows.length)).toBe(0);
    expect(await asUser(memberA.userId, async (q) => (await q("select id from public.client_groups")).rows.length)).toBe(0);
  });

  it("tenant isolation: a foreign owner or a foreign id changes nothing", async () => {
    await createAs(a.s.userId, a.s.studioId, "Isolated");
    const ga = await groupRow(a.s.studioId, "Isolated");
    await createAs(b.s.userId, b.s.studioId, "Isolated"); // same name in another studio is fine
    const gb = await groupRow(b.s.studioId, "Isolated");
    expect(gb.id).not.toBe(ga.id);
    expect(await createAs(b.s.userId, a.s.studioId, "Intruder")).toBe("denied");
    expect(await call(b.s.userId, "public.rename_client_group($1,$2,$3,$4,$5)", [a.s.studioId, ga.id, "Hijack", ga.name, ga.updated_at])).toBe("denied");
    expect(await call(b.s.userId, "public.rename_client_group($1,$2,$3,$4,$5)", [b.s.studioId, ga.id, "Hijack", ga.name, ga.updated_at])).toBe("missing");
    expect(await call(a.s.userId, "public.set_client_group_membership($1,$2,$3,true)", [a.s.studioId, b.s.clientId, ga.id])).toBe("missing");
    expect(await call(a.s.userId, "public.set_client_group_membership($1,$2,$3,true)", [a.s.studioId, a.s.clientId, gb.id])).toBe("missing");
    expect(await call(memberA.userId, "public.set_client_group_membership($1,$2,$3,true)", [a.s.studioId, a.s.clientId, ga.id])).toBe("denied");
    expect((await groupRow(a.s.studioId, "Isolated")).name).toBe("Isolated");
    // the composite foreign keys refuse a cross-studio link even from an administrative connection
    await expect(adminQuery("insert into public.client_group_memberships(studio_id,client_id,group_id) values($1,$2,$3)", [a.s.studioId, b.s.clientId, ga.id])).rejects.toMatchObject({ code: "23503" });
    await expect(adminQuery("insert into public.client_group_memberships(studio_id,client_id,group_id) values($1,$2,$3)", [a.s.studioId, a.s.clientId, gb.id])).rejects.toMatchObject({ code: "23503" });
  });

  it("erasing a client or deleting a studio is not blocked by group data (cascade)", async () => {
    const s = await seedStudio("groups-cascade");
    await createAs(s.userId, s.studioId, "Cascade");
    const g = await groupRow(s.studioId, "Cascade");
    expect(await call(s.userId, "public.set_client_group_membership($1,$2,$3,true)", [s.studioId, s.clientId, g.id])).toBe("saved");
    await adminQuery("delete from public.clients where id=$1", [s.clientId]);
    expect(Number((await adminQuery("select count(*) from public.client_group_memberships where studio_id=$1", [s.studioId])).rows[0].count)).toBe(0);
    expect(Number((await adminQuery("select count(*) from public.client_groups where id=$1", [g.id])).rows[0].count)).toBe(1);
    // studio deletion: both tables' studio foreign keys and the membership-to-client key cascade
    const fk = (await adminQuery("select conrelid::regclass::text as t, confrelid::regclass::text as r, confdeltype as d from pg_constraint where contype='f' and conrelid in ('public.client_groups'::regclass,'public.client_group_memberships'::regclass) and confrelid in ('public.studios'::regclass,'public.clients'::regclass)")).rows;
    expect(fk).toHaveLength(3);
    expect(fk.every((x) => x.d === "c"), JSON.stringify(fk)).toBe(true);
    await adminQuery("delete from public.client_groups where studio_id=$1", [s.studioId]);
  });

  describe("two connections at once: every case ends with statuses, never a deadlock or timeout", () => {
    it("same name, differently cased: exactly one creates", async () => {
      const r = await settled(["Race", "RACE", " race ", "rAcE"].map((n) => createAs(a.s.userId, a.s.studioId, n)));
      expect(tally(r)).toEqual({ created: 1, exists: 3 });
      expect(Number((await adminQuery("select count(*) from public.client_groups where studio_id=$1 and name_key='race'", [a.s.studioId])).rows[0].count)).toBe(1);
    });

    it("at 99 groups: exactly one concurrent create wins, the other gets the limit", async () => {
      const s = await seedStudio("groups-cap");
      await adminQuery("insert into public.client_groups(studio_id,name) select $1,'Seed '||n from generate_series(1,99) n", [s.studioId]);
      for (let round = 0; round < 3; round++) {
        await adminQuery("delete from public.client_groups where studio_id=$1 and name like 'Cap %'", [s.studioId]);
        const r = await settled([createAs(s.userId, s.studioId, `Cap ${round}a`), createAs(s.userId, s.studioId, `Cap ${round}b`)]);
        expect(tally(r)).toEqual({ created: 1, limit: 1 });
        expect(await count(s.studioId)).toBe(100);
      }
      await adminQuery("delete from public.client_groups where studio_id=$1", [s.studioId]);
    });

    it("rename against the same expected version: one renames, the rest are stale", async () => {
      await createAs(a.s.userId, a.s.studioId, "Cas");
      const g = await groupRow(a.s.studioId, "Cas");
      const r = await settled(["Cas 1", "Cas 2", "Cas 3", "Cas 4"].map((n) => call(a.s.userId, "public.rename_client_group($1,$2,$3,$4,$5)", [a.s.studioId, g.id, n, g.name, g.updated_at])));
      expect(tally(r)).toEqual({ renamed: 1, stale: 3 });
    });

    it("rename versus a create of the same name: one wins, the other is refused as a duplicate", async () => {
      await createAs(a.s.userId, a.s.studioId, "Dup base");
      const g = await groupRow(a.s.studioId, "Dup base");
      const r = await settled([
        call(a.s.userId, "public.rename_client_group($1,$2,$3,$4,$5)", [a.s.studioId, g.id, "Contested", g.name, g.updated_at]),
        createAs(a.s.userId, a.s.studioId, "contested"),
      ]);
      expect(r.slice().sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^(renamed|created)$/), expect.stringMatching(/^(duplicate|exists)$/)]));
      expect(Number((await adminQuery("select count(*) from public.client_groups where studio_id=$1 and name_key='contested'", [a.s.studioId])).rows[0].count)).toBe(1);
    });

    it("two renames to the same name: one wins, the other is a duplicate", async () => {
      await createAs(a.s.userId, a.s.studioId, "Two x");
      await createAs(a.s.userId, a.s.studioId, "Two y");
      const x = await groupRow(a.s.studioId, "Two x"), y = await groupRow(a.s.studioId, "Two y");
      const r = await settled([
        call(a.s.userId, "public.rename_client_group($1,$2,$3,$4,$5)", [a.s.studioId, x.id, "Twin", x.name, x.updated_at]),
        call(a.s.userId, "public.rename_client_group($1,$2,$3,$4,$5)", [a.s.studioId, y.id, "TWIN", y.name, y.updated_at]),
      ]);
      expect(tally(r)).toEqual({ renamed: 1, duplicate: 1 });
    });

    it("same-pair assign versus remove: always a saved status, and at most one row", async () => {
      await createAs(a.s.userId, a.s.studioId, "Pair");
      const g = await groupRow(a.s.studioId, "Pair");
      for (let round = 0; round < 6; round++) {
        const r = await settled([true, false, true, false].map((on) => call(a.s.userId, "public.set_client_group_membership($1,$2,$3,$4)", [a.s.studioId, a.s.clientId, g.id, on])));
        expect(tally(r)).toEqual({ saved: 4 });
        const n = Number((await adminQuery("select count(*) from public.client_group_memberships where studio_id=$1 and client_id=$2 and group_id=$3", [a.s.studioId, a.s.clientId, g.id])).rows[0].count);
        expect([0, 1]).toContain(n);
      }
    });

    it("a command waits for the studio lock and then proceeds; membership inserts do not wait on it", async () => {
      const s = await seedStudio("groups-lock");
      await createAs(s.userId, s.studioId, "Lockbase");
      const g = await groupRow(s.studioId, "Lockbase");
      let release!: () => void; const gate = new Promise<void>((r) => (release = r));
      let held!: () => void; const holding = new Promise<void>((r) => (held = r));
      const holder = adminTx(async (q) => { await q("select 1 from public.studios where id=$1 for no key update", [s.studioId]); held(); await gate; });
      await holding;
      // a membership foreign-key check takes a key-share lock; it must not queue behind the studio lock
      await adminTx(async (q) => {
        await q("set local lock_timeout='1500ms'");
        await q("insert into public.client_group_memberships(studio_id,client_id,group_id) values($1,$2,$3)", [s.studioId, s.clientId, g.id]);
      });
      const pending = createAs(s.userId, s.studioId, "Waits");
      let done = false; void pending.then(() => (done = true), () => (done = true));
      await new Promise((r) => setTimeout(r, 700));
      expect(done).toBe(false);
      const waiting = (await adminQuery("select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and query ilike '%create_client_group%'")).rows[0].n;
      expect(waiting).toBeGreaterThanOrEqual(1);
      release(); await holder;
      expect(await pending).toBe("created");
      await adminQuery("delete from public.client_group_memberships where studio_id=$1", [s.studioId]);
      await adminQuery("delete from public.client_groups where studio_id=$1", [s.studioId]);
    });
  });

  it("DOWN restores the whole catalog exactly, and UP is repeatable", async () => {
    // the shared fixtures would be removed by DOWN anyway; clear memberships/groups so DOWN is a pure DDL step
    for (const s of [a.s, b.s]) {
      await adminQuery("delete from public.client_group_memberships where studio_id=$1", [s.studioId]);
      await adminQuery("delete from public.client_groups where studio_id=$1", [s.studioId]);
    }
    await down();
    expect(await fingerprint(), "after DOWN").toBe(before);
    await apply();
    expect(await fingerprint(), "after UP again").toBe(afterUp);
  });
});
