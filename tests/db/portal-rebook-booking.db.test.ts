import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";

// ===========================================================================
// EMERG-PORTAL-REBOOK-01 — the guarantees the portal action LEANS ON, proved
// against the real database rather than against a fake.
// ===========================================================================
//
// The action passes `session.studioId` and `session.clientId` to
// `create_public_appointment` and relies on the command to refuse everything
// it must refuse under the studio lock. Those refusals are the second half of
// the identity boundary: even if the TypeScript were wrong, the database has
// to say no. Nothing here mocks anything.
//
// WHY THE COMMAND AND NOT THE ACTION. The action's own pre-lock re-check runs
// BEFORE the studio lock and is therefore advisory by construction. What
// actually decides is this command, and what the unit suite cannot reach is
// the real availability contract: working hours, blockouts, buffers, the
// exclusion constraint, and exact membership of the re-derived public grid.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Fixture = {
  studioId: string;
  otherStudioId: string;
  clientId: string;
  archivedClientId: string;
  otherStudioClientId: string;
  serviceId: string;
  inactiveServiceId: string;
  otherStudioServiceId: string;
  /** An offered start: an open weekday at the studio's opening hour + 1h. */
  candidate: string;
  candidateDate: string;
};

/** A studio open 09:00-17:00 UTC every day, with one active 60-minute service. */
async function seedStudio(label: string, bufferMinutes = 0) {
  const studioId = randomUUID();
  const userId = randomUUID();
  const practitionerId = randomUUID();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;

  await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios
       (id,name,owner_email,timezone,buffer_minutes,slug,public_booking_horizon_months,
        default_appointment_duration_minutes)
     values ($1,$2,$3,'UTC',$4,$5,3,60)`,
    [studioId, `Rebook ${label}`, email, bufferMinutes, `rebook-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners
       (id,studio_id,user_id,display_name,email,role,active)
     values ($1,$2,$3,$4,$5,'owner',true)`,
    [practitionerId, studioId, userId, `Owner ${label}`, email],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time)
     select $1, d, true, '09:00', '17:00' from generate_series(0,6) d`,
    [studioId],
  );
  return { studioId, practitionerId };
}

async function seedService(
  studioId: string,
  name: string,
  active: boolean,
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.services
       (id,studio_id,name,modality,default_duration_minutes,price_cents,active)
     values ($1,$2,$3,'electrolysis',60,0,$4)`,
    [id, studioId, name, active],
  );
  return id;
}

async function seedClient(
  studioId: string,
  name: string,
  archived: boolean,
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.clients (id,studio_id,name,email,archived_at)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      studioId,
      name,
      `${name.replace(/\s+/g, "-").toLowerCase()}-${id.slice(0, 8)}@harness.local`,
      archived ? new Date().toISOString() : null,
    ],
  );
  return id;
}

/** `select * from create_public_appointment(...)`, one row. */
async function book(args: {
  studioId: string;
  clientId: string;
  serviceId: string;
  startsAt: string;
  notes?: string | null;
}) {
  const r = await adminQuery(
    `select * from public.create_public_appointment($1,$2,$3,$4,$5,$6,$7)`,
    [
      args.studioId,
      args.clientId,
      args.serviceId,
      args.startsAt,
      hash64(),
      args.notes ?? null,
      null,
    ],
  );
  return r.rows[0] as {
    result: string;
    appointment_id: string | null;
    starts_at: string | null;
    duration_minutes: number | null;
    practitioner_id: string | null;
  };
}

let fx: Fixture;

beforeAll(async () => {
  const a = await seedStudio("a");
  const b = await seedStudio("b");

  // Ten days out, at 10:00 UTC — an open day, and a start the public grid
  // offers (opening hour 09:00 plus one 60-minute step).
  const day = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const candidateDate = day.toISOString().slice(0, 10);
  const candidate = `${candidateDate}T10:00:00.000Z`;

  fx = {
    studioId: a.studioId,
    otherStudioId: b.studioId,
    clientId: await seedClient(a.studioId, "Returning Client", false),
    archivedClientId: await seedClient(a.studioId, "Archived Client", true),
    otherStudioClientId: await seedClient(b.studioId, "Other Studio Client", false),
    serviceId: await seedService(a.studioId, "Follow-up", true),
    inactiveServiceId: await seedService(a.studioId, "Retired", false),
    otherStudioServiceId: await seedService(b.studioId, "Other Service", true),
    candidate,
    candidateDate,
  };
});

afterAll(async () => {
  await closePool();
});

/** Keep each test's instant distinct so a booking never blocks its neighbour. */
function at(hour: number): string {
  return `${fx.candidateDate}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

describe("A + B. the appointment belongs to the exact client that was passed", () => {
  it("creates it, and the stored row carries that client and that studio", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.serviceId,
      startsAt: at(10),
      notes: "Portal rebooking note.",
    });
    expect(out.result).toBe("created");
    expect(out.appointment_id).not.toBeNull();

    const row = await adminQuery(
      `select studio_id, client_id, service_id, status, duration_minutes, notes
         from public.appointments where id = $1`,
      [out.appointment_id],
    );
    expect(row.rows[0]).toMatchObject({
      studio_id: fx.studioId,
      client_id: fx.clientId,
      service_id: fx.serviceId,
      duration_minutes: 60,
      notes: "Portal rebooking note.",
    });
  });

  it("writes the mandatory audit row in the same transaction", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.serviceId,
      startsAt: at(11),
    });
    expect(out.result).toBe("created");
    const audit = await adminQuery(
      `select action, actor_type from public.appointment_audit where appointment_id = $1`,
      [out.appointment_id],
    );
    expect(audit.rows.map((r) => r.action)).toContain("created");
  });

  it("derives duration from the service row, not from any caller value", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.serviceId,
      startsAt: at(12),
    });
    expect(out.duration_minutes).toBe(60);
  });
});

describe("D. cross-studio isolation is enforced by the database", () => {
  it("refuses a client that belongs to another studio", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.otherStudioClientId,
      serviceId: fx.serviceId,
      startsAt: at(13),
    });
    expect(out.result).toBe("invalid_client");
    expect(out.appointment_id).toBeNull();
  });

  it("refuses this studio's client against the OTHER studio", async () => {
    const out = await book({
      studioId: fx.otherStudioId,
      clientId: fx.clientId,
      serviceId: fx.otherStudioServiceId,
      startsAt: at(13),
    });
    expect(out.result).toBe("invalid_client");
  });

  it("refuses a service that belongs to another studio", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.otherStudioServiceId,
      startsAt: at(13),
    });
    expect(out.result).toBe("invalid_service");
  });

  it("NON-VACUITY: the same client and service DO book inside their own studio", async () => {
    const out = await book({
      studioId: fx.otherStudioId,
      clientId: fx.otherStudioClientId,
      serviceId: fx.otherStudioServiceId,
      startsAt: at(13),
    });
    expect(out.result).toBe("created");
  });

  it("no cross-studio attempt left a row behind", async () => {
    const rows = await adminQuery(
      `select count(*)::int as n from public.appointments
        where (studio_id = $1 and client_id = $2)
           or (studio_id = $2 and client_id = $1)`,
      [fx.studioId, fx.otherStudioId],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe("F + G. archived clients and inactive services are refused", () => {
  it("refuses an archived client with the SAME code a missing one gets", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.archivedClientId,
      serviceId: fx.serviceId,
      startsAt: at(14),
    });
    expect(out.result).toBe("invalid_client");
    const missing = await book({
      studioId: fx.studioId,
      clientId: randomUUID(),
      serviceId: fx.serviceId,
      startsAt: at(14),
    });
    expect(missing.result).toBe("invalid_client");
  });

  it("refuses an inactive service", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.inactiveServiceId,
      startsAt: at(14),
    });
    expect(out.result).toBe("invalid_service");
    expect(out.appointment_id).toBeNull();
  });
});

describe("H + I. the availability contract still holds", () => {
  it("refuses a start OUTSIDE the studio's working hours", async () => {
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.serviceId,
      startsAt: `${fx.candidateDate}T07:00:00.000Z`,
    });
    expect(out.result).not.toBe("created");
    expect(out.appointment_id).toBeNull();
  });

  it("refuses a start that is not ON the offered grid", async () => {
    // 10:17 sits inside working hours and collides with nothing, but the public
    // page would never offer it. Exact membership is the point.
    const out = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.serviceId,
      startsAt: `${fx.candidateDate}T10:17:00.000Z`,
    });
    expect(out.result).not.toBe("created");
  });

  it("refuses a second booking of a start the first one took", async () => {
    const first = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.serviceId,
      startsAt: at(15),
    });
    expect(first.result).toBe("created");
    const second = await book({
      studioId: fx.studioId,
      clientId: fx.clientId,
      serviceId: fx.serviceId,
      startsAt: at(15),
    });
    expect(second.result).not.toBe("created");
    expect(second.appointment_id).toBeNull();

    const n = await adminQuery(
      `select count(*)::int as n from public.appointments
        where studio_id = $1 and starts_at = $2 and status = 'confirmed'`,
      [fx.studioId, at(15)],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("refuses every start on a FULL-DAY blockout", async () => {
    const blocked = await seedStudio("blocked");
    const service = await seedService(blocked.studioId, "Blocked service", true);
    const client = await seedClient(blocked.studioId, "Blocked Client", false);
    const day = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // POSITIVE CONTROL FIRST: the instant books before the blockout exists, so
    // the refusal below is attributable to the blockout and not to the seed.
    const before = await book({
      studioId: blocked.studioId,
      clientId: client,
      serviceId: service,
      startsAt: `${day}T10:00:00.000Z`,
    });
    expect(before.result).toBe("created");
    await adminQuery(`delete from public.appointments where id = $1`, [
      before.appointment_id,
    ]);

    await adminQuery(
      `insert into public.studio_blockouts (id,studio_id,starts_on,ends_on,reason)
       values ($1,$2,$3,$3,'closed')`,
      [randomUUID(), blocked.studioId, day],
    );
    const after = await book({
      studioId: blocked.studioId,
      clientId: client,
      serviceId: service,
      startsAt: `${day}T10:00:00.000Z`,
    });
    expect(after.result).not.toBe("created");
    expect(after.appointment_id).toBeNull();
  });

  it("still honours the studio BUFFER around an existing appointment", async () => {
    const buffered = await seedStudio("buffered", 30);
    const service = await seedService(buffered.studioId, "Buffered service", true);
    const client = await seedClient(buffered.studioId, "Buffered Client", false);
    const day = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const first = await book({
      studioId: buffered.studioId,
      clientId: client,
      serviceId: service,
      startsAt: `${day}T10:00:00.000Z`,
    });
    expect(first.result).toBe("created");

    // 11:00 starts exactly when the 10:00-11:00 appointment ends, so it lands
    // inside the 30-minute buffer and must be refused.
    const inBuffer = await book({
      studioId: buffered.studioId,
      clientId: client,
      serviceId: service,
      startsAt: `${day}T11:00:00.000Z`,
    });
    expect(inBuffer.result).not.toBe("created");
    expect(inBuffer.appointment_id).toBeNull();

    // NON-VACUITY: a start clear of the buffer is still offered and accepted.
    const clear = await book({
      studioId: buffered.studioId,
      clientId: client,
      serviceId: service,
      startsAt: `${day}T11:30:00.000Z`,
    });
    expect(clear.result).toBe("created");
  });
});

describe("J. one press = one appointment, even for two simultaneous presses", () => {
  it("two concurrent commits for the same instant produce exactly ONE appointment", async () => {
    const studio = await seedStudio("race");
    const service = await seedService(studio.studioId, "Race service", true);
    const client = await seedClient(studio.studioId, "Race Client", false);
    const day = new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const instant = `${day}T10:00:00.000Z`;

    const a = new Client({ connectionString: resolveLocalDbUrl() });
    const b = new Client({ connectionString: resolveLocalDbUrl() });
    await a.connect();
    await b.connect();
    try {
      const call = (c: Client) =>
        c.query(
          `select result, appointment_id from public.create_public_appointment($1,$2,$3,$4,$5,null,null)`,
          [studio.studioId, client, service, instant, hash64()],
        );
      // Both dispatched before either is awaited: the command's own studio lock
      // is what serialises them, not the test.
      const [ra, rb] = await Promise.all([call(a), call(b)]);
      const results = [ra.rows[0].result, rb.rows[0].result];
      expect(
        results.filter((r) => r === "created"),
        `exactly one press may win; got ${JSON.stringify(results)}`,
      ).toHaveLength(1);
    } finally {
      await a.end();
      await b.end();
    }

    const n = await adminQuery(
      `select count(*)::int as n from public.appointments
        where studio_id = $1 and starts_at = $2 and status = 'confirmed'`,
      [studio.studioId, instant],
    );
    expect(n.rows[0].n).toBe(1);
  });
});

describe("the command takes no parameter that could widen this surface", () => {
  it("accepts exactly the seven the portal action sends", async () => {
    // `proargnames` holds INPUT names followed by the OUT columns of the
    // RETURNS TABLE, so it is sliced to `pronargs` — the input arity. Reading
    // the whole array would quietly assert the return shape as well and go red
    // for a reason that has nothing to do with the surface being pinned.
    const r = await adminQuery(
      `select p.proargnames[1:p.pronargs] as in_args
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_public_appointment'`,
    );
    expect(r.rows[0].in_args).toEqual([
      "p_studio_id",
      "p_client_id",
      "p_service_id",
      "p_starts_at",
      "p_cancellation_token_hash",
      "p_notes",
      "p_referral_source",
    ]);
  });
});
