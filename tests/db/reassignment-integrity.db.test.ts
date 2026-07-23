import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { dropSynthStudio, seedStudioWideOpenAllWeek, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 Item 7 — data-integrity of a practitioner reassignment via
// move_or_reassign_appointment. The command's outcomes are proven broadly in
// move-reassign-appointment.db + move-target-integrity.db; this pins the explicit
// Item 7 checklist: same row, PHI/relationships preserved, shadow re-keyed, one
// correct audit row with the previous + new practitioner, atomic rollback.

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners.find((p) => p.role === "owner")!.practitionerId;
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

async function seedAppt(practitionerId: string, start: string) {
  const end = new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(),$1,$2,$3,$4,$5::timestamptz,$6::timestamptz,30,'confirmed',$7)
     returning id, starts_at::text s, ends_at::text e`,
    [B.studioId, practitionerId, B.clientId, serviceId, start, end, hash64()],
  );
  return { id: r.rows[0].id as string, exp: r.rows[0].s as string, expEnd: r.rows[0].e as string };
}
const move = (id: string, target: string, es: string, ee: string, ns: string) =>
  adminQuery(
    `select result from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
    [id, B.studioId, owner(), target, es, ee, ns],
  ).then((r) => r.rows[0].result as string).catch((e) => `throw:${(e as { code?: string }).code}`);
const fullRow = (id: string) =>
  adminQuery(
    `select id, client_id, service_id, duration_minutes, practitioner_id, starts_at::text s from public.appointments where id=$1`,
    [id],
  ).then((r) => r.rows[0]);
const resKeys = (id: string) =>
  adminQuery(
    `select resource_key from public.studio_calendar_reservations where source_kind='appointment' and source_id=$1`,
    [id],
  ).then((r) => r.rows.map((x) => x.resource_key as string));
const audits = (id: string) =>
  adminQuery(
    `select action, details from public.appointment_audit where appointment_id=$1 order by created_at`,
    [id],
  ).then((r) => r.rows as { action: string; details: Record<string, unknown> }[]);

describe("Item 7 — reassignment data integrity", () => {
  it("same-time A→B: same row + client/service/duration preserved, practitioner + shadow re-keyed, one 'reassigned' audit", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const before = await fullRow(a.id);
    expect(await move(a.id, P(2), a.exp, a.expEnd, a.exp)).toBe("reassigned");
    const after = await fullRow(a.id);
    expect(after.id).toBe(before.id); // same appointment row
    expect(after.client_id).toBe(before.client_id);
    expect(after.service_id).toBe(before.service_id);
    expect(after.duration_minutes).toBe(before.duration_minutes);
    expect(after.s).toContain("10:00:00"); // time unchanged
    expect(after.practitioner_id).toBe(P(2)); // only the practitioner changed
    expect(await resKeys(a.id)).toEqual([P(2)]); // shadow re-keyed to B, no orphan on A
    const aud = await audits(a.id);
    const reassign = aud.filter((x) => x.action === "reassigned");
    expect(reassign).toHaveLength(1);
    expect(reassign[0].details.previous_practitioner_id).toBe(P(1));
    expect(reassign[0].details.new_practitioner_id).toBe(P(2));
  });

  it("move + reassign in one op writes exactly one 'moved_and_reassigned' audit", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    expect(await move(a.id, P(2), a.exp, a.expEnd, T("12:00"))).toBe("moved_and_reassigned");
    const aud = await audits(a.id);
    expect(aud.filter((x) => x.action === "moved_and_reassigned")).toHaveLength(1);
    expect(aud.filter((x) => x.action === "reassigned")).toHaveLength(0);
  });

  it("a colliding reassignment rolls back appointment, shadow AND audit together", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await seedAppt(P(2), T("10:00")); // B already busy at 10:00
    expect(await move(a.id, P(2), a.exp, a.expEnd, a.exp)).toBe("throw:23P01");
    const after = await fullRow(a.id);
    expect(after.practitioner_id).toBe(P(1)); // unchanged
    expect(await resKeys(a.id)).toEqual([P(1)]); // shadow unchanged
    // No reassignment audit row survives the rollback.
    const aud = await audits(a.id);
    expect(aud.filter((x) => x.action === "reassigned" || x.action === "moved_and_reassigned")).toHaveLength(0);
  });
});
