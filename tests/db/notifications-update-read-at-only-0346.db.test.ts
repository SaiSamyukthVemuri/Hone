import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedMember, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// 0346: members may only mark notifications read. Synthetic placeholder values only.

let A: SeededStudio;
let B: SeededStudio;
let colleague: { userId: string; practitionerId: string };
let dual: { userId: string };
let rowA: string;
let rowB: string;

const T = "public.practitioner_notifications";
const DENIED = /permission denied for table practitioner_notifications/i;

async function seedRow(studio: SeededStudio, practitionerId: string | null, title = "synthetic title"): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into ${T} (id, studio_id, practitioner_id, event_type, title, body, href) values ($1,$2,$3,'synthetic_event',$4,'synthetic body','/dashboard')`,
    [id, studio.studioId, practitionerId, title],
  );
  return id;
}
const row = async (id: string) => (await adminQuery(`select * from ${T} where id = $1`, [id])).rows[0];

beforeAll(async () => {
  A = await seedStudio("n0346-a");
  B = await seedStudio("n0346-b");
  colleague = await seedMember(A, "col");
  // A user who is an active practitioner of BOTH studios: the membership check alone would let a studio move through.
  const userId = randomUUID();
  const email = `dual-${userId.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
  for (const s of [A, B]) {
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Dual',$4,'practitioner',true)`,
      [randomUUID(), s.studioId, userId, email],
    );
  }
  dual = { userId };
  rowA = await seedRow(A, A.practitionerId);
  rowB = await seedRow(B, B.practitionerId);
});
afterAll(async () => {
  await closePool();
});

describe("0346: members can mark notifications read", () => {
  it("the owner marks unread rows of their studio read (the mark-all statement shape)", async () => {
    const id = await seedRow(A, A.practitionerId);
    const r = await userQuery(
      A.userId,
      `update ${T} set read_at = $2 where studio_id = $1 and read_at is null and id = $3 returning id`,
      [A.studioId, new Date().toISOString(), id],
    );
    expect(r.rowCount).toBe(1);
    expect((await row(id)).read_at).not.toBeNull();
  });

  it("an ordinary practitioner can do the same", async () => {
    const id = await seedRow(A, A.practitionerId);
    const r = await userQuery(colleague.userId, `update ${T} set read_at = now() where id = $1 returning id`, [id]);
    expect(r.rowCount).toBe(1);
    expect((await row(id)).read_at).not.toBeNull();
  });

  it("a member can read the rows of their own studio and not another studio's", async () => {
    expect((await userQuery(A.userId, `select id from ${T} where id = $1`, [rowA])).rowCount).toBe(1);
    expect((await userQuery(A.userId, `select id from ${T} where id = $1`, [rowB])).rowCount).toBe(0);
  });

  it("another studio's rows are not touched by a mark-read", async () => {
    const r = await userQuery(A.userId, `update ${T} set read_at = now() where id = $1 returning id`, [rowB]);
    expect(r.rowCount).toBe(0);
    expect((await row(rowB)).read_at).toBeNull();
  });
});

describe("0346: nothing else on a notification can be changed by a member", () => {
  it("every column other than read_at is refused, by the privilege layer, for every column that exists", async () => {
    const cols = (
      await adminQuery(
        `select column_name from information_schema.columns where table_schema='public' and table_name='practitioner_notifications' and column_name <> 'read_at' order by ordinal_position`,
      )
    ).rows.map((r) => r.column_name as string);
    expect(cols.length).toBeGreaterThanOrEqual(10);
    for (const c of cols) {
      // A self-assignment is type-valid for every column and still needs UPDATE on it.
      await expect(userQuery(A.userId, `update ${T} set "${c}" = "${c}" where id = $1`, [rowA]), c).rejects.toThrow(DENIED);
    }
  });

  it("an update that sets a different value is refused and the row is unchanged", async () => {
    const before = await row(rowA);
    await expect(userQuery(A.userId, `update ${T} set title = 'changed' where id = $1`, [rowA])).rejects.toThrow(DENIED);
    expect(await row(rowA)).toEqual(before);
  });

  it("read_at together with another column is refused as a whole", async () => {
    const id = await seedRow(A, A.practitionerId);
    await expect(userQuery(A.userId, `update ${T} set read_at = now(), body = 'changed' where id = $1`, [id])).rejects.toThrow(DENIED);
    const r = await row(id);
    expect(r.read_at).toBeNull();
    expect(r.body).toBe("synthetic body");
  });

  it("a member of two studios cannot move a row from one to the other", async () => {
    const id = await seedRow(A, A.practitionerId);
    await expect(userQuery(dual.userId, `update ${T} set studio_id = $2 where id = $1`, [id, B.studioId])).rejects.toThrow(DENIED);
    expect((await row(id)).studio_id).toBe(A.studioId);
  });

  it("anon is refused, and a non-member changes nothing", async () => {
    await expect(asRole("anon", (q) => q(`update ${T} set read_at = now() where id = $1`, [rowA]))).rejects.toThrow(DENIED);
    const r = await userQuery(randomUUID(), `update ${T} set read_at = now() where id = $1 returning id`, [rowA]);
    expect(r.rowCount).toBe(0);
  });
});

describe("0346: census and unchanged paths", () => {
  it("only read_at is updatable by authenticated; nothing is updatable by anon or PUBLIC; no table-level grant remains", async () => {
    const r = (
      await adminQuery(
        `select a.attname,
                has_column_privilege('authenticated', 'public.practitioner_notifications', a.attname, 'UPDATE') as auth_u,
                has_column_privilege('anon', 'public.practitioner_notifications', a.attname, 'UPDATE') as anon_u
           from pg_attribute a
          where a.attrelid = 'public.practitioner_notifications'::regclass and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
      )
    ).rows;
    expect(r.filter((x) => x.auth_u).map((x) => x.attname)).toEqual(["read_at"]);
    expect(r.filter((x) => x.anon_u)).toEqual([]);
    const t = (
      await adminQuery(
        `select has_table_privilege('authenticated','${T}','UPDATE') as auth_t,
                has_table_privilege('anon','${T}','UPDATE') as anon_t,
                exists (select 1 from pg_class c, lateral aclexplode(c.relacl) a where c.oid='${T}'::regclass and a.grantee=0 and a.privilege_type='UPDATE') as public_t,
                exists (select 1 from pg_attribute pa, lateral aclexplode(pa.attacl) a where pa.attrelid='${T}'::regclass and pa.attacl is not null and a.grantee=0 and a.privilege_type='UPDATE') as public_c`,
      )
    ).rows[0];
    expect(t).toEqual({ auth_t: false, anon_t: false, public_t: false, public_c: false });
  });

  it("the policies are unchanged: one SELECT and one UPDATE, both to authenticated", async () => {
    const r = (
      await adminQuery(`select polname, polcmd from pg_policy where polrelid='${T}'::regclass order by polname`)
    ).rows;
    expect(r.map((x) => [x.polname, x.polcmd])).toEqual([
      ["practitioner_notifications_member_read", "r"],
      ["practitioner_notifications_member_update", "w"],
    ]);
  });

  it("the server paths are unchanged: service_role still inserts and updates, and the owner still can", async () => {
    await asRole("service_role", async (q) => {
      const id = randomUUID();
      await q(`insert into ${T} (id, studio_id, practitioner_id, event_type, title) values ($1,$2,$3,'synthetic_event','t')`, [id, A.studioId, A.practitionerId]);
      const u = await q(`update ${T} set title = 'server edit' where id = $1 returning id`, [id]);
      expect(u.rowCount).toBe(1);
    });
  });
});
