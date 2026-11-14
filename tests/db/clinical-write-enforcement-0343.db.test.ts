import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0343: write gates on treatment_goals, client_pinned_notes, client_personal_notes, client_budget_context, keyed exactly like the 0335 read side.
// Per table: owner, KEYED practitioner, RESTRICTED practitioner (key ACTIVATED and denied), independent keys, an upsert, an inactive practitioner,
// another studio's member, anon, the service-role/system path, and the budget attribution clause. Synthetic data only.

const KEYS = ["clin.view_records", "client.view_personal_notes", "client.view_budget"] as const;
type Key = (typeof KEYS)[number];
let saved: Array<{ key: string; released_at: string | null; release_tag: string; release_kind: string }> = [];

async function setStored(studioId: string, key: Key, scope: "studio" | "off"): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,$3, now()) on conflict (studio_id,role,key) do update set scope=$3, set_at=now()",
    [studioId, key, scope],
  );
}
beforeAll(async () => {
  saved = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key = any($1)", [[...KEYS]])).rows;
  for (const k of KEYS) {
    await adminQuery("delete from public.permission_key_release where key=$1", [k]);
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,'2000-01-01T00:00:00Z','T0343','full')", [k]);
  }
});
afterAll(async () => {
  await adminQuery("delete from public.permission_key_release where key = any($1)", [[...KEYS]]);
  for (const r of saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  await closePool();
});

type Fix = { s: SeededStudio; member: { userId: string; practitionerId: string } };
async function seed(label: string, denied: readonly Key[] = []): Promise<Fix> {
  const s = await seedStudio(label);
  const member = await seedMember(s, `${label}m`);
  for (const k of denied) await setStored(s.studioId, k, "off");
  return { s, member };
}

type Who = "member" | "owner";
type T = {
  table: string;
  key: Key;
  conflictCol: "client_id" | null;
  insert: (f: Fix, who: Who) => [string, unknown[]];
  seedRow: (f: Fix) => Promise<void>;
  upsert: ((f: Fix, who: Who) => [string, unknown[]]) | null;
  update: ((f: Fix) => [string, unknown[]]) | null;
  readCol: string;
};
const actor = (f: Fix, who: Who) => (who === "owner" ? f.s : f.member);
const practId = (f: Fix, who: Who) => (who === "owner" ? f.s.practitionerId : f.member.practitionerId);

const TABLES: T[] = [
  {
    table: "treatment_goals", key: "clin.view_records", conflictCol: "client_id", readCol: "notes",
    insert: (f) => ["insert into public.treatment_goals (studio_id, client_id, estimated_total_minutes, notes) values ($1,$2,60,'NEW')", [f.s.studioId, f.s.clientId]],
    seedRow: async (f) => { await adminQuery("insert into public.treatment_goals (studio_id, client_id, estimated_total_minutes, notes) values ($1,$2,60,'ORIG')", [f.s.studioId, f.s.clientId]); },
    upsert: (f) => ["insert into public.treatment_goals (studio_id, client_id, estimated_total_minutes, notes) values ($1,$2,60,'NEW') on conflict (client_id) do update set notes = excluded.notes", [f.s.studioId, f.s.clientId]],
    update: (f) => ["update public.treatment_goals set notes='NEW' where client_id=$1", [f.s.clientId]],
  },
  {
    table: "client_pinned_notes", key: "clin.view_records", conflictCol: null, readCol: "text",
    insert: (f, w) => ["insert into public.client_pinned_notes (client_id, studio_id, text, created_by_practitioner_id) values ($1,$2,'NEW',$3)", [f.s.clientId, f.s.studioId, practId(f, w)]],
    seedRow: async (f) => { await adminQuery("insert into public.client_pinned_notes (client_id, studio_id, text, created_by_practitioner_id) values ($1,$2,'ORIG',$3)", [f.s.clientId, f.s.studioId, f.member.practitionerId]); },
    upsert: null,
    update: null, // no UPDATE policy exists (0022); the edit action runs on the service-role client
  },
  {
    table: "client_personal_notes", key: "client.view_personal_notes", conflictCol: "client_id", readCol: "personal_notes",
    insert: (f) => ["insert into public.client_personal_notes (studio_id, client_id, personal_notes) values ($1,$2,'NEW')", [f.s.studioId, f.s.clientId]],
    seedRow: async (f) => { await adminQuery("insert into public.client_personal_notes (studio_id, client_id, personal_notes) values ($1,$2,'ORIG')", [f.s.studioId, f.s.clientId]); },
    upsert: (f) => ["insert into public.client_personal_notes (studio_id, client_id, personal_notes) values ($1,$2,'NEW') on conflict (client_id) do update set personal_notes = excluded.personal_notes", [f.s.studioId, f.s.clientId]],
    update: (f) => ["update public.client_personal_notes set personal_notes='NEW' where client_id=$1", [f.s.clientId]],
  },
  {
    table: "client_budget_context", key: "client.view_budget", conflictCol: "client_id", readCol: "budget_notes",
    insert: (f, w) => ["insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id) values ($1,$2,'somewhat_limited','NEW',$3)", [f.s.clientId, f.s.studioId, practId(f, w)]],
    seedRow: async (f) => { await adminQuery("insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id) values ($1,$2,'somewhat_limited','ORIG',$3)", [f.s.clientId, f.s.studioId, f.member.practitionerId]); },
    upsert: (f, w) => ["insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id) values ($1,$2,'somewhat_limited','NEW',$3) on conflict (client_id) do update set budget_notes = excluded.budget_notes, updated_by_practitioner_id = excluded.updated_by_practitioner_id", [f.s.clientId, f.s.studioId, practId(f, w)]],
    update: (f) => ["update public.client_budget_context set budget_notes='NEW', updated_by_practitioner_id=$2 where client_id=$1", [f.s.clientId, f.member.practitionerId]],
  },
];

async function attempt(userId: string, [q, p]: [string, unknown[]]): Promise<string | null> {
  try { await asUser(userId, async (run) => { await run(q, p); }); return null; } catch (e) { return String(e); }
}
const count = async (t: T, f: Fix) => (await adminQuery(`select count(*)::int n from public.${t.table} where client_id=$1`, [f.s.clientId])).rows[0].n as number;
const stored = async (t: T, f: Fix) => (await adminQuery(`select ${t.readCol} v from public.${t.table} where client_id=$1 order by 1 limit 1`, [f.s.clientId])).rows[0]?.v as string | undefined;
const denies = async (f: Fix, key: Key) => !(await asUser(f.member.userId, async (q) => (await q("select public.has_studio_permission($1,$2) h", [f.s.studioId, key])).rows[0].h as boolean));

for (const t of TABLES) {
  describe(`${t.table} (${t.key})`, () => {
    it("a KEYED practitioner and the owner insert", async () => {
      const f = await seed(`w-k-${t.table.slice(0, 7)}`);
      expect(await attempt(f.member.userId, t.insert(f, "member")), "member").toBeNull();
      expect(await count(t, f)).toBe(1);
      const g = await seed(`w-o-${t.table.slice(0, 7)}`, [t.key]);
      expect(await attempt(g.s.userId, t.insert(g, "owner")), "owner passes with the key off").toBeNull();
    });
    it("a RESTRICTED practitioner (key activated and denied) is refused by row-level security, and no row exists after", async () => {
      const f = await seed(`w-r-${t.table.slice(0, 7)}`, [t.key]);
      expect(await denies(f, t.key), "precondition: the key is denied").toBe(true);
      const err = await attempt(f.member.userId, t.insert(f, "member"));
      expect(err, `${t.table}: restricted insert was ACCEPTED`).not.toBeNull();
      expect(err).toMatch(/row-level security|permission denied/i);
      expect(await count(t, f)).toBe(0);
    });
    it("the key is independent: denying a DIFFERENT key does not block this table", async () => {
      const other = KEYS.filter((k) => k !== t.key);
      const f = await seed(`w-i-${t.table.slice(0, 7)}`, other);
      expect(await attempt(f.member.userId, t.insert(f, "member"))).toBeNull();
    });
    it("an inactive practitioner and another studio's member are refused", async () => {
      const f = await seed(`w-x-${t.table.slice(0, 7)}`);
      await adminQuery("update public.practitioners set active=false where id=$1", [f.member.practitionerId]);
      // refused by RLS or earlier by the studio-derivation trigger (an inactive user cannot see the client); either way nothing is written
      expect(await attempt(f.member.userId, t.insert(f, "member")), "inactive").not.toBeNull();
      expect(await count(t, f), "inactive wrote a row").toBe(0);
      const g = await seed(`w-y-${t.table.slice(0, 7)}`);
      const foreign = await seed(`w-z-${t.table.slice(0, 7)}`);
      expect(await attempt(foreign.member.userId, t.insert(g, "member")), "foreign studio").not.toBeNull();
      expect(await count(t, g)).toBe(0);
    });
    it("anon cannot insert", async () => {
      const f = await seed(`w-a-${t.table.slice(0, 7)}`);
      const [q, p] = t.insert(f, "member");
      let err: string | null = null;
      try { await asRole("anon", async (run) => { await run(q, p); }); } catch (e) { err = String(e); }
      expect(err).not.toBeNull();
      expect(await count(t, f)).toBe(0);
    });
    it("the SYSTEM path (service role / admin connection) is unchanged: it still writes", async () => {
      const f = await seed(`w-s-${t.table.slice(0, 7)}`, [t.key]);
      await t.seedRow(f);
      expect(await stored(t, f)).toBe("ORIG");
    });
    if (t.upsert) {
      it("an UPSERT over an existing row: keyed succeeds and updates; restricted is refused and the stored value is unchanged", async () => {
        const f = await seed(`w-u-${t.table.slice(0, 7)}`);
        await t.seedRow(f);
        expect(await attempt(f.member.userId, t.upsert!(f, "member")), "keyed upsert").toBeNull();
        expect(await stored(t, f)).toBe("NEW");
        const g = await seed(`w-v-${t.table.slice(0, 7)}`, [t.key]);
        await t.seedRow(g);
        expect(await attempt(g.member.userId, t.upsert!(g, "member")), "restricted upsert").not.toBeNull();
        expect(await stored(t, g)).toBe("ORIG");
      });
    }
    if (t.update) {
      it("an UPDATE: keyed succeeds; restricted changes nothing", async () => {
        const f = await seed(`w-p-${t.table.slice(0, 7)}`);
        await t.seedRow(f);
        expect(await attempt(f.member.userId, t.update!(f))).toBeNull();
        expect(await stored(t, f)).toBe("NEW");
        const g = await seed(`w-q-${t.table.slice(0, 7)}`, [t.key]);
        await t.seedRow(g);
        await attempt(g.member.userId, t.update!(g));
        expect(await stored(t, g)).toBe("ORIG");
      });
    }
  });
}

describe("moves and attribution", () => {
  it("a keyed practitioner cannot move a goal, personal note or budget row into another studio (WITH CHECK)", async () => {
    for (const [table, setSql] of [["treatment_goals", "studio_id"], ["client_personal_notes", "studio_id"], ["client_budget_context", "studio_id"]] as const) {
      const f = await seed(`w-m-${table.slice(0, 7)}`);
      const other = await seed(`w-n-${table.slice(0, 7)}`);
      await TABLES.find((x) => x.table === table)!.seedRow(f);
      await attempt(f.member.userId, [`update public.${table} set ${setSql}=$2 where client_id=$1`, [f.s.clientId, other.s.studioId]]);
      expect((await adminQuery(`select studio_id from public.${table} where client_id=$1`, [f.s.clientId])).rows[0].studio_id, table).toBe(f.s.studioId);
    }
  });
  it("budget: a keyed practitioner cannot write a row attributed to a COLLEAGUE (the 0183 attribution clause is kept)", async () => {
    const f = await seed("w-attr");
    const err = await attempt(f.member.userId, ["insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id) values ($1,$2,'somewhat_limited','x',$3)", [f.s.clientId, f.s.studioId, f.s.practitionerId]]);
    expect(err).toMatch(/row-level security/i);
  });
  it("the pinned-note owner-only DELETE and the absence of an UPDATE policy are unchanged", async () => {
    const pol = (await adminQuery("select polname, polcmd from pg_policy where polrelid='public.client_pinned_notes'::regclass order by 1")).rows.map((r) => `${r.polname}:${r.polcmd}`);
    expect(pol).toEqual([
      "client_pinned_notes_owner_delete:d",
      "client_pinned_notes_studio_member_insert:a",
      "client_pinned_notes_studio_member_read:r",
    ]);
  });
  it("census: each of the four tables has exactly one INSERT policy (and, except pinned notes, one UPDATE policy), all `authenticated` only", async () => {
    const rows = (await adminQuery(
      `select c.relname t, p.polcmd cmd, (select array_agg(r.rolname::text) from pg_roles r where r.oid = any(p.polroles)) roles
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relname in ('treatment_goals','client_pinned_notes','client_personal_notes','client_budget_context') and p.polcmd in ('a','w')`,
    )).rows;
    for (const t of TABLES) {
      expect(rows.filter((r) => r.t === t.table && r.cmd === "a").length, `${t.table} insert`).toBe(1);
      expect(rows.filter((r) => r.t === t.table && r.cmd === "w").length, `${t.table} update`).toBe(t.update ? 1 : 0);
    }
    for (const r of rows) expect(r.roles, `${r.t}/${r.cmd}`).toEqual(["authenticated"]);
  });
  it("a pending (unreleased) key keeps today's behaviour: a practitioner still writes (resolves to the snapshot)", async () => {
    await adminQuery("update public.permission_key_release set released_at = null where key='client.view_budget'");
    try {
      const f = await seed("w-pend");
      const t = TABLES.find((x) => x.table === "client_budget_context")!;
      expect(await attempt(f.member.userId, t.insert(f, "member"))).toBeNull();
    } finally {
      await adminQuery("update public.permission_key_release set released_at = '2000-01-01T00:00:00Z' where key='client.view_budget'");
    }
  });
});
