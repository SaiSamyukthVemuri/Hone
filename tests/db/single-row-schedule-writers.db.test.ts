import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import {
  dropSynthStudio,
  seedStudioWideOpenAllWeek,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (migration 0150, Item 2), the single-row schedule writers take the
// studios-row + capacity advisory lock. Functional + serialization proofs.

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners[0].practitionerId;
const member = () => B.practitioners[1].practitionerId;
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
  await seedStudioWideOpenAllWeek(B.studioId, "09:00", "17:00");
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const dayUpsert = (actor: string, scope: string | null, dow: number, isOpen: boolean, o: string | null, c: string | null) =>
  adminQuery(`select public.upsert_availability_day_locked($1,$2,$3,$4,$5,$6::time,$7::time) r`, [
    B.studioId, actor, scope, dow, isOpen, o, c,
  ]).then((r) => r.rows[0].r as string);
const dayDelete = (actor: string, scope: string | null, dow: number | null) =>
  adminQuery(`select public.delete_availability_day_locked($1,$2,$3,$4) r`, [B.studioId, actor, scope, dow]).then(
    (r) => r.rows[0].r as string,
  );
const overrideUpsert = (actor: string, scope: string | null, date: string, isOpen: boolean, o: string | null, c: string | null) =>
  adminQuery(`select public.upsert_availability_override_locked($1,$2,$3,$4,$5,$6::time,$7::time,null) r`, [
    B.studioId, actor, scope, date, isOpen, o, c,
  ]).then((r) => r.rows[0].r as string);
const overrideDelete = (actor: string, id: string | null, scope: string | null, date: string | null) =>
  adminQuery(`select public.delete_availability_override_locked($1,$2,$3,$4,$5) r`, [
    B.studioId, actor, id, scope, date,
  ]).then((r) => r.rows[0].r as string);
const setEligible = (actor: string, service: string, prac: string, eligible: boolean) =>
  adminQuery(`select public.set_service_practitioner_eligibility_locked($1,$2,$3,$4,$5) r`, [
    B.studioId, actor, service, prac, eligible,
  ]).then((r) => r.rows[0].r as string);
const setActive = (actor: string, target: string, active: boolean) =>
  adminQuery(`select public.set_practitioner_active_locked($1,$2,$3,$4) r`, [B.studioId, actor, target, active]).then(
    (r) => r.rows[0].r as string,
  );
const book = (actor: string, target: string, start: string) =>
  adminQuery(
    `select result from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
    [B.studioId, actor, target, B.clientId, serviceId, start, hash64()],
  ).then((r) => r.rows[0].result as string);

describe("0150, functional: locked single-row schedule writers", () => {
  it("studio-wide + practitioner weekday upsert, single + full-week reset", async () => {
    expect(await dayUpsert(owner(), null, 1, true, "08:00", "12:00")).toBe("ok");
    expect(await dayUpsert(owner(), P(1), 1, true, "10:00", "14:00")).toBe("ok");
    let rows = await adminQuery(
      `select practitioner_id, open_time::text o from public.studio_availability_default where studio_id=$1 and day_of_week=1 order by practitioner_id nulls first`,
      [B.studioId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    expect(await dayDelete(owner(), P(1), 1)).toBe("ok"); // single day reset
    expect(await dayUpsert(owner(), P(1), 2, true, "10:00", "14:00")).toBe("ok");
    expect(await dayDelete(owner(), P(1), null)).toBe("ok"); // whole-week reset
    rows = await adminQuery(
      `select count(*)::int n from public.studio_availability_default where studio_id=$1 and practitioner_id=$2`,
      [B.studioId, P(1)],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("date override upsert/delete (studio-wide by id, practitioner by scope+date)", async () => {
    expect(await overrideUpsert(owner(), null, DATE, true, "10:00", "12:00")).toBe("ok");
    const id = (
      await adminQuery(`select id from public.studio_availability_overrides where studio_id=$1 and effective_date=$2 and practitioner_id is null`, [B.studioId, DATE])
    ).rows[0].id as string;
    expect(await overrideDelete(owner(), id, null, null)).toBe("ok");
    expect(await overrideUpsert(owner(), P(1), DATE, false, null, null)).toBe("ok");
    expect(await overrideDelete(owner(), null, P(1), DATE)).toBe("ok");
  });

  it("eligibility add/remove is idempotent", async () => {
    expect(await setEligible(owner(), serviceId, P(1), false)).toBe("ok");
    expect(await setEligible(owner(), serviceId, P(1), false)).toBe("ok"); // idempotent
    expect((await adminQuery(`select count(*)::int n from public.service_practitioners where service_id=$1 and practitioner_id=$2`, [serviceId, P(1)])).rows[0].n).toBe(0);
    expect(await setEligible(owner(), serviceId, P(1), true)).toBe("ok");
    expect(await setEligible(owner(), serviceId, P(1), true)).toBe("ok"); // idempotent, no dup
    expect((await adminQuery(`select count(*)::int n from public.service_practitioners where service_id=$1 and practitioner_id=$2`, [serviceId, P(1)])).rows[0].n).toBe(1);
  });

  it("deactivation sets active=false; owner + self are protected", async () => {
    expect(await setActive(owner(), P(1), false)).toBe("ok");
    expect((await adminQuery(`select active from public.practitioners where id=$1`, [P(1)])).rows[0].active).toBe(false);
    expect(await setActive(owner(), owner(), false)).toBe("cannot_modify_owner");
  });

  it("rejects: non-owner actor, cross-studio/unknown scope, inactive scope, capacity-OFF scope, invalid day/date, unknown studio", async () => {
    expect(await dayUpsert(member(), null, 1, true, "09:00", "17:00")).toBe("not_authorized");
    expect(await dayUpsert(owner(), randomUUID(), 1, true, "09:00", "17:00")).toBe("invalid_practitioner");
    await adminQuery(`update public.practitioners set active=false where id=$1`, [P(2)]);
    expect(await dayUpsert(owner(), P(2), 1, true, "09:00", "17:00")).toBe("invalid_practitioner");
    expect(await dayUpsert(owner(), null, 9, true, "09:00", "17:00")).toBe("invalid_day");
    expect(await overrideUpsert(owner(), null, null as unknown as string, true, "09:00", "17:00")).toBe("invalid_date");
    const other = await adminQuery(
      `select public.upsert_availability_day_locked('00000000-0000-0000-0000-000000000000',$1,null,1,true,'09:00','17:00') r`,
      [owner()],
    );
    expect(other.rows[0].r).toBe("studio_not_found");
  });

  it("capacity-OFF scoped write → capacity_disabled; Legacy studio-wide write → ok", async () => {
    await adminQuery(
      `update public.studios set practitioner_capacity_booking_enabled=false, practitioner_capacity_enabled=false where id=$1`,
      [B.studioId],
    );
    expect(await dayUpsert(owner(), P(1), 1, true, "09:00", "17:00")).toBe("capacity_disabled");
    expect(await dayUpsert(owner(), null, 1, true, "08:00", "12:00")).toBe("ok"); // studio-wide still works
  });
});

describe("0150: serialization (booking/move vs. schedule mutation)", () => {
  async function withHold(
    holdSql: string,
    holdParams: unknown[],
    contend: () => Promise<string>,
  ): Promise<string> {
    const c1 = new Client({ connectionString: resolveLocalDbUrl() });
    await c1.connect();
    try {
      await c1.query("set statement_timeout = '15s'");
      await c1.query("begin");
      await c1.query(holdSql, holdParams); // takes + holds the studios-row/advisory lock
      let done = false;
      const p = contend().then((r) => {
        done = true;
        return r;
      });
      await sleep(200);
      expect(done).toBe(false); // the contender is blocked behind the lock
      await c1.query("commit");
      return await p;
    } finally {
      await c1.end();
    }
  }

  it("A: day-close wins first → later booking blocks, then rejects practitioner_closed; no appt", async () => {
    const r = await withHold(
      `select public.upsert_availability_day_locked($1,$2,null,$3,false,null,null)`,
      [B.studioId, owner(), DOW],
      () => book(owner(), P(1), T("10:00")),
    );
    expect(r).toBe("practitioner_closed");
    expect((await adminQuery(`select count(*)::int n from public.appointments where studio_id=$1`, [B.studioId])).rows[0].n).toBe(0);
  });

  it("B: booking wins first → later day-close blocks, then commits; the appt is intact", async () => {
    // Booking holds the lock; the day-close waits, then applies AFTER the commit.
    const c1 = new Client({ connectionString: resolveLocalDbUrl() });
    await c1.connect();
    try {
      await c1.query("set statement_timeout = '15s'");
      await c1.query("begin");
      await c1.query(
        `select public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
        [B.studioId, owner(), P(1), B.clientId, serviceId, T("10:00"), hash64()],
      );
      let done = false;
      const close = adminQuery(`select public.upsert_availability_day_locked($1,$2,null,$3,false,null,null) r`, [
        B.studioId, owner(), DOW,
      ]).then((r) => { done = true; return r.rows[0].r as string; });
      await sleep(200);
      expect(done).toBe(false);
      await c1.query("commit");
      expect(await close).toBe("ok");
      // The already-committed appointment survives the later close.
      const appt = await adminQuery(
        `select practitioner_id, starts_at::text s from public.appointments where studio_id=$1`,
        [B.studioId],
      );
      expect(appt.rows).toHaveLength(1);
      expect(appt.rows[0].practitioner_id).toBe(P(1));
      expect(appt.rows[0].s).toContain("10:00:00");
    } finally {
      await c1.end();
    }
  });

  it("date-override close wins first → booking rejects outside/closed", async () => {
    const r = await withHold(
      `select public.upsert_availability_override_locked($1,$2,null,$3,false,null,null,null)`,
      [B.studioId, owner(), DATE],
      () => book(owner(), P(1), T("10:00")),
    );
    expect(r).toBe("practitioner_closed");
  });

  it("eligibility removal wins first → booking rejects not_eligible", async () => {
    const r = await withHold(
      `select public.set_service_practitioner_eligibility_locked($1,$2,$3,$4,false)`,
      [B.studioId, owner(), serviceId, P(1)],
      () => book(owner(), P(1), T("10:00")),
    );
    expect(r).toBe("not_eligible");
  });

  it("deactivation wins first → booking rejects invalid_practitioner", async () => {
    const r = await withHold(
      `select public.set_practitioner_active_locked($1,$2,$3,false)`,
      [B.studioId, owner(), P(1)],
      () => book(owner(), P(1), T("10:00")),
    );
    expect(r).toBe("invalid_practitioner");
  });

  it("two concurrent writes to the SAME availability row → deterministic last value, one row, no deadlock", async () => {
    const r = await withHold(
      `select public.upsert_availability_day_locked($1,$2,null,1,true,'09:00','17:00')`,
      [B.studioId, owner()],
      () => dayUpsert(owner(), null, 1, true, "10:00", "16:00"),
    );
    expect(r).toBe("ok");
    const rows = await adminQuery(
      `select open_time::text o, close_time::text c from public.studio_availability_default where studio_id=$1 and day_of_week=1 and practitioner_id is null`,
      [B.studioId],
    );
    expect(rows.rows).toHaveLength(1); // no duplicate
    expect(rows.rows[0].o).toBe("10:00:00"); // the second writer won
    expect(rows.rows[0].c).toBe("16:00:00");
  });
});
