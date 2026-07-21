import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioA, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 — move_or_reassign_appointment (migration 0143): atomic time-move
// + practitioner-reassignment. Studio B (owner P0 + members P1, P2), capacity ON,
// booking ON, UTC, buffer 0. Never Willow.

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

type MoveOut =
  | { ok: true; result: string; row: Record<string, unknown> }
  | { ok: false; code: string | undefined };
const move = (
  apptId: string,
  actor: string,
  target: string,
  expStart: string,
  expEnd: string,
  newStart: string,
): Promise<MoveOut> =>
  adminQuery(
    `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
    [apptId, B.studioId, actor, target, expStart, expEnd, newStart],
  )
    .then((r) => ({ ok: true as const, result: r.rows[0].result as string, row: r.rows[0] as Record<string, unknown> }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));

const apptRow = (id: string) =>
  adminQuery(`select practitioner_id, starts_at::text s from public.appointments where id=$1`, [id]).then((r) => r.rows[0]);
const resKey = (id: string) =>
  adminQuery(
    `select resource_key from public.studio_calendar_reservations where source_kind='appointment' and source_id=$1`,
    [id],
  ).then((r) => r.rows.map((x) => x.resource_key as string));
const setBooking = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_booking_enabled = $2 where id = $1`, [B.studioId, v]);

// ---------------------------------------------------------------------------
describe("0143 move/reassign contracts", () => {
  it("owner time-only move (target = current): moved, time updated, practitioner + shadow key unchanged", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const r = await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00"));
    expect(r).toMatchObject({ ok: true, result: "moved" });
    const row = await apptRow(a.id);
    expect(row.practitioner_id).toBe(P(1));
    expect(row.s).toContain("11:00:00");
    expect(await resKey(a.id)).toEqual([P(1)]);
  });

  it("owner reassign A→B (same time): reassigned, practitioner + shadow key move to B", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const r = await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp);
    expect(r).toMatchObject({ ok: true, result: "reassigned" });
    expect((await apptRow(a.id)).practitioner_id).toBe(P(2));
    expect(await resKey(a.id)).toEqual([P(2)]); // re-keyed; no orphan on A
  });

  it("owner move + reassign in one op: moved_and_reassigned", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const r = await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, T("12:00"));
    expect(r).toMatchObject({ ok: true, result: "moved_and_reassigned" });
    const row = await apptRow(a.id);
    expect(row.practitioner_id).toBe(P(2));
    expect(row.s).toContain("12:00:00");
  });

  it("member may move OWN appointment but not another's, and may not reassign", async () => {
    const own = await seedAppt(P(1), T("10:00"));
    expect(await move(own.id, P(1), P(1), own.exp, own.expEnd, T("10:30"))).toMatchObject({ result: "moved" });
    const others = await seedAppt(P(2), T("13:00"));
    // member P1 moving P2's appointment → not_authorized
    const m1 = await seedAppt(P(1), T("15:00"));
    expect(await move(others.id, P(1), P(2), others.exp, others.expEnd, T("13:30"))).toMatchObject({
      result: "not_authorized",
    });
    // member P1 reassigning their OWN appt to P2 → not_authorized
    expect(await move(m1.id, P(1), P(2), m1.exp, m1.expEnd, m1.exp)).toMatchObject({ result: "not_authorized" });
  });

  it("rejects reassignment to inactive / ineligible / cross-studio targets", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await adminQuery(`update public.practitioners set active=false where id=$1`, [P(2)]);
    expect(await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp)).toMatchObject({
      result: "invalid_practitioner",
    });
    await adminQuery(`update public.practitioners set active=true where id=$1`, [P(2)]);
    await adminQuery(`delete from public.service_practitioners where service_id=$1 and practitioner_id=$2`, [serviceId, P(2)]);
    expect(await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp)).toMatchObject({ result: "not_eligible" });
    const A = await seedSynthStudioA();
    try {
      expect(
        await move(a.id, owner().practitionerId, A.practitioners[0].practitionerId, a.exp, a.expEnd, a.exp),
      ).toMatchObject({ result: "invalid_practitioner" });
    } finally {
      await dropSynthStudio(A);
    }
  });

  it("stale snapshot and no-op are handled without mutating", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    // no-op: same time, same practitioner
    expect(await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, a.exp)).toMatchObject({ result: "no_change" });
    // stale: wrong expected end
    expect(await move(a.id, owner().practitionerId, P(1), a.exp, T("09:59"), T("11:00"))).toMatchObject({
      result: "stale_appointment",
    });
    expect((await apptRow(a.id)).s).toContain("10:00:00"); // unchanged
  });

  it("reassign that would collide on the target rolls back (23P01); the original is preserved", async () => {
    const a = await seedAppt(P(1), T("10:00")); // A busy 10:00
    await seedAppt(P(2), T("10:00")); // B already busy 10:00
    const r = await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp); // reassign A's appt to B @10:00
    expect(r).toMatchObject({ ok: false, code: "23P01" });
    expect((await apptRow(a.id)).practitioner_id).toBe(P(1)); // unchanged
    expect(await resKey(a.id)).toEqual([P(1)]);
  });

  it("booking-paused rejects any move/reassign that commits a new interval or target", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    await setBooking(false);
    expect(await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00"))).toMatchObject({
      result: "booking_paused",
    });
    expect(await move(a.id, owner().practitionerId, P(2), a.exp, a.expEnd, a.exp)).toMatchObject({
      result: "booking_paused",
    });
  });
});

// ---------------------------------------------------------------------------
describe("0143 concurrency + privilege", () => {
  it("two moves from the same snapshot: one moves, the other is stale (advisory-serialized)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const first = await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00"));
    expect(first).toMatchObject({ result: "moved" });
    const second = await move(a.id, owner().practitionerId, P(1), a.exp, a.expEnd, T("12:00"));
    expect(second).toMatchObject({ result: "stale_appointment" }); // snapshot no longer matches
  });

  it("a move blocks under the shared studio lock while another holds it", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const conA = new Client({ connectionString: resolveLocalDbUrl() });
    const conB = new Client({ connectionString: resolveLocalDbUrl() });
    await conA.connect();
    await conB.connect();
    try {
      await conA.query("begin");
      await conA.query(`select public.acquire_studio_capacity_lock($1)`, [B.studioId]); // hold the lock
      await conB.query("begin");
      await conB.query("set local statement_timeout = '900ms'");
      let code: string | undefined;
      try {
        await conB.query(
          `select public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
          [a.id, B.studioId, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00")],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("57014"); // blocked on the advisory lock
      await conB.query("rollback").catch(() => undefined);
      await conA.query("rollback");
    } finally {
      await conA.end();
      await conB.end();
    }
  });

  it("is service_role only — anon and authenticated denied (42501)", async () => {
    const a = await seedAppt(P(1), T("10:00"));
    const call = (q: (t: string, p?: unknown[]) => Promise<unknown>) =>
      q(`select public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`, [
        a.id, B.studioId, owner().practitionerId, P(1), a.exp, a.expEnd, T("11:00"),
      ]);
    const code = (p: Promise<unknown>) => p.then(() => "ok").catch((e) => (e as { code?: string }).code);
    expect(await code(asRole("anon", call))).toBe("42501");
    expect(await code(asUser(owner().userId, call))).toBe("42501");
  });
});
