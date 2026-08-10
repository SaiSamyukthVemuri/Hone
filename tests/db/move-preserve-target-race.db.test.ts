import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedStudioWideOpenAllWeek, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (migration 0145) — the time-only move stale-target race is gone.
// A NULL target = "preserve the CURRENT practitioner, resolved from the LOCKED
// row", so the 0133 wrapper (and the app's time-only path) can NEVER become an
// unintended reassignment under a concurrent reassign. Studio B, cap ON, book ON.

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners.find((p) => p.role === "owner")!;
const T = (hhmm: string) => `2031-09-15T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = true,
       practitioner_capacity_booking_enabled = true, timezone = 'UTC', buffer_minutes = 0 where id = $1`,
    [B.studioId],
  );
  await seedStudioWideOpenAllWeek(B.studioId);
  const svc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Consult',30,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceId = svc.rows[0].id as string;
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

async function seedAppt(practitionerId: string, start: string, durMin = 30) {
  const end = new Date(new Date(start).getTime() + durMin * 60_000).toISOString();
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(),$1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,'confirmed',$8)
     returning id, starts_at::text s, ends_at::text e`,
    [B.studioId, practitionerId, B.clientId, serviceId, start, end, durMin, hash64()],
  );
  return { id: r.rows[0].id as string, exp: r.rows[0].s as string, expEnd: r.rows[0].e as string };
}
const pract = (id: string) =>
  adminQuery(`select practitioner_id, starts_at::text s from public.appointments where id=$1`, [id]).then((r) => r.rows[0]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// move_or_reassign with an explicit or NULL target ($4 may be null).
const moveMR = (id: string, actor: string, target: string | null, es: string, ee: string, ns: string) =>
  adminQuery(
    `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
    [id, B.studioId, actor, target, es, ee, ns],
  ).then((r) => r.rows[0] as { result: string; new_practitioner_id: string });
// B6 / 0175: was the retired 6-arg wrapper; now the successor's NULL-target
// time-only form, which is the same semantic the wrapper provided.
const wrapper = (id: string, actor: string, es: string, ee: string, ns: string) =>
  adminQuery(
    `select * from public.move_or_reassign_appointment($1,$2,$3,null,$4::timestamptz,$5::timestamptz,$6::timestamptz,false)`,
    [id, B.studioId, actor, es, ee, ns],
  ).then((r) => r.rows[0] as { result: string });

describe("0145 — NULL target preserves the current practitioner (race-safe)", () => {
  it("move_or_reassign with a NULL target is a time-only move that keeps the current practitioner", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const r = await moveMR(a.id, owner().practitionerId, null, a.exp, a.expEnd, T("11:00"));
    expect(r.result).toBe("moved");
    const row = await pract(a.id);
    expect(row.practitioner_id).toBe(P(1)); // unchanged
    expect(row.s).toContain("11:00:00");
  });

  it("the wrapper time-move preserves whatever the CURRENT practitioner is after a committed reassignment (never reverts)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    // Reassign A->B first (commit). The OLD wrapper (pre-lock read of P1) would
    // have reverted this move back to P1; the NULL-preserve wrapper keeps B.
    await moveMR(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp);
    expect((await pract(a.id)).practitioner_id).toBe(P(2));
    const r = await wrapper(a.id, owner().practitionerId, a.exp, a.expEnd, T("11:00"));
    expect(r.result).toBe("moved"); // time-only — NOT "reassigned"
    const row = await pract(a.id);
    expect(row.practitioner_id).toBe(P(2)); // still B — the wrapper never reassigned
    expect(row.s).toContain("11:00:00");
  });

  it("CONCURRENT reassign A→B then time-only move: the time-only move keeps B, one winner, no deadlock", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const c1 = new Client({ connectionString: resolveLocalDbUrl() });
    const c2 = new Client({ connectionString: resolveLocalDbUrl() });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("begin");
      // c1 reassigns A->B (holds studios-row + advisory + appt locks, uncommitted).
      await c1.query(
        `select public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
        [a.id, B.studioId, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp],
      );
      // c2 fires the time-only form (NULL target); it must BLOCK on c1's locks.
      await c2.query("begin");
      const c2Done = c2.query(
        `select * from public.move_or_reassign_appointment($1,$2,$3,null,$4::timestamptz,$5::timestamptz,$6::timestamptz,false)`,
        [a.id, B.studioId, owner().practitionerId, a.exp, a.expEnd, T("11:00")],
      );
      await sleep(200); // let c2 reach + block on the lock
      await c1.query("commit"); // A is now B; release the locks
      const res = (await c2Done).rows[0] as { result: string };
      await c2.query("commit");
      expect(res.result).toBe("moved"); // time-only, never a reassignment
      const row = await pract(a.id);
      expect(row.practitioner_id).toBe(P(2)); // the reassignment winner — NOT reverted to P1
      expect(row.s).toContain("11:00:00");
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("an EXPLICIT target is still a reassignment (NULL is the only preserve-current signal)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const r = await moveMR(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp);
    expect(r.result).toBe("reassigned");
    expect((await pract(a.id)).practitioner_id).toBe(P(2));
  });
});
