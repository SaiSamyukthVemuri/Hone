import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (migration 0144) — final-target integrity on EVERY move (Item 1) +
// the 0133 legacy compatibility wrapper (Item 3). Studio B, capacity ON, booking
// ON, UTC, buffer 0. Never Willow.

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
type Out = { ok: true; result: string; row: Record<string, unknown> } | { ok: false; code: string | undefined };
const move = (id: string, actor: string, target: string, es: string, ee: string, ns: string): Promise<Out> =>
  adminQuery(
    `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
    [id, B.studioId, actor, target, es, ee, ns],
  )
    .then((r) => ({ ok: true as const, result: r.rows[0].result as string, row: r.rows[0] as Record<string, unknown> }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));
// Legacy time-only wrapper (old 6-arg / 6-column shape).
const legacyMove = (id: string, actor: string, es: string, ee: string, ns: string): Promise<Out> =>
  adminQuery(
    `select * from public.practitioner_move_appointment($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::timestamptz)`,
    [id, B.studioId, actor, es, ee, ns],
  )
    .then((r) => ({ ok: true as const, result: r.rows[0].result as string, row: r.rows[0] as Record<string, unknown> }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));
const apptPract = (id: string) =>
  adminQuery(`select practitioner_id, starts_at::text s from public.appointments where id=$1`, [id]).then((r) => r.rows[0]);
const deactivate = (pid: string) => adminQuery(`update public.practitioners set active=false where id=$1`, [pid]);
const removeElig = (pid: string) =>
  adminQuery(`delete from public.service_practitioners where service_id=$1 and practitioner_id=$2`, [serviceId, pid]);

// ---------------------------------------------------------------------------
describe("0144 Item 1 — final-target integrity on EVERY move", () => {
  it("time-only move retaining an INACTIVE current practitioner -> practitioner_reassignment_required", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await deactivate(P(1));
    const r = await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00"));
    expect(r).toMatchObject({ result: "practitioner_reassignment_required" });
    expect((await apptPract(a.id)).s).toContain("10:00:00"); // unchanged
  });

  it("time-only move retaining a now-INELIGIBLE current practitioner -> practitioner_reassignment_required", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await removeElig(P(1));
    expect(await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00"))).toMatchObject({
      result: "practitioner_reassignment_required",
    });
  });

  it("owner resolves an inactive current by moving AND reassigning to an active eligible target atomically", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await deactivate(P(1));
    const r = await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, T("11:00"));
    expect(r).toMatchObject({ result: "moved_and_reassigned" });
    const row = await apptPract(a.id);
    expect(row.practitioner_id).toBe(P(2));
    expect(row.s).toContain("11:00:00");
  });

  it("owner resolves an ineligible current by reassigning to an eligible target", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await removeElig(P(1));
    expect(await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp)).toMatchObject({
      result: "reassigned",
    });
    expect((await apptPract(a.id)).practitioner_id).toBe(P(2));
  });

  it("a member whose own membership went inactive can no longer move their appointment", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await deactivate(P(1)); // P1 is a member
    expect(await move(a.id, P(1), P(1), a.exp, a.expEnd, T("11:00"))).toMatchObject({ result: "not_authorized" });
  });

  it("a valid time-only move (active, eligible current) still succeeds", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    expect(await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00"))).toMatchObject({
      result: "moved",
    });
  });
});

// ---------------------------------------------------------------------------
describe("0144 Item 3 — practitioner_move_appointment is a safe compatibility wrapper", () => {
  it("still moves a valid time-only appointment (old 6-column shape)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const r = await legacyMove(a.id, owner().practitionerId, a.exp, a.expEnd, T("11:00"));
    expect(r).toMatchObject({ ok: true, result: "moved" });
    expect((await apptPract(a.id)).s).toContain("11:00:00");
  });

  it("cannot bypass booking pause", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await adminQuery(`update public.studios set practitioner_capacity_booking_enabled=false where id=$1`, [B.studioId]);
    expect(await legacyMove(a.id, owner().practitionerId, a.exp, a.expEnd, T("11:00"))).toMatchObject({
      result: "booking_paused",
    });
  });

  it("cannot move an appointment whose current practitioner is inactive (inherits final-target integrity)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await deactivate(P(1));
    expect(await legacyMove(a.id, owner().practitionerId, a.exp, a.expEnd, T("11:00"))).toMatchObject({
      result: "practitioner_reassignment_required",
    });
  });

  it("uses the same collision authority (23P01 on overlap)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await seedAppt(P(1), T("12:00")); // P1 already busy 12:00
    expect(await legacyMove(a.id, owner().practitionerId, a.exp, a.expEnd, T("12:00"))).toMatchObject({
      ok: false,
      code: "23P01",
    });
  });

  it("remains service_role only — anon + authenticated denied (42501)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const call = (q: (t: string, p?: unknown[]) => Promise<unknown>) =>
      q(`select public.practitioner_move_appointment($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::timestamptz)`, [
        a.id, B.studioId, owner().practitionerId, a.exp, a.expEnd, T("11:00"),
      ]);
    const code = (p: Promise<unknown>) => p.then(() => "ok").catch((e) => (e as { code?: string }).code);
    expect(await code(asRole("anon", call))).toBe("42501");
    expect(await code(asUser(owner().userId, call))).toBe("42501");
  });
});
