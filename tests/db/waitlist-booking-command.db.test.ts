import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0313 — redeem_and_book_waitlist_invitation: a refused booking leaves the
// invitation live. The failing-first characterization of the old behaviour is
// tests/db/waitlist-conflict-recovery.db.test.ts.
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
  q<{ s: string }>(`select state as s from public.waitlist_invitation_booking_state($1)`, [token]).then((r) => r[0].s);

describe("0313 redeem_and_book_waitlist_invitation", () => {
  it("books once, converts the entry and spends the invitation", async () => {
    const f = await fixture("ok");
    const p = await provenEntry(f, "ok");
    const [slot] = await slots(f, 1);
    const r = await q<any>(BOOK, [p.token, p.cap, f.studioId, p.email, f.serviceId, slot, tokenHash("ok")]);
    expect(r[0].result).toBe("created_and_converted");
    expect(r[0].appointment_id).not.toBeNull();
    expect(await entryStatus(p.entryId)).toBe("converted");
    expect((await invitationOf(p.entryId)).redeemed_at).not.toBeNull();
    expect(await state(p.token)).toBe("booked");
    const when = await q<{ starts_at: string | null }>(
      `select starts_at from public.waitlist_invitation_booking_state($1)`, [p.token],
    );
    expect(new Date(when[0].starts_at as string).toISOString()).toBe(new Date(slot).toISOString());
    expect(await apptCount(f.studioId)).toBe(1);

    // IDEMPOTENT: the same invitation cannot book a second time.
    const again = await q<any>(BOOK, [p.token, p.cap, f.studioId, p.email, f.serviceId, slot, tokenHash("ok2")]);
    expect(again[0].appointment_id).toBeNull();
    expect(await apptCount(f.studioId)).toBe(1);
  });

  it("a contested time leaves the loser's invitation LIVE, and the loser can book another time", async () => {
    const f = await fixture("loser");
    const [t1, t2] = await slots(f, 2);
    const a = await provenEntry(f, "a");
    const b = await provenEntry(f, "b");
    const win = await q<any>(BOOK, [a.token, a.cap, f.studioId, a.email, f.serviceId, t1, tokenHash("wa")]);
    expect(win[0].result).toBe("created_and_converted");

    const lose = await q<any>(BOOK, [b.token, b.cap, f.studioId, b.email, f.serviceId, t1, tokenHash("lb")]);
    expect(lose[0].appointment_id).toBeNull();
    expect(lose[0].result).not.toMatch(/^created/);
    expect(await apptCount(f.studioId)).toBe(1);
    // THE REPAIR: the old chain left this redeemed.
    expect((await invitationOf(b.entryId)).redeemed_at).toBeNull();
    expect(await entryStatus(b.entryId)).toBe("invited");
    expect(await state(b.token)).toBe("live");

    // No client row was left behind by the refused attempt.
    const stray = await q<{ n: number }>(
      `select count(*)::int as n from public.clients where studio_id=$1 and email=$2`, [f.studioId, b.email],
    );
    expect(stray[0].n).toBe(0);

    const retry = await q<any>(BOOK, [b.token, b.cap, f.studioId, b.email, f.serviceId, t2, tokenHash("lb2")]);
    expect(retry[0].result).toBe("created_and_converted");
    expect(await apptCount(f.studioId)).toBe(2);
  });

  it("the booked time is the appointment THIS conversion created, not a later or cancelled one", async () => {
    const f = await fixture("bt");
    const [t1, t2, t3] = await slots(f, 3);
    const p = await provenEntry(f, "bt");
    const r = await q<any>(BOOK, [p.token, p.cap, f.studioId, p.email, f.serviceId, t1, tokenHash("bt1")]);
    expect(r[0].result).toBe("created_and_converted");
    const when = () =>
      q<{ state: string; starts_at: string | null }>(
        `select state, starts_at from public.waitlist_invitation_booking_state($1)`, [p.token],
      ).then((x) => x[0]);
    const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
    expect(iso((await when()).starts_at)).toBe(new Date(t1).toISOString());

    // A LATER appointment for the same client (made hours after the conversion).
    const later = await q<any>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, r[0].client_id, f.serviceId, t2, tokenHash("bt2")],
    );
    expect(later[0].result).toBe("created");
    await q(`update public.appointments set created_at = created_at + interval '3 hours' where id=$1`, [later[0].appointment_id]);
    expect(iso((await when()).starts_at)).toBe(new Date(t1).toISOString());

    // The original booking is CANCELLED and only the later one remains: unknown, never the later time.
    const originalStatus = (await q<{ status: string }>(`select status from public.appointments where id=$1`, [r[0].appointment_id]))[0].status;
    await q(`update public.appointments set status = 'cancelled' where id=$1`, [r[0].appointment_id]);
    const after = await when();
    expect(after.state).toBe("booked");
    expect(after.starts_at).toBeNull();

    // Two live candidates inside the window: ambiguous, so unknown.
    const twin = await q<any>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, r[0].client_id, f.serviceId, t3, tokenHash("bt3")],
    );
    expect(twin[0].result).toBe("created");
    await q(`update public.appointments set created_at = $2::timestamptz where id=$1`, [
      twin[0].appointment_id,
      (await q<{ c: string }>(`select converted_at::text as c from public.new_client_waitlist_entries where id=$1`, [p.entryId]))[0].c,
    ]);
    await q(`update public.appointments set status = $3, created_at = (select converted_at from public.new_client_waitlist_entries where id=$2) where id=$1`, [r[0].appointment_id, p.entryId, originalStatus]);
    expect((await when()).starts_at).toBeNull();
  });

  it("the window edges: 59s before the conversion is included, 61s before is excluded", async () => {
    const f = await fixture("edge");
    const [t1] = await slots(f, 1);
    const p = await provenEntry(f, "edge");
    const r = await q<any>(BOOK, [p.token, p.cap, f.studioId, p.email, f.serviceId, t1, tokenHash("edge1")]);
    expect(r[0].result).toBe("created_and_converted");
    const read = () =>
      q<{ starts_at: string | null }>(
        `select starts_at from public.waitlist_invitation_booking_state($1)`, [p.token],
      ).then((x) => x[0].starts_at);
    const setAge = (secs: number) =>
      q(
        `update public.appointments
            set created_at = (select converted_at from public.new_client_waitlist_entries where id=$2) - ($3 || ' seconds')::interval
          where id=$1`,
        [r[0].appointment_id, p.entryId, String(secs)],
      );
    await setAge(59);
    expect(await read()).not.toBeNull();
    await setAge(61);
    expect(await read()).toBeNull();
  });

  it("any other exception (a forced unique violation) propagates, rolls the redeem back and leaves the invitation live", async () => {
    const f = await fixture("uv");
    const [t1, t2] = await slots(f, 2);
    const a = await provenEntry(f, "a");
    const b = await provenEntry(f, "b");
    const shared = tokenHash("uv-shared");
    const win = await q<any>(BOOK, [a.token, a.cap, f.studioId, a.email, f.serviceId, t1, shared]);
    expect(win[0].result).toBe("created_and_converted");
    // The SAME cancellation hash for a different, free time: appointments_cancellation_token_hash_uniq.
    await expect(
      q(BOOK, [b.token, b.cap, f.studioId, b.email, f.serviceId, t2, shared]),
    ).rejects.toMatchObject({ code: "23505" });
    expect((await invitationOf(b.entryId)).redeemed_at).toBeNull();
    expect(await state(b.token)).toBe("live");
    expect(await apptCount(f.studioId)).toBe(1);
  });

  it("a bad capability is refused and the invitation stays live", async () => {
    const f = await fixture("cap");
    const p = await provenEntry(f, "cap");
    const [slot] = await slots(f, 1);
    const bad = "0".repeat(64);
    const r = await q<any>(BOOK, [p.token, bad, f.studioId, p.email, f.serviceId, slot, tokenHash("bc")]);
    expect(r[0].appointment_id).toBeNull();
    expect(r[0].result).toBe("redeem_proof_invalid");
    expect((await invitationOf(p.entryId)).redeemed_at).toBeNull();
  });

  it("a token from another studio is invalid", async () => {
    const f = await fixture("x1");
    const g = await fixture("x2");
    const p = await provenEntry(f, "x");
    const [slot] = await slots(g, 1);
    const r = await q<any>(BOOK, [p.token, p.cap, g.studioId, p.email, g.serviceId, slot, tokenHash("xs")]);
    expect(r[0].result).toBe("invalid_token");
    expect((await invitationOf(p.entryId)).redeemed_at).toBeNull();
  });

  it("is callable only by service_role", async () => {
    const rows = await q<{ fn: string; anon: boolean; auth: boolean; svc: boolean }>(
      `select p.proname as fn,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname in (
          'redeem_and_book_waitlist_invitation','waitlist_invitation_booking_state',
          'record_waitlist_invitation_followup','resolve_waitlist_invitation_followup')`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect([r.fn, r.anon, r.auth, r.svc]).toEqual([r.fn, false, false, true]);
    }
    const t = await q<{ a: boolean; b: boolean; c: boolean }>(
      `select has_table_privilege('anon','public.waitlist_invitation_followups','select') as a,
              has_table_privilege('authenticated','public.waitlist_invitation_followups','select') as b,
              has_table_privilege('service_role','public.waitlist_invitation_followups','insert') as c`,
    );
    expect(t[0]).toEqual({ a: false, b: false, c: false });
  });
});

describe("0313 durable follow-up item", () => {
  it("records once for a redeemed, unbooked invitation, and clears when resolved by the owner", async () => {
    const f = await fixture("fu");
    const p = await provenEntry(f, "fu");
    // Live invitation: nothing to record.
    expect((await q<any>(`select public.record_waitlist_invitation_followup($1,'booking_outcome_unknown') as r`, [p.token]))[0].r).toBe("not_redeemed");
    // Redeem without booking (the lost-response state).
    await q(`select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`, [p.token, p.cap]);
    expect(await state(p.token)).toBe("redeemed_unbooked");
    const rec = () => q<any>(`select public.record_waitlist_invitation_followup($1,'booking_outcome_unknown') as r`, [p.token]);
    expect((await rec())[0].r).toBe("recorded");
    expect((await rec())[0].r).toBe("already_recorded");
    const open = () =>
      q<{ n: number }>(
        `select count(*)::int as n from public.waitlist_invitation_followups where studio_id=$1 and resolved_at is null`,
        [f.studioId],
      ).then((r) => r[0].n);
    expect(await open()).toBe(1);
    const res = await q<any>(`select public.resolve_waitlist_invitation_followup($1,$2,$3) as r`, [f.studioId, p.entryId, f.userId]);
    expect(res[0].r).toBe("resolved");
    expect(await open()).toBe(0);
    expect((await q<any>(`select public.record_waitlist_invitation_followup($1,'not_a_reason') as r`, [p.token]))[0].r).toBe("invalid_input");
  });

  it("is erased with its studio (an invited entry cannot be deleted alone: invitations are append-only)", async () => {
    const f = await fixture("er");
    const p = await provenEntry(f, "er");
    await q(`select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`, [p.token, p.cap]);
    await q(`select public.record_waitlist_invitation_followup($1,'booking_not_completed')`, [p.token]);
    await q(`delete from public.studios where id=$1`, [f.studioId]);
    const n = await q<{ n: number }>(
      `select count(*)::int as n from public.waitlist_invitation_followups where entry_id=$1`, [p.entryId],
    );
    expect(n[0].n).toBe(0);
  });
});
