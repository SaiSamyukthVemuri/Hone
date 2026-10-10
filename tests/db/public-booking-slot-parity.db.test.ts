import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgrestClient } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, closePool } from "./helpers/harness";
import { getAvailableSlots } from "@/lib/booking/slots";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "../../e2e/helpers/local-env";
import { randomUUID } from "node:crypto";

// ===========================================================================
// BEHAVIOURAL PARITY: public_booking_slot_candidates (SQL) vs getAvailableSlots (TS)
// ===========================================================================
//
// Migration 0170 re-derives the public offer grid in SQL so the command can
// require EXACT slot membership. Re-deriving is only safe if the two engines
// agree exactly, so this suite runs BOTH against the same seeded studio and
// compares the instant sets.
//
// This is behavioural, not a source grep: it executes the real TypeScript
// loader against the real local Supabase, and the real SQL function against the
// same rows.
//
// The three anchor families come from lib/booking/slots.ts:300-319 and the
// fallback step is FALLBACK_GRANULARITY_MINUTES = 60 (slots.ts:115) — NOT 15.

// A PostgREST client, NOT a full supabase-js client. `createClient` from
// @supabase/supabase-js constructs a RealtimeClient in its constructor, which
// needs a native WebSocket — absent on Node 20, which CI runs. That made this
// whole file die at import time in CI ("0 test") while passing locally on a
// newer Node. getAvailableSlots only ever calls `.from(...)`, so the PostgREST
// client alone satisfies it, adds no dependency, and starts no socket.
const supabase = new PostgrestClient(`${E2E_SUPABASE_URL}/rest/v1`, {
  headers: {
    apikey: E2E_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
  },
}) as unknown as SupabaseClient;

type Fixture = {
  studioId: string;
  ownerId: string;
  serviceId: string;
  tz: string;
  buffer: number;
  duration: number;
};

async function seed(
  label: string,
  opts: { tz?: string; buffer?: number; duration?: number; open?: string; close?: string } = {},
): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const serviceId = randomUUID();
  const tz = opts.tz ?? "America/Toronto";
  const buffer = opts.buffer ?? 30;
  const duration = opts.duration ?? 60;
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;

  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios (id,name,owner_email,timezone,buffer_minutes,slug,public_booking_horizon_months)
     values ($1,$2,$3,$4,$5,$6,3)`,
    [studioId, `Parity ${label}`, email, tz, buffer, `${label}-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
     values ($1,$2,$3,'Owner',$4,'owner',true)`,
    [ownerId, studioId, userId, email],
  );
  await adminQuery(
    `insert into public.services (id,studio_id,name,default_duration_minutes,active)
     values ($1,$2,'Service',$3,true)`,
    [serviceId, studioId, duration],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
     select $1,g,true,$2::time,$3::time,null from generate_series(0,6) g`,
    [studioId, opts.open ?? "09:00", opts.close ?? "17:00"],
  );
  return { studioId, ownerId, serviceId, tz, buffer, duration };
}

/** The TypeScript loader's offered starts, as epoch ms. */
async function tsOffered(f: Fixture, dateStr: string): Promise<number[]> {
  const slots = await getAvailableSlots(
    supabase,
    {
      id: f.studioId,
      timezone: f.tz,
      default_appointment_duration_minutes: f.duration,
      buffer_minutes: f.buffer,
    } as Parameters<typeof getAvailableSlots>[1],
    dateStr,
    f.duration,
  );
  return slots.map((s) => new Date(s.start).getTime()).sort((a, b) => a - b);
}

/** The SQL candidate set, as epoch ms. */
async function sqlCandidates(f: Fixture, dateStr: string): Promise<number[]> {
  const r = await adminQuery(
    `select c from public.public_booking_slot_candidates($1,$2::date,$3) c order by c`,
    [f.studioId, dateStr, f.duration],
  );
  return r.rows.map((row) => new Date(row.c).getTime()).sort((a, b) => a - b);
}

const fmt = (ms: number[]) => ms.map((m) => new Date(m).toISOString());

afterAll(async () => {
  await closePool();
});

describe("SQL candidate set == TypeScript offered set", () => {
  let plain: Fixture;

  beforeAll(async () => {
    plain = await seed("plain");
  });

  it("agrees on an empty, conflict-free day", async () => {
    const d = "2026-06-10";
    const [ts, sql] = [await tsOffered(plain, d), await sqlCandidates(plain, d)];
    expect(sql.length).toBeGreaterThan(0);
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees around an appointment (source-aware buffered end + backward pack)", async () => {
    const f = await seed("with-appt");
    // The command enforces the booking horizon and refuses past instants, so
    // this case must use a real future date rather than a fixed literal.
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 14);
    const d = day.toISOString().slice(0, 10);
    const offered = await tsOffered(f, d);
    expect(offered.length).toBeGreaterThan(2);
    const clientId = (
      await adminQuery(
        `insert into public.clients (id,studio_id,name,email) values (gen_random_uuid(),$1,'C',$2) returning id`,
        [f.studioId, `c-${f.studioId.slice(0, 8)}@harness.local`],
      )
    ).rows[0].id;
    // Book a middle slot so both the forward (buffered end) and backward
    // (start - duration - buffer) anchors are exercised.
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [
        f.studioId,
        clientId,
        f.serviceId,
        new Date(offered[2]).toISOString(),
        (randomUUID() + randomUUID()).replace(/-/g, ""),
      ],
    );
    expect(r.rows[0].result).toBe("created");
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    // The appointment must actually have changed the offered set.
    expect(fmt(ts)).not.toEqual(fmt(offered));
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees around a timed block (raw end, no appointment buffer)", async () => {
    const f = await seed("with-block");
    const d = "2026-06-12";
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id,starts_at,ends_at,category,practitioner_id)
       values ($1,'2026-06-12T15:00:00Z','2026-06-12T16:30:00Z','admin',null)`,
      [f.studioId],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees on a full-day blockout (both empty)", async () => {
    const f = await seed("blockout");
    const d = "2026-06-13";
    await adminQuery(
      `insert into public.studio_blockouts (studio_id,starts_on,ends_on) values ($1,$2::date,$2::date)`,
      [f.studioId, d],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(sql).toEqual([]);
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees on a closed weekday (both empty)", async () => {
    const f = await seed("closed");
    const d = "2026-06-14"; // Sunday
    await adminQuery(
      `update public.studio_availability_default set is_open=false
        where studio_id=$1 and day_of_week=0`,
      [f.studioId],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(sql).toEqual([]);
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees on a date override that narrows the window", async () => {
    const f = await seed("override");
    const d = "2026-06-15";
    await adminQuery(
      `insert into public.studio_availability_overrides
         (studio_id,effective_date,is_open,open_time,close_time,practitioner_id)
       values ($1,$2::date,true,'11:00','14:00',null)`,
      [f.studioId, d],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql)).toEqual(fmt(ts));
  });
});

describe("DST parity — America/Toronto", () => {
  it("agrees on the spring-forward day", async () => {
    const f = await seed("spring");
    const d = "2026-03-08";
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(sql.length).toBeGreaterThan(0);
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees on the fall-back day", async () => {
    const f = await seed("fall");
    const d = "2026-11-01";
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(sql.length).toBeGreaterThan(0);
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees on a spring-forward day whose window spans the transition", async () => {
    // Open 00:00-23:59 so the 02:00-03:00 local gap is inside the window.
    const f = await seed("spring-wide", { open: "00:00", close: "23:59" });
    const d = "2026-03-08";
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("agrees on a fall-back day whose window spans the transition", async () => {
    const f = await seed("fall-wide", { open: "00:00", close: "23:59" });
    const d = "2026-11-01";
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("the ported local->UTC helper matches the TS conventions on both edges", async () => {
    // Nonexistent local time: TS maps to the instant one hour BEFORE the wall
    // clock; Postgres AT TIME ZONE shifts forward. Ambiguous local time: TS
    // picks the FIRST occurrence; Postgres picks the second.
    const r = await adminQuery(
      `select
         public.public_booking_local_to_utc('2026-03-08','02:30','America/Toronto') as ported_gap,
         ('2026-03-08 02:30'::timestamp at time zone 'America/Toronto')            as native_gap,
         public.public_booking_local_to_utc('2026-11-01','01:30','America/Toronto') as ported_amb,
         ('2026-11-01 01:30'::timestamp at time zone 'America/Toronto')            as native_amb`,
    );
    const row = r.rows[0];
    expect(new Date(row.ported_gap).toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(new Date(row.native_gap).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(row.ported_amb).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(new Date(row.native_amb).toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // The whole point: the ported helper and the native operator DISAGREE, and
    // the ported one is the side that matches the offered slots.
    expect(row.ported_gap).not.toEqual(row.native_gap);
    expect(row.ported_amb).not.toEqual(row.native_amb);
  });
});

describe("every TS-offered slot is ACCEPTED, every off-grid time REJECTED", () => {
  it("accepts each offered start and rejects the minutes between them", async () => {
    const f = await seed("accept-reject");
    const d = "2026-06-16";
    const offered = await tsOffered(f, d);
    expect(offered.length).toBeGreaterThan(2);

    for (const ms of offered) {
      const r = await adminQuery(
        `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,
                 $4::timestamptz + make_interval(mins => $5)) as v`,
        [f.studioId, f.ownerId, f.serviceId, new Date(ms).toISOString(), f.duration],
      );
      expect(r.rows[0].v, `offered slot ${new Date(ms).toISOString()} must be accepted`).toBe("ok");
    }

    // Every minute strictly between the first two offered starts is off-grid.
    for (let m = 1; m < 60; m += 7) {
      const off = new Date(offered[0] + m * 60_000).toISOString();
      const r = await adminQuery(
        `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,
                 $4::timestamptz + make_interval(mins => $5)) as v`,
        [f.studioId, f.ownerId, f.serviceId, off, f.duration],
      );
      expect(r.rows[0].v, `${off} is off-grid and must be refused`).toBe("not_a_public_slot");
    }
  });

  it("rejects sub-minute drift from a legitimate candidate", async () => {
    const f = await seed("drift");
    const d = "2026-06-17";
    const offered = await tsOffered(f, d);
    const drifted = new Date(offered[0] + 1000).toISOString(); // +1 second
    const r = await adminQuery(
      `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,
               $4::timestamptz + make_interval(mins => $5)) as v`,
      [f.studioId, f.ownerId, f.serviceId, drifted, f.duration],
    );
    expect(r.rows[0].v).toBe("not_a_public_slot");
  });

  it("pins the fallback granularity at 60 minutes, matching slots.ts", async () => {
    const f = await seed("granularity");
    const offered = await tsOffered(f, "2026-06-18");
    for (let i = 1; i < offered.length; i++) {
      expect(offered[i] - offered[i - 1]).toBe(60 * 60_000);
    }
  });
});

describe("capacity history does not change public candidate membership", () => {
  it("retained practitioner-scoped rows are ignored by both engines", async () => {
    const f = await seed("capacity-history");
    const d = "2026-06-19";
    const before = await sqlCandidates(f, d);

    await adminQuery(`update public.studios set practitioner_capacity_enabled=true where id=$1`, [
      f.studioId,
    ]);
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       values ($1,$2,false,null,null,$3)`,
      [f.studioId, new Date(`${d}T12:00:00Z`).getUTCDay(), f.ownerId],
    );
    await adminQuery(`update public.studios set practitioner_capacity_enabled=false where id=$1`, [
      f.studioId,
    ]);

    const after = await sqlCandidates(f, d);
    expect(fmt(after)).toEqual(fmt(before));
    expect(fmt(after)).toEqual(fmt(await tsOffered(f, d)));
  });
});

describe("regressions from adversarial review", () => {
  it("D1: a close_time carrying SECONDS does not admit an off-grid start", async () => {
    // The candidate walk truncates the window to HH:MM (matching trimTime in
    // lib/booking/slots.ts). Deriving the minute bounds from hour+minute while
    // deriving the UTC bounds from the full `time` let a close_time of 17:00:45
    // accept a start whose service end was 17:00:30 — a slot the page never
    // offers. Reachable only by a direct DB write, but the port must not depend
    // on the app's HH:MM validation.
    const f = await seed("close-seconds", { buffer: 0 });
    await adminQuery(
      `update public.studio_availability_default
          set open_time='09:00'::time, close_time='17:00:45'::time
        where studio_id=$1`,
      [f.studioId],
    );
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 10);
    const d = day.toISOString().slice(0, 10);
    // A conflict ending at 16:00:30 LOCAL. With buffer 0 its after-conflict
    // anchor is 16:00:30, whose service end is 17:00:30 — past the real 17:00
    // close but inside a naive 17:00:45 bound. The hourly walk alone can never
    // land in that 45-second gap, so the conflict is what makes this reproduce.
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id, starts_at, ends_at, category, practitioner_id)
       values ($1,
               public.public_booking_local_to_utc($2::date,'15:00'::time,$3),
               public.public_booking_local_to_utc($2::date,'16:00:30'::time,$3),
               'admin', null)`,
      [f.studioId, d, f.tz],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql), "seconds in close_time must not change the offered set").toEqual(fmt(ts));
    // And the off-grid 16:00:30 start must be refused outright.
    const anchor = await adminQuery(
      `select public.public_booking_local_to_utc($1::date,'16:00:30'::time,$2) as t`,
      [d, f.tz],
    );
    const r = await adminQuery(
      `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,
               $4::timestamptz + make_interval(mins => $5)) as v`,
      [f.studioId, f.ownerId, f.serviceId, anchor.rows[0].t, f.duration],
    );
    expect(r.rows[0].v, "service end 17:00:30 is past the real 17:00 close").not.toBe("ok");
  });

  it("D1: an open_time carrying SECONDS does not drop the opening anchor", async () => {
    const f = await seed("open-seconds", { buffer: 0 });
    await adminQuery(
      `update public.studio_availability_default
          set open_time='09:00:30'::time, close_time='17:00'::time
        where studio_id=$1`,
      [f.studioId],
    );
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 11);
    const d = day.toISOString().slice(0, 10);
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(sql.length, "the opening anchor family must survive").toBeGreaterThan(0);
    expect(fmt(sql)).toEqual(fmt(ts));
    // And the first offered slot must actually be bookable.
    const r = await adminQuery(
      `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,
               $4::timestamptz + make_interval(mins => $5)) as v`,
      [f.studioId, f.ownerId, f.serviceId, new Date(ts[0]).toISOString(), f.duration],
    );
    expect(r.rows[0].v).toBe("ok");
  });

  it("the validator never raises, even on a non-positive interval", async () => {
    // It is independently grantable and its contract says it returns codes.
    const f = await seed("never-raises");
    const r = await adminQuery(
      `select public.validate_public_booking_slot($1,$2,$3,
               now() + interval '2 days', now() + interval '1 day') as v`,
      [f.studioId, f.ownerId, f.serviceId],
    );
    expect(r.rows[0].v).toBe("invalid_time");
  });
});

describe("precision domain — JavaScript milliseconds, by truncation", () => {
  // Postgres timestamptz keeps MICROseconds; a JS Date keeps milliseconds and
  // truncates on parse. A reservation boundary carrying microseconds would make
  // the SQL anchor .123456 while the page offers .123 — the page would offer a
  // slot the command refused. Both engines are normalised to milliseconds.
  //
  // NOTE these tests deliberately inspect the RAW textual timestamp too. An
  // earlier version of this file compared only `new Date(v).getTime()`, which
  // truncates the SQL value before the comparison and therefore HID the very
  // mismatch it was supposed to catch.

  /** The SQL candidates as raw microsecond-precision text. */
  async function sqlCandidateText(f: Fixture, dateStr: string): Promise<string[]> {
    const r = await adminQuery(
      `select to_char(c at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as t
         from public.public_booking_slot_candidates($1,$2::date,$3) c order by c`,
      [f.studioId, dateStr, f.duration],
    );
    return r.rows.map((row) => row.t as string);
  }

  it("the SQL function itself returns MILLISECOND-normalised values", async () => {
    const f = await seed("us-normalised", { buffer: 30 });
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 9);
    const d = day.toISOString().slice(0, 10);
    // A timed block whose end carries microseconds.
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id,starts_at,ends_at,category,practitioner_id)
       values ($1,
               public.public_booking_local_to_utc($2::date,'11:00'::time,$3),
               public.public_booking_local_to_utc($2::date,'12:00'::time,$3) + interval '123456 microseconds',
               'admin', null)`,
      [f.studioId, d, f.tz],
    );
    const texts = await sqlCandidateText(f, d);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t.slice(-3), `${t} must have zero microsecond remainder`).toBe("000");
    }
  });

  it("an APPOINTMENT conflict with microseconds keeps TS and SQL in agreement", async () => {
    const f = await seed("us-appointment", { buffer: 30 });
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 9);
    const d = day.toISOString().slice(0, 10);
    const clientId = (
      await adminQuery(
        `insert into public.clients (id,studio_id,name,email) values (gen_random_uuid(),$1,'C',$2) returning id`,
        [f.studioId, `c-${f.studioId.slice(0, 8)}@harness.local`],
      )
    ).rows[0].id;
    const offered = await tsOffered(f, d);
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, clientId, f.serviceId, new Date(offered[2]).toISOString(), (randomUUID() + randomUUID()).replace(/-/g, "")],
    );
    expect(r.rows[0].result).toBe("created");
    // Push microseconds onto the committed appointment's boundaries.
    await adminQuery(
      `update public.appointments
          set starts_at = starts_at + interval '654321 microseconds',
              ends_at   = ends_at   + interval '654321 microseconds'
        where id = $1`,
      [r.rows[0].appointment_id],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql)).toEqual(fmt(ts));
    for (const t of await sqlCandidateText(f, d)) expect(t.slice(-3)).toBe("000");
  });

  it("a TIMED BLOCK with microseconds keeps TS and SQL in agreement", async () => {
    const f = await seed("us-block", { buffer: 30 });
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 10);
    const d = day.toISOString().slice(0, 10);
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id,starts_at,ends_at,category,practitioner_id)
       values ($1,
               public.public_booking_local_to_utc($2::date,'11:00'::time,$3) + interval '111111 microseconds',
               public.public_booking_local_to_utc($2::date,'12:30'::time,$3) + interval '777777 microseconds',
               'admin', null)`,
      [f.studioId, d, f.tz],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql)).toEqual(fmt(ts));
  });

  it("the BACKWARD-packed anchor normalises identically in both engines", async () => {
    const f = await seed("us-backward", { buffer: 30 });
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 11);
    const d = day.toISOString().slice(0, 10);
    // A conflict whose START carries microseconds drives conflict.start - dur - buf.
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id,starts_at,ends_at,category,practitioner_id)
       values ($1,
               public.public_booking_local_to_utc($2::date,'13:00'::time,$3) + interval '999999 microseconds',
               public.public_booking_local_to_utc($2::date,'14:00'::time,$3),
               'admin', null)`,
      [f.studioId, d, f.tz],
    );
    const [ts, sql] = [await tsOffered(f, d), await sqlCandidates(f, d)];
    expect(fmt(sql)).toEqual(fmt(ts));
    for (const t of await sqlCandidateText(f, d)) expect(t.slice(-3)).toBe("000");
  });

  it("the exact ISO string the loader offers is ACCEPTED by the validator", async () => {
    const f = await seed("us-membership", { buffer: 30 });
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 12);
    const d = day.toISOString().slice(0, 10);
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id,starts_at,ends_at,category,practitioner_id)
       values ($1,
               public.public_booking_local_to_utc($2::date,'11:00'::time,$3),
               public.public_booking_local_to_utc($2::date,'12:00'::time,$3) + interval '456789 microseconds',
               'admin', null)`,
      [f.studioId, d, f.tz],
    );
    const offered = await tsOffered(f, d);
    expect(offered.length).toBeGreaterThan(0);
    for (const ms of offered) {
      const iso = new Date(ms).toISOString(); // exactly what the form posts
      const v = await adminQuery(
        `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,
                 $4::timestamptz + make_interval(mins => $5)) as v`,
        [f.studioId, f.ownerId, f.serviceId, iso, f.duration],
      );
      expect(v.rows[0].v, `${iso} is offered and must be accepted`).toBe("ok");
    }
  });
});

// ---------------------------------------------------------------------------
// WAIT-v4 PR0 — a protected buffer that crosses LOCAL MIDNIGHT
// ---------------------------------------------------------------------------

describe("WAIT-v4 PR0: the buffer that crosses local midnight", () => {
  // `studio_calendar_reservations` stores an appointment's ACTUAL end (0152);
  // both engines re-apply the studio buffer to reach its PROTECTED end. Both
  // read the reservation set with `ends_at > window_start` — the ACTUAL end —
  // so a 23:50 appointment under a 30-minute buffer, protected to 00:20, was
  // never loaded for the following day and LOCAL MIDNIGHT WAS OFFERED, while
  // validate_public_booking_slot and 0152's enforce_appointment_buffer both
  // refused it.
  //
  // Reachable ONLY by a studio whose open time falls within `buffer` minutes of
  // local midnight, which is why every fixture here opens at 00:00.
  //
  // The existing cases in this file seed `studio_timed_blocks`, and a timed
  // block is protected to its RAW end — it takes no buffer. That is precisely
  // why none of them reaches this, and why the defect sat in both engines
  // unnoticed.

  /** 23:50-local the previous day, derived from the studio's own timezone. */
  async function seedPrevEveningAppointment(f: Fixture, dateStr: string) {
    const clientId = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1,$2,'Prev')`,
      [clientId, f.studioId],
    );
    await adminQuery(
      `insert into public.appointments
         (id, studio_id, client_id, service_id, practitioner_id,
          starts_at, ends_at, duration_minutes, status)
       select $1, $2, $3, $4, $5,
              (($6::date - 1)::text || ' 23:00')::timestamp at time zone st.timezone,
              (($6::date - 1)::text || ' 23:50')::timestamp at time zone st.timezone,
              50, 'confirmed'
         from public.studios st where st.id = $2`,
      [randomUUID(), f.studioId, clientId, f.serviceId, f.ownerId, dateStr],
    );
    return clientId;
  }

  /** The studio-local wall time of an instant, as HH:MM. */
  async function localOf(f: Fixture, iso: string): Promise<string> {
    const r = await adminQuery(
      `select to_char($1::timestamptz at time zone st.timezone, 'HH24:MI') as t
         from public.studios st where st.id = $2`,
      [iso, f.studioId],
    );
    return r.rows[0].t as string;
  }

  const DATE = "2027-06-16"; // mid-month, clear of both DST transition weeks

  it("1. SQL no longer offers local midnight", async () => {
    const f = await seed("mid-sql", { open: "00:00", close: "08:00", buffer: 30 });
    await seedPrevEveningAppointment(f, DATE);
    const sql = await sqlCandidates(f, DATE);
    expect(sql.length, "the day produced no candidates at all").toBeGreaterThan(0);
    const locals = await Promise.all(
      sql.map((ms) => localOf(f, new Date(ms).toISOString())),
    );
    expect(
      locals,
      "00:00 is protected until 00:20 — offering it is an offer the authority refuses",
    ).not.toContain("00:00");
  });

  it("2. and it still offers the protected end itself", async () => {
    // The over-correction control: a repair that dropped the whole morning would
    // satisfy case 1. 00:20 is the protected end, and touching is allowed.
    const f = await seed("mid-end", { open: "00:00", close: "08:00", buffer: 30 });
    await seedPrevEveningAppointment(f, DATE);
    const sql = await sqlCandidates(f, DATE);
    const locals = await Promise.all(
      sql.map((ms) => localOf(f, new Date(ms).toISOString())),
    );
    expect(locals, "the earliest legal start was withheld too").toContain("00:20");
  });

  it("3. CONTROL — with a ZERO buffer local midnight still stands", async () => {
    // The reservation protects nothing past its own end, so 00:00 is genuinely
    // free and the authority accepts it. Proves the repair is scoped to the
    // buffered case and did not simply narrow the morning.
    const f = await seed("mid-zero", { open: "00:00", close: "08:00", buffer: 0 });
    await seedPrevEveningAppointment(f, DATE);
    const sql = await sqlCandidates(f, DATE);
    const locals = await Promise.all(
      sql.map((ms) => localOf(f, new Date(ms).toISOString())),
    );
    expect(locals).toContain("00:00");
  });

  it("4. SET EQUALITY — TS and SQL agree in the midnight scenario", async () => {
    // The case the rest of this file could not reach. Before the repair the two
    // engines agreed only by sharing the same defect; after it they agree on the
    // corrected set. This is the parity claim PR0 exists to make.
    const f = await seed("mid-parity", { open: "00:00", close: "08:00", buffer: 30 });
    await seedPrevEveningAppointment(f, DATE);
    const [ts, sql] = await Promise.all([tsOffered(f, DATE), sqlCandidates(f, DATE)]);
    expect(sql.length, "no candidates to compare").toBeGreaterThan(0);
    expect(fmt(ts), "the two engines disagree about the midnight boundary").toEqual(
      fmt(sql),
    );
  });

  it("5. and the write authority accepts exactly what they now offer", async () => {
    // Closes the loop the defect opened: the first offered start must validate.
    const f = await seed("mid-accept", { open: "00:00", close: "08:00", buffer: 30 });
    await seedPrevEveningAppointment(f, DATE);
    const sql = await sqlCandidates(f, DATE);
    const first = new Date(sql[0]!).toISOString();
    const end = new Date(sql[0]! + f.duration * 60_000).toISOString();
    const v = await adminQuery(
      `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,$5::timestamptz) as v`,
      [f.studioId, f.ownerId, f.serviceId, first, end],
    );
    expect(v.rows[0].v, `${first} is offered and must be accepted`).toBe("ok");
  });
});
