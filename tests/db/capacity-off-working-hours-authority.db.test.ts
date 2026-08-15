import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// WHERE WORKING-HOURS AUTHORITY ACTUALLY LIVES, per capacity mode.
//
// This suite exists to pin the single fact the application-layer working-hours
// check depends on, because that fact is surprising and invisible from the
// call site:
//
//   validate_appointment_availability (migration 0152) fences its ENTIRE
//   working-hours block — the practitioner check, the service eligibility
//   check, the blockout check and the open/close window — behind
//   `if v_cap then`. A capacity-OFF studio therefore gets NO hours enforcement
//   from Postgres at all. The only rules it still applies are the soft buffer
//   and, through the shadow table's exclusion constraint, real collisions.
//
// Why that matters for lib/booking/availability-window.ts. When the internal
// booking action stopped demanding exact smart-suggestion membership, it would
// have been natural to assume the database validates hours and simply drop the
// check. On a capacity-ON studio that assumption holds. On a Legacy studio it
// is false, and dropping the check would have let the manual-time path book
// 03:00 with no gate, no owner requirement and no audit stamp.
//
// If a future migration makes the validator enforce hours in BOTH modes, the
// capacity-OFF cases below go red. That is the correct signal: the app-layer
// check becomes defence in depth rather than the sole authority, and this file
// should be updated deliberately rather than the check quietly removed.

let B: SynthStudio;
let serviceId: string;
const owner = () => B.practitioners[0].practitionerId;
const DATE = "2031-09-16";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

// Studio timezone is UTC throughout so a local wall-clock time and its UTC
// instant are the same string; the hours dimension is what is under test, not
// timezone projection.
async function setCapacity(capacity: boolean) {
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = $2,
       practitioner_capacity_booking_enabled = $2
     where id = $1`,
    [B.studioId, capacity],
  );
}

const validate = (start: string, end: string, allowOutside = false) =>
  adminQuery(
    `select public.validate_appointment_availability($1,$2,$3,$4::timestamptz,$5::timestamptz,null,$6) as result`,
    [B.studioId, owner(), serviceId, start, end, allowOutside],
  ).then((r) => r.rows[0].result as string);

const book = (start: string, end: string, allowOutside = false) =>
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,$8)`,
    [B.studioId, owner(), owner(), B.clientId, serviceId, start, hash64(), allowOutside],
  ).then((r) => r.rows[0] as { result: string; appointment_id: string | null });

beforeAll(async () => {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set timezone = 'UTC', buffer_minutes = 0 where id = $1`,
    [B.studioId],
  );
  const svc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Consult',60,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceId = svc.rows[0].id as string;
  // A DELIBERATELY NARROW window: open 09:00-17:00 on this weekday only.
  await adminQuery(
    `insert into public.studio_availability_default
       (id, studio_id, day_of_week, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,true,'09:00','17:00')`,
    [B.studioId, DOW],
  );
  for (const p of B.practitioners) {
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1,$2,$3) on conflict do nothing`,
      [B.studioId, serviceId, p.practitionerId],
    );
  }
});

afterAll(async () => {
  await dropSynthStudio(B);
  await closePool();
});

describe("capacity ON — the database DOES enforce working hours", () => {
  beforeAll(() => setCapacity(true));

  it("accepts a time inside the window", async () => {
    expect(await validate(T("15:30"), T("16:30"))).toBe("ok");
  });

  it("accepts 15:30 — a time that is NOT a packed smart suggestion", async () => {
    // The point of the whole change: the database has never cared about
    // suggestion membership on the internal path. There is no
    // 'not_a_public_slot' equivalent here (compare migration 0170's public
    // command, which re-derives the candidate set in SQL and demands exact
    // membership). The refusal Chloe hit was purely application-layer.
    expect(await validate(T("15:30"), T("16:30"))).toBe("ok");
  });

  it("refuses a time whose service end runs past close", async () => {
    expect(await validate(T("16:30"), T("17:30"))).toBe("outside_availability");
  });

  it("refuses a time before open", async () => {
    expect(await validate(T("08:00"), T("09:00"))).toBe("outside_availability");
  });

  it("the owner override bypasses the window", async () => {
    expect(await validate(T("03:00"), T("04:00"), true)).toBe("ok");
  });
});

describe("capacity OFF — the database does NOT enforce working hours", () => {
  beforeAll(() => setCapacity(false));

  it("accepts a time inside the window (as expected)", async () => {
    expect(await validate(T("15:30"), T("16:30"))).toBe("ok");
  });

  it("ALSO accepts 03:00, hours before the studio opens", async () => {
    // THE LOAD-BEARING FACT. Not a bug being asserted as correct — a documented
    // property of migration 0152 that the application must compensate for. With
    // capacity OFF there is no per-practitioner working-hours model in the
    // validator, so it returns 'ok' for a time no one is working.
    expect(await validate(T("03:00"), T("04:00"))).toBe("ok");
  });

  it("ALSO accepts a time past closing", async () => {
    expect(await validate(T("22:00"), T("23:00"))).toBe("ok");
  });

  it("and the full booking command accepts it too — no hours gate anywhere", async () => {
    // Proven through the command the application actually calls, not just the
    // validator, so the claim covers the real path end to end.
    const r = await book(T("04:00"), T("05:00"));
    expect(r.result).toBe("created");
    expect(r.appointment_id).not.toBeNull();
    await adminQuery(`delete from public.appointments where id = $1`, [
      r.appointment_id,
    ]);
  });

  it("the SOFT BUFFER still runs with capacity OFF (it sits outside the v_cap branch)", async () => {
    // Not everything is fenced: the buffer check is deliberately outside
    // `if v_cap then`, which is why the application layer does NOT need to
    // re-implement buffer law and deliberately does not.
    await adminQuery(
      `update public.studios set buffer_minutes = 30 where id = $1`,
      [B.studioId],
    );
    const seeded = await book(T("13:00"), T("14:00"));
    expect(seeded.result).toBe("created");
    try {
      // 14:15 does not overlap 13:00-14:00, but it is inside the 30-minute gap.
      expect(await validate(T("14:15"), T("15:15"))).toBe("buffer_conflict");
    } finally {
      await adminQuery(`delete from public.appointments where id = $1`, [
        seeded.appointment_id,
      ]);
      await adminQuery(
        `update public.studios set buffer_minutes = 0 where id = $1`,
        [B.studioId],
      );
    }
  });

  it("REAL COLLISIONS are still refused with capacity OFF, and are NOT bypassable", async () => {
    // The per-resource GiST exclusion on studio_calendar_reservations is the
    // authority for appointments, timed blocks, recurring breaks and full-day
    // blockouts alike, in both modes. This is why the application layer leaves
    // collision detection entirely to the database.
    const first = await book(T("10:00"), T("11:00"));
    expect(first.result).toBe("created");
    try {
      await expect(
        adminQuery(
          `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,$8)`,
          [
            B.studioId,
            owner(),
            owner(),
            B.clientId,
            serviceId,
            T("10:30"),
            hash64(),
            // Even WITH the override, the exclusion still fires.
            true,
          ],
        ),
      ).rejects.toThrow(/23P01|exclusion|overlap/i);
    } finally {
      await adminQuery(`delete from public.appointments where id = $1`, [
        first.appointment_id,
      ]);
    }
  });
});
