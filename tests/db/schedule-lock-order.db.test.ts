import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (Item 4) — booking vs. reassignment into the SAME target slot.
// The canonical lock order (studios row -> advisory -> source rows) serializes
// the two, and the per-resource GiST exclusion is the final authority: exactly
// one winner when they overlap, both commit when disjoint, never a deadlock.
// See docs/reviews/part4-lock-order-and-race-matrix.md (scenario 10).

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners[0].practitionerId;
const DATE = "2031-09-15";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = true,
       practitioner_capacity_booking_enabled = true, timezone = 'UTC', buffer_minutes = 0 where id = $1`,
    [B.studioId],
  );
  const svc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Consult',30,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceId = svc.rows[0].id as string;
  await adminQuery(
    `insert into public.studio_availability_default
       (id, studio_id, day_of_week, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,true,'09:00','17:00')`,
    [B.studioId, DOW],
  );
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
const countAt = (practitionerId: string, start: string) =>
  adminQuery(
    `select count(*)::int n from public.appointments where practitioner_id=$1 and starts_at=$2::timestamptz`,
    [practitionerId, start],
  ).then((r) => r.rows[0].n as number);

describe("Item 4 — booking vs. reassignment into the same target slot", () => {
  it("overlap: reassign A->P2@10:00 wins, a concurrent P2@10:00 booking loses with 23P01 (no deadlock)", async () => {
    // A is P1's 10:00 appointment; a fresh client B books P2 also at 10:00.
    const a = await seedAppt(P(1), T("10:00"));
    const c1 = new Client({ connectionString: resolveLocalDbUrl() });
    const c2 = new Client({ connectionString: resolveLocalDbUrl() });
    await c1.connect();
    await c2.connect();
    let collision: string | null = null;
    try {
      await c1.query("begin");
      // c1 reassigns A -> P2 at the SAME 10:00 (holds studios-row + advisory + appt locks).
      await c1.query(
        `select public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
        [a.id, B.studioId, owner(), P(2), a.exp, a.expEnd, a.exp],
      );
      // c2 tries to BOOK P2 at 10:00 — must block on c1's locks, then collide.
      await c2.query("begin");
      const c2Done = c2
        .query(
          `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
          [B.studioId, owner(), P(2), B.clientId, serviceId, T("10:00"), hash64()],
        )
        .then(() => "committed" as const)
        .catch((e: { code?: string }) => (collision = e.code ?? "error"));
      await sleep(200);
      await c1.query("commit"); // reassignment wins; P2@10:00 is now taken
      await c2Done;
      // c2's transaction aborted on the 23P01; roll it back cleanly.
      await c2.query("rollback").catch(() => {});
      expect(collision).toBe("23P01");
      expect(await countAt(P(2), T("10:00"))).toBe(1); // exactly one — the reassignment
      expect(await countAt(P(1), T("10:00"))).toBe(0); // A moved off P1
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("disjoint: reassign A->P2@10:00 and a P2@11:00 booking BOTH commit (advisory serializes, no false conflict)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const c1 = new Client({ connectionString: resolveLocalDbUrl() });
    const c2 = new Client({ connectionString: resolveLocalDbUrl() });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("begin");
      await c1.query(
        `select public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
        [a.id, B.studioId, owner(), P(2), a.exp, a.expEnd, a.exp],
      );
      await c2.query("begin");
      const c2Done = c2.query(
        `select result from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
        [B.studioId, owner(), P(2), B.clientId, serviceId, T("11:00"), hash64()],
      );
      await sleep(200);
      await c1.query("commit");
      const res = (await c2Done).rows[0] as { result: string };
      await c2.query("commit");
      expect(res.result).toBe("created");
      expect(await countAt(P(2), T("10:00"))).toBe(1); // reassigned
      expect(await countAt(P(2), T("11:00"))).toBe(1); // newly booked
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});
