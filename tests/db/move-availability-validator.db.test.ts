import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (migration 0148) — move/reassign now runs the shared availability
// validator on the FINAL target + resulting interval. Working hours, closed days,
// blockouts apply; the OWNER outside-availability bypass skips ONLY working hours;
// a member can never forge it. Studio B, cap ON, UTC, weekday window 09:00–17:00.

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners[0].practitionerId;
const DATE = "2031-09-15";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

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
       (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,null,$2,true,'09:00','17:00')`,
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
const move = (
  id: string, actor: string, target: string | null, es: string, ee: string, ns: string, outside = false,
) =>
  adminQuery(
    `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8)`,
    [id, B.studioId, actor, target, es, ee, ns, outside],
  ).then((r) => r.rows[0] as { result: string });

describe("0148 — move/reassign availability validation", () => {
  it("time-only move WITHIN hours → moved; move OUTSIDE hours → outside_availability", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    expect((await move(a.id, owner(), null, a.exp, a.expEnd, T("11:00"))).result).toBe("moved");
    const a2 = await seedAppt(P(1), T("12:00"));
    expect((await move(a2.id, owner(), null, a2.exp, a2.expEnd, T("08:00"))).result).toBe("outside_availability");
  });

  it("move onto a CLOSED day (date override is_open=false) → practitioner_closed", async () => {
    await adminQuery(
      `insert into public.studio_availability_overrides
         (id, studio_id, practitioner_id, effective_date, is_open, open_time, close_time)
       values (gen_random_uuid(),$1,null,$2,false,null,null)`,
      [B.studioId, "2031-09-16"],
    );
    const a = await seedAppt(P(1), T("10:00"));
    // move to 2031-09-16 10:00 (that date is force-closed)
    expect((await move(a.id, owner(), null, a.exp, a.expEnd, "2031-09-16T10:00:00.000Z")).result).toBe(
      "practitioner_closed",
    );
  });

  it("OWNER outside-availability bypass skips ONLY working hours (moves outside hours)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    expect((await move(a.id, owner(), null, a.exp, a.expEnd, T("08:00"), true)).result).toBe("moved");
  });

  it("blockout is NEVER bypassed, even with the owner override", async () => {
    // Blockout on a DIFFERENT day than the appointment (a full-day blockout and an
    // appointment cannot coexist on the same resource/day — they collide in the
    // shadow). The appt lives on the open DATE; we move it onto the blocked day.
    const BLOCKED = "2031-09-16";
    await adminQuery(
      `insert into public.studio_blockouts (id, studio_id, starts_on, ends_on) values (gen_random_uuid(),$1,$2,$2)`,
      [B.studioId, BLOCKED],
    );
    const a = await seedAppt(P(1), T("10:00"));
    expect(
      (await move(a.id, owner(), null, a.exp, a.expEnd, `${BLOCKED}T14:00:00.000Z`, true)).result,
    ).toBe("practitioner_closed");
  });

  it("a MEMBER cannot forge the outside-availability bypass on their own move", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    // P(1) is a member; moving own appt is allowed, but the bypass is owner-only.
    expect((await move(a.id, P(1), null, a.exp, a.expEnd, T("08:00"), true)).result).toBe("not_authorized");
  });

  it("reassignment validates the NEW target's own hours (practitioner-specific window)", async () => {
    // P2 works only 10:00–12:00 that day; reassigning A to P2 at 14:00 → outside P2's hours.
    await adminQuery(
      `insert into public.studio_availability_overrides
         (id, studio_id, practitioner_id, effective_date, is_open, open_time, close_time)
       values (gen_random_uuid(),$1,$2,$3,true,'10:00','12:00')`,
      [B.studioId, P(2), DATE],
    );
    const a = await seedAppt(P(1), T("14:00")); // P1 within studio-wide 09–17
    // Reassign-only (time unchanged): 14:00 is outside P2's 10–12 window.
    expect((await move(a.id, owner(), P(2), a.exp, a.expEnd, T("14:00"))).result).toBe("outside_availability");
    // Reassign + move the time into P2's window → both changed → moved_and_reassigned.
    const a2 = await seedAppt(P(1), T("15:00"));
    expect((await move(a2.id, owner(), P(2), a2.exp, a2.expEnd, T("10:30"))).result).toBe("moved_and_reassigned");
  });
});
