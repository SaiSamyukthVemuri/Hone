import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioA, seedStudioWideOpenAllWeek, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 4: create_internal_appointment (migration 0142): the canonical
// atomic internal booking command. Contracts + concurrency on synthetic Studio B
// (owner P0 + members P1, P2). Capacity ON + booking ON unless a test toggles it.
// Never Willow.

let B: SynthStudio;
let serviceId: string;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners.find((p) => p.role === "owner")!;

// A safe future instant (UTC studio) on a fixed far-future date.
const T = (hhmm: string) => `2031-09-15T${hhmm}:00Z`;
// A valid 64-char lowercase-hex token hash (appointments_cancellation_token_hash_check).
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
  // The 0134 default_eligibility_for_service() AFTER-INSERT trigger already made
  // every ACTIVE practitioner (P0/P1/P2) eligible, no manual inserts (they'd
  // collide on service_practitioners_unique). The ineligible test deletes a row.
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

type BookOut = { ok: true; result: string; id: string | null } | { ok: false; code: string | undefined };
const book = (
  actor: string,
  target: string,
  start: string,
  opts: { client?: string; service?: string; dur?: number } = {},
): Promise<BookOut> =>
  // B6 / 0175 REPOINTED to the governed successor. Every invariant this suite
  // proves, per-practitioner collision, parallel practitioners, scoped blocks,
  // actor authorization, capacity pause, advisory-lock serialization, EXECUTE
  // posture, is a property of internal booking, not of the retired wrapper.
  //
  // THE ARGUMENT ORDER IS NOT THE SAME and a name-only swap would have
  // silently mis-bound: the retired wrapper took
  //   (..., starts_at, duration, token_hash, notes)
  // while v2 takes
  //   (..., starts_at, token_hash, notes, duration_override, allow_outside)
  // so duration and token_hash would have traded places, a 30 landing in a
  // token column and a hex digest landing in an integer. Mapped explicitly.
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`,
    [
      B.studioId,
      actor,
      target,
      opts.client ?? B.clientId,
      opts.service ?? serviceId,
      start,
      hash64(),
      null,
      // DURATION IS NOT A STRAIGHT PORT. The retired wrapper's `duration` was
      // the appointment's length; v2's `p_duration_override_minutes` is an
      // OWNER-ONLY override layered over the service default, and v2 returns
      // not_authorized if a non-owner sends one at all. Passing the old 30
      // unconditionally therefore made every MEMBER booking unauthorized,
      // which looked like a v2 authorization defect and was really a
      // mis-port. Default to null so the service's own 30-minute default
      // applies (identical geometry, so every collision case is unchanged),
      // and send an explicit override only where a test asks for one.
      opts.dur ?? null,
      false,
    ],
  )
    .then((r) => ({ ok: true as const, result: r.rows[0].result as string, id: r.rows[0].appointment_id as string | null }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));

const setBooking = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_booking_enabled = $2 where id = $1`, [B.studioId, v]);
const setCap = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_enabled = $2 where id = $1`, [B.studioId, v]);
const insScopedBlock = (pid: string | null, s: string, e: string) =>
  adminQuery(
    `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
     values ($1,$2,$3,$4,'break',$5)`,
    [randomUUID(), B.studioId, s, e, pid],
  );

// ---------------------------------------------------------------------------
describe("0142 booking contracts (capacity ON, booking ON)", () => {
  it("two bookings for A at the same time: one succeeds, one fails (23P01)", async () => {
    const first = await book(owner().practitionerId, P(1), T("10:00"));
    expect(first).toMatchObject({ ok: true, result: "created" });
    const second = await book(owner().practitionerId, P(1), T("10:00"));
    expect(second).toMatchObject({ ok: false, code: "23P01" }); // shadow GiST is the authority
  });

  it("bookings for A and B at the same time both succeed (parallel practitioners)", async () => {
    expect(await book(owner().practitionerId, P(1), T("11:00"))).toMatchObject({ ok: true, result: "created" });
    expect(await book(owner().practitionerId, P(2), T("11:00"))).toMatchObject({ ok: true, result: "created" });
  });

  it("a scoped A block collides with an A booking, but NOT a B booking", async () => {
    await insScopedBlock(P(1), T("13:00"), T("13:30"));
    expect(await book(owner().practitionerId, P(1), T("13:00"))).toMatchObject({ ok: false, code: "23P01" });
    expect(await book(owner().practitionerId, P(2), T("13:00"))).toMatchObject({ ok: true, result: "created" });
  });

  it("owner may book for any eligible practitioner; a member may book only for themselves", async () => {
    expect(await book(owner().practitionerId, P(2), T("14:00"))).toMatchObject({ ok: true, result: "created" });
    // member P1 booking for P2 → not_authorized; booking for self → created.
    expect(await book(P(1), P(2), T("14:30"))).toMatchObject({ ok: true, result: "not_authorized" });
    expect(await book(P(1), P(1), T("14:30"))).toMatchObject({ ok: true, result: "created" });
  });

  it("rejects inactive, ineligible, and cross-studio targets", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [P(2)]);
    expect(await book(owner().practitionerId, P(2), T("15:00"))).toMatchObject({ result: "invalid_practitioner" });
    // ineligible: remove P1's eligibility for the service.
    await adminQuery(`delete from public.service_practitioners where service_id=$1 and practitioner_id=$2`, [serviceId, P(1)]);
    expect(await book(owner().practitionerId, P(1), T("15:00"))).toMatchObject({ result: "not_eligible" });
    // cross-studio practitioner id from a separate studio.
    const A = await seedSynthStudioA();
    try {
      expect(await book(owner().practitionerId, A.practitioners[0].practitionerId, T("15:00"))).toMatchObject({
        result: "invalid_practitioner",
      });
    } finally {
      await dropSynthStudio(A);
    }
  });

  it("rejects a past time and a non-positive duration", async () => {
    expect(await book(owner().practitionerId, P(1), "2020-01-01T10:00:00Z")).toMatchObject({ result: "invalid_time" });
    expect(await book(owner().practitionerId, P(1), T("16:00"), { dur: 0 })).toMatchObject({ result: "invalid_duration" });
  });
});

// ---------------------------------------------------------------------------
describe("0142 booking-state contract", () => {
  it("capacity-ready / booking-PAUSED rejects new creation", async () => {
    await setBooking(false); // cap ON, book OFF
    expect(await book(owner().practitionerId, P(1), T("10:00"))).toMatchObject({ result: "booking_paused" });
  });

  it("Legacy (capacity OFF) preserves studio-wide single-chair booking, self-assigned", async () => {
    // Booking OFF first, then capacity OFF, cap=false requires book=false
    // (studios_capacity_booking_valid).
    await setBooking(false);
    await setCap(false); // Legacy
    // Self-assign works; a second booking at the same time on ANY practitioner
    // collides studio-wide (resource_key = studio_id).
    expect(await book(P(1), P(1), T("12:00"))).toMatchObject({ ok: true, result: "created" });
    expect(await book(P(2), P(2), T("12:00"))).toMatchObject({ ok: false, code: "23P01" }); // studio-wide
  });
});

// ---------------------------------------------------------------------------
describe("0142 concurrency + privilege", () => {
  it("the advisory lock serializes concurrent bookings for the studio (second blocks)", async () => {
    const a = new Client({ connectionString: resolveLocalDbUrl() });
    const b = new Client({ connectionString: resolveLocalDbUrl() });
    await a.connect();
    await b.connect();
    try {
      await a.query("begin");
      await a.query(
        `select public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`,
        [B.studioId, owner().practitionerId, P(1), B.clientId, serviceId, T("09:00"), hash64(), null, 30, false],
      );
      // B tries to book (different practitioner, different time), must WAIT on the
      // shared studio advisory lock A holds, proving serialization.
      await b.query("begin");
      await b.query("set local statement_timeout = '900ms'");
      let code: string | undefined;
      try {
        await b.query(
          `select public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`,
          [B.studioId, owner().practitionerId, P(2), B.clientId, serviceId, T("09:00"), hash64(), null, 30, false],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("57014"); // blocked by the advisory lock
      await b.query("rollback").catch(() => undefined);
      await a.query("rollback");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("booking blocks under the SAME lock while retirement holds it (no deadlock)", async () => {
    // Retirement requires booking OFF first.
    await setBooking(false);
    const a = new Client({ connectionString: resolveLocalDbUrl() });
    const b = new Client({ connectionString: resolveLocalDbUrl() });
    await a.connect();
    await b.connect();
    try {
      await a.query("begin");
      await a.query(`select public.retire_practitioner_capacity($1)`, [B.studioId]); // holds studios-row + advisory
      await b.query("begin");
      await b.query("set local statement_timeout = '900ms'");
      let code: string | undefined;
      try {
        await b.query(
          `select public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`,
          [B.studioId, owner().practitionerId, P(1), B.clientId, serviceId, T("08:00"), hash64(), null, 30, false],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("57014"); // blocked, NOT a deadlock (40P01)
      expect(code).not.toBe("40P01");
      await b.query("rollback").catch(() => undefined);
      await a.query("rollback");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("is service_role only: anon and authenticated are denied (42501)", async () => {
    const call = (q: (t: string, p?: unknown[]) => Promise<unknown>) =>
      q(`select public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`, [
        B.studioId, owner().practitionerId, P(1), B.clientId, serviceId, T("10:00"), hash64(), null, 30, false,
      ]);
    const code = (p: Promise<unknown>) => p.then(() => "ok").catch((e) => (e as { code?: string }).code);
    expect(await code(asRole("anon", call))).toBe("42501");
    expect(await code(asUser(owner().userId, call))).toBe("42501");
  });
});
