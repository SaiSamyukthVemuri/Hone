import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// B6 / 0175 — REFRAMED, NOT DELETED.
//
// This suite was written for migration 0147, when the old 9-arg
// create_internal_appointment became a deployment-compatible wrapper around v2.
// B6 RETIRED that wrapper after a zero-caller census, so its forwarding
// contract no longer exists and the "stale deployment" premise is void.
//
// What does NOT go away is the set of guarantees the wrapper existed to prove,
// several of which are covered nowhere else: v2's duration AUTHORITY (a
// non-owner may not send an override at all; an owner may, within shape),
// invalid_service, per-practitioner working hours on booking, booking pause,
// and the GiST collision authority. Those are properties of the governed
// command, so the suite now exercises v2 directly.
//
// The one thing deliberately dropped is the wrapper's argument FORWARDING —
// there is no wrapper left to forward. tests/migrations/0175-* pins the exact
// DROP and tests/db/appointment-transition-integrity.db.test.ts proves the
// function is absent, so no third copy is added here. Studio B, cap ON, UTC.

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners[0].practitionerId;
const member = () => B.practitioners[1].practitionerId;
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

// v2 directly, preserving the retired wrapper's duration MAPPING so each test
// keeps its original meaning: the wrapper forwarded an override ONLY when the
// requested length differed from the service default, and passed null when it
// matched. Collapsing that to "always send the override" would turn every
// member booking into not_authorized and silently destroy these tests.
const SERVICE_DEFAULT_MINUTES = 30;
const legacyBook = (actor: string, target: string, start: string, durationMinutes: number) =>
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,$8,false)`,
    [
      B.studioId, actor, target, B.clientId, serviceId, start, hash64(),
      durationMinutes === SERVICE_DEFAULT_MINUTES ? null : durationMinutes,
    ],
  ).then((r) => r.rows[0] as { result: string; appointment_id: string | null; ends_at: string | null });

describe("v2 duration authority, hours, pause and collision (was: 0147 wrapper skew)", () => {
  it("duration == service default → normal booking (authoritative default applied)", async () => {
    const r = await legacyBook(member(), member(), T("10:00"), 30);
    expect(r.result).toBe("created");
    const row = await adminQuery(`select duration_minutes d from public.appointments where id=$1`, [r.appointment_id]);
    expect(row.rows[0].d).toBe(30);
  });

  it("a stale MEMBER app forging a NON-default duration is rejected (not_authorized)", async () => {
    expect((await legacyBook(member(), member(), T("10:00"), 45)).result).toBe("not_authorized");
  });

  it("an OWNER may book a valid non-default length through the old command", async () => {
    const r = await legacyBook(owner(), member(), T("10:00"), 45);
    expect(r.result).toBe("created");
    const row = await adminQuery(`select duration_minutes d from public.appointments where id=$1`, [r.appointment_id]);
    expect(row.rows[0].d).toBe(45);
  });

  it("an owner non-default length that violates the shape → invalid_duration", async () => {
    expect((await legacyBook(owner(), member(), T("10:00"), 20)).result).toBe("invalid_duration");
  });

  it("the old command now ENFORCES per-practitioner working hours", async () => {
    expect((await legacyBook(member(), member(), T("08:00"), 30)).result).toBe("outside_availability");
  });

  it("the old command still honours booking pause and the GiST collision authority", async () => {
    // Collision: book, then a second overlapping booking rolls back with 23P01.
    expect((await legacyBook(member(), member(), T("10:00"), 30)).result).toBe("created");
    await expect(legacyBook(owner(), member(), T("10:00"), 30)).rejects.toMatchObject({ code: "23P01" });
    // Pause: cap ON, booking OFF → booking_paused.
    await adminQuery(`update public.studios set practitioner_capacity_booking_enabled=false where id=$1`, [B.studioId]);
    expect((await legacyBook(member(), member(), T("11:00"), 30)).result).toBe("booking_paused");
  });

  it("a missing/inactive service → invalid_service (not a forged-duration bypass)", async () => {
    await adminQuery(`update public.services set active=false where id=$1`, [serviceId]);
    expect((await legacyBook(owner(), member(), T("10:00"), 999)).result).toBe("invalid_service");
  });

  it("Legacy (capacity OFF) is unchanged: the old command books normally with no hours enforcement", async () => {
    await adminQuery(
      `update public.studios set practitioner_capacity_booking_enabled=false,
         practitioner_capacity_enabled=false where id=$1`,
      [B.studioId],
    );
    // 03:00 is outside 09–17 but Legacy has no per-practitioner availability → books.
    expect((await legacyBook(member(), member(), T("03:00"), 30)).result).toBe("created");
  });
});
