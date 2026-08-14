import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// Migration 0152: Chloe manual-override booking blocker.
//   * Actual treatment overlap is a HARD GiST exclusion (never bypassable).
//   * The configured buffer/gap is SOFT: enforced for every normal writer,
//     bypassed only by an authenticated internal OWNER override
//     (allow_outside_availability=true), which stamps booked_outside_availability.
// Studio B, buffer 30, service duration 60, a wide 00:00–23:59 window so the
// working-hours dimension never masks the buffer dimension under test.

let B: SynthStudio;
let serviceId: string;
const owner = () => B.practitioners[0].practitionerId; // [0] = owner
const member = () => B.practitioners[1].practitionerId; // [1] = member
const DATE = "2031-09-15";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

async function setup(capacity: boolean) {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = $2,
       practitioner_capacity_booking_enabled = $2, timezone = 'UTC', buffer_minutes = 30
     where id = $1`,
    [B.studioId, capacity],
  );
  const svc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Consult',60,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceId = svc.rows[0].id as string;
  await adminQuery(
    `insert into public.studio_availability_default
       (id, studio_id, day_of_week, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,true,'00:00','23:59')`,
    [B.studioId, DOW],
  );
  for (const p of B.practitioners) {
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1,$2,$3) on conflict do nothing`,
      [B.studioId, serviceId, p.practitionerId],
    );
  }
}

// create_internal_appointment_v2(actor, target, start, {outside}) -> result row.
const book = (
  actor: string,
  target: string,
  start: string,
  outside = false,
) =>
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,$8)`,
    [B.studioId, actor, target, B.clientId, serviceId, start, hash64(), outside],
  ).then((r) => r.rows[0] as { result: string; appointment_id: string | null });

// Direct insert simulating a "normal writer" (e.g. public booking) that never
// sets the override flag. blocked_ends_at + snapshot are set by the 0029 trigger.
const directInsert = (
  practitionerId: string | null,
  start: string,
  end: string,
  outsideFlag = false,
) =>
  adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, booked_outside_availability)
     values ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,60,'confirmed',$8)`,
    [randomUUID(), B.studioId, practitionerId, B.clientId, serviceId, start, end, outsideFlag],
  );

afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

for (const capacity of [false, true]) {
  const mode = capacity ? "capacity ON (per-practitioner)" : "capacity OFF (studio-wide)";
  // The resource: cap ON scopes to the practitioner; cap OFF is studio-wide.
  const P = () => (capacity ? owner() : owner());

  describe(`0152 manual override: ${mode}`, () => {
    beforeEach(async () => {
      await setup(capacity);
      // Existing neighbour 13:00–14:00, booked normally by the owner.
      const first = await book(owner(), P(), T("13:00"));
      expect(first.result).toBe("created");
    });

    it("A: override 12:00–13:00 (immediately before) → created", async () => {
      const r = await book(owner(), P(), T("12:00"), true);
      expect(r.result).toBe("created");
    });

    it("B: override 14:00–15:00 (immediately after) → created", async () => {
      const r = await book(owner(), P(), T("14:00"), true);
      expect(r.result).toBe("created");
    });

    it("C: override OFF, both buffer-proximate times → buffer_conflict", async () => {
      expect((await book(owner(), P(), T("12:00"), false)).result).toBe("buffer_conflict");
      expect((await book(owner(), P(), T("14:00"), false)).result).toBe("buffer_conflict");
    });

    it("D: override ON but ACTUAL overlap 12:59–13:59 → hard reject (23P01)", async () => {
      // 12:59 + 60min = 13:59 overlaps 13:00–14:00. Validator skips buffer on
      // override, but the actual-interval GiST exclusion still rejects → 23P01.
      await expect(book(owner(), P(), T("12:59"), true)).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("non-override actual overlap 12:59–13:59 → hard reject (23P01), not the soft buffer", async () => {
      // A true overlap is NOT a buffer conflict (the soft check excludes actual
      // overlaps), so it falls through to the hard GiST exclusion → 23P01.
      await expect(book(owner(), P(), T("12:59"), false)).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("E: two concurrent override bookings at the SAME slot → exactly one confirmed", async () => {
      await Promise.allSettled([
        book(owner(), P(), T("15:00"), true),
        book(owner(), P(), T("15:00"), true),
      ]);
      // Regardless of how the race resolves (one 23P01 rollback), the actual-
      // overlap GiST exclusion guarantees exactly one confirmed row survives.
      const n = await adminQuery(
        `select count(*)::int n from public.appointments
          where studio_id=$1 and status='confirmed' and starts_at=$2::timestamptz`,
        [B.studioId, T("15:00")],
      );
      expect(n.rows[0].n).toBe(1);
    });

    it("G: exact touching boundary override 14:00 & 12:00 leave the neighbour intact (1 confirmed + 2 new)", async () => {
      expect((await book(owner(), P(), T("12:00"), true)).result).toBe("created");
      expect((await book(owner(), P(), T("14:00"), true)).result).toBe("created");
      const c = await adminQuery(
        `select count(*)::int n from public.appointments
          where studio_id=$1 and status='confirmed'`,
        [B.studioId],
      );
      expect(c.rows[0].n).toBe(3);
    });

    it("normal writer (direct insert, no flag) buffer-proximate → HB001 trigger", async () => {
      await expect(
        directInsert(P(), T("12:00"), T("13:00"), false),
      ).rejects.toMatchObject({ code: "HB001" });
    });

    it("member cannot forge the override (owner-only) → not_authorized", async () => {
      // A member booking for themselves is fine; the OVERRIDE flag is owner-only.
      const r = await book(member(), member(), T("12:00"), true);
      expect(r.result).toBe("not_authorized");
    });
  });
}

describe("0152: a NULL-practitioner direct insert (public booking, cap OFF) still buffered", () => {
  beforeEach(async () => {
    await setup(false);
    await book(owner(), owner(), T("13:00")); // neighbour on the owner
  });
  it("studio-wide buffer catches a NULL-practitioner buffer-proximate insert → HB001", async () => {
    // Public booking attributes to the owner, but prove the studio-wide branch
    // rejects even a NULL-practitioner buffer-proximate insert without a flag.
    await expect(
      directInsert(null, T("12:00"), T("13:00"), false),
    ).rejects.toMatchObject({ code: "HB001" });
  });
});
