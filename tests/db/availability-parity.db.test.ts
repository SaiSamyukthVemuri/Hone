import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (Item 5), availability parity: the internal creation command
// ACCEPTS exactly the intervals the slot reader (lib/booking/slots.ts) would
// offer, and REJECTS exactly those it hides. The reader + the DB validator read
// the SAME tables with the SAME rule ordering (date override > weekly default;
// practitioner-specific > studio-wide NULL; studio timezone; half-open overlap),
// and interval collisions are the shared per-resource GiST authority. The reader's
// offered-slot behaviour is unit-proven in tests/lib/booking/slots-per-practitioner
// + slots-smart-scheduling; this suite proves the WRITER side across every
// dimension with representative should-offer / should-hide points (the db lane
// cannot execute the TS reader, no local REST client). 12h/24h is display-only:
// the command/validator are timezone-based and format-independent.

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

// Book via the authoritative v2 creation command (owner books target P1).
const book = (start: string, target = P(1)) =>
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
    [B.studioId, owner(), target, B.clientId, serviceId, start, hash64()],
  ).then((r) => r.rows[0] as { result: string });
const overrideRow = (target: string | null, date: string, open: string | null, close: string | null, isOpen: boolean) =>
  adminQuery(
    `insert into public.studio_availability_overrides
       (id, studio_id, practitioner_id, effective_date, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
    [B.studioId, target, date, isOpen, open, close],
  );

describe("Item 5: availability parity (writer accepts offered, rejects hidden)", () => {
  it("studio weekly fallback: in-window offered → created; out-of-window hidden → outside_availability", async () => {
    expect((await book(T("10:00"))).result).toBe("created");
    expect((await book(T("08:00"))).result).toBe("outside_availability");
  });

  it("practitioner-specific override wins over studio-wide", async () => {
    await overrideRow(P(1), DATE, "10:00", "12:00", true);
    expect((await book(T("10:30"))).result).toBe("created");
    expect((await book(T("09:30"))).result).toBe("outside_availability"); // studio-wide would allow; P-specific wins
  });

  it("studio-wide date override wins over the weekly default", async () => {
    await overrideRow(null, DATE, "13:00", "15:00", true);
    expect((await book(T("14:00"))).result).toBe("created");
    expect((await book(T("10:00"))).result).toBe("outside_availability"); // weekly would allow; override wins
  });

  it("closed day (override is_open=false) → practitioner_closed", async () => {
    await overrideRow(null, DATE, null, null, false);
    expect((await book(T("10:00"))).result).toBe("practitioner_closed");
  });

  it("full-day blockout → practitioner_closed", async () => {
    await adminQuery(
      `insert into public.studio_blockouts (id, studio_id, starts_on, ends_on) values (gen_random_uuid(),$1,$2,$2)`,
      [B.studioId, DATE],
    );
    expect((await book(T("10:00"))).result).toBe("practitioner_closed");
  });

  it("timed block reserves the interval → overlap rejected (23P01), adjacent allowed", async () => {
    await adminQuery(
      `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
       values (gen_random_uuid(),$1,$2::timestamptz,$3::timestamptz,'other',$4)`,
      [B.studioId, T("10:00"), T("11:00"), P(1)],
    );
    await expect(book(T("10:00"))).rejects.toMatchObject({ code: "23P01" });
    expect((await book(T("11:00"))).result).toBe("created"); // touching is allowed (half-open)
    // Recurring breaks fan out to the SAME shadow reservation table by resource_key,
    // so their overlap rejection is identical to this timed-block case.
  });

  it("existing appointment + buffer reserves the protected interval", async () => {
    await adminQuery(`update public.studios set buffer_minutes = 15 where id=$1`, [B.studioId]);
    // Existing P1 appt 10:00–10:30, blocked to 10:45 by the 15-min buffer snapshot.
    const end = new Date(new Date(T("10:00")).getTime() + 30 * 60_000).toISOString();
    await adminQuery(
      `insert into public.appointments
         (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
       values (gen_random_uuid(),$1,$2,$3,$4,$5::timestamptz,$6::timestamptz,30,'confirmed',$7)`,
      [B.studioId, P(1), B.clientId, serviceId, T("10:00"), end, hash64()],
    );
    // Buffer is now a SOFT constraint: a non-override writer inside the buffer
    // is rejected via the validator (result 'buffer_conflict'), not a hard 23P01.
    expect((await book(T("10:40"))).result).toBe("buffer_conflict"); // inside the buffer
    expect((await book(T("10:45"))).result).toBe("created"); // exactly at the protected end
  });

  it("DST spring-forward + fall-back: local-window math is timezone-correct", async () => {
    await adminQuery(`update public.studios set timezone = 'America/Toronto' where id=$1`, [B.studioId]);
    for (const day of ["2031-03-09" /* spring forward */, "2031-11-02" /* fall back */]) {
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      await adminQuery(
        `insert into public.studio_availability_default
           (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
         values (gen_random_uuid(),$1,null,$2,true,'09:00','17:00')
         on conflict on constraint studio_availability_default_scope_key
         do update set is_open=true, open_time='09:00', close_time='17:00'`,
        [B.studioId, dow],
      );
      // Compute the UTC instant for 14:00 / 06:00 LOCAL Toronto via Postgres (DST-correct).
      const inWindow = (
        await adminQuery(`select (timestamp '${day} 14:00' at time zone 'America/Toronto') u`)
      ).rows[0].u as Date;
      const outWindow = (
        await adminQuery(`select (timestamp '${day} 06:00' at time zone 'America/Toronto') u`)
      ).rows[0].u as Date;
      expect((await book(inWindow.toISOString())).result).toBe("created");
      expect((await book(outWindow.toISOString())).result).toBe("outside_availability");
    }
  });
});
