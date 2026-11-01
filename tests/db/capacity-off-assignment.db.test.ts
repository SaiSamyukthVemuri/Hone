import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// Sam 1 Nov: assignment is not a capacity feature. In a capacity-OFF studio the owner can record WHICH
// practitioner an appointment belongs to (booking and reassignment), a member still cannot name anyone
// else, and collision stays STUDIO-WIDE (0134): recording a practitioner creates no parallel booking.
// Capacity ON is the control: the same two bookings DO run in parallel there.

const DATE = "2031-09-15";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

let B: SynthStudio;
let serviceId: string;
const owner = () => B.practitioners[0].practitionerId;
const member = () => B.practitioners[1].practitionerId;
const created: SynthStudio[] = [];

async function setup(capacity: boolean) {
  B = await seedSynthStudioB();
  created.push(B);
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = $2, practitioner_capacity_booking_enabled = $2,
       timezone = 'UTC', buffer_minutes = 0 where id = $1`,
    [B.studioId, capacity],
  );
  const svc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Consult',60,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceId = svc.rows[0].id as string;
  await adminQuery(
    `insert into public.studio_availability_default (id, studio_id, day_of_week, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,true,'00:00','23:59')`,
    [B.studioId, DOW],
  );
  for (const p of B.practitioners) {
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3) on conflict do nothing`,
      [B.studioId, serviceId, p.practitionerId],
    );
  }
}

const book = (actor: string, target: string, start: string) =>
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
    [B.studioId, actor, target, B.clientId, serviceId, start, hash64()],
  ).then((r) => r.rows[0] as { result: string; appointment_id: string | null });

const assigneeOf = async (id: string) =>
  (await adminQuery(`select practitioner_id from public.appointments where id = $1`, [id])).rows[0].practitioner_id as string | null;

afterAll(async () => {
  for (const s of created) await dropSynthStudio(s).catch(() => undefined);
  await closePool();
});

describe("capacity OFF: assignment without parallelism", () => {
  it("the owner books FOR a member and the appointment records that member", async () => {
    await setup(false);
    const r = await book(owner(), member(), T("10:00"));
    expect(r.result).toBe("created");
    expect(await assigneeOf(r.appointment_id!)).toBe(member());
  });

  it("collision stays studio-wide: a second booking at the same time for ANOTHER practitioner is refused", async () => {
    await setup(false);
    expect((await book(owner(), member(), T("10:00"))).result).toBe("created");
    const second = await book(owner(), owner(), T("10:00"));
    expect(second.result).not.toBe("created");
    const n = await adminQuery(`select count(*)::int n from public.appointments where studio_id = $1 and status = 'confirmed'`, [B.studioId]);
    expect(n.rows[0].n).toBe(1);
  });

  it("control, capacity ON: the same two bookings run in parallel", async () => {
    await setup(true);
    expect((await book(owner(), member(), T("10:00"))).result).toBe("created");
    expect((await book(owner(), owner(), T("10:00"))).result).toBe("created");
  });

  it("a member can only book for themselves, in either mode", async () => {
    await setup(false);
    expect((await book(member(), owner(), T("10:00"))).result).toBe("not_authorized");
    expect((await book(member(), member(), T("10:00"))).result).toBe("created");
  });

  it("an inactive or other-studio target is refused for the owner", async () => {
    await setup(false);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [member()]);
    expect((await book(owner(), member(), T("10:00"))).result).toBe("invalid_practitioner");
    const other = await seedSynthStudioB();
    created.push(other);
    expect((await book(owner(), other.practitioners[0].practitionerId, T("11:00"))).result).toBe("invalid_practitioner");
  });
});

describe("capacity OFF: explicit, audited reassignment of a FUTURE appointment", () => {
  const reassign = (id: string, actor: string, target: string, start: string, end: string) =>
    adminQuery(`select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz,false)`,
      [id, B.studioId, actor, target, start, end]).then((r) => r.rows[0] as { result: string });

  it("the owner reassigns owner -> member; the audit row carries from and to; the time is unchanged", async () => {
    await setup(false);
    const a = await book(owner(), owner(), T("10:00"));
    const row = (await adminQuery(`select starts_at, ends_at from public.appointments where id = $1`, [a.appointment_id])).rows[0];
    const r = await reassign(a.appointment_id!, owner(), member(), row.starts_at.toISOString(), row.ends_at.toISOString());
    expect(r.result).toBe("reassigned");
    expect(await assigneeOf(a.appointment_id!)).toBe(member());
    const audit = await adminQuery(
      `select action, details from public.appointment_audit where appointment_id = $1 and action = 'reassigned'`, [a.appointment_id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details.previous_practitioner_id).toBe(owner());
    expect(audit.rows[0].details.new_practitioner_id).toBe(member());
    const after = (await adminQuery(`select starts_at from public.appointments where id = $1`, [a.appointment_id])).rows[0];
    expect(after.starts_at.toISOString()).toBe(row.starts_at.toISOString());
  });

  it("a member cannot reassign, and nothing changes", async () => {
    await setup(false);
    const a = await book(member(), member(), T("10:00"));
    const row = (await adminQuery(`select starts_at, ends_at from public.appointments where id = $1`, [a.appointment_id])).rows[0];
    const r = await reassign(a.appointment_id!, member(), owner(), row.starts_at.toISOString(), row.ends_at.toISOString());
    expect(r.result).toBe("not_authorized");
    expect(await assigneeOf(a.appointment_id!)).toBe(member());
  });
});
