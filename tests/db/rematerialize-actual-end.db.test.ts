import { afterAll, describe, expect, it } from "vitest";
import { PostgrestClient } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool } from "./helpers/harness";
import { getAvailableSlots } from "@/lib/booking/slots";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "../../e2e/helpers/local-env";

// ===========================================================================
// HON-114 — a staff change must not hide openings that are genuinely free.
// ===========================================================================
//
// rematerialize_studio_reservations (0137) wrote each appointment reservation's end from blocked_ends_at (the real end PLUS the studio buffer). Every reader
// (lib/booking/slots.ts, public_booking_slot_candidates[_for_practitioner], the buffer validator) re-adds the buffer, so after a staff change the buffer was
// counted TWICE and the first opening after each existing visit disappeared until the visit was touched again. 0384 stores the real end.
//
// Each scenario starts from an EXISTING appointment (10:00-11:00) in a studio with a 20-minute buffer and per-practitioner capacity ON, makes the staff change,
// and WITHOUT re-saving the appointment proves, against the real database and the real TypeScript engine:
//   1. the reservation still holds the appointment's REAL end (11:00), not 11:20;
//   2. the first opening exactly one buffer later (11:20) is OFFERED by the TypeScript engine AND by the SQL candidate function;
//   3. the 20-minute gap itself is NOT offered by either (no start between 11:00 and 11:19);
//   4. a client can BOOK 11:20 through the public SQL command (create_public_appointment), and a start inside the gap (11:10) is refused.
// The scenarios are: add a practitioner, delete one, deactivate one (active=false: it is NOT a refan caller, so this is the proven no-op), and toggle the
// capacity flag off and on (a second caller of the same function).

const supabase = new PostgrestClient(`${E2E_SUPABASE_URL}/rest/v1`, {
  headers: { apikey: E2E_SERVICE_ROLE_KEY, Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}` },
}) as unknown as SupabaseClient;

const TZ = "America/Toronto";
const BUFFER = 20;
const DURATION = 60;

type Fx = {
  studioId: string;
  ownerId: string; // the one active owner: the public command attributes bookings to this row
  serviceId: string;
  apptId: string;
  otherId: string | null; // a second practitioner that exists BEFORE the appointment (scenario 'deactivate' only)
  day: string; // local date, yyyy-mm-dd
  endMs: number; // the appointment's REAL end, epoch ms
};

async function utc(day: string, hhmm: string): Promise<number> {
  const r = await adminQuery(`select (($1::date + $2::time) at time zone $3) as t`, [day, hhmm, TZ]);
  return new Date(r.rows[0].t).getTime();
}

async function seed(label: string, opts: { secondPractitionerFirst?: boolean } = {}): Promise<Fx> {
  const studioId = randomUUID();
  const ownerUser = randomUUID();
  const ownerId = randomUUID();
  const serviceId = randomUUID();
  const clientId = randomUUID();
  const apptId = randomUUID();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 21);
  const day = d.toISOString().slice(0, 10);

  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [ownerUser, email]);
  await adminQuery(
    `insert into public.studios (id,name,owner_email,timezone,buffer_minutes,slug,public_booking_horizon_months)
     values ($1,$2,$3,$4,$5,$6,3)`,
    [studioId, `HON114 ${label}`, email, TZ, BUFFER, `hon114-${label}-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
     values ($1,$2,$3,'Owner',$4,'owner',true)`,
    [ownerId, studioId, ownerUser, email],
  );
  await adminQuery(
    `insert into public.services (id,studio_id,name,default_duration_minutes,active) values ($1,$2,'Service',$3,true)`,
    [serviceId, studioId, DURATION],
  );
  await adminQuery(
    `insert into public.studio_availability_default (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
     select $1,g,true,'09:00'::time,'17:00'::time,null from generate_series(0,6) g`,
    [studioId],
  );
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Existing client')`, [clientId, studioId]);
  // Capacity ON BEFORE the appointment, so the appointment reaches the reservation through the per-appointment sync trigger (the correct, real-end path).
  await adminQuery(`update public.studios set practitioner_capacity_enabled = true where id = $1`, [studioId]);
  let otherId: string | null = null;
  if (opts.secondPractitionerFirst) {
    // Capacity is already ON here, so this INSERT runs the refan BEFORE any appointment exists: nothing is left to go stale.
    otherId = randomUUID();
    const ou = randomUUID();
    const oe = `p-${otherId.slice(0, 8)}@harness.local`;
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [ou, oe]);
    await adminQuery(
      `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active) values ($1,$2,$3,'Second',$4,'practitioner',true)`,
      [otherId, studioId, ou, oe],
    );
  }
  const start = await utc(day, "10:00");
  const end = await utc(day, "11:00");
  await adminQuery(
    `insert into public.appointments (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed')`,
    [apptId, studioId, clientId, ownerId, serviceId, new Date(start).toISOString(), new Date(end).toISOString(), DURATION],
  );
  return { studioId, ownerId, serviceId, apptId, otherId, day, endMs: end };
}

async function addPractitioner(f: Fx, role = "practitioner"): Promise<string> {
  const id = randomUUID();
  const userId = randomUUID();
  const email = `p-${id.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
  await adminQuery(
    `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active) values ($1,$2,$3,'Second',$4,$5,true)`,
    [id, f.studioId, userId, email, role],
  );
  return id;
}

async function reservationEndMs(f: Fx): Promise<number[]> {
  const r = await adminQuery(
    `select ends_at from public.studio_calendar_reservations where studio_id = $1 and source_kind = 'appointment' and source_id = $2 order by ends_at`,
    [f.studioId, f.apptId],
  );
  return r.rows.map((x) => new Date(x.ends_at).getTime());
}

async function tsOffered(f: Fx): Promise<number[]> {
  const slots = await getAvailableSlots(
    supabase,
    {
      id: f.studioId,
      timezone: TZ,
      default_appointment_duration_minutes: DURATION,
      buffer_minutes: BUFFER,
      practitioner_capacity_enabled: true,
    } as unknown as Parameters<typeof getAvailableSlots>[1],
    f.day,
    DURATION,
    undefined,
    f.ownerId,
  );
  return slots.map((s) => new Date(s.start).getTime()).sort((a, b) => a - b);
}

async function sqlOffered(f: Fx): Promise<number[]> {
  const r = await adminQuery(
    `select c from public.public_booking_slot_candidates_for_practitioner($1,$2::date,$3,$4) c order by c`,
    [f.studioId, f.day, DURATION, f.ownerId],
  );
  return r.rows.map((x) => new Date(x.c).getTime()).sort((a, b) => a - b);
}

const iso = (ms: number[]) => ms.map((m) => new Date(m).toISOString());
const MIN = 60_000;

/** The five assertions every scenario makes, WITHOUT touching the appointment. */
async function assertOpeningsIntact(f: Fx) {
  // 1. the reservation holds the REAL end
  // soft: when this fails the SYMPTOM checks below still run, so one failure shows both the cause (the stored end) and the effect (the missing opening)
  expect.soft(iso(await reservationEndMs(f)), "the appointment's reservation must end at its real end, not real end + buffer").toEqual(iso([f.endMs]));
  const firstOpen = f.endMs + BUFFER * MIN;
  for (const [name, offered] of [["TypeScript engine", await tsOffered(f)], ["SQL candidates", await sqlOffered(f)]] as const) {
    // POSITIVE CONTROL: the day offers something at all, so an empty result cannot pass the absence checks below.
    expect(offered.length, `${name}: the day must offer openings`).toBeGreaterThan(0);
    // 2. the first opening exactly one buffer after the visit is offered
    expect(iso(offered), `${name}: the opening exactly ${BUFFER} minutes after the visit ends must be offered`).toContain(new Date(firstOpen).toISOString());
    // 3. nothing inside the buffer gap (visit end .. end + buffer) is offered
    const inGap = offered.filter((t) => t >= f.endMs - DURATION * MIN + 1 && t < firstOpen);
    expect(iso(inGap), `${name}: no start inside the ${BUFFER}-minute gap or overlapping the visit may be offered`).toEqual([]);
  }
}

/** 4. BOOK through the public SQL command: the opening works, the gap does not. */
async function assertBookable(f: Fx) {
  const hash = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const gapClient = randomUUID();
  const openClient = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Gap client'),($3,$2,'Open client')`, [gapClient, f.studioId, openClient]);
  const inGap = new Date(f.endMs + 10 * MIN).toISOString();
  const refused = await adminQuery(`select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`, [f.studioId, gapClient, f.serviceId, inGap, hash()]).then(
    (r) => ({ ok: true as const, result: String(r.rows[0]?.result) }),
    (e) => ({ ok: false as const, result: String((e as { message?: string }).message ?? e) }),
  );
  expect(refused.ok && refused.result === "created", `a start inside the gap (${inGap}) must be refused, got ${JSON.stringify(refused)}`).toBe(false);
  const open = new Date(f.endMs + BUFFER * MIN).toISOString();
  const r = await adminQuery(`select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`, [f.studioId, openClient, f.serviceId, open, hash()]);
  expect(r.rows[0].result, `the opening exactly ${BUFFER} minutes after the visit (${open}) must be bookable`).toBe("created");
}

afterAll(async () => {
  await closePool();
});

describe("HON-114: a staff change leaves the openings after existing visits intact", () => {
  it("control: a fresh studio already offers the opening (the checks are not vacuous)", async () => {
    const f = await seed("fresh");
    await assertOpeningsIntact(f);
    await assertBookable(f);
  });

  it("adding a practitioner (refan on INSERT)", async () => {
    const f = await seed("add");
    await addPractitioner(f);
    await assertOpeningsIntact(f);
    await assertBookable(f);
  });

  it("removing a practitioner (refan on DELETE)", async () => {
    const f = await seed("delete");
    const other = await addPractitioner(f);
    await adminQuery(`delete from public.practitioners where id = $1`, [other]);
    await assertOpeningsIntact(f);
    await assertBookable(f);
  });

  it("deactivating a practitioner (active=false is not a refan caller: reservations stay as they were)", async () => {
    const f = await seed("deactivate", { secondPractitionerFirst: true });
    const before = iso(await reservationEndMs(f));
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.otherId]);
    // the update is not a refan caller: the reservation rows are exactly what they were
    expect(iso(await reservationEndMs(f))).toEqual(before);
    await assertOpeningsIntact(f);
    await assertBookable(f);
  });

  it("toggling per-practitioner capacity off and on (the capacity-flag trigger is a second caller)", async () => {
    const f = await seed("flag");
    await adminQuery(`update public.studios set practitioner_capacity_enabled = false where id = $1`, [f.studioId]);
    await adminQuery(`update public.studios set practitioner_capacity_enabled = true where id = $1`, [f.studioId]);
    await assertOpeningsIntact(f);
    await assertBookable(f);
  });

  it("the rematerialize body stores the appointment's ends_at, never blocked_ends_at (a source pin on the live function)", async () => {
    const r = await adminQuery(`select pg_get_functiondef('public.rematerialize_studio_reservations(uuid)'::regprocedure) as def`);
    const def = String(r.rows[0].def);
    expect(def).toContain("'appointment', a.id, a.starts_at, a.ends_at");
    expect(def).not.toMatch(/a\.starts_at,\s*a\.blocked_ends_at/);
  });
});
