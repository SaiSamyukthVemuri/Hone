import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// RBAC Nov-20 matrix, GAP-C3 / C6 / C13 / C15 (revocation, database layer). Synthetic ids only, real role JWTs (asUser = authenticated + jwt sub).
//  C6  a removed member, with their OWN login, reads nothing from the tables a practitioner could read a second earlier. The removal is the real
//      command (set_practitioner_active_locked), not a raw UPDATE. Each table has a positive control: the same member read rows before removal.
//      Limits, stated: only tables the fixture can fill directly are covered (clients, sessions, session_blocks, practitioners, studios,
//      pending_invitations). Appointments, notes, payments and consent are NOT covered here and stay a GAP.
//  C3  a REVOKED invitation cannot be accepted: the accept command finds no invitation and creates no membership (positive control: a pending one is accepted).
//  C13 the owner of studio B cannot revoke studio A's invitation (positive control: the owner of A can revoke their own).
//  C15 removing a member and inviting them again reactivates the SAME row in place (no second membership row), and the invitation is consumed.
// NOT RUN until a database stack exists for the reviewer; this file only proves what it asserts when it passes.

afterAll(async () => {
  await closePool();
});

const email = async (userId: string): Promise<string> => (await adminQuery("select email from auth.users where id=$1", [userId])).rows[0].email;
const invite = async (s: SeededStudio, to: string, role = "practitioner"): Promise<string> =>
  (await adminQuery("insert into public.pending_invitations (studio_id,email,role,display_name,invited_by) values ($1,$2,$3,'Invitee',$4) returning id", [s.studioId, to, role, s.practitionerId])).rows[0].id;
const remove = async (s: SeededStudio, targetPractitionerId: string): Promise<unknown> =>
  (await adminQuery("select public.set_practitioner_active_locked($1,$2,$3,false) as r", [s.studioId, s.practitionerId, targetPractitionerId])).rows[0].r;
const count = (userId: string, table: string): Promise<number> =>
  asUser(userId, async (q) => Number((await q(`select count(*) n from public.${table}`)).rows[0].n));

const TABLES = ["clients", "sessions", "session_blocks", "practitioners", "studios", "pending_invitations"] as const;

describe("C6: a removed member reads nothing from core tables with their own login", () => {
  it("every table: rows before removal (control), zero after, and the owner is unaffected", async () => {
    const A = await seedStudio("rv-core");
    await seedSession(A);
    const m = await seedMember(A, "rv-core-m");
    await invite(A, `someone-${randomUUID().slice(0, 8)}@harness.local`);

    const before: Record<string, number> = {};
    for (const t of TABLES) before[t] = await count(m.userId, t);
    for (const t of TABLES) expect(before[t], `${t} must be readable by an active member (positive control)`).toBeGreaterThan(0);

    expect(await remove(A, m.practitionerId)).toBe("ok");

    for (const t of TABLES) expect(await count(m.userId, t), `${t} must be empty for the removed member`).toBe(0);
    for (const t of TABLES) expect(await count(A.userId, t), `${t} must stay readable by the owner`).toBeGreaterThan(0);
  });

  it("the removed member cannot write either: an update on clients changes nothing", async () => {
    const A = await seedStudio("rv-write");
    const m = await seedMember(A, "rv-write-m");
    expect(await remove(A, m.practitionerId)).toBe("ok");
    const changed = await asUser(m.userId, async (q) => (await q("update public.clients set name='tampered' where studio_id=$1 returning id", [A.studioId])).rowCount);
    expect(changed).toBe(0);
    expect((await adminQuery("select name from public.clients where id=$1", [A.clientId])).rows[0].name).not.toBe("tampered");
  });
});

describe("C3: a revoked invitation cannot be accepted", () => {
  it("revoked: no invitation is found and no membership is created; CONTROL: a pending invitation is accepted", async () => {
    const A = await seedStudio("rv-inv");
    const mk = async (label: string) => {
      const id = randomUUID(); const e = `${label}-${id.slice(0, 8)}@harness.local`;
      await adminQuery("insert into auth.users (id,email) values ($1,$2)", [id, e]);
      return { id, e };
    };
    const revoked = await mk("rv-revoked");
    const inv = await invite(A, revoked.e);
    await adminQuery("update public.pending_invitations set status='revoked' where id=$1", [inv]);
    const r = (await adminQuery("select public.admin_accept_pending_invitation($1) as r", [revoked.id])).rows[0].r;
    expect(r.status).toBe("no_invitation");
    expect((await adminQuery("select count(*) n from public.practitioners where user_id=$1", [revoked.id])).rows[0].n).toBe("0");
    expect((await adminQuery("select status from public.pending_invitations where id=$1", [inv])).rows[0].status).toBe("revoked");

    const ok = await mk("rv-pending");
    await invite(A, ok.e);
    const r2 = (await adminQuery("select public.admin_accept_pending_invitation($1) as r", [ok.id])).rows[0].r;
    expect(r2.status).not.toBe("no_invitation");
    expect((await adminQuery("select count(*) n from public.practitioners where user_id=$1 and studio_id=$2 and active", [ok.id, A.studioId])).rows[0].n).toBe("1");
  });
});

describe("C13: an owner cannot revoke another studio's invitation", () => {
  it("owner of B changes nothing in A's invitation; CONTROL: the owner of A can revoke their own", async () => {
    const A = await seedStudio("rv-own-a");
    const B = await seedStudio("rv-own-b");
    const inv = await invite(A, `foreign-${randomUUID().slice(0, 8)}@harness.local`);
    const byB = await asUser(B.userId, async (q) => (await q("update public.pending_invitations set status='revoked' where id=$1 returning id", [inv])).rowCount);
    expect(byB).toBe(0);
    expect((await adminQuery("select status from public.pending_invitations where id=$1", [inv])).rows[0].status).toBe("pending");
    const byA = await asUser(A.userId, async (q) => (await q("update public.pending_invitations set status='revoked' where id=$1 returning id", [inv])).rowCount);
    expect(byA).toBe(1);
    expect((await adminQuery("select status from public.pending_invitations where id=$1", [inv])).rows[0].status).toBe("revoked");
  });
});

describe("C15: removing and inviting the same person again", () => {
  it("reactivates the same membership row in place; the invitation is consumed; the person sees the studio again", async () => {
    const A = await seedStudio("rv-reinv");
    await seedSession(A);
    const m = await seedMember(A, "rv-reinv-m");
    const e = await email(m.userId);
    expect(await remove(A, m.practitionerId)).toBe("ok");
    expect(await count(m.userId, "clients")).toBe(0);

    const inv = await invite(A, e);
    const r = (await adminQuery("select public.admin_accept_pending_invitation($1) as r", [m.userId])).rows[0].r;
    expect(r.status).not.toBe("no_invitation");
    const rows = (await adminQuery("select id, active, role from public.practitioners where studio_id=$1 and user_id=$2", [A.studioId, m.userId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: m.practitionerId, active: true, role: "practitioner" });
    expect((await adminQuery("select status from public.pending_invitations where id=$1", [inv])).rows[0].status).toBe("accepted");
    expect(await count(m.userId, "clients")).toBeGreaterThan(0);
  });
});
