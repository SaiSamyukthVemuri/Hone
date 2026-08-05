import { afterAll, describe, expect, it } from "vitest";
import { PostgrestClient } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, closePool } from "./helpers/harness";
import { getAvailableSlots } from "@/lib/booking/slots";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "../../e2e/helpers/local-env";
import { randomUUID } from "node:crypto";

// ===========================================================================
// BEHAVIOURAL PARITY: public_reschedule_slot_candidates (SQL)
//                 vs getAvailableSlots(..., excludeReservation, practitionerId) (TS)
// ===========================================================================
//
// Migration 0171 re-derives the RESCHEDULE offer grid in SQL so the command can
// require EXACT slot membership. Re-deriving is only safe if the two engines
// agree exactly, so this suite runs BOTH against the same seeded rows and
// compares the instant sets.
//
// This is behavioural, not a source grep: it executes the real TypeScript
// loader against the real local Supabase, and the real SQL function against the
// same rows.
//
// The two dimensions 0171 adds over 0170's booking helper — and the ONLY two —
// are exercised here:
//   * the original appointment's own reservation is excluded;
//   * capacity ON uses practitioner-scoped availability precedence and
//     resource_key reservations.
//
// PostgREST client, NOT supabase-js: `createClient` builds a RealtimeClient in
// its constructor which needs a native WebSocket, absent on the Node 20 CI
// runs. That made an earlier parity file die at import in CI only, reporting
// "0 test" while passing locally. getAvailableSlots only calls `.from(...)`.
const supabase = new PostgrestClient(`${E2E_SUPABASE_URL}/rest/v1`, {
  headers: {
    apikey: E2E_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
  },
}) as unknown as SupabaseClient;

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Fixture = {
  studioId: string;
  ownerId: string;
  otherPractId: string;
  clientId: string;
  serviceId: string;
  originalId: string;
  tz: string;
  buffer: number;
  duration: number;
  capacity: boolean;
};

async function seed(
  label: string,
  opts: {
    tz?: string;
    buffer?: number;
    duration?: number;
    capacity?: boolean;
    open?: string;
    close?: string;
  } = {},
): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const otherUser = randomUUID();
  const otherPractId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const originalId = randomUUID();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;
  const tz = opts.tz ?? "America/Toronto";
  const buffer = opts.buffer ?? 15;
  const duration = opts.duration ?? 45;
  const capacity = opts.capacity ?? false;

  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
    otherUser,
    `other-${studioId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.studios
       (id, name, owner_email, timezone, buffer_minutes, slug,
        public_booking_horizon_months, practitioner_capacity_enabled)
     values ($1,$2,$3,$4,$5,$6,3,$7)`,
    [studioId, `Parity ${label}`, email, tz, buffer, `${label}-${studioId.slice(0, 8)}`, capacity],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,'Owner',$4,'owner',true)`,
    [ownerId, studioId, userId, email],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,'Other',$4,'practitioner',true)`,
    [otherPractId, studioId, otherUser, `other-${studioId.slice(0, 8)}@harness.local`],
  );
  await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,'C',$3)`, [
    clientId,
    studioId,
    `c-${studioId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1,$2,'S',$3,true)`,
    [serviceId, studioId, duration],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, $2, $3, null from generate_series(0,6) g`,
    [studioId, opts.open ?? "09:00", opts.close ?? "17:00"],
  );

  return { studioId, ownerId, otherPractId, clientId, serviceId, originalId, tz, buffer, duration, capacity };
}

/** Insert a confirmed appointment; its shadow reservation is trigger-derived. */
async function appointment(
  f: Fixture,
  id: string,
  startIso: string,
  minutes: number,
  practitionerId?: string,
): Promise<void> {
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4,$5,$6, $6::timestamptz + make_interval(mins => $7), $7,
             'confirmed', $8)`,
    [id, f.studioId, practitionerId ?? f.ownerId, f.clientId, f.serviceId, startIso, minutes, hash64()],
  );
}

/** The TypeScript loader's answer, as sorted ISO strings. */
async function tsCandidates(f: Fixture, localDate: string): Promise<string[]> {
  const slots = await getAvailableSlots(
    supabase,
    {
      id: f.studioId,
      timezone: f.tz,
      default_appointment_duration_minutes: 60,
      buffer_minutes: f.buffer,
      practitioner_capacity_enabled: f.capacity,
    },
    localDate,
    f.duration,
    { sourceKind: "appointment", sourceId: f.originalId },
    f.capacity ? f.ownerId : null,
  );
  return slots.map((s) => new Date(s.start).toISOString()).sort();
}

/** The SQL helper's answer, as sorted ISO strings. */
async function sqlCandidates(f: Fixture, localDate: string): Promise<string[]> {
  const r = await adminQuery(
    `select c from public.public_reschedule_slot_candidates($1,$2::date,$3,$4,$5) c order by c`,
    [f.studioId, localDate, f.duration, f.originalId, f.capacity ? f.ownerId : null],
  );
  return r.rows.map((row: { c: string }) => new Date(row.c).toISOString()).sort();
}

async function expectParity(f: Fixture, localDate: string): Promise<string[]> {
  const [ts, sql] = await Promise.all([tsCandidates(f, localDate), sqlCandidates(f, localDate)]);
  expect(sql).toEqual(ts);
  return ts;
}

/** A local date `days` from today, in the fixture's timezone. */
function localDay(days: number, tz: string): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------

describe("0171 reschedule slot parity — empty day", () => {
  it("agrees on the opening anchor + hourly fallback family", async () => {
    const f = await seed("empty");
    const day = localDay(20, f.tz);
    const set = await expectParity(f, day);
    // 09:00 open, 17:00 close, 45-minute service, hourly walk -> 09..16 = 8.
    expect(set.length).toBe(8);
  });
});

describe("0171 reschedule slot parity — the ORIGINAL reservation exclusion", () => {
  it("agrees that the original's own interval is offered again", async () => {
    const f = await seed("exclusion");
    const day = localDay(21, f.tz);
    // The original sits at 11:00 local. Both engines must ignore its shadow.
    const r = await adminQuery(
      `select public.public_booking_local_to_utc($1::date, '11:00'::time, $2) as t`,
      [day, f.tz],
    );
    const originalStart = new Date(r.rows[0].t).toISOString();
    await appointment(f, f.originalId, originalStart, f.duration);

    const set = await expectParity(f, day);
    expect(set).toContain(originalStart);
  });

  // THE EXCLUSION MUST BE OBSERVABLE IN BOTH HALVES OF THE SQL.
  //
  // An earlier version of this suite placed the original at 11:00 with a
  // 45-minute duration and a 15-minute buffer. Its two derived anchors are then
  // 11:45+15 = 12:00 and 11:00-45-15 = 10:00 — BOTH already members of the
  // hourly fallback family. Deleting the exclusion from the candidate-
  // GENERATION loop therefore changed nothing observable and the negative
  // control passed, i.e. the test proved nothing about that half.
  //
  // An OFF-GRID original covers the generation half: 11:20 for 50 minutes with
  // a 25-minute buffer derives 12:35 and 09:25, neither of which any other
  // family produces, so leaving the exclusion out of the loop makes SQL emit
  // two anchors TS never offers.
  //
  // The OVERLAP-FILTER half is covered by the on-grid test above, where the
  // original's own 11:00 start IS a candidate and survives only because the
  // filter ignores its reservation. Note that an off-grid original's own start
  // is correctly offered by NEITHER engine — once its reservation is excluded,
  // nothing generates 11:20 at all — so this test must not assert it.
  it("is observable in the candidate-generation loop (off-grid original)", async () => {
    const f = await seed("offgridexcl", { buffer: 25, duration: 50 });
    const day = localDay(33, f.tz);
    const r = await adminQuery(
      `select public.public_booking_local_to_utc($1::date, '11:20'::time, $2) as t`,
      [day, f.tz],
    );
    const originalStart = new Date(r.rows[0].t).toISOString();
    await appointment(f, f.originalId, originalStart, 50);

    const set = await expectParity(f, day);

    // The generation loop must NOT emit the original's derived anchors.
    const spuriousForward = new Date(
      new Date(originalStart).getTime() + (50 + 25) * 60_000,
    ).toISOString();
    const spuriousBackward = new Date(
      new Date(originalStart).getTime() - (50 + 25) * 60_000,
    ).toISOString();
    expect(set).not.toContain(spuriousForward);
    expect(set).not.toContain(spuriousBackward);
  });

  it("agrees that ANOTHER appointment's reservation still blocks", async () => {
    const f = await seed("otherblocks");
    const day = localDay(22, f.tz);
    const r = await adminQuery(
      `select public.public_booking_local_to_utc($1::date, '11:00'::time, $2) as t,
              public.public_booking_local_to_utc($1::date, '13:00'::time, $2) as u`,
      [day, f.tz],
    );
    const originalStart = new Date(r.rows[0].t).toISOString();
    const blockerStart = new Date(r.rows[0].u).toISOString();
    await appointment(f, f.originalId, originalStart, f.duration);
    await appointment(f, randomUUID(), blockerStart, f.duration);

    const set = await expectParity(f, day);
    expect(set).toContain(originalStart); // the original is excluded
    expect(set).not.toContain(blockerStart); // the other one is not
  });

  it("agrees on the post-conflict and pre-conflict anchors around a blocker", async () => {
    const f = await seed("anchors", { buffer: 30 });
    const day = localDay(23, f.tz);
    const r = await adminQuery(
      `select public.public_booking_local_to_utc($1::date, '12:20'::time, $2) as t`,
      [day, f.tz],
    );
    const blockerStart = new Date(r.rows[0].t).toISOString();
    await appointment(f, randomUUID(), blockerStart, 50);

    const set = await expectParity(f, day);
    // The forward anchor is blocker.end + buffer; the backward anchor is
    // blocker.start - duration - buffer. Both are off the hourly grid, so their
    // presence proves the conflict-derived families are reproduced.
    const forward = new Date(new Date(blockerStart).getTime() + (50 + 30) * 60_000).toISOString();
    const backward = new Date(
      new Date(blockerStart).getTime() - (f.duration + 30) * 60_000,
    ).toISOString();
    expect(set).toContain(forward);
    expect(set).toContain(backward);
  });
});

describe("0171 reschedule slot parity — capacity ON", () => {
  it("agrees when capacity is ON with practitioner-scoped reservations", async () => {
    const f = await seed("capon", { capacity: true });
    const day = localDay(24, f.tz);
    const r = await adminQuery(
      `select public.public_booking_local_to_utc($1::date, '11:00'::time, $2) as t,
              public.public_booking_local_to_utc($1::date, '13:00'::time, $2) as u`,
      [day, f.tz],
    );
    const originalStart = new Date(r.rows[0].t).toISOString();
    const otherStart = new Date(r.rows[0].u).toISOString();
    await appointment(f, f.originalId, originalStart, f.duration, f.ownerId);
    // A DIFFERENT practitioner's appointment must NOT block the owner.
    await appointment(f, randomUUID(), otherStart, f.duration, f.otherPractId);

    const set = await expectParity(f, day);
    expect(set).toContain(originalStart);
    expect(set).toContain(otherStart);
  });

  it("agrees when capacity is ON and the practitioner has a scoped availability window", async () => {
    const f = await seed("capscoped", { capacity: true });
    const day = localDay(25, f.tz);
    // A practitioner-scoped default that is NARROWER than the studio-wide one.
    // Both engines must prefer it.
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
       values ($1, extract(dow from $2::date)::int, true, '10:00', '12:00', $3)`,
      [f.studioId, day, f.ownerId],
    );
    const set = await expectParity(f, day);
    // 10:00 open, 12:00 close, 45-minute service, hourly -> 10:00 and 11:00.
    expect(set.length).toBe(2);
  });

  it("agrees that a studio-wide OVERRIDE beats a practitioner-scoped DEFAULT", async () => {
    const f = await seed("overrideprec", { capacity: true });
    const day = localDay(26, f.tz);
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
       values ($1, extract(dow from $2::date)::int, true, '10:00', '12:00', $3)`,
      [f.studioId, day, f.ownerId],
    );
    await adminQuery(
      `insert into public.studio_availability_overrides
         (studio_id, effective_date, is_open, open_time, close_time, practitioner_id)
       values ($1,$2,true,'14:00','17:00',null)`,
      [f.studioId, day],
    );
    const set = await expectParity(f, day);
    // The studio-wide override wins: 14:00, 15:00, 16:00.
    expect(set.length).toBe(3);
  });
});

describe("0171 reschedule slot parity — closed days and blockouts", () => {
  it("agrees on a closed weekday (both empty)", async () => {
    const f = await seed("closed");
    const day = localDay(27, f.tz);
    await adminQuery(
      `update public.studio_availability_default set is_open = false
        where studio_id = $1 and day_of_week = extract(dow from $2::date)::int`,
      [f.studioId, day],
    );
    const set = await expectParity(f, day);
    expect(set).toHaveLength(0);
  });

  it("agrees on a full-day blockout (both empty)", async () => {
    const f = await seed("blockout");
    const day = localDay(28, f.tz);
    await adminQuery(
      `insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason)
       values ($1,$2,$2,'closed')`,
      [f.studioId, day],
    );
    const set = await expectParity(f, day);
    expect(set).toHaveLength(0);
  });

  it("agrees that a timed block is protected to its RAW end (no buffer widening)", async () => {
    const f = await seed("timedblock", { buffer: 30 });
    const day = localDay(29, f.tz);
    const r = await adminQuery(
      `select public.public_booking_local_to_utc($1::date, '12:00'::time, $2) as t`,
      [day, f.tz],
    );
    const blockStart = new Date(r.rows[0].t).toISOString();
    const blockEnd = new Date(new Date(blockStart).getTime() + 60 * 60_000).toISOString();
    await adminQuery(
      `insert into public.studio_calendar_reservations
         (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
       values ($1, null, $1, 'timed_block', $2, $3, $4)`,
      [f.studioId, randomUUID(), blockStart, blockEnd],
    );
    const set = await expectParity(f, day);
    // A timed block carries NO buffer, so its raw end is a legal next start.
    expect(set).toContain(blockEnd);
  });
});

describe("0171 reschedule slot parity — DST and timezones", () => {
  // America/Toronto spring-forward 2027-03-14, fall-back 2027-11-07. Both are
  // far enough out that a 3-month horizon would refuse a BOOKING, but the
  // candidate helper itself has no horizon — it is a pure grid function, so
  // these dates exercise the DST port directly.
  it.each([
    ["spring forward", "2027-03-14"],
    ["fall back", "2027-11-07"],
    ["ordinary day", "2027-06-15"],
  ])("agrees across %s in America/Toronto", async (_label, day) => {
    const f = await seed(`dst-${day}`, { tz: "America/Toronto" });
    await expectParity(f, day);
  });

  it.each([
    ["Asia/Kolkata (half-hour offset)", "Asia/Kolkata"],
    ["Australia/Adelaide (half-hour + southern DST)", "Australia/Adelaide"],
    ["Pacific/Chatham (45-minute offset)", "Pacific/Chatham"],
    ["Europe/Berlin", "Europe/Berlin"],
    ["UTC", "UTC"],
  ])("agrees in %s", async (_label, tz) => {
    const f = await seed(`tz-${tz.replace(/[^a-z]/gi, "")}`, { tz });
    const day = localDay(30, tz);
    await expectParity(f, day);
  });
});

describe("0171 reschedule slot parity — window edges", () => {
  it("agrees that the trailing buffer MAY spill past close", async () => {
    const f = await seed("spill", { buffer: 30, duration: 60, open: "09:00", close: "17:00" });
    const day = localDay(31, f.tz);
    const set = await expectParity(f, day);
    // 16:00 + 60 = 17:00 exactly, fits. Its buffer runs to 17:30, past close,
    // which is allowed. So 16:00 must be offered by BOTH.
    const r = await adminQuery(
      `select public.public_booking_local_to_utc($1::date, '16:00'::time, $2) as t`,
      [day, f.tz],
    );
    expect(set).toContain(new Date(r.rows[0].t).toISOString());
  });

  it("agrees when the window carries SECONDS on both bounds", async () => {
    const f = await seed("seconds", { open: "09:00:30", close: "17:00:45" });
    const day = localDay(32, f.tz);
    await expectParity(f, day);
  });
});
