import { afterAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  purgeAppointmentAudit,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// ===========================================================================
// #825 GAP G1 — the public intake path is PRACTITIONER-BLIND, end to end.
// ===========================================================================
//
// THIS SUITE PROVES A GAP, NOT A FEATURE. Most assertions below pin behaviour
// that is WRONG for a five-plus-practitioner studio. They exist so the gap is
// executable evidence rather than prose, and so the follow-up implementation
// has a red-to-green target it cannot satisfy by accident.
//
// The gap, verified at production 6c5eac80 before this file was written:
//
//   * `public_booking_slot_candidates(uuid, date, integer)` (0209:49) takes NO
//     practitioner. The offer grid cannot be asked "free for whom?".
//   * `create_public_appointment(studio, client, service, starts_at,
//     token_hash, notes, referral)` (0170:636) takes NO practitioner either. It
//     derives one from OWNER COUNT (0170:788):
//         select case when count(*) = 1 then (array_agg(id))[1] else null end
//     so exactly one active owner wins the appointment, and zero or two or more
//     active owners leave `practitioner_id` NULL.
//
// 0170 is NOT missing the machinery. Its internal helper at :394 already takes
// `p_practitioner_id uuid`, validates the practitioner is active (:437) and
// checks `service_practitioners` eligibility (:452). The public entry point
// simply cannot reach it. That is why this is a bounded surface change and not
// a capacity rebuild.
//
// THE CONTROL IS THE POINT. G1-C proves per-practitioner parallel capacity
// genuinely exists at the schema level. Without it, "public booking cannot
// place two people at once" would be indistinguishable from "the studio has no
// parallel capacity at all", and this suite would prove nothing.
//
// Release boundary: synthetic studios only, created and dropped here. No
// production read, no hosted write, no activation, no provider contact.

type Fixture = {
  studioId: string;
  serviceId: string;
  owners: string[];
  practitioners: string[];
  tz: string;
  duration: number;
};

const made: string[] = [];

/** A synthetic studio with `ownerCount` ACTIVE owners and `practitionerCount`
 *  additional active practitioners, studio-wide open all week, one service. */
async function seedStudio(opts: {
  ownerCount: number;
  practitionerCount: number;
  capacityOn?: boolean;
}): Promise<Fixture> {
  const studioId = randomUUID();
  const tz = "America/Los_Angeles";
  const duration = 60;
  await adminQuery(
    `insert into public.studios
       (id,name,owner_email,timezone,buffer_minutes,slug,public_booking_horizon_months,
        default_appointment_duration_minutes,practitioner_capacity_enabled)
     values ($1,$2,$3,$4,0,$5,6,$6,$7)`,
    [
      studioId,
      `G1 synth ${studioId.slice(0, 8)}`,
      `g1-${studioId.slice(0, 8)}@harness.local`,
      tz,
      `g1-${studioId.slice(0, 8)}`,
      duration,
      opts.capacityOn === true,
    ],
  );
  made.push(studioId);

  const mk = async (role: "owner" | "practitioner", n: number) => {
    const userId = randomUUID();
    const practitionerId = randomUUID();
    await adminQuery(
      `insert into auth.users (id,email) values ($1,$2) on conflict (id) do nothing`,
      [userId, `g1-${role}-${n}-${studioId.slice(0, 8)}@harness.local`],
    );
    await adminQuery(
      `insert into public.practitioners
         (id,studio_id,user_id,display_name,email,role,active)
       values ($1,$2,$3,$4,$5,$6,true)`,
      [
        practitionerId,
        studioId,
        userId,
        `G1 ${role} ${n}`,
        `g1-${role}-${n}-${studioId.slice(0, 8)}@harness.local`,
        role,
      ],
    );
    return practitionerId;
  };

  const owners: string[] = [];
  for (let i = 0; i < opts.ownerCount; i++) owners.push(await mk("owner", i));
  const practitioners: string[] = [];
  for (let i = 0; i < opts.practitionerCount; i++)
    practitioners.push(await mk("practitioner", i));

  const serviceId = (
    await adminQuery(
      `insert into public.services (id,studio_id,name,default_duration_minutes,active)
       values (gen_random_uuid(),$1,'G1 consult',$2,true) returning id`,
      [studioId, duration],
    )
  ).rows[0].id;

  // Studio-wide (practitioner_id NULL) window, open every weekday. The public
  // path reads ONLY these rows (0170:510 "STUDIO-WIDE ROWS ONLY").
  for (let dow = 0; dow <= 6; dow++) {
    await adminQuery(
      `insert into public.studio_availability_default
         (id,studio_id,practitioner_id,day_of_week,is_open,open_time,close_time)
       values (gen_random_uuid(),$1,null,$2,true,'09:00','17:00')`,
      [studioId, dow],
    );
  }

  return { studioId, serviceId, owners, practitioners, tz, duration };
}

async function seedClient(studioId: string): Promise<string> {
  return (
    await adminQuery(
      `insert into public.clients (id,studio_id,name,email)
       values (gen_random_uuid(),$1,'G1 client',$2) returning id`,
      [studioId, `g1c-${randomUUID().slice(0, 8)}@harness.local`],
    )
  ).rows[0].id;
}

/** A real offered instant from the SQL candidate grid, 10 days out. */
async function firstOffer(f: Fixture): Promise<string> {
  const d = (
    await adminQuery(
      `select ((now() at time zone $1)::date + 10)::date as d`,
      [f.tz],
    )
  ).rows[0].d;
  const r = await adminQuery(
    `select c as ts from public.public_booking_slot_candidates($1,$2::date,$3) c
      order by c limit 1`,
    [f.studioId, d, f.duration],
  );
  expect(r.rows.length, "the synthetic studio offered no public slots").toBe(1);
  return new Date(r.rows[0].ts).toISOString();
}

function tokenHash(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

async function bookPublic(f: Fixture, startsAt: string, clientId: string) {
  const r = await adminQuery(
    `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
    [f.studioId, clientId, f.serviceId, startsAt, tokenHash()],
  );
  return r.rows[0] as {
    result: string;
    appointment_id: string | null;
    practitioner_id: string | null;
  };
}

afterAll(async () => {
  for (const studioId of made) {
    // `appointment_audit` is append-only with an FK to studios, so the audit
    // rows must be purged through the harness (which drops the append-only
    // trigger for the duration) before the studio row will release.
    await purgeAppointmentAudit(studioId);
    await adminQuery(`delete from public.studios where id = $1`, [studioId]);
  }
  await closePool();
});

describe("G1 — the public surface cannot express a practitioner", () => {
  it("G1-R1: create_public_appointment accepts NO practitioner argument", async () => {
    const r = await adminQuery(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_public_appointment'`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      // It RETURNS practitioner_id but cannot be TOLD one. The argument list is
      // what a caller can influence, so that is what this asserts.
      expect(
        row.args,
        "the public command gained a practitioner argument — G1 may be fixed; re-read this suite",
      ).not.toMatch(/p_practitioner_id/);
    }
  });

  it("G1-R2: the SQL offer grid accepts NO practitioner argument either", async () => {
    const r = await adminQuery(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'public_booking_slot_candidates'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].args).not.toMatch(/practitioner/);
    // Pinned positively so a signature change is visible, not just absent.
    expect(r.rows[0].args.replace(/\s+/g, " ")).toBe(
      "p_studio_id uuid, p_local_date date, p_duration_minutes integer",
    );
  });
});

describe("G1 — assignment is derived from OWNER COUNT, not from who is free", () => {
  it("G1-R3: with exactly ONE active owner, the booking lands on that owner", async () => {
    const f = await seedStudio({ ownerCount: 1, practitionerCount: 4 });
    const startsAt = await firstOffer(f);
    const got = await bookPublic(f, startsAt, await seedClient(f.studioId));
    expect(got.result).toBe("created");
    // THE GAP: four other active practitioners are equally free and eligible,
    // and the client had no way to ask for any of them.
    expect(got.practitioner_id).toBe(f.owners[0]);
    expect(f.practitioners).not.toContain(got.practitioner_id);
  });

  it("G1-R4: with TWO active owners, the booking lands on NOBODY", async () => {
    const f = await seedStudio({ ownerCount: 2, practitionerCount: 4 });
    const startsAt = await firstOffer(f);
    const got = await bookPublic(f, startsAt, await seedClient(f.studioId));
    expect(got.result).toBe("created");
    // THE GAP, and the sharper half: a six-person studio takes a public booking
    // that is attributed to no practitioner at all. 0170:788's
    // `count(*) = 1 ... else null` is the whole of the assignment rule.
    expect(got.practitioner_id).toBeNull();
    const row = await adminQuery(
      `select practitioner_id from public.appointments where id = $1`,
      [got.appointment_id],
    );
    expect(row.rows[0].practitioner_id).toBeNull();
  });

  it("G1-R5: with ZERO active owners it also lands on nobody, and still succeeds", async () => {
    const f = await seedStudio({ ownerCount: 0, practitionerCount: 5 });
    const startsAt = await firstOffer(f);
    const got = await bookPublic(f, startsAt, await seedClient(f.studioId));
    expect(got.result).toBe("created");
    expect(got.practitioner_id).toBeNull();
  });
});

describe("G1 — the consequence, and the control that makes it meaningful", () => {
  it("G1-R6: two public bookings cannot occupy one instant, though five practitioners are free", async () => {
    const f = await seedStudio({
      ownerCount: 1,
      practitionerCount: 4,
      capacityOn: true,
    });
    const startsAt = await firstOffer(f);
    const first = await bookPublic(f, startsAt, await seedClient(f.studioId));
    expect(first.result).toBe("created");

    // Second public client wants the same instant. A five-plus studio has the
    // capacity; the public path has no practitioner to place them on, so the
    // instant has simply left the offer grid.
    const second = await bookPublic(
      f,
      startsAt,
      await seedClient(f.studioId),
    );
    expect(
      second.result,
      "the public path placed two bookings at one instant — G1 may be fixed; re-read this suite",
    ).not.toBe("created");
  });

  it("G1-C (CONTROL): the schema DOES support two practitioners at one instant", async () => {
    const f = await seedStudio({
      ownerCount: 1,
      practitionerCount: 4,
      capacityOn: true,
    });
    const startsAt = await firstOffer(f);
    const endsAt = new Date(
      new Date(startsAt).getTime() + f.duration * 60_000,
    ).toISOString();
    const clientA = await seedClient(f.studioId);
    const clientB = await seedClient(f.studioId);

    // Same instant, two DIFFERENT practitioners, capacity ON: both rows land.
    // This is the capacity G1-R6 proves the public surface cannot reach.
    for (const [i, practitionerId] of [
      f.owners[0],
      f.practitioners[0],
    ].entries()) {
      await adminQuery(
        `insert into public.appointments
           (id,studio_id,client_id,practitioner_id,starts_at,ends_at,
            duration_minutes,status)
         values (gen_random_uuid(),$1,$2,$3,$4::timestamptz,$5::timestamptz,
                 $6,'confirmed')`,
        [
          f.studioId,
          i === 0 ? clientA : clientB,
          practitionerId,
          startsAt,
          endsAt,
          f.duration,
        ],
      );
    }
    const n = await adminQuery(
      `select count(*)::int as n from public.appointments
        where studio_id = $1 and starts_at = $2::timestamptz`,
      [f.studioId, startsAt],
    );
    expect(
      n.rows[0].n,
      "per-practitioner parallel capacity did NOT work, so G1-R6 proves nothing",
    ).toBe(2);
  });
});
