import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";
import { patchedNames, patchedWhere, proposalHandle } from "./helpers/managed-appointments-proposal";

// APPLIED-STATE qualification of the studio-managed proposal. The sibling file
// proves the proposal inside a rolled-back transaction; two behaviours need real
// COMMITTED state and two real connections:
//   1. with the mode OFF, a valid request passes through EACH patched command;
//   2. the setter versus a public booking: the guard's NO KEY UPDATE and the
//      booking command's own FOR UPDATE serialize with no deadlock.
// The proposal is applied for real in beforeAll and put back in afterAll from the
// definitions read before it; the test then asserts the catalog is exactly as it
// was. DB test files run serially (fileParallelism: false), so no other file sees
// the applied state. A numbered migration is NOT assumed.
const patched = patchedNames;
const rows = async (text: string, params: unknown[] = []) => (await adminQuery(text, params)).rows;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

const handle = proposalHandle();

beforeAll(() => handle.apply());

// Tears down only what THIS suite applied; a refused (already-applied) run touches nothing.
afterAll(async () => {
  try { await handle.teardown(); } finally { await closePool(); }
});

type Fx = { studioId: string; userId: string; clientId: string; serviceId: string };

async function fixture(label: string): Promise<Fx> {
  const s = await seedStudio(`sma-${label}`);
  const svc = await rows(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Consultation',30,true,'consultation') returning id`, [s.studioId]);
  for (let d = 0; d < 7; d += 1) {
    await adminQuery(`insert into public.studio_availability_default (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id) values ($1,$2,true,'08:00','20:00',null)`, [s.studioId, d]);
  }
  await adminQuery(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, clientId: s.clientId, serviceId: svc[0].id };
}
/** The nth legal slot, from the booking path's own candidate generator. */
async function slot(f: Fx, nth: number): Promise<string> {
  for (let day = 2; day < 30; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await rows(`select c from public.public_booking_slot_candidates($1,$2::date,30) c`, [f.studioId, when]);
    if (cands.length > nth) return cands[nth].c as string;
  }
  throw new Error("no legal slot");
}
const apptCount = async (studio: string) => (await rows(`select count(*)::int as n from public.appointments where studio_id=$1`, [studio]))[0].n as number;
const modeOf = async (studio: string) => (await rows(`select studio_managed_appointments as m from public.studios where id=$1`, [studio]))[0].m as boolean;

/** Admit + prove a waitlist entry; the redeeming commands take it from here. */
async function provenEntry(f: Fx, label: string) {
  const email = `w-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await rows(`select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`, [f.studioId, f.userId, email]);
  expect(e[0].result).toBe("created");
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await rows(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,1000)`, [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to]);
  expect(a[0].result).toBe("admitted");
  const b = await rows(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
  const c = await rows(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge]);
  return { entryId: e[0].entry_id as string, email, token: a[0].raw_token as string, cap: c[0].raw_capability as string };
}

describe("mode OFF: a valid request passes through each patched command", () => {
  it("every patched command carries the guard (the applied catalog, not the proposal text)", async () => {
    const guarded = await rows(
      `select p.proname, position('assert_client_self_service_open' in p.prosrc) > 0 as has from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${patchedWhere}`, [patched]);
    expect(guarded).toHaveLength(8);
    expect(guarded.every(r => r.has)).toBe(true);
  });

  it("the commands outside the guarded set are unreachable by a client (the README's list)", async () => {
    // dropped by earlier migrations: nothing to guard, and a re-creation must be a deliberate change
    expect(await rows(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('reschedule_appointment','finalize_card_required_public_booking')`)).toEqual([]);
    // no client-facing grant, not even the service role
    const core = await rows(`select has_function_privilege('anon',p.oid,'execute') as anon, has_function_privilege('authenticated',p.oid,'execute') as auth, has_function_privilege('service_role',p.oid,'execute') as svc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='cancel_appointment_core'`);
    expect(core).toEqual([{ anon: false, auth: false, svc: false }]);
    // the v2 wrapper delegates to the guarded v3
    const wrapper = await rows(`select p.prosrc ilike '%reschedule_appointment_v3%' as delegates from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='reschedule_appointment_v2'`);
    expect(wrapper).toEqual([{ delegates: true }]);
  });

  it("create_public_appointment, create_public_appointment_v2 and the cancel/reschedule pair on a booked appointment", async () => {
    const f = await fixture("a");
    expect(await modeOf(f.studioId)).toBe(false);
    const h1 = hash64();
    const r1 = await rows(`select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`, [f.studioId, f.clientId, f.serviceId, await slot(f, 0), h1]);
    expect(r1[0].result).toBe("created");
    const h2 = hash64();
    const r2 = await rows(`select * from public.create_public_appointment_v2($1,$2,$3,$4::timestamptz,$5,null,null,null)`, [f.studioId, f.clientId, f.serviceId, await slot(f, 3), h2]);
    expect(r2[0].result).toBe("created");
    expect(await apptCount(f.studioId)).toBe(2);

    // reschedule_appointment_v3 of the first appointment onto a free slot
    const h3 = hash64();
    const moved = await rows(`select * from public.reschedule_appointment_v3($1,$2,$3::timestamptz,$4,false,null)`, [r1[0].appointment_id, h1, await slot(f, 6), h3]);
    expect(moved[0].result, JSON.stringify(moved[0])).toBe("success");
    // public_cancel_appointment_with_token (7 arguments) cancels the second one
    // the presented policy hash is the digest of the studio's (empty) policy text, as the command derives it
    const cancelled = await rows(`select * from public.public_cancel_appointment_with_token($1,null,null,null,false,false,encode(extensions.digest(E'\\n---\\n','sha256'),'hex'))`, [h2]);
    expect(cancelled[0].result, JSON.stringify(cancelled[0])).toBe("cancelled");
  });

  it("create_public_appointment_for_new_client and _v2", async () => {
    const f = await fixture("b");
    await adminTx(async q => {
      await q("select set_config('hone.admission_mode_studio_id', $1, true)", [f.studioId]);
      await q("update public.studios set new_client_admission_mode = 'open', new_client_admission_mode_set_at = now() where id = $1", [f.studioId]);
    });
    const mk = (n: 1 | 2, start: string, hash: string) => n === 1
      ? rows(`select * from public.create_public_appointment_for_new_client($1,$2,'Prospect',$3,'+15555550101',now(),$4,$5::timestamptz,$6,false,null,null,null)`, [f.studioId, null, `nc1-${f.studioId.slice(0, 8)}@example.com`, f.serviceId, start, hash])
      : rows(`select * from public.create_public_appointment_for_new_client_v2($1,$2,'Prospect',$3,'+15555550102',now(),$4,$5::timestamptz,$6,false,null,null,null,null)`, [f.studioId, null, `nc2-${f.studioId.slice(0, 8)}@example.com`, f.serviceId, start, hash]);
    for (const [n, i] of [[1, 0], [2, 3]] as const) {
      const r = await mk(n, await slot(f, i), hash64());
      expect(r[0].result, JSON.stringify(r[0])).toBe("created");
    }
    expect(await apptCount(f.studioId)).toBe(2);
  });

  it("create_waitlist_public_appointment and redeem_and_book_waitlist_invitation", async () => {
    const f = await fixture("c");
    // create_waitlist_public_appointment: a redeemed entry books the existing client bound to its address
    const p = await provenEntry(f, "wl");
    const red = await rows(`select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`, [p.token, p.cap]);
    expect(red[0].result).toBe("redeemed");
    const found = await rows(`select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`, [f.studioId, p.email]);
    const wl = await rows(`select * from public.create_waitlist_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,null,null)`, [f.studioId, found[0].client_id, f.serviceId, await slot(f, 0), hash64(), red[0].entry_id]);
    expect(wl[0].result, JSON.stringify(wl[0])).toBe("created_and_converted");
    // redeem_and_book_waitlist_invitation: a second proven entry, redeemed inside the command
    const q = await provenEntry(f, "rb");
    const rb = await rows(
      `select * from public.redeem_and_book_waitlist_invitation($1,$2,$3,null,'Prospect',$4,'+15555550123',null,$5,$6::timestamptz,$7,false,null,null)`,
      [q.token, q.cap, f.studioId, q.email, f.serviceId, await slot(f, 4), hash64()]);
    expect(["created", "created_and_converted"], JSON.stringify(rb[0])).toContain(rb[0].result);
    expect(await apptCount(f.studioId)).toBe(2);
  });
});

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}
const pidOf = async (c: Client) => (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;
async function waitUntilBlocked(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rows(`select wait_event_type from pg_stat_activity where pid=$1`, [pid]);
    if (r[0]?.wait_event_type === "Lock") return true;
    await new Promise(res => setTimeout(res, 100));
  }
  return false;
}
const book = (c: Client, f: Fx, start: string) =>
  c.query(`select * from public.create_public_appointment_v2($1,$2,$3,$4::timestamptz,$5,null,null,null)`, [f.studioId, f.clientId, f.serviceId, start, hash64()]);
/** The setter, as the owner would call it through PostgREST: authenticated role + jwt claims, in a transaction. */
async function beginSetter(c: Client, f: Fx) {
  await c.query("begin");
  await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: f.userId, role: "authenticated" })]);
  await c.query("set local role authenticated");
}

describe("the setter versus public bookings: two connections, no deadlock", () => {
  it("a booking in flight holds the setter back; the booking stands; the mode then turns on", async () => {
    const f = await fixture("r1");
    const B = await conn(), A = await conn();
    const pidA = await pidOf(A);
    try {
      await B.query("begin");
      expect((await book(B, f, await slot(f, 0))).rows[0].result).toBe("created");
      await beginSetter(A, f);
      const setter = A.query(`select public.set_studio_managed_appointments($1,true) as enabled`, [f.studioId]);
      expect(await waitUntilBlocked(pidA)).toBe(true);
      await B.query("commit");
      expect((await setter).rows[0].enabled).toBe(true);
      await A.query("commit");
      expect(await apptCount(f.studioId)).toBe(1);
      expect(await modeOf(f.studioId)).toBe(true);
    } finally { await A.query("rollback").catch(() => undefined); await B.query("rollback").catch(() => undefined); await A.end(); await B.end(); }
  });

  it("a setter in flight holds the booking back; the booking is then refused with no record", async () => {
    const f = await fixture("r2");
    const B = await conn(), A = await conn();
    const pidB = await pidOf(B);
    try {
      await beginSetter(A, f);
      await A.query(`select public.set_studio_managed_appointments($1,true)`, [f.studioId]);
      await B.query("begin");
      const booking = book(B, f, await slot(f, 0)).then(() => ({ code: "none" }), (e: { code?: string }) => ({ code: e.code ?? "?" }));
      expect(await waitUntilBlocked(pidB)).toBe(true);
      await A.query("commit");
      expect((await booking).code).toBe("42501");
      await B.query("rollback");
      expect(await apptCount(f.studioId)).toBe(0);
    } finally { await A.query("rollback").catch(() => undefined); await B.query("rollback").catch(() => undefined); await A.end(); await B.end(); }
  });

  it("two bookings and the setter at once: no deadlock, no booking after the mode is on", async () => {
    const f = await fixture("r3");
    const B1 = await conn(), B2 = await conn(), A = await conn();
    const pidA = await pidOf(A), pidB2 = await pidOf(B2);
    try {
      await B1.query("begin");
      expect((await book(B1, f, await slot(f, 0))).rows[0].result).toBe("created");
      await beginSetter(A, f);
      const setter = A.query(`select public.set_studio_managed_appointments($1,true)`, [f.studioId]).then(() => "set", (e: { code?: string }) => e.code ?? "?");
      expect(await waitUntilBlocked(pidA)).toBe(true);
      await B2.query("begin");
      const second = book(B2, f, await slot(f, 3)).then(() => "created", (e: { code?: string }) => e.code ?? "?");
      expect(await waitUntilBlocked(pidB2)).toBe(true);
      await B1.query("commit");
      expect(await setter).toBe("set");
      await A.query("commit");
      const outcome = await second;
      // The second booking either serialised before the setter or was refused by it. It is never a deadlock.
      expect(["created", "42501"]).toContain(outcome);
      expect(outcome).not.toBe("40P01");
      await B2.query(outcome === "created" ? "commit" : "rollback");
      // after the mode is on, a fresh booking is refused
      const late = await book(B2, f, await slot(f, 6)).then(() => "created", (e: { code?: string }) => e.code ?? "?");
      expect(late).toBe("42501");
    } finally { for (const c of [A, B1, B2]) { await c.query("rollback").catch(() => undefined); await c.end(); } }
  });
});
