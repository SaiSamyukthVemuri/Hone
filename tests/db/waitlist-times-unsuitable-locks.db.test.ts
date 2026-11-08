import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0319 — "these times don't work" vs the 0313 redeem-and-book. Each case parks
// one participant on a real lock (pg_stat_activity), lets the other commit, and
// requires a closed answer and NO deadlock (40P01).
// ===========================================================================

const BOOK = `select * from public.redeem_and_book_waitlist_invitation(
  $1,$2,$3,null,'Prospect',$4,'+15555550123',null,$5,$6::timestamptz,$7,false,null,null)`;

afterAll(async () => {
  await closePool();
});

// Per-run salt: the cancellation hash is unique across the whole database, so a
// fixed seed collides with another suite or a re-run.
const tokenHash = (seed: string): string => {
  const salted = `${seed}-${randomUUID()}`;
  return Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(salted.charCodeAt(i % salted.length) + i) % 16]).join("");
};

type Fixture = { studioId: string; userId: string; serviceId: string };

async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`b313-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  for (let d = 0; d < 7; d += 1) {
    await q(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       values ($1,$2,true,'08:00','20:00',null)`,
      [s.studioId, d],
    );
  }
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

async function slots(f: Fixture, n: number): Promise<string[]> {
  for (let day = 2; day < 30; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<{ c: string }>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length >= n) return cands.slice(0, n).map((r) => r.c);
  }
  throw new Error("no legal slots");
}

/** Admit and prove, but do NOT redeem: the app now redeems inside the command. */
async function provenEntry(f: Fixture, label: string) {
  const email = `b3-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, email],
  );
  expect(e[0].result).toBe("created");
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
    [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to],
  );
  expect(a[0].result).toBe("admitted");
  const b = await q<any>(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
  const c = await q<any>(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge]);
  return { entryId: e[0].entry_id as string, email, token: a[0].raw_token as string, cap: c[0].raw_capability as string };
}

const invitationOf = (entryId: string) =>
  q<{ redeemed_at: string | null }>(
    `select redeemed_at from public.new_client_waitlist_invitations where entry_id=$1`, [entryId],
  ).then((r) => r[0]);
const entryStatus = (id: string) =>
  q<{ status: string }>(`select status from public.new_client_waitlist_entries where id=$1`, [id]).then((r) => r[0].status);
const apptCount = (sid: string) =>
  q<{ n: number }>(`select count(*)::int as n from public.appointments where studio_id=$1`, [sid]).then((r) => r[0].n);
const state = (token: string) =>
  q<{ s: string }>(`select public.waitlist_invitation_booking_state($1) as s`, [token]).then((r) => r[0].s);

const connect = async (): Promise<Client> => {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  await c.query("set statement_timeout = 15000");
  return c;
};
const pidOf = async (c: Client) => (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;

type Outcome = { ok: true; value: any } | { ok: false; code: string };
async function inTx(c: Client, fn: (c: Client) => Promise<any>): Promise<Outcome> {
  try {
    await c.query("begin");
    const value = await fn(c);
    await c.query("commit");
    return { ok: true, value };
  } catch (e: any) {
    await c.query("rollback").catch(() => undefined);
    return { ok: false, code: String(e?.code ?? e?.message) };
  }
}

const DECLINE = `select public.decline_waitlist_invitation_times_unsuitable($1,$2,null) as r`;

describe("0319 lock order against 0313", () => {
  it("a booking in flight makes the decline WAIT, then answer not_live; one appointment, entry converted", async () => {
    const f = await fixture("dvb");
    const p = await provenEntry(f, "dvb");
    const [slot] = await slots(f, 1);
    const A = await connect(); const B = await connect();
    try {
      const pidA = await pidOf(A);
      await B.query("begin");
      const booked = await B.query(BOOK, [p.token, p.cap, f.studioId, p.email, f.serviceId, slot, tokenHash("v1")]);
      expect(booked.rows[0].result).toBe("created_and_converted");
      const ra = inTx(A, (c) => c.query(DECLINE, [p.token, p.cap]).then((x) => x.rows[0].r));
      expect(await waitUntilBlocked(pidA, 8000)).not.toBeNull();
      await B.query("commit");
      const xa = await ra;
      expect(xa.ok).toBe(true);
      if (xa.ok) expect(xa.value).toBe("not_live");
    } finally {
      await Promise.all([A.end(), B.end()].map((c) => c.catch(() => undefined)));
    }
    expect(await apptCount(f.studioId)).toBe(1);
    expect(await entryStatus(p.entryId)).toBe("converted");
    const fb = await q(`select 1 from public.waitlist_times_feedback where entry_id=$1`, [p.entryId]);
    expect(fb).toHaveLength(0);
  });

  it("a decline in flight makes the booking WAIT, then refuse; no appointment, entry waiting", async () => {
    const f = await fixture("bvd");
    const p = await provenEntry(f, "bvd");
    const [slot] = await slots(f, 1);
    const A = await connect(); const B = await connect();
    try {
      const pidA = await pidOf(A);
      await B.query("begin");
      const d = await B.query(DECLINE, [p.token, p.cap]);
      expect(d.rows[0].r).toBe("returned_to_waiting");
      const ra = inTx(A, (c) => c.query(BOOK, [p.token, p.cap, f.studioId, p.email, f.serviceId, slot, tokenHash("v2")]).then((x) => x.rows[0]));
      expect(await waitUntilBlocked(pidA, 8000)).not.toBeNull();
      await B.query("commit");
      const xa = await ra;
      expect(xa.ok).toBe(true);
      if (xa.ok) {
        expect(xa.value.appointment_id).toBeNull();
        expect(xa.value.result).toMatch(/^redeem_/);
      }
    } finally {
      await Promise.all([A.end(), B.end()].map((c) => c.catch(() => undefined)));
    }
    expect(await apptCount(f.studioId)).toBe(0);
    expect(await entryStatus(p.entryId)).toBe("waiting");
  });

  it("an owner release in flight makes the decline WAIT, then answer not_live", async () => {
    const f = await fixture("dvr");
    const p = await provenEntry(f, "dvr");
    const A = await connect(); const B = await connect();
    try {
      const pidA = await pidOf(A);
      await B.query("begin");
      const rel = await B.query<{ r: string }>(
        `select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [f.studioId, p.entryId, f.userId],
      );
      expect(rel.rows[0].r).toBe("released");
      const ra = inTx(A, (c) => c.query(DECLINE, [p.token, p.cap]).then((x) => x.rows[0].r));
      expect(await waitUntilBlocked(pidA, 8000)).not.toBeNull();
      await B.query("commit");
      const xa = await ra;
      expect(xa.ok).toBe(true);
      if (xa.ok) expect(xa.value).toBe("not_live");
    } finally {
      await Promise.all([A.end(), B.end()].map((c) => c.catch(() => undefined)));
    }
    expect(await entryStatus(p.entryId)).toBe("released");
  });
});
