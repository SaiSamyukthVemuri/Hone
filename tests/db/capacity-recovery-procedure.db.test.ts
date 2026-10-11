import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioB,
  type SynthPractitioner,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// ===========================================================================
// STUDIO-READY-01 (#824) — the capacity RECOVERY procedure in
// docs/roadmap/STUDIO_READINESS_824.md §1.4, run against the actual commands.
// ===========================================================================
//
// Each step of the procedure is a claim about a real command. This file runs
// them on synthetic capacity-ON studios in America/Los_Angeles:
//
//   §1  `closed` pauses NEW clients only. At the COMMAND layer, a returning
//       client still books (0170), reschedules (0171) and cancels by their own
//       link (0176). Two things are proven elsewhere and cited, not repeated:
//       - the ACTION layer: in publicBookAppointmentAction an existing client is
//         outside the CLOSED refusal and still reaches the booking command
//         (tests/app/book/new-client-waitlist-gate.test.ts, "CLOSED: an
//         EXISTING client is completely outside this authority");
//       - the new-client and invitation refusals under `closed`, and the
//         unstamped cutover (new-client-admission-commit-authority.db.test.ts
//         §1B, §3B and its UNSTAMPED block).
//   §2  Hiding every service stops new public and staff bookings, and only
//       those. Moves, cancellations and client self-reschedule continue, and
//       restoring the menu depends on the order services are shown again.
//   §3  retire_practitioner_capacity counts overlaps in TIME, studio-wide.
//       Reassignment never clears one. Moving, cancelling, a no-show, or a
//       completion whose blocked end has passed does. A client's
//       self-reschedule still runs in the retirement window itself, with the
//       services hidden and booking OFF, and can create the overlap that
//       makes retirement refuse.
//
// One studio per scenario, so no scenario's appointments reach another's
// overlap count. Instants are RELATIVE to now: the public command enforces a
// booking horizon, and a fixed date would one day fall outside it and make the
// public cases vacuous. Synthetic studios only, removed by id.

const LA = "America/Los_Angeles";
const studios: SynthStudio[] = [];

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Lab = {
  s: SynthStudio;
  owner: SynthPractitioner;
  p1: SynthPractitioner;
  p2: SynthPractitioner;
  services: string[];
  clients: string[];
};

const week = (open: string, close: string) =>
  Array.from({ length: 7 }, (_, dow) => ({
    day_of_week: dow,
    is_open: true,
    open_time: open,
    close_time: close,
  }));

/** A capacity-ON, booking-ON studio: owner + two practitioners, open 08–20 daily. */
async function lab(label: string, serviceNames = [`${label} 30`]): Promise<Lab> {
  const s = await seedSynthStudioB();
  studios.push(s);
  await adminQuery(
    `update public.studios
        set practitioner_capacity_enabled = true,
            practitioner_capacity_booking_enabled = true,
            timezone = $2,
            buffer_minutes = 0
      where id = $1`,
    [s.studioId, LA],
  );
  await adminQuery(`select public.save_weekly_availability($1, $2, $3::jsonb) as r`, [
    s.studioId,
    null,
    JSON.stringify(week("08:00", "20:00")),
  ]);
  // The 0134 default-eligibility trigger makes every active member eligible.
  const services: string[] = [];
  for (const [i, name] of serviceNames.entries()) {
    const r = await adminQuery(
      `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active, sort_order)
       values ($1, $2, $3, 30, 0, true, $4) returning id`,
      [randomUUID(), s.studioId, name, (i + 1) * 10],
    );
    services.push(r.rows[0].id as string);
  }
  const clients: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, $3)`, [
      id,
      s.studioId,
      `RECOVERY ${label} client ${i}`,
    ]);
    clients.push(id);
  }
  const owner = s.practitioners.find((p) => p.role === "owner")!;
  const [p1, p2] = s.practitioners.filter((p) => p.role !== "owner");
  return { s, owner, p1, p2, services, clients };
}

/** `days` from today, at local wall-clock `time`, in Los Angeles. */
const at = (days: number, time: string) =>
  adminQuery(
    `select ((((now() at time zone $3)::date + $1::int) + $2::time) at time zone $3)::text as t`,
    [days, time, LA],
  ).then((r) => r.rows[0].t as string);

const publicBook = async (l: Lab, startsAt: string) => {
  const hash = hash64();
  const r = await adminQuery(
    `select r.result, r.appointment_id
       from public.create_public_appointment($1, $2, $3, $4::timestamptz, $5) r`,
    [l.s.studioId, l.clients[0], l.services[0], startsAt, hash],
  );
  return { result: r.rows[0].result as string, id: r.rows[0].appointment_id as string | null, hash };
};

const staffBook = (l: Lab, target: SynthPractitioner, client: string, startsAt: string) =>
  adminQuery(
    `select r.result, r.appointment_id
       from public.create_internal_appointment_v2($1, $2, $3, $4, $5, $6::timestamptz, $7) r`,
    [l.s.studioId, l.owner.practitionerId, target.practitionerId, client, l.services[0], startsAt, hash64()],
  ).then((r) => ({ result: r.rows[0].result as string, id: r.rows[0].appointment_id as string | null }));

/** The owner moves and/or reassigns, from the appointment's CURRENT snapshot. */
const moveTo = async (l: Lab, apptId: string, target: SynthPractitioner, newStart: string) => {
  const cur = await adminQuery(
    `select starts_at::text s, ends_at::text e from public.appointments where id = $1`,
    [apptId],
  );
  const r = await adminQuery(
    `select r.result from public.move_or_reassign_appointment(
       $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz) r`,
    [apptId, l.s.studioId, l.owner.practitionerId, target.practitionerId, cur.rows[0].s, cur.rows[0].e, newStart],
  );
  return r.rows[0].result as string;
};

const startOf = (apptId: string) =>
  adminQuery(`select starts_at::text s from public.appointments where id = $1`, [apptId]).then(
    (r) => r.rows[0].s as string,
  );

const cancel = (l: Lab, apptId: string) =>
  adminQuery(`select public.practitioner_cancel_appointment($1, $2, $3, $4) as r`, [
    apptId,
    l.s.studioId,
    l.owner.practitionerId,
    "recovery",
  ]).then((r) => r.rows[0].r as string);

/** The client's own reschedule link: the token hash is the only credential. */
const clientReschedule = (apptId: string, currentHash: string, newStart: string) => {
  const newHash = hash64();
  return adminQuery(
    `select r.result, r.new_appointment_id
       from public.reschedule_appointment_v2($1, $2, $3::timestamptz, $4, true) r`,
    [apptId, currentHash, newStart, newHash],
  ).then((r) => ({
    result: r.rows[0].result as string,
    newId: r.rows[0].new_appointment_id as string | null,
    newHash,
  }));
};

/**
 * The client's own cancel link. The action hashes the URL token before the call,
 * and 0176 demands the hash of the policy the page PRESENTED, unconditionally:
 * an empty policy still has a hash. It is derived here exactly as 0176 derives it.
 */
const clientCancel = (l: Lab, tokenHash: string) =>
  adminQuery(
    `select r.result
       from public.studios s,
            public.public_cancel_appointment_with_token(
              $2, $3, $4, null, false, false,
              encode(extensions.digest(
                coalesce(s.cancellation_policy_text, '') || E'\\n---\\n' || coalesce(s.no_show_policy_text, ''),
                'sha256'), 'hex')
            ) r
      where s.id = $1`,
    [l.s.studioId, tokenHash, "schedule", "Schedule conflict"],
  ).then((r) => r.rows[0].result as string);

const setBooking = (l: Lab, on: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_booking_enabled = $2 where id = $1`, [
    l.s.studioId,
    on,
  ]);

type RetireOut = { ok: true } | { ok: false; code: string | undefined; message: string };
const retire = (l: Lab): Promise<RetireOut> =>
  adminQuery(`select public.retire_practitioner_capacity($1)`, [l.s.studioId])
    .then(() => ({ ok: true as const }))
    .catch((e: { code?: string; message?: string }) => ({
      ok: false as const,
      code: e.code,
      message: e.message ?? "",
    }));

const structureOn = (l: Lab) =>
  adminQuery(`select practitioner_capacity_enabled as on from public.studios where id = $1`, [
    l.s.studioId,
  ]).then((r) => r.rows[0].on as boolean);

/** A confirmed appointment placed directly, relative to now (the commands refuse the past). */
const placeAt = (l: Lab, who: SynthPractitioner, client: string, startAgo: string, endAgo: string) =>
  adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, service_id, practitioner_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1, $2, $3, $4, $5, now() - $6::interval, now() - $7::interval,
             60, 0, now() - $7::interval, 'confirmed')
     returning id`,
    [randomUUID(), l.s.studioId, client, l.services[0], who.practitionerId, startAgo, endAgo],
  ).then((r) => r.rows[0].id as string);

/** Overlapping participating pairs, counted exactly as 0138's retirement counts them. */
const overlapPairs = (l: Lab) =>
  adminQuery(
    `select count(*)::int as n
       from public.appointments a1
       join public.appointments a2 on a1.studio_id = a2.studio_id and a1.id < a2.id
      where a1.studio_id = $1
        and public.appointment_participates_in_capacity(a1.status, a1.blocked_ends_at)
        and public.appointment_participates_in_capacity(a2.status, a2.blocked_ends_at)
        and tstzrange(a1.starts_at, a1.blocked_ends_at, '[)')
            && tstzrange(a2.starts_at, a2.blocked_ends_at, '[)')`,
    [l.s.studioId],
  ).then((r) => r.rows[0].n as number);

/** toggleServiceActiveAction's hide branch, for every active service, as the owner. */
const hideAllServices = (l: Lab) =>
  asUser(l.owner.userId, (q) =>
    q(
      `update public.services set active = false, updated_at = now()
        where studio_id = $1 and active returning id`,
      [l.s.studioId],
    ),
  ).then((r) => r.rowCount);

const participates = (apptId: string) =>
  adminQuery(
    `select public.appointment_participates_in_capacity(status, blocked_ends_at) as p
       from public.appointments where id = $1`,
    [apptId],
  ).then((r) => r.rows[0].p as boolean);

/** Two confirmed future appointments at the same instant, on different practitioners. */
async function parallelPair(l: Lab) {
  const t = await at(10, "10:00");
  const a = await staffBook(l, l.p1, l.clients[0], t);
  const b = await staffBook(l, l.p2, l.clients[1], t);
  expect([a.result, b.result]).toEqual(["created", "created"]);
  return { a: a.id!, b: b.id! };
}

afterAll(async () => {
  for (const s of studios) await dropSynthStudio(s);
  await closePool();
});

// ---------------------------------------------------------------------------
describe("§1 `closed` pauses new clients only: a returning client still books, reschedules and cancels", () => {
  let L: Lab;
  beforeAll(async () => {
    L = await lab("closed");
  });

  it("the owner can set `closed` on a studio stamped at creation (0205)", async () => {
    const r = await asUser(L.owner.userId, (q) =>
      q(`select * from public.set_new_client_admission_mode($1, $2)`, [L.s.studioId, "closed"]),
    );
    expect(r.rows[0].outcome).toBe("ok");
    const m = await adminQuery(`select new_client_admission_mode as m from public.studios where id = $1`, [
      L.s.studioId,
    ]);
    expect(m.rows[0].m).toBe("closed");
  });

  it("under `closed`, an EXISTING client still books, reschedules and cancels through their own links", async () => {
    const booked = await publicBook(L, await at(7, "10:00"));
    expect(booked.result).toBe("created");
    const moved = await clientReschedule(booked.id!, booked.hash, await at(8, "10:00"));
    expect(moved.result).toBe("success");
    expect(await clientCancel(L, moved.newHash)).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
describe("§2 hiding every service freezes NEW bookings, and only those", () => {
  let L: Lab;
  let original: string[];
  let held: { id: string; hash: string };
  beforeAll(async () => {
    L = await lab("freeze", ["Freeze A", "Freeze B", "Freeze C"]);
    original = [...L.services];
    const b = await publicBook(L, await at(7, "10:00"));
    expect(b.result).toBe("created");
    held = { id: b.id!, hash: b.hash };
    // The owner's own path: toggleServiceActiveAction's hide branch is this
    // UPDATE, under the owner's session.
    const hidden = await asUser(L.owner.userId, (q) =>
      q(
        `update public.services set active = false, updated_at = now()
          where studio_id = $1 and active returning id`,
        [L.s.studioId],
      ),
    );
    expect(hidden.rowCount).toBe(3);
  });

  it("stops new public bookings (public_booking_unavailable) and new staff bookings (invalid_service)", async () => {
    expect((await publicBook(L, await at(7, "14:00"))).result).toBe("public_booking_unavailable");
    expect((await staffBook(L, L.p1, L.clients[1], await at(7, "14:00"))).result).toBe("invalid_service");
  });

  it("does NOT stop staff moves or a client's self-reschedule", async () => {
    expect(await moveTo(L, held.id, L.owner, await at(7, "12:00"))).toBe("moved");
    // The reschedule command reads neither services.active, the admission mode
    // nor the booking flag (0171). §3 runs it in the retirement window itself.
    const r = await clientReschedule(held.id, held.hash, await at(8, "10:00"));
    expect(r.result).toBe("success");
    held = { id: r.newId!, hash: held.hash };
  });

  it("does NOT stop cancellations", async () => {
    expect(await cancel(L, held.id)).toBe("cancelled");
  });

  it("restoring depends on ORDER: each service shown again goes to the bottom of the menu", async () => {
    const order = () =>
      adminQuery(`select id from public.services where studio_id = $1 and active order by sort_order, id`, [
        L.s.studioId,
      ]).then((r) => r.rows.map((x) => x.id as string));
    const show = (id: string) =>
      asUser(L.owner.userId, (q) => q(`select public.show_studio_service($1, $2)`, [L.s.studioId, id]));
    const hideAll = () =>
      asUser(L.owner.userId, (q) =>
        q(`update public.services set active = false where studio_id = $1 and active`, [L.s.studioId]),
      );

    // Shown in the wrong order, the menu comes back in that wrong order.
    for (const id of [original[1], original[0], original[2]]) await show(id);
    expect(await order()).toEqual([original[1], original[0], original[2]]);

    // Shown in the recorded original order, it comes back as it was.
    await hideAll();
    for (const id of original) await show(id);
    expect(await order()).toEqual(original);

    // Both refusals above were the freeze, not the fixture: with the menu back,
    // the same service books again on both paths.
    expect((await publicBook(L, await at(7, "16:00"))).result).toBe("created");
    expect((await staffBook(L, L.p1, L.clients[1], await at(7, "14:00"))).result).toBe("created");
  });
});

// ---------------------------------------------------------------------------
describe("§3 retirement counts overlaps in TIME, studio-wide; only time or status clears one", () => {
  it("reassignment does not clear it; moving one appointment to another time does", async () => {
    const L = await lab("move");
    const { b } = await parallelPair(L);

    await setBooking(L, false);
    let r = await retire(L);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("23P01");
      expect(r.message).toContain("overlapping_appointments:1");
    }

    // Reassign b to the owner at the SAME instant: a different practitioner,
    // the same time. Retirement still counts the pair.
    await setBooking(L, true);
    expect(await moveTo(L, b, L.owner, await startOf(b))).toBe("reassigned");
    await setBooking(L, false);
    r = await retire(L);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("overlapping_appointments:1");

    // A move in TIME clears it. Moves need booking ON.
    await setBooking(L, true);
    expect(await moveTo(L, b, L.owner, await at(10, "12:00"))).toBe("moved");
    await setBooking(L, false);
    expect(await retire(L)).toEqual({ ok: true });
    expect(await structureOn(L)).toBe(false);
  });

  it("with booking OFF, moves pause but cancellation still clears a future overlap", async () => {
    const L = await lab("cancel");
    const { a, b } = await parallelPair(L);
    await setBooking(L, false);
    expect(await moveTo(L, b, L.p2, await at(10, "12:00"))).toBe("booking_paused");
    expect((await retire(L)).ok).toBe(false);
    expect(await cancel(L, a)).toBe("cancelled");
    expect(await retire(L)).toEqual({ ok: true });
  });

  it("a PAST overlap left `confirmed` blocks indefinitely; move and cancel refuse it, and a no-show clears it", async () => {
    const L = await lab("noshow");
    const a = await placeAt(L, L.p1, L.clients[0], "3 hours", "2 hours");
    await placeAt(L, L.p2, L.clients[1], "3 hours", "2 hours");

    expect(await moveTo(L, a, L.p1, await at(10, "10:00"))).toBe("appointment_not_movable");
    expect(await cancel(L, a)).toBe("not_cancelable");

    await setBooking(L, false);
    const r = await retire(L);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("overlapping_appointments:1");

    // No-show does not read the booking flag, and stops participating at once.
    const marked = await adminQuery(`select public.mark_appointment_no_show($1, $2, $3) as r`, [
      a,
      L.s.studioId,
      L.owner.practitionerId,
    ]);
    expect(marked.rows[0].r).toBe("marked");
    expect(await participates(a)).toBe(false);
    expect(await retire(L)).toEqual({ ok: true });
  });

  it("completion clears an overlap only once the appointment's blocked end has passed", async () => {
    // In progress: started 30 minutes ago, ends in 30 minutes.
    const live = await lab("complete-live");
    const a = await placeAt(live, live.p1, live.clients[0], "30 minutes", "-30 minutes");
    await placeAt(live, live.p2, live.clients[1], "30 minutes", "-30 minutes");
    await adminQuery(`select public.mark_appointment_complete($1, $2, $3)`, [
      a,
      live.s.studioId,
      live.owner.practitionerId,
    ]);
    expect(await participates(a)).toBe(true);
    await setBooking(live, false);
    const r = await retire(live);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("overlapping_appointments:1");

    // Already ended: completing it stops it participating at once.
    const past = await lab("complete-past");
    const c = await placeAt(past, past.p1, past.clients[0], "3 hours", "2 hours");
    await placeAt(past, past.p2, past.clients[1], "3 hours", "2 hours");
    await adminQuery(`select public.mark_appointment_complete($1, $2, $3)`, [
      c,
      past.s.studioId,
      past.owner.practitionerId,
    ]);
    expect(await participates(c)).toBe(false);
    await setBooking(past, false);
    expect(await retire(past)).toEqual({ ok: true });
  });

  it("in the retirement window itself, a client's self-reschedule still runs and creates the overlap that blocks it", async () => {
    const L = await lab("window");
    // The owner's public booking on day 7, and P1's staff booking on day 8.
    const held = await publicBook(L, await at(7, "10:00"));
    expect(held.result).toBe("created");
    expect((await staffBook(L, L.p1, L.clients[1], await at(8, "10:00"))).result).toBe("created");

    // The recovery state: every service hidden, booking OFF, no overlap left.
    expect(await hideAllServices(L)).toBe(1);
    await setBooking(L, false);
    expect(await overlapPairs(L)).toBe(0);

    // The client moves their booking onto P1's time. The command reads neither
    // the freeze nor the booking flag (0171), so it goes through.
    const r = await clientReschedule(held.id!, held.hash, await at(8, "10:00"));
    expect(r.result).toBe("success");
    expect(await overlapPairs(L)).toBe(1);

    const blocked = await retire(L);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("23P01");
      expect(blocked.message).toContain("overlapping_appointments:1");
    }
  });
});
