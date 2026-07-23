import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (migration 0147) — the OLD create_internal_appointment signature is
// now a deployment-compatible wrapper around v2. A stale deployment (or a second
// service-role adapter) that still calls the 9-arg command gets EVERY v2 guarantee:
// authoritative duration, per-practitioner working hours, owner-only custom length,
// booking pause, and the GiST collision authority. Studio B, cap ON, UTC.

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

// The OLD 9-arg command (what a pre-v2 deployment calls).
const legacyBook = (actor: string, target: string, start: string, durationMinutes: number) =>
  adminQuery(
    `select * from public.create_internal_appointment($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,null)`,
    [B.studioId, actor, target, B.clientId, serviceId, start, durationMinutes, hash64()],
  ).then((r) => r.rows[0] as { result: string; appointment_id: string | null; ends_at: string | null });

describe("0147 — old create_internal_appointment routes through v2 (deployment skew)", () => {
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
