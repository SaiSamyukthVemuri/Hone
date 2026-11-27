import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioA,
  seedSynthStudioB,
  type SynthPractitioner,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// ===========================================================================
// STUDIO-READY-01 (#824) — five-plus-practitioner acceptance, against the real
// migrated schema (production 6c5eac80, migrations 0001–0210).
// ===========================================================================
//
// ONE synthetic studio S in America/Los_Angeles with capacity structure AND
// booking ON: an owner, five treating practitioners P1–P5, and an INACTIVE P6.
// It drives ONLY the authoritative commands (create_internal_appointment_v2,
// move_or_reassign_appointment, practitioner_cancel_appointment) and the
// structural sources they collide with. Nothing here rebuilds the capacity
// engine; the existing suites prove the model on three practitioners in UTC, and
// this file proves the same commands hold at five-plus, in a US timezone, across
// both 2031 US DST transitions, with a Toronto control.
//
// What this file does NOT prove, because no command exists for it: public
// practitioner selection / "any available" assignment. That is GAP G1 in
// docs/roadmap/STUDIO_READINESS_824.md; §K pins today's public behaviour so the
// gap is visible rather than assumed.
//
// Fixed 2031 dates keep every instant in the future (cancel and book refuse the
// past) and keep each section's window distinct. Synthetic studios only, cleaned
// up by id; never Willow, never production.

const LA = "America/Los_Angeles";
const TORONTO = "America/Toronto";

let S: SynthStudio; // the five-plus studio
let X: SynthStudio; // another studio, for cross-studio negatives
let T: SynthStudio; // the Toronto control (capacity OFF)

let electrolysis = ""; // 30 min, eligible for every active treating member
let laser = ""; // 30 min, eligible for P1 and P2 only
let torontoService = ""; // the Toronto control's own service
const clients: string[] = [];

const owner = () => S.practitioners.find((p) => p.role === "owner")!;
const P = (n: 1 | 2 | 3 | 4 | 5 | 6): SynthPractitioner => S.practitioners[n];
const treating = () => [owner(), P(1), P(2), P(3), P(4), P(5)];

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type BookOut =
  | { ok: true; result: string; id: string | null; startsUtc: string | null }
  | { ok: false; code: string | undefined };

function book(input: {
  studio?: SynthStudio;
  actor: SynthPractitioner;
  target: SynthPractitioner;
  local: string; // wall-clock time in `tz`, e.g. "2031-06-10 10:00"
  tz?: string;
  service?: string;
  client?: string;
  outside?: boolean;
}): Promise<BookOut> {
  const studio = input.studio ?? S;
  return adminQuery(
    `select r.result, r.appointment_id,
            to_char(r.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') as starts_utc
       from public.create_internal_appointment_v2(
              $1, $2, $3, $4, $5, ($6::timestamp at time zone $7), $8, null, null, $9
            ) r`,
    [
      studio.studioId,
      input.actor.practitionerId,
      input.target.practitionerId,
      input.client ?? clients[0],
      input.service ?? electrolysis,
      input.local,
      input.tz ?? LA,
      hash64(),
      input.outside ?? false,
    ],
  )
    .then((r) => ({
      ok: true as const,
      result: r.rows[0].result as string,
      id: (r.rows[0].appointment_id as string | null) ?? null,
      startsUtc: (r.rows[0].starts_utc as string | null) ?? null,
    }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));
}

type MoveOut =
  | { ok: true; result: string }
  | { ok: false; code: string | undefined };

async function move(input: {
  apptId: string;
  actor: SynthPractitioner;
  target: SynthPractitioner;
  newLocal: string;
  expectStale?: boolean;
}): Promise<MoveOut> {
  const cur = await appt(input.apptId);
  const expectedStart = input.expectStale ? "2031-01-01T00:00:00Z" : cur.s;
  return adminQuery(
    `select r.result from public.move_or_reassign_appointment(
       $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, ($7::timestamp at time zone $8)
     ) r`,
    [
      input.apptId,
      S.studioId,
      input.actor.practitionerId,
      input.target.practitionerId,
      expectedStart,
      cur.e,
      input.newLocal,
      LA,
    ],
  )
    .then((r) => ({ ok: true as const, result: r.rows[0].result as string }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));
}

const cancel = (apptId: string, actor: SynthPractitioner) =>
  adminQuery(`select public.practitioner_cancel_appointment($1, $2, $3, $4) as r`, [
    apptId,
    S.studioId,
    actor.practitionerId,
    "acceptance",
  ]).then((r) => r.rows[0].r as string);

const appt = (id: string) =>
  adminQuery(
    `select practitioner_id, status, starts_at::text s, ends_at::text e,
            booked_outside_availability as outside
       from public.appointments where id = $1`,
    [id],
  ).then(
    (r) =>
      r.rows[0] as {
        practitioner_id: string;
        status: string;
        s: string;
        e: string;
        outside: boolean;
      },
  );

const reservationKeys = (apptId: string) =>
  adminQuery(
    `select resource_key from public.studio_calendar_reservations
      where source_kind = 'appointment' and source_id = $1`,
    [apptId],
  ).then((r) => r.rows.map((x) => x.resource_key as string));

const studioCounts = (studioId: string) =>
  adminQuery(
    `select (select count(*) from public.appointments where studio_id = $1)::int as appts,
            (select count(*) from public.studio_calendar_reservations where studio_id = $1)::int as res,
            (select count(*) from public.appointment_audit where studio_id = $1)::int as audit`,
    [studioId],
  ).then((r) => r.rows[0] as { appts: number; res: number; audit: number });

function timedBlock(input: {
  practitionerId: string | null;
  startLocal: string;
  endLocal: string;
}): Promise<{ ok: true; id: string } | { ok: false; code: string | undefined }> {
  const id = randomUUID();
  return adminQuery(
    `insert into public.studio_timed_blocks (id, studio_id, practitioner_id, starts_at, ends_at, category)
     values ($1, $2, $3, ($4::timestamp at time zone $6), ($5::timestamp at time zone $6), 'break')
     returning id`,
    [id, S.studioId, input.practitionerId, input.startLocal, input.endLocal, LA],
  )
    .then(() => ({ ok: true as const, id }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));
}

const week = (open: string, close: string) =>
  Array.from({ length: 7 }, (_, dow) => ({
    day_of_week: dow,
    is_open: true,
    open_time: open,
    close_time: close,
  }));

async function addMember(studio: SynthStudio, label: string): Promise<SynthPractitioner> {
  const m = await seedMember(studio, label);
  const pr: SynthPractitioner = {
    userId: m.userId,
    practitionerId: m.practitionerId,
    role: "practitioner",
    email: `${label}-${m.userId.slice(0, 8)}@harness.local`,
  };
  // Pushed so dropSynthStudio removes the fake auth user too.
  studio.practitioners.push(pr);
  return pr;
}

beforeAll(async () => {
  // Owner + P1 + P2 from the fleet helper, then P3–P5 and an inactive P6.
  S = await seedSynthStudioB();
  for (const n of [3, 4, 5, 6]) await addMember(S, `fiveplus-p${n}`);
  await adminQuery(`update public.practitioners set active = false where id = $1`, [
    P(6).practitionerId,
  ]);

  // Structure + booking ON together (studios_capacity_booking_valid). The
  // operator guards admit the harness's service connection, never a browser.
  await adminQuery(
    `update public.studios
        set practitioner_capacity_enabled = true,
            practitioner_capacity_booking_enabled = true,
            timezone = $2,
            buffer_minutes = 15
      where id = $1`,
    [S.studioId, LA],
  );

  // Studio-wide hours 08:00–20:00 local every day; P3 keeps her OWN hours,
  // 09:00–13:00, which take precedence for her alone.
  for (const [scope, days] of [
    [null, week("08:00", "20:00")],
    [P(3).practitionerId, week("09:00", "13:00")],
  ] as const) {
    await adminQuery(`select public.save_weekly_availability($1, $2, $3::jsonb) as r`, [
      S.studioId,
      scope,
      JSON.stringify(days),
    ]);
  }

  // The 0134 default-eligibility trigger makes every ACTIVE member eligible.
  const e = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1, $2, 'Electrolysis 30', 30, 0, true) returning id`,
    [randomUUID(), S.studioId],
  );
  electrolysis = e.rows[0].id as string;
  const l = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1, $2, 'Laser 30', 30, 0, true) returning id`,
    [randomUUID(), S.studioId],
  );
  laser = l.rows[0].id as string;
  await adminQuery(
    `delete from public.service_practitioners
      where service_id = $1 and practitioner_id not in ($2, $3)`,
    [laser, P(1).practitionerId, P(2).practitionerId],
  );

  for (let i = 0; i < 8; i++) {
    const id = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, $3)`, [
      id,
      S.studioId,
      `FIVEPLUS client ${i}`,
    ]);
    clients.push(id);
  }

  X = await seedSynthStudioA();
  T = await seedSynthStudioA();
  await adminQuery(`update public.studios set timezone = $2, buffer_minutes = 0 where id = $1`, [
    T.studioId,
    TORONTO,
  ]);
  const t = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1, $2, 'Toronto 30', 30, 0, true) returning id`,
    [randomUUID(), T.studioId],
  );
  torontoService = t.rows[0].id as string;
});

afterAll(async () => {
  for (const s of [S, X, T]) if (s) await dropSynthStudio(s);
  await closePool();
});

describe("STUDIO-READY-01: five-plus practitioners in America/Los_Angeles", () => {
  it("setup: owner + five active treating practitioners + one inactive; capacity and booking ON", async () => {
    const r = await adminQuery(
      `select count(*) filter (where active)::int as active,
              count(*) filter (where not active)::int as inactive,
              (select practitioner_capacity_enabled and practitioner_capacity_booking_enabled
                 from public.studios where id = $1) as flags,
              (select timezone from public.studios where id = $1) as tz
         from public.practitioners where studio_id = $1`,
      [S.studioId],
    );
    expect(r.rows[0]).toEqual({ active: 6, inactive: 1, flags: true, tz: LA });
    // Default eligibility covered every ACTIVE member and not the inactive one.
    const elig = await adminQuery(
      `select practitioner_id from public.service_practitioners where service_id = $1`,
      [electrolysis],
    );
    expect(new Set(elig.rows.map((x) => x.practitioner_id))).toEqual(
      new Set(treating().map((p) => p.practitionerId)),
    );
  });

  // -------------------------------------------------------------------------
  // §A — different practitioners treat simultaneously.
  // -------------------------------------------------------------------------
  it("A) six treating members book the SAME LA instant concurrently; every one is created on its own resource", async () => {
    const out = await Promise.all(
      treating().map((p, i) =>
        book({ actor: owner(), target: p, local: "2031-06-10 10:00", client: clients[i] }),
      ),
    );
    for (const o of out) expect(o).toMatchObject({ ok: true, result: "created" });
    // 10:00 PDT is 17:00Z.
    for (const o of out) if (o.ok) expect(o.startsUtc).toBe("2031-06-10T17:00Z");
    const keys = await Promise.all(out.map((o) => (o.ok && o.id ? reservationKeys(o.id) : [])));
    expect(keys.map((k) => k[0])).toEqual(treating().map((p) => p.practitionerId));
  });

  // -------------------------------------------------------------------------
  // §B — the same practitioner never double-books.
  // -------------------------------------------------------------------------
  it("B1) an overlapping booking for the SAME practitioner is refused by the per-resource exclusion (23P01)", async () => {
    const o = await book({ actor: owner(), target: P(1), local: "2031-06-10 10:15", client: clients[6] });
    expect(o).toMatchObject({ ok: false, code: "23P01" });
  });

  it("B2) the studio buffer is enforced per practitioner: 10:35 is a buffer conflict, 10:45 is free", async () => {
    // P1 holds 10:00–10:30; buffer 15 → the next start is 10:45.
    expect(await book({ actor: owner(), target: P(1), local: "2031-06-10 10:35", client: clients[6] })).toMatchObject({
      ok: true,
      result: "buffer_conflict",
    });
    expect(await book({ actor: owner(), target: P(1), local: "2031-06-10 10:45", client: clients[6] })).toMatchObject({
      ok: true,
      result: "created",
    });
    // The buffer belongs to P1's own schedule: once P1 holds 15:00–15:30, 15:35
    // is a conflict for P1 and free for P2, whose own day is clear around it.
    expect(await book({ actor: owner(), target: P(1), local: "2031-06-10 15:00", client: clients[6] })).toMatchObject({
      ok: true,
      result: "created",
    });
    expect(await book({ actor: owner(), target: P(1), local: "2031-06-10 15:35", client: clients[7] })).toMatchObject({
      ok: true,
      result: "buffer_conflict",
    });
    expect(await book({ actor: owner(), target: P(2), local: "2031-06-10 15:35", client: clients[7] })).toMatchObject({
      ok: true,
      result: "created",
    });
  });

  it("B3) two CONCURRENT bookings for the same practitioner and time: exactly one wins, no duplicate row", async () => {
    const [a, b] = await Promise.all([
      book({ actor: owner(), target: P(2), local: "2031-06-10 14:00", client: clients[1] }),
      book({ actor: owner(), target: P(2), local: "2031-06-10 14:00", client: clients[2] }),
    ]);
    const created = [a, b].filter((o) => o.ok && o.result === "created");
    expect(created).toHaveLength(1);
    const loser = [a, b].find((o) => !(o.ok && o.result === "created"))!;
    expect(loser).toMatchObject({ ok: false, code: "23P01" });
    const n = await adminQuery(
      `select count(*)::int as n from public.appointments
        where studio_id = $1 and practitioner_id = $2 and status = 'confirmed'
          and starts_at = ('2031-06-10 14:00'::timestamp at time zone $3)`,
      [S.studioId, P(2).practitionerId, LA],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("B4) the owner's outside-hours override never bypasses an ACTUAL overlap", async () => {
    const o = await book({
      actor: owner(),
      target: P(1),
      local: "2031-06-10 10:00",
      client: clients[6],
      outside: true,
    });
    expect(o).toMatchObject({ ok: false, code: "23P01" });
  });

  // -------------------------------------------------------------------------
  // §C — per-practitioner availability and its edges.
  // -------------------------------------------------------------------------
  it("C1) P3's own hours (09:00–13:00) govern P3 only; the studio-wide fallback governs P4", async () => {
    expect(await book({ actor: owner(), target: P(3), local: "2031-06-11 15:00" })).toMatchObject({
      ok: true,
      result: "outside_availability",
    });
    expect(await book({ actor: owner(), target: P(4), local: "2031-06-11 15:00" })).toMatchObject({
      ok: true,
      result: "created",
    });
    expect(await book({ actor: owner(), target: P(3), local: "2031-06-11 09:00" })).toMatchObject({
      ok: true,
      result: "created",
    });
  });

  it("C2) opening and closing edges hold in local time: 07:45 and 19:45 refused, 19:30 (ending 20:00) accepted", async () => {
    expect(await book({ actor: owner(), target: P(5), local: "2031-06-11 07:45" })).toMatchObject({
      ok: true,
      result: "outside_availability",
    });
    expect(await book({ actor: owner(), target: P(5), local: "2031-06-11 19:45" })).toMatchObject({
      ok: true,
      result: "outside_availability",
    });
    expect(await book({ actor: owner(), target: P(5), local: "2031-06-11 19:30" })).toMatchObject({
      ok: true,
      result: "created",
    });
  });

  it("C3) only the OWNER may book outside a practitioner's hours, and the row records it", async () => {
    const self = await book({ actor: P(3), target: P(3), local: "2031-06-11 15:00", outside: true });
    expect(self).toMatchObject({ ok: true, result: "not_authorized" });
    const o = await book({ actor: owner(), target: P(3), local: "2031-06-11 15:00", outside: true });
    expect(o).toMatchObject({ ok: true, result: "created" });
    if (o.ok && o.id) expect((await appt(o.id)).outside).toBe(true);
  });

  // -------------------------------------------------------------------------
  // §D — service eligibility and inactive members.
  // -------------------------------------------------------------------------
  it("D1) eligibility is enforced per practitioner: Laser is refused for P3 and accepted for P1", async () => {
    expect(await book({ actor: owner(), target: P(3), local: "2031-06-11 10:00", service: laser })).toMatchObject({
      ok: true,
      result: "not_eligible",
    });
    expect(await book({ actor: owner(), target: P(1), local: "2031-06-11 10:00", service: laser })).toMatchObject({
      ok: true,
      result: "created",
    });
  });

  it("D2) an INACTIVE practitioner can be neither booked nor act", async () => {
    expect(await book({ actor: owner(), target: P(6), local: "2031-06-11 11:00" })).toMatchObject({
      ok: true,
      result: "invalid_practitioner",
    });
    expect(await book({ actor: P(6), target: P(6), local: "2031-06-11 11:00" })).toMatchObject({
      ok: true,
      result: "not_authorized",
    });
  });

  // -------------------------------------------------------------------------
  // §E — studio-wide closures hit every resource; scoped closures hit one.
  // -------------------------------------------------------------------------
  it("E1) a practitioner-scoped block refuses that practitioner only", async () => {
    const blk = await timedBlock({
      practitionerId: P(4).practitionerId,
      startLocal: "2031-06-12 12:00",
      endLocal: "2031-06-12 13:00",
    });
    expect(blk.ok).toBe(true);
    expect(await book({ actor: owner(), target: P(4), local: "2031-06-12 12:00" })).toMatchObject({
      ok: false,
      code: "23P01",
    });
    expect(await book({ actor: owner(), target: P(5), local: "2031-06-12 12:00" })).toMatchObject({
      ok: true,
      result: "created",
    });
  });

  it("E2) a studio-wide block fans out to EVERY member and refuses every treating member", async () => {
    // 11:00–12:00 sits inside every member's hours (P3 included), so the refusal
    // below is the block's own collision (23P01), not an availability refusal.
    const blk = await timedBlock({
      practitionerId: null,
      startLocal: "2031-06-12 11:00",
      endLocal: "2031-06-12 12:00",
    });
    expect(blk.ok).toBe(true);
    const fan = await adminQuery(
      `select resource_key from public.studio_calendar_reservations
        where source_kind = 'timed_block' and source_id = $1`,
      [blk.ok ? blk.id : ""],
    );
    // Every member, the inactive P6 included (a deactivated member can still hold
    // confirmed bookings, and the block must cover them).
    expect(new Set(fan.rows.map((r) => r.resource_key))).toEqual(
      new Set(S.practitioners.map((p) => p.practitionerId)),
    );
    for (const p of treating()) {
      expect(await book({ actor: owner(), target: p, local: "2031-06-12 11:00" })).toMatchObject({
        ok: false,
        code: "23P01",
      });
    }
  });

  it("E3) a studio-wide block cannot be laid over ANY practitioner's existing appointment", async () => {
    // P5 holds 2031-06-12 12:00–12:30 from E1.
    const blk = await timedBlock({
      practitionerId: null,
      startLocal: "2031-06-12 12:00",
      endLocal: "2031-06-12 12:30",
    });
    expect(blk).toMatchObject({ ok: false, code: "23P01" });
  });

  it("E4) a full-day blockout closes the studio for every practitioner, owner override included", async () => {
    await adminQuery(
      `insert into public.studio_blockouts (id, studio_id, starts_on, ends_on) values ($1, $2, '2031-06-13', '2031-06-13')`,
      [randomUUID(), S.studioId],
    );
    for (const p of treating()) {
      expect(await book({ actor: owner(), target: p, local: "2031-06-13 10:00", outside: true })).toMatchObject({
        ok: true,
        result: "practitioner_closed",
      });
    }
  });

  // -------------------------------------------------------------------------
  // §F — assignment, move, cancel and deactivation.
  // -------------------------------------------------------------------------
  let p1Appt = "";
  it("F1) reassigning onto an occupied practitioner is refused and changes nothing", async () => {
    const o = await book({ actor: owner(), target: P(1), local: "2031-06-16 10:00" });
    expect(o).toMatchObject({ ok: true, result: "created" });
    p1Appt = o.ok && o.id ? o.id : "";
    const blocker = await book({ actor: owner(), target: P(2), local: "2031-06-16 10:00", client: clients[1] });
    expect(blocker).toMatchObject({ ok: true, result: "created" });
    const r = await move({ apptId: p1Appt, actor: owner(), target: P(2), newLocal: "2031-06-16 10:00" });
    expect(r).toMatchObject({ ok: false, code: "23P01" });
    expect((await appt(p1Appt)).practitioner_id).toBe(P(1).practitionerId);
    expect(await reservationKeys(p1Appt)).toEqual([P(1).practitionerId]);
  });

  it("F2) the owner moves AND reassigns in one command; the reservation follows the new practitioner", async () => {
    const r = await move({ apptId: p1Appt, actor: owner(), target: P(4), newLocal: "2031-06-16 11:00" });
    expect(r).toMatchObject({ ok: true, result: "moved_and_reassigned" });
    expect((await appt(p1Appt)).practitioner_id).toBe(P(4).practitionerId);
    expect(await reservationKeys(p1Appt)).toEqual([P(4).practitionerId]);
  });

  it("F3) a practitioner may move their OWN appointment but never reassign it", async () => {
    const o = await book({ actor: P(2), target: P(2), local: "2031-06-16 13:00" });
    expect(o).toMatchObject({ ok: true, result: "created" });
    const id = o.ok && o.id ? o.id : "";
    expect(await move({ apptId: id, actor: P(2), target: P(3), newLocal: "2031-06-16 13:00" })).toMatchObject({
      ok: true,
      result: "not_authorized",
    });
    expect(await move({ apptId: id, actor: P(2), target: P(2), newLocal: "2031-06-16 14:00" })).toMatchObject({
      ok: true,
      result: "moved",
    });
  });

  it("F4) a stale move snapshot is refused and leaves the appointment untouched", async () => {
    const before = await appt(p1Appt);
    const r = await move({
      apptId: p1Appt,
      actor: owner(),
      target: P(4),
      newLocal: "2031-06-16 15:00",
      expectStale: true,
    });
    expect(r).toMatchObject({ ok: true, result: "stale_appointment" });
    expect(await appt(p1Appt)).toEqual(before);
  });

  it("F5) cancelling frees the practitioner's slot at once", async () => {
    const o = await book({ actor: owner(), target: P(5), local: "2031-06-17 10:00" });
    const id = o.ok && o.id ? o.id : "";
    expect(await cancel(id, owner())).toBe("cancelled");
    expect(await reservationKeys(id)).toEqual([]);
    expect(await book({ actor: owner(), target: P(5), local: "2031-06-17 10:00", client: clients[3] })).toMatchObject({
      ok: true,
      result: "created",
    });
  });

  it("F6) CURRENT RULE, flagged for decision: any active member may cancel ANY future booking in the studio", async () => {
    // create and move are own-only for a non-owner; cancel is not
    // (practitioner_cancel_appointment, 0174; the calendar action adds no own-only
    // check). Pinned here so a change is deliberate. See the contract, §1.
    const o = await book({ actor: owner(), target: P(3), local: "2031-06-17 09:30" });
    const id = o.ok && o.id ? o.id : "";
    expect(await cancel(id, P(2))).toBe("cancelled");
  });

  it("F7) deactivating a practitioner stops new bookings but keeps (and still protects) their existing ones", async () => {
    const o = await book({ actor: owner(), target: P(5), local: "2031-06-18 10:00" });
    const id = o.ok && o.id ? o.id : "";
    await adminQuery(`update public.practitioners set active = false where id = $1`, [P(5).practitionerId]);
    try {
      expect(await book({ actor: owner(), target: P(5), local: "2031-06-18 12:00" })).toMatchObject({
        ok: true,
        result: "invalid_practitioner",
      });
      expect((await appt(id)).status).toBe("confirmed");
      expect(await reservationKeys(id)).toEqual([P(5).practitionerId]);
      // The studio-wide fan-out still covers an inactive member's live booking.
      const blk = await timedBlock({
        practitionerId: null,
        startLocal: "2031-06-18 10:00",
        endLocal: "2031-06-18 10:30",
      });
      expect(blk).toMatchObject({ ok: false, code: "23P01" });
    } finally {
      await adminQuery(`update public.practitioners set active = true where id = $1`, [P(5).practitionerId]);
    }
  });

  // -------------------------------------------------------------------------
  // §G — explicit permissions, same-studio and cross-studio negatives.
  // -------------------------------------------------------------------------
  it("G1) a practitioner cannot book another practitioner; the owner can", async () => {
    expect(await book({ actor: P(1), target: P(2), local: "2031-06-19 10:00" })).toMatchObject({
      ok: true,
      result: "not_authorized",
    });
    expect(await book({ actor: owner(), target: P(2), local: "2031-06-19 10:00" })).toMatchObject({
      ok: true,
      result: "created",
    });
  });

  it("G2) another studio's member cannot act in S, and another studio's client cannot be booked in S", async () => {
    const outsider = X.practitioners[0];
    expect(await book({ actor: outsider, target: P(1), local: "2031-06-19 11:00" })).toMatchObject({
      ok: true,
      result: "not_authorized",
    });
    expect(await book({ actor: owner(), target: P(1), local: "2031-06-19 11:00", client: X.clientId })).toMatchObject({
      ok: true,
      result: "invalid_client",
    });
  });

  it("G3) RLS: members read their own studio's appointments; another studio reads none", async () => {
    const own = await asUser(P(1).userId, (q) =>
      q(`select count(*)::int as n from public.appointments where studio_id = $1`, [S.studioId]),
    );
    expect(own.rows[0].n).toBeGreaterThan(0);
    const foreign = await asUser(X.practitioners[0].userId, (q) =>
      q(`select count(*)::int as n from public.appointments where studio_id = $1`, [S.studioId]),
    );
    expect(foreign.rows[0].n).toBe(0);
  });

  it("G4) no browser role may call the booking command directly (EXECUTE revoked)", async () => {
    const e = await asRole("authenticated", (q) =>
      q(
        `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,now() + interval '30 days',$6,null,null,false)`,
        [S.studioId, owner().practitionerId, P(1).practitionerId, clients[0], electrolysis, hash64()],
      ),
    )
      .then(() => null)
      .catch((err) => err as { code?: string });
    expect(e?.code).toBe("42501");
  });

  // -------------------------------------------------------------------------
  // §H — America/Los_Angeles date boundaries and DST; Toronto unchanged.
  // -------------------------------------------------------------------------
  it("H1) 09:00 local is stored at the right UTC instant on both sides of each 2031 US DST change", async () => {
    const cases: Array<[string, string]> = [
      ["2031-03-08 09:00", "2031-03-08T17:00Z"], // PST, the day before spring forward
      ["2031-03-09 09:00", "2031-03-09T16:00Z"], // PDT, the spring-forward day
      ["2031-11-01 09:00", "2031-11-01T16:00Z"], // PDT, the day before fall back
      ["2031-11-02 09:00", "2031-11-02T17:00Z"], // PST, the fall-back day
    ];
    for (const [local, utc] of cases) {
      const o = await book({ actor: owner(), target: P(4), local });
      expect(o).toMatchObject({ ok: true, result: "created", startsUtc: utc });
    }
  });

  it("H2) a booking that crosses UTC midnight keeps its LOCAL date and closing edge", async () => {
    // 19:30–20:00 PDT on 2031-11-01 is 02:30–03:00Z on 2031-11-02.
    const o = await book({ actor: owner(), target: P(5), local: "2031-11-01 19:30" });
    expect(o).toMatchObject({ ok: true, result: "created", startsUtc: "2031-11-02T02:30Z" });
    const id = o.ok && o.id ? o.id : "";
    const local = await adminQuery(
      `select (starts_at at time zone $2)::date::text as d from public.appointments where id = $1`,
      [id, LA],
    );
    expect(local.rows[0].d).toBe("2031-11-01");
    expect(await book({ actor: owner(), target: P(5), local: "2031-11-01 19:45", client: clients[2] })).toMatchObject({
      ok: true,
      result: "outside_availability",
    });
  });

  it("H3) Toronto control (capacity OFF): local 09:00 maps to EST/EDT correctly and collision stays studio-wide", async () => {
    const tOwner = T.practitioners[0];
    const tBook = (target: SynthPractitioner, local: string) =>
      book({ studio: T, actor: tOwner, target, local, tz: TORONTO, client: T.clientId, service: torontoService });
    expect(await tBook(tOwner, "2031-03-08 09:00")).toMatchObject({
      ok: true,
      result: "created",
      startsUtc: "2031-03-08T14:00Z", // EST
    });
    expect(await tBook(tOwner, "2031-03-09 09:00")).toMatchObject({
      ok: true,
      result: "created",
      startsUtc: "2031-03-09T13:00Z", // EDT
    });
    // Capacity OFF: a second practitioner still collides studio-wide, as today.
    const second = await addMember(T, "toronto-second");
    const clash = await tBook(second, "2031-03-09 09:00");
    expect(clash).toMatchObject({ ok: false, code: "23P01" });
    const keys = await adminQuery(
      `select distinct resource_key from public.studio_calendar_reservations where studio_id = $1`,
      [T.studioId],
    );
    expect(keys.rows.map((r) => r.resource_key)).toEqual([T.studioId]);
  });

  // -------------------------------------------------------------------------
  // §J — failed or stale operations leave no partial state.
  // -------------------------------------------------------------------------
  it("J) a batch of refused operations changes no appointment, reservation or audit row", async () => {
    const before = await studioCounts(S.studioId);
    await book({ actor: owner(), target: P(1), local: "2031-06-10 10:15" }); // 23P01 overlap
    await book({ actor: owner(), target: P(1), local: "2031-06-10 10:35" }); // buffer_conflict
    await book({ actor: owner(), target: P(3), local: "2031-06-11 10:00", service: laser }); // not_eligible
    await book({ actor: owner(), target: P(3), local: "2031-06-11 17:00" }); // outside_availability
    await book({ actor: P(1), target: P(2), local: "2031-06-19 12:00" }); // not_authorized
    await book({ actor: owner(), target: P(4), local: "2031-06-13 10:00", outside: true }); // practitioner_closed
    await move({ apptId: p1Appt, actor: owner(), target: P(4), newLocal: "2031-06-16 15:00", expectStale: true }); // stale
    await move({ apptId: p1Appt, actor: owner(), target: P(2), newLocal: "2031-06-16 10:00" }); // 23P01 reassign
    await timedBlock({ practitionerId: null, startLocal: "2031-06-12 12:00", endLocal: "2031-06-12 12:30" }); // 23P01
    expect(await studioCounts(S.studioId)).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // §K — GAP G1, pinned: public booking has no practitioner choice.
  // -------------------------------------------------------------------------
  it("K) GAP G1: the public command takes no practitioner and assigns the single active OWNER on a five-plus studio", async () => {
    const r = await adminQuery(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_public_appointment'`,
    );
    expect(r.rows).toHaveLength(1);
    // No practitioner parameter exists to request P1–P5 or "any available".
    expect(r.rows[0].args).not.toMatch(/practitioner/);
    const src = await adminQuery(
      `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_public_appointment'`,
    );
    // The only assignment rule is "exactly one active owner, else NULL".
    expect(src.rows[0].prosrc).toMatch(/pr\.role = 'owner'/);
  });
});
