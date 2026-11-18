import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-54: a future appointment assigned to ANOTHER practitioner. The page and the action now answer the refusal with a sentence (unit tests); this file
// proves the DATABASE side the answer depends on, on the real chain, with synthetic data: who start_session refuses and with exactly which words, that
// the assignee reaches a chart, that the future booking stays confirmed with exactly ONE linked session, and that the page's pre-check query is valid
// against the real schema (the named assignment foreign key and the columns it reads).
afterAll(async () => {
  await closePool();
});

const hash64 = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
const ASSIGNED_ELSEWHERE_RAISED = "Appointment is assigned to a different practitioner.";

let studio: SeededStudio;
let assignee: { userId: string; practitionerId: string };
let colleague: { userId: string; practitionerId: string };
let appointmentId: string;

async function createFutureBooking(): Promise<string> {
  const serviceId = randomUUID();
  await adminQuery(`insert into public.services (id, studio_id, name, default_duration_minutes, active) values ($1, $2, 'Synthetic', 30, true)`, [serviceId, studio.studioId]);
  for (let d = 0; d < 7; d++) {
    await adminQuery(`insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time) values ($1, $2, true, '00:00', '23:59')`, [studio.studioId, d]);
  }
  await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1, $2, $3) on conflict do nothing`, [studio.studioId, serviceId, assignee.practitionerId]);
  const r = await adminTx(async (q) => {
    await q("set local role service_role");
    const res = await q(`select * from public.create_internal_appointment_v2($1, $2, $3, $4, $5, now() + interval '30 days', $6, null, null, false)`, [studio.studioId, studio.practitionerId, assignee.practitionerId, studio.clientId, serviceId, hash64()]);
    await q("reset role");
    return res.rows[0] as { result: string; appointment_id: string };
  });
  expect(r.result, "the future booking is created for the assignee").toBe("created");
  return r.appointment_id;
}

const startAs = async (userId: string, appt: string | null) =>
  asUser(userId, (q) => q(`select * from public.start_session($1, 'electrolysis', $2, 90, $3)`, [studio.clientId, appt, studio.studioId]));
const attempt = async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, message: String((e as Error).message) };
  }
};
const sessionsFor = async (appt: string) => (await adminQuery(`select id, practitioner_id, appointment_id from public.sessions where appointment_id = $1`, [appt])).rows;
const statusOf = async (appt: string) => String((await adminQuery(`select status from public.appointments where id = $1`, [appt])).rows[0].status);

describe("HON-54: a future booking assigned to another practitioner", () => {
  it("setup: a studio, an assignee, a colleague, a future booking assigned to the assignee", async () => {
    studio = await seedStudio("hon54");
    assignee = await seedMember(studio, "hon54-assignee");
    colleague = await seedMember(studio, "hon54-colleague");
    appointmentId = await createFutureBooking();
    expect(await statusOf(appointmentId)).toBe("confirmed");
    expect(await sessionsFor(appointmentId)).toEqual([]);
  });

  it("the owner opening a colleague's booking is refused by the command with the exact words the action recognises, and nothing is written", async () => {
    const r = await attempt(() => startAs(studio.userId, appointmentId));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain(ASSIGNED_ELSEWHERE_RAISED);
    expect(await sessionsFor(appointmentId)).toEqual([]);
    expect(await statusOf(appointmentId)).toBe("confirmed");
  });

  it("another practitioner (not the assignee) is refused the same way", async () => {
    const r = await attempt(() => startAs(colleague.userId, appointmentId));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain(ASSIGNED_ELSEWHERE_RAISED);
    expect(await sessionsFor(appointmentId)).toEqual([]);
  });

  it("the assignee reaches a chart from the same booking: the booking stays CONFIRMED and has exactly ONE linked session, charted by the assignee", async () => {
    const r = await startAs(assignee.userId, appointmentId);
    expect(r.rows.length).toBe(1);
    const linked = await sessionsFor(appointmentId);
    expect(linked.length).toBe(1);
    expect(linked[0].practitioner_id).toBe(assignee.practitionerId);
    expect(await statusOf(appointmentId)).toBe("confirmed"); // a future booking is not completed by opening its chart
  });

  it("starting again from the same booking reuses that chart: still exactly one linked session", async () => {
    const again = await startAs(assignee.userId, appointmentId);
    expect(again.rows.length).toBe(1);
    expect((await sessionsFor(appointmentId)).length).toBe(1);
    expect(await statusOf(appointmentId)).toBe("confirmed");
  });

  it("reassigned: once the booking belongs to the colleague the old assignee is refused and the colleague can chart (the answer follows the appointment as it is now)", async () => {
    const other = await seedStudio("hon54-reassign");
    const a2 = await seedMember(other, "hon54-a2");
    const b2 = await seedMember(other, "hon54-b2");
    const svc = randomUUID();
    await adminQuery(`insert into public.services (id, studio_id, name, default_duration_minutes, active) values ($1, $2, 'Synthetic', 30, true)`, [svc, other.studioId]);
    for (let d = 0; d < 7; d++) await adminQuery(`insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time) values ($1, $2, true, '00:00', '23:59')`, [other.studioId, d]);
    for (const p of [a2.practitionerId, b2.practitionerId]) await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1, $2, $3) on conflict do nothing`, [other.studioId, svc, p]);
    const appt = (await adminTx(async (q) => {
      await q("set local role service_role");
      const res = await q(`select * from public.create_internal_appointment_v2($1, $2, $3, $4, $5, now() + interval '31 days', $6, null, null, false)`, [other.studioId, other.practitionerId, a2.practitionerId, other.clientId, svc, hash64()]);
      await q("reset role");
      return res.rows[0] as { appointment_id: string };
    })).appointment_id;
    const start = (uid: string) => asUser(uid, (q) => q(`select * from public.start_session($1, 'electrolysis', $2, 90, $3)`, [other.clientId, appt, other.studioId]));
    expect((await attempt(() => start(b2.userId))).ok).toBe(false);
    await adminQuery(`update public.appointments set practitioner_id = $2 where id = $1`, [appt, b2.practitionerId]);
    expect((await attempt(() => start(a2.userId))).ok, "the former assignee is now refused").toBe(false);
    expect((await attempt(() => start(b2.userId))).ok, "the new assignee can chart").toBe(true);
  });

  it("the page's pre-check query is valid on the real schema: the assignment foreign key it names exists, and the owner can read the assignee's name and active flag", async () => {
    const fk = await adminQuery(`select conname from pg_constraint where conrelid = 'public.appointments'::regclass and conname = 'appointments_practitioner_same_studio_fk' and contype = 'f'`);
    expect(fk.rows.length, "the embed names this foreign key").toBe(1);
    const cols = (await adminQuery(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'practitioners' and column_name in ('display_name', 'active')`)).rows.map((r) => String(r.column_name)).sort();
    expect(cols).toEqual(["active", "display_name"]);
    const seen = await asUser(studio.userId, (q) => q(`select a.studio_id, a.client_id, a.practitioner_id, p.display_name, p.active from public.appointments a join public.practitioners p on p.id = a.practitioner_id where a.id = $1`, [appointmentId]));
    expect(seen.rows.length).toBe(1);
    expect(seen.rows[0].active).toBe(true);
    expect(String(seen.rows[0].display_name)).toContain("hon54-assignee");
  });

  it("no existence oracle at the database: another studio's appointment, and a nonexistent id, are refused with the SAME message and write nothing", async () => {
    const other = await seedStudio("hon54-other");
    const otherSvc = randomUUID();
    await adminQuery(`insert into public.services (id, studio_id, name, default_duration_minutes, active) values ($1, $2, 'Synthetic', 30, true)`, [otherSvc, other.studioId]);
    for (let d = 0; d < 7; d++) await adminQuery(`insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time) values ($1, $2, true, '00:00', '23:59')`, [other.studioId, d]);
    await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1, $2, $3) on conflict do nothing`, [other.studioId, otherSvc, other.practitionerId]);
    const foreignAppt = (await adminTx(async (q) => {
      await q("set local role service_role");
      const res = await q(`select * from public.create_internal_appointment_v2($1, $2, $3, $4, $5, now() + interval '32 days', $6, null, null, false)`, [other.studioId, other.practitionerId, other.practitionerId, other.clientId, otherSvc, hash64()]);
      await q("reset role");
      return res.rows[0] as { appointment_id: string };
    })).appointment_id;
    const foreign = await attempt(() => startAs(studio.userId, foreignAppt));
    const nonexistent = await attempt(() => startAs(studio.userId, randomUUID()));
    expect(foreign.ok).toBe(false);
    expect(nonexistent.ok).toBe(false);
    expect(foreign.ok === false && nonexistent.ok === false && foreign.message).toBe(nonexistent.ok === false ? nonexistent.message : "");
    expect(foreign.ok === false && foreign.message).not.toContain(foreignAppt); // the id, names and times are never echoed
    expect(foreign.ok === false && foreign.message).not.toMatch(/hon54|\d{4}-\d{2}-\d{2}/);
    expect(await sessionsFor(foreignAppt)).toEqual([]);
  });
});
