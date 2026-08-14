import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4 (migration 0146), Item 2 authoritative duration + Item 3 the one
// shared, target-aware availability validator. Studio B, capacity ON + booking ON,
// UTC, studio-wide window 09:00–17:00 on the test date's weekday.

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners[0].practitionerId; // [0] = owner
const member = () => B.practitioners[1].practitionerId; // [1] = member
const DATE = "2031-09-15";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat (matches pg dow)
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
  // Studio-wide weekly default: open 09:00–17:00 on the test weekday.
  await adminQuery(
    `insert into public.studio_availability_default
       (id, studio_id, day_of_week, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,true,'09:00','17:00')`,
    [B.studioId, DOW],
  );
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const validate = (
  target: string,
  start: string,
  end: string,
  outside = false,
  service: string | null = serviceId,
) =>
  adminQuery(
    `select public.validate_appointment_availability($1,$2,$3,$4::timestamptz,$5::timestamptz,null,$6) v`,
    [B.studioId, target, service, start, end, outside],
  ).then((r) => r.rows[0].v as string);

type BookOpts = { override?: number | null; outside?: boolean };
const book = (actor: string, target: string, start: string, opts: BookOpts = {}) =>
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,$8,$9)`,
    [
      B.studioId, actor, target, B.clientId, serviceId, start, hash64(),
      opts.override ?? null, opts.outside ?? false,
    ],
  ).then((r) => r.rows[0] as { result: string; appointment_id: string | null; ends_at: string | null });

const overrideOpen = (target: string | null, open: string, close: string, isOpen = true) =>
  adminQuery(
    `insert into public.studio_availability_overrides
       (id, studio_id, practitioner_id, effective_date, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
    [B.studioId, target, DATE, isOpen, isOpen ? open : null, isOpen ? close : null],
  );

describe("0146 validator: working hours, blockouts, membership, eligibility", () => {
  it("within the window → ok", async () => {
    expect(await validate(P(1), T("10:00"), T("10:30"))).toBe("ok");
  });
  it("before open / after close → outside_availability", async () => {
    expect(await validate(P(1), T("08:00"), T("08:30"))).toBe("outside_availability");
    expect(await validate(P(1), T("16:45"), T("17:15"))).toBe("outside_availability");
  });
  it("closed day (date override is_open=false) → practitioner_closed", async () => {
    await overrideOpen(null, "", "", false);
    expect(await validate(P(1), T("10:00"), T("10:30"))).toBe("practitioner_closed");
  });
  it("full-day blockout → practitioner_closed, NEVER bypassed by the owner override", async () => {
    await adminQuery(
      `insert into public.studio_blockouts (id, studio_id, starts_on, ends_on)
       values (gen_random_uuid(),$1,$2,$2)`,
      [B.studioId, DATE],
    );
    expect(await validate(P(1), T("10:00"), T("10:30"))).toBe("practitioner_closed");
    expect(await validate(P(1), T("10:00"), T("10:30"), true)).toBe("practitioner_closed");
  });
  it("owner outside-availability override bypasses ONLY the working-hours window", async () => {
    expect(await validate(P(1), T("08:00"), T("08:30"))).toBe("outside_availability");
    expect(await validate(P(1), T("08:00"), T("08:30"), true)).toBe("ok");
  });
  it("a practitioner-specific window wins over the studio-wide window", async () => {
    await overrideOpen(P(1), "10:00", "12:00");
    expect(await validate(P(1), T("09:30"), T("10:00"))).toBe("outside_availability"); // P1: 10–12
    expect(await validate(P(1), T("10:30"), T("11:00"))).toBe("ok");
    expect(await validate(P(2), T("09:30"), T("10:00"))).toBe("ok"); // P2: studio-wide 09–17
  });
  it("ineligible target → not_eligible; inactive/unknown target → invalid_practitioner", async () => {
    await adminQuery(
      `delete from public.service_practitioners where service_id=$1 and practitioner_id=$2`,
      [serviceId, P(1)],
    );
    expect(await validate(P(1), T("10:00"), T("10:30"))).toBe("not_eligible");
    await adminQuery(`update public.practitioners set active=false where id=$1`, [P(2)]);
    expect(await validate(P(2), T("10:00"), T("10:30"))).toBe("invalid_practitioner");
  });
  it("Legacy (capacity OFF) is a no-op → ok even outside any window", async () => {
    await adminQuery(
      `update public.studios set practitioner_capacity_booking_enabled=false,
         practitioner_capacity_enabled=false where id=$1`,
      [B.studioId],
    );
    expect(await validate(P(1), T("03:00"), T("03:30"))).toBe("ok");
  });
});

describe("0146 v2 command: authoritative duration + owner-only overrides", () => {
  it("normal booking derives duration from the service row (30 min)", async () => {
    const r = await book(member(), member(), T("10:00"));
    expect(r.result).toBe("created");
    const row = await adminQuery(
      `select duration_minutes d, ends_at::text e from public.appointments where id=$1`,
      [r.appointment_id],
    );
    expect(row.rows[0].d).toBe(30);
    expect(row.rows[0].e).toContain("10:30:00");
  });
  it("owner may book a custom length (45) inside the window", async () => {
    const r = await book(owner(), member(), T("10:00"), { override: 45 });
    expect(r.result).toBe("created");
    const row = await adminQuery(`select duration_minutes d from public.appointments where id=$1`, [r.appointment_id]);
    expect(row.rows[0].d).toBe(45);
  });
  it("a MEMBER cannot forge a custom duration or an availability bypass", async () => {
    expect((await book(member(), member(), T("10:00"), { override: 45 })).result).toBe("not_authorized");
    expect((await book(member(), member(), T("08:00"), { outside: true })).result).toBe("not_authorized");
  });
  it("owner override outside 15..360 / not a multiple of 15 → invalid_duration", async () => {
    expect((await book(owner(), member(), T("10:00"), { override: 20 })).result).toBe("invalid_duration");
    expect((await book(owner(), member(), T("10:00"), { override: 400 })).result).toBe("invalid_duration");
  });
  it("member booking outside hours (no bypass) → outside_availability; owner WITH bypass → created", async () => {
    expect((await book(member(), member(), T("08:00"))).result).toBe("outside_availability");
    expect((await book(owner(), member(), T("08:00"), { outside: true })).result).toBe("created");
  });
  it("booking paused (capacity ON, booking OFF) → booking_paused, no appointment", async () => {
    await adminQuery(
      `update public.studios set practitioner_capacity_booking_enabled=false where id=$1`,
      [B.studioId],
    );
    const r = await book(owner(), member(), T("10:00"));
    expect(r.result).toBe("booking_paused");
    expect(r.appointment_id).toBeNull();
  });
  it("owner booking for an INELIGIBLE target → not_eligible", async () => {
    await adminQuery(
      `delete from public.service_practitioners where service_id=$1 and practitioner_id=$2`,
      [serviceId, P(2)],
    );
    expect((await book(owner(), P(2), T("10:00"))).result).toBe("not_eligible");
  });
});
