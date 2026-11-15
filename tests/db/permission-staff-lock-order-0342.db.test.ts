import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, resolveLocalDbUrl, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0342 lock order (Codex P2 on #1446/#1448: 4571004182, 4571048877, 4571157071, 4571122379, 4571160115).
// Every command that touches a membership takes: studio row (FOR NO KEY UPDATE) -> capacity lock -> membership-kind lock -> membership row.
// Appointment writers take studio row FOR UPDATE -> capacity lock (0150, 0170, 0220); receptionist commands take the kind lock before the row (0216, 0218).
// These are REAL two-session tests: session A plays the other writer and holds its first lock; session B runs the command and must be blocked on a lock;
// then A asks for its second lock. With the wrong order Postgres aborts one side with 40P01 (deadlock_detected); with the right order A gets its lock,
// commits, and B finishes. Synthetic data only. NOT RUN until an OPS slot is granted and 0342 is on an owned isolated stack.

const REASON = "Left the studio at the end of the month";
const url = () => resolveLocalDbUrl();

async function open(): Promise<Client> {
  const c = new Client({ connectionString: url() });
  await c.connect();
  await c.query("begin");
  return c;
}
async function asUserTx(userId: string): Promise<Client> {
  const c = await open();
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  await c.query("set local lock_timeout = '20s'");
  return c;
}
const pidOf = async (c: Client) => (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;

// Resolves once the backend `pid` is waiting on a lock held by someone else (or rejects after ~10 s).
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const r = await adminQuery("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

type Outcome = { ok: true; result: any } | { ok: false; code: string | undefined };
async function settle(p: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, result: await p };
  } catch (e: any) {
    return { ok: false, code: e?.code };
  }
}

const openGate = (studioId: string) =>
  adminQuery("insert into public.permission_ship_gates(studio_id,gate,met) values ($1,'staff_role_change',true) on conflict (studio_id,gate) do update set met=true", [studioId]);

async function seedDesk(s: SeededStudio, label: string, active: boolean) {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `${label}-${userId.slice(0, 8)}@harness.local`]);
  const r = await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,email,active) values ($1,$2,$3,$4,$5) returning id",
    [s.studioId, userId, `Desk ${label}`, `${label}-${userId.slice(0, 8)}@harness.local`, active],
  );
  return { userId, id: r.rows[0].id as string };
}

afterAll(async () => {
  await closePool();
});

describe("0342 lock order: no deadlock with the other writers", () => {
  it("change_staff_role (practitioner to receptionist, first time) does not deadlock with a booking-style writer: studio row FOR UPDATE, then capacity lock", async () => {
    const s = await seedStudio("lo1");
    await openGate(s.studioId);
    const m = await seedMember(s, "lo1m");
    const a = await open(); // the booking writer
    const b = await asUserTx(s.userId); // the owner's command
    try {
      await a.query("select 1 from public.studios where id = $1 for update", [s.studioId]);
      const cmd = settle(b.query("select public.change_staff_role($1,$2,'receptionist','practitioner',$3) as r", [s.studioId, m.practitionerId, REASON]));
      await waitUntilBlocked(await pidOf(b));
      const second = await settle(a.query("select public.acquire_studio_capacity_lock($1)", [s.studioId]));
      expect(second, "the booking writer must get its capacity lock (no 40P01)").toEqual(expect.objectContaining({ ok: true }));
      await a.query("commit");
      const done = await cmd;
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect((done as any).result.rows[0].r).toMatchObject({ ok: true, role: "receptionist" });
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it("reactivate_staff_member (practitioner) does not deadlock with the same booking-style writer", async () => {
    const s = await seedStudio("lo2");
    await openGate(s.studioId);
    const m = await seedMember(s, "lo2m");
    await adminQuery("update public.practitioners set active = false where id = $1", [m.practitionerId]);
    const a = await open();
    const b = await asUserTx(s.userId);
    try {
      await a.query("select 1 from public.studios where id = $1 for update", [s.studioId]);
      const cmd = settle(b.query("select public.reactivate_staff_member($1,$2,'practitioner',$3) as r", [s.studioId, m.practitionerId, REASON]));
      await waitUntilBlocked(await pidOf(b));
      expect(await settle(a.query("select public.acquire_studio_capacity_lock($1)", [s.studioId]))).toEqual(expect.objectContaining({ ok: true }));
      await a.query("commit");
      const done = await cmd;
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect((done as any).result.rows[0].r).toMatchObject({ ok: true, active: true });
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it("deactivate_staff_member (practitioner) does not deadlock with the same booking-style writer", async () => {
    const s = await seedStudio("lo3");
    const m = await seedMember(s, "lo3m");
    const a = await open();
    const b = await asUserTx(s.userId);
    try {
      await a.query("select 1 from public.studios where id = $1 for update", [s.studioId]);
      const cmd = settle(b.query("select public.deactivate_staff_member($1,$2,'practitioner',$3) as r", [s.studioId, m.practitionerId, REASON]));
      await waitUntilBlocked(await pidOf(b));
      expect(await settle(a.query("select public.acquire_studio_capacity_lock($1)", [s.studioId]))).toEqual(expect.objectContaining({ ok: true }));
      await a.query("commit");
      const done = await cmd;
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect((done as any).result.rows[0].r).toMatchObject({ ok: true, active: false });
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it("reactivate_staff_member (receptionist) does not deadlock with a command that holds the membership-kind lock and then wants the receptionist row (add_studio_receptionist / invitation acceptance order)", async () => {
    const s = await seedStudio("lo4");
    await openGate(s.studioId);
    const d = await seedDesk(s, "lo4d", false);
    const a = await open();
    const b = await asUserTx(s.userId);
    try {
      await a.query("select public.studio_membership_kind_lock($1,$2)", [s.studioId, d.userId]);
      const cmd = settle(b.query("select public.reactivate_staff_member($1,$2,'receptionist',$3) as r", [s.studioId, d.id, REASON]));
      await waitUntilBlocked(await pidOf(b)); // B waits for the kind lock WITHOUT holding the row
      expect(await settle(a.query("select 1 from public.studio_receptionists where id = $1 for update", [d.id]))).toEqual(expect.objectContaining({ ok: true }));
      await a.query("commit");
      const done = await cmd;
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect((done as any).result.rows[0].r).toMatchObject({ ok: true, active: true });
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it("deactivate_staff_member (receptionist) takes the same order", async () => {
    const s = await seedStudio("lo5");
    const d = await seedDesk(s, "lo5d", true);
    const a = await open();
    const b = await asUserTx(s.userId);
    try {
      await a.query("select public.studio_membership_kind_lock($1,$2)", [s.studioId, d.userId]);
      const cmd = settle(b.query("select public.deactivate_staff_member($1,$2,'receptionist',$3) as r", [s.studioId, d.id, REASON]));
      await waitUntilBlocked(await pidOf(b));
      expect(await settle(a.query("select 1 from public.studio_receptionists where id = $1 for update", [d.id]))).toEqual(expect.objectContaining({ ok: true }));
      await a.query("commit");
      const done = await cmd;
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect((done as any).result.rows[0].r).toMatchObject({ ok: true, active: false });
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it("change_staff_role (receptionist to practitioner) takes the kind lock before the receptionist row", async () => {
    const s = await seedStudio("lo6");
    await openGate(s.studioId);
    const d = await seedDesk(s, "lo6d", true);
    const a = await open();
    const b = await asUserTx(s.userId);
    try {
      await a.query("select public.studio_membership_kind_lock($1,$2)", [s.studioId, d.userId]);
      const cmd = settle(b.query("select public.change_staff_role($1,$2,'practitioner','receptionist',$3) as r", [s.studioId, d.id, REASON]));
      await waitUntilBlocked(await pidOf(b));
      expect(await settle(a.query("select 1 from public.studio_receptionists where id = $1 for update", [d.id]))).toEqual(expect.objectContaining({ ok: true }));
      await a.query("commit");
      const done = await cmd;
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect((done as any).result.rows[0].r).toMatchObject({ ok: true, role: "practitioner" });
      await b.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it("the commands still serialise with a booking writer: while the writer holds the studio row, the command waits and then sees the writer's appointment", async () => {
    const s = await seedStudio("lo7");
    await openGate(s.studioId);
    const m = await seedMember(s, "lo7m");
    const a = await open();
    const b = await asUserTx(s.userId);
    try {
      await a.query("select 1 from public.studios where id = $1 for update", [s.studioId]);
      await a.query("select public.acquire_studio_capacity_lock($1)", [s.studioId]);
      await a.query(
        `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
         values ($1,$2,$3,$4, now() + interval '3 days', now() + interval '3 days 30 minutes', 30, 'confirmed')`,
        [randomUUID(), s.studioId, m.practitionerId, s.clientId],
      );
      const cmd = settle(b.query("select public.change_staff_role($1,$2,'receptionist','practitioner',$3) as r", [s.studioId, m.practitionerId, REASON]));
      await waitUntilBlocked(await pidOf(b));
      await a.query("commit");
      const done = await cmd;
      expect(done.ok, JSON.stringify(done)).toBe(true);
      // RF-1: the count happened AFTER the writer committed, so the role change is refused rather than overtaken
      expect((done as any).result.rows[0].r).toMatchObject({ ok: false, code: "has_upcoming_appointments" });
      await b.query("rollback");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });
});
