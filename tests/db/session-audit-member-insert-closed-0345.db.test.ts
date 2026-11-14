import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  closePool,
  seedLegacyRecordStatus,
  seedMember,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// 0345 (Untangle M1-04): a studio member has no direct INSERT into session_audit. Rows are written only by the governed session commands, which
// run as the table owner. Synthetic placeholder values only; no clinical text.

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let sessionB: string;
let colleague: { userId: string; practitionerId: string };

const rows = async (sessionId: string) =>
  (await adminQuery(`select count(*)::int as n from public.session_audit where session_id = $1`, [sessionId])).rows[0].n as number;

// A direct insert as `userId`, attributed to `editedBy`. The refusal must come from the PRIVILEGE (permission denied), not only from RLS: a
// dropped policy alone would still leave the grant, and a future permissive policy would reopen the path.
const insertAudit = (userId: string, sessionId: string, editedBy: string, editedAt?: string) =>
  userQuery(
    userId,
    `insert into public.session_audit (session_id, edited_by_practitioner_id, field, old_value, new_value, edited_at)
     values ($1, $2, 'started_at', 'x', 'y', coalesce($3::timestamptz, now()))`,
    [sessionId, editedBy, editedAt ?? null],
  );
const DENIED = /permission denied for table session_audit/i;

beforeAll(async () => {
  A = await seedStudio("sa0345-a");
  B = await seedStudio("sa0345-b");
  sessionA = (await seedSession(A)).sessionId;
  sessionB = (await seedSession(B)).sessionId;
  colleague = await seedMember(A, "col");
});
afterAll(async () => {
  await closePool();
});

describe("0345: a member cannot write a session_audit row by hand", () => {
  it("the owner is refused for an own-studio session, self-attributed (the old approved path)", async () => {
    const before = await rows(sessionA);
    await expect(insertAudit(A.userId, sessionA, A.practitionerId)).rejects.toThrow(DENIED);
    expect(await rows(sessionA)).toBe(before);
  });

  it("an ordinary practitioner is refused the same way", async () => {
    const before = await rows(sessionA);
    await expect(insertAudit(colleague.userId, sessionA, colleague.practitionerId)).rejects.toThrow(DENIED);
    expect(await rows(sessionA)).toBe(before);
  });

  it("a BACKDATED row is refused (edited_at was the writer's to choose)", async () => {
    const before = await rows(sessionA);
    await expect(insertAudit(A.userId, sessionA, A.practitionerId, "2020-01-01T00:00:00Z")).rejects.toThrow(DENIED);
    expect(await rows(sessionA)).toBe(before);
    expect((await adminQuery(`select count(*)::int n from public.session_audit where session_id=$1 and edited_at < '2021-01-01'`, [sessionA])).rows[0].n).toBe(0);
  });

  it("a row attributed to a colleague is refused too (attribution was never the only problem)", async () => {
    await expect(insertAudit(A.userId, sessionA, colleague.practitionerId)).rejects.toThrow(DENIED);
  });

  it("a legacy FINALIZED session is refused", async () => {
    const fin = await seedSession(A);
    await seedLegacyRecordStatus(fin.sessionId, "finalized");
    const before = await rows(fin.sessionId);
    await expect(insertAudit(A.userId, fin.sessionId, A.practitionerId)).rejects.toThrow(DENIED);
    expect(await rows(fin.sessionId)).toBe(before);
  });

  it("a column-limited insert, and an insert that selects its values, are refused (no column-level back door)", async () => {
    await expect(userQuery(A.userId, `insert into public.session_audit (session_id, field) values ($1, 'f')`, [sessionA])).rejects.toThrow(DENIED);
    await expect(
      userQuery(A.userId, `insert into public.session_audit (session_id, field) select $1::uuid, 'f'`, [sessionA]),
    ).rejects.toThrow(DENIED);
    await expect(
      userQuery(A.userId, `insert into public.session_audit (id, session_id, field) values (gen_random_uuid(), $1, 'f') on conflict (id) do nothing`, [sessionA]),
    ).rejects.toThrow(DENIED);
  });

  it("the cross-tenant refusal still holds (Studio A cannot write Studio B's history)", async () => {
    const before = await rows(sessionB);
    await expect(insertAudit(A.userId, sessionB, A.practitionerId)).rejects.toThrow();
    await expect(insertAudit(A.userId, sessionB, B.practitionerId)).rejects.toThrow();
    expect(await rows(sessionB)).toBe(before);
  });

  it("anon and a non-member are refused", async () => {
    await expect(
      asRole("anon", (q) => q(`insert into public.session_audit (session_id, field) values ($1, 'f')`, [sessionA])),
    ).rejects.toThrow(DENIED);
    await expect(insertAudit(randomUUID(), sessionA, A.practitionerId)).rejects.toThrow();
  });
});

describe("0345: census and privileges", () => {
  it("no INSERT privilege for anon, authenticated or PUBLIC, at table or column level", async () => {
    const r = (
      await adminQuery(
        `select has_table_privilege('anon','public.session_audit','INSERT') as anon_t,
                has_table_privilege('authenticated','public.session_audit','INSERT') as auth_t,
                has_any_column_privilege('anon','public.session_audit','INSERT') as anon_c,
                has_any_column_privilege('authenticated','public.session_audit','INSERT') as auth_c,
                exists (select 1 from pg_class c, lateral aclexplode(c.relacl) a
                         where c.oid='public.session_audit'::regclass and a.grantee=0 and a.privilege_type='INSERT') as public_t,
                exists (select 1 from pg_attribute pa, lateral aclexplode(pa.attacl) a
                         where pa.attrelid='public.session_audit'::regclass and pa.attacl is not null and a.grantee=0 and a.privilege_type='INSERT') as public_c`,
      )
    ).rows[0];
    expect(r).toEqual({ anon_t: false, auth_t: false, anon_c: false, auth_c: false, public_t: false, public_c: false });
  });

  it("the policy set is exactly one SELECT policy: no INSERT, UPDATE, DELETE or ALL policy", async () => {
    const r = (
      await adminQuery(
        `select p.polname, p.polcmd from pg_policy p where p.polrelid='public.session_audit'::regclass order by p.polname`,
      )
    ).rows;
    expect(r.map((x) => x.polcmd)).toEqual(["r"]);
    expect(r[0].polname).toBe("session_audit_studio_member_read");
  });
});

describe("0345: reads and the governed writers are unchanged", () => {
  it("a member reads their own studio's rows and not another studio's", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.session_audit (id, session_id, edited_by_practitioner_id, field, old_value, new_value) values ($1,$2,$3,'started_at','x','y')`,
      [id, sessionB, B.practitionerId],
    );
    expect((await userQuery(B.userId, `select id from public.session_audit where id=$1`, [id])).rowCount).toBe(1);
    expect((await userQuery(A.userId, `select id from public.session_audit where id=$1`, [id])).rowCount).toBe(0);
  });

  it("UPDATE and DELETE remain blocked and the row survives", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.session_audit (id, session_id, edited_by_practitioner_id, field, old_value, new_value) values ($1,$2,$3,'started_at','orig','y')`,
      [id, sessionB, B.practitionerId],
    );
    expect((await userQuery(B.userId, `update public.session_audit set new_value='tampered' where id=$1`, [id])).rowCount).toBe(0);
    expect((await userQuery(B.userId, `delete from public.session_audit where id=$1`, [id])).rowCount).toBe(0);
    expect((await adminQuery(`select old_value from public.session_audit where id=$1`, [id])).rows[0].old_value).toBe("orig");
  });

  it("edit_session_started_at still records its audit row (definer, table owner)", async () => {
    const s = await seedSession(A);
    const before = await rows(s.sessionId);
    const r = await userQuery(A.userId, `select public.edit_session_started_at($1,$2,$3::timestamptz)`, [s.sessionId, A.clientId, "2026-07-01T15:30:00Z"]);
    expect(r.rows[0].edit_session_started_at).toBe(true);
    expect(await rows(s.sessionId)).toBe(before + 1);
    const row = (await adminQuery(`select field, edited_by_practitioner_id from public.session_audit where session_id=$1 order by edited_at desc limit 1`, [s.sessionId])).rows[0];
    expect(row).toMatchObject({ field: "started_at", edited_by_practitioner_id: A.practitionerId });
  });

  it("soft_delete_session_area still records its audit row (definer, table owner)", async () => {
    const s = await seedSession(A);
    const before = await rows(s.sessionId);
    await userQuery(A.userId, `select * from public.soft_delete_session_area($1,$2,$3)`, [s.sessionId, s.blockId, "recorded on the wrong client"]);
    expect(await rows(s.sessionId)).toBeGreaterThan(before);
  });
});
