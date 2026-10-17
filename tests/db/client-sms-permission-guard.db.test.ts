import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  adminTx,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0211 — G3: a studio member cannot manufacture a client's SMS consent or
// clear their STOP. BEHAVIOUR, against the real migrated database.
// ===========================================================================
//
// Members write through the REAL `authenticated` role with their JWT claims
// (`asUser`), which is exactly what a raw database API request runs: row-level
// security applies, and so does the trigger. Trusted paths write as
// `service_role` (the STOP route and public booking connect that way) or
// through the real SECURITY DEFINER booking command (0204).
//
// What must hold:
//   * a member never adds, changes or removes consent;
//   * a member never clears, re-times or re-sources an opt-out, and neither
//     does anyone else;
//   * recorded consent evidence is write-once, for everyone;
//   * a member CAN record a withdrawal: source practitioner, database clock;
//   * every governed writer, and every ordinary client edit, still works.
// ===========================================================================

type Sms = {
  sms_consent_at: string | null;
  sms_consent_source: string | null;
  sms_opted_out_at: string | null;
  sms_opt_out_source: string | null;
};

const NO_SMS: Sms = {
  sms_consent_at: null,
  sms_consent_source: null,
  sms_opted_out_at: null,
  sms_opt_out_source: null,
};
const CONSENTED_AT = "2026-09-01T10:00:00.000Z";
const STOPPED_AT = "2026-09-15T12:00:00.000Z";
const DENIED = { code: "42501" };
const IMMUTABLE = { code: "23514" };

let A: SeededStudio;
let B: SeededStudio;
let memberA: { userId: string; practitionerId: string };

beforeAll(async () => {
  A = await seedStudio("g3-a");
  B = await seedStudio("g3-b");
  memberA = await seedMember(A, "g3-a-member");
});

afterAll(async () => {
  await closePool();
});

/** A client in a given SMS state, written as the privileged test role: a trusted path. */
async function client(state: Partial<Sms> = {}, studio: SeededStudio = A): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.clients
       (id, studio_id, name, phone, sms_consent_at, sms_consent_source, sms_opted_out_at, sms_opt_out_source)
     values ($1, $2, 'G3 Client', '+14165550100', $3, $4, $5, $6)`,
    [
      id,
      studio.studioId,
      state.sms_consent_at ?? null,
      state.sms_consent_source ?? null,
      state.sms_opted_out_at ?? null,
      state.sms_opt_out_source ?? null,
    ],
  );
  return id;
}
const consenting = () => client({ sms_consent_at: CONSENTED_AT, sms_consent_source: "public_booking" });
const stopped = () =>
  client({
    sms_consent_at: CONSENTED_AT,
    sms_consent_source: "public_booking",
    sms_opted_out_at: STOPPED_AT,
    sms_opt_out_source: "twilio_stop",
  });

async function sms(id: string): Promise<Sms> {
  const r = await adminQuery(
    `select sms_consent_at, sms_consent_source, sms_opted_out_at, sms_opt_out_source
       from public.clients where id = $1`,
    [id],
  );
  const row = r.rows[0];
  const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null);
  return {
    sms_consent_at: iso(row.sms_consent_at),
    sms_consent_source: row.sms_consent_source,
    sms_opted_out_at: iso(row.sms_opted_out_at),
    sms_opt_out_source: row.sms_opt_out_source,
  };
}

/** A raw member write: the authenticated role with that user's JWT, as the database API runs it. */
const asMember = (userId: string, text: string, params: unknown[] = []) =>
  asUser(userId, (q) => q(text, params));
const OWNER = () => A.userId;
const PRACTITIONER = () => memberA.userId;

/** A trusted service_role write that persists: how the STOP route and public booking connect. */
const asService = (text: string, params: unknown[] = []) =>
  adminTx(async (q) => {
    await q("set local role service_role");
    return q(text, params);
  });

/** Seconds between a stored instant and the database clock now. */
async function secondsFromNow(iso: string | null): Promise<number> {
  const r = await adminQuery(`select extract(epoch from (now() - $1::timestamptz))::float8 as d`, [iso]);
  return Math.abs(r.rows[0].d);
}

// ---------------------------------------------------------------------------
// 1. A raw member write cannot manufacture consent
// ---------------------------------------------------------------------------
describe("a raw member write cannot manufacture consent", () => {
  for (const [who, user] of [
    ["the owner", OWNER],
    ["a practitioner", PRACTITIONER],
  ] as const) {
    it(`${who} cannot record consent on a client who never agreed`, async () => {
      const id = await client();
      await expect(
        asMember(
          user(),
          `update public.clients set sms_consent_at = now(), sms_consent_source = 'public_booking' where id = $1`,
          [id],
        ),
      ).rejects.toMatchObject(DENIED);
      expect(await sms(id)).toEqual(NO_SMS);
    });
  }

  it("whatever source it claims, and even naming the source alone", async () => {
    const id = await client();
    for (const set of [
      `sms_consent_at = now(), sms_consent_source = 'practitioner'`,
      `sms_consent_at = now(), sms_consent_source = 'import'`,
      `sms_consent_at = now()`,
      `sms_consent_source = 'public_booking'`,
    ]) {
      await expect(
        asMember(OWNER(), `update public.clients set ${set} where id = $1`, [id]),
        set,
      ).rejects.toMatchObject(DENIED);
    }
    expect(await sms(id)).toEqual(NO_SMS);
  });

  it("a member cannot create a client who arrives already consenting", async () => {
    for (const cols of [
      ["sms_consent_at, sms_consent_source", "now(), 'public_booking'"],
      ["sms_consent_source", "'practitioner'"],
    ]) {
      const id = randomUUID();
      await expect(
        asMember(
          OWNER(),
          `insert into public.clients (id, studio_id, name, ${cols[0]}) values ($1, $2, 'Forged', ${cols[1]})`,
          [id, A.studioId],
        ),
      ).rejects.toMatchObject(DENIED);
      const r = await adminQuery(`select count(*)::int as n from public.clients where id = $1`, [id]);
      expect(r.rows[0].n).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A raw member write cannot alter or erase consent evidence
// ---------------------------------------------------------------------------
describe("a raw member write cannot alter or erase consent evidence", () => {
  for (const [what, set] of [
    ["erase it", `sms_consent_at = null, sms_consent_source = null`],
    ["erase only the time", `sms_consent_at = null`],
    ["re-time it", `sms_consent_at = '2026-01-01T00:00:00Z'`],
    ["re-source it", `sms_consent_source = 'practitioner'`],
  ] as const) {
    it(`a member cannot ${what}`, async () => {
      const id = await consenting();
      const before = await sms(id);
      await expect(
        asMember(OWNER(), `update public.clients set ${set} where id = $1`, [id]),
      ).rejects.toMatchObject(DENIED);
      expect(await sms(id)).toEqual(before);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. A raw member write cannot clear suppression
// ---------------------------------------------------------------------------
describe("a raw member write cannot clear suppression", () => {
  for (const [what, set] of [
    ["clear the STOP", `sms_opted_out_at = null, sms_opt_out_source = null`],
    ["clear only its time", `sms_opted_out_at = null`],
    ["clear only its source", `sms_opt_out_source = null`],
    ["re-time it", `sms_opted_out_at = now()`],
    ["re-source it", `sms_opt_out_source = 'practitioner'`],
  ] as const) {
    it(`a member cannot ${what}`, async () => {
      const id = await stopped();
      const before = await sms(id);
      await expect(
        asMember(PRACTITIONER(), `update public.clients set ${set} where id = $1`, [id]),
      ).rejects.toMatchObject(IMMUTABLE);
      expect(await sms(id)).toEqual(before);
    });
  }

  it("a withdrawal a member recorded is just as terminal", async () => {
    const id = await consenting();
    await asMember(
      OWNER(),
      `update public.clients set sms_opted_out_at = now(), sms_opt_out_source = 'practitioner' where id = $1`,
      [id],
    );
    const recorded = await sms(id);
    await expect(
      asMember(OWNER(), `update public.clients set sms_opted_out_at = null, sms_opt_out_source = null where id = $1`, [id]),
    ).rejects.toMatchObject(IMMUTABLE);
    expect(await sms(id)).toEqual(recorded);
  });
});

// ---------------------------------------------------------------------------
// 4. Legitimate withdrawal stays open to members
// ---------------------------------------------------------------------------
describe("a member can still record a withdrawal", () => {
  for (const [who, user] of [
    ["the owner", OWNER],
    ["a practitioner", PRACTITIONER],
  ] as const) {
    it(`${who} records it: source practitioner, on the database clock, consent evidence kept`, async () => {
      const id = await consenting();
      await asMember(
        user(),
        // A backdated instant is replaced by the database clock.
        `update public.clients set sms_opted_out_at = '2020-01-01T00:00:00Z', sms_opt_out_source = 'practitioner' where id = $1`,
        [id],
      );
      const after = await sms(id);
      expect(after.sms_opt_out_source).toBe("practitioner");
      expect(after.sms_opted_out_at).not.toBe("2020-01-01T00:00:00.000Z");
      expect(await secondsFromNow(after.sms_opted_out_at)).toBeLessThan(60);
      // The history of what was agreed is untouched.
      expect(after.sms_consent_at).toBe(CONSENTED_AT);
      expect(after.sms_consent_source).toBe("public_booking");
    });
  }

  it("naming only the source is enough: the database stamps the time", async () => {
    const id = await client();
    await asMember(OWNER(), `update public.clients set sms_opt_out_source = 'practitioner' where id = $1`, [id]);
    const after = await sms(id);
    expect(after.sms_opt_out_source).toBe("practitioner");
    expect(await secondsFromNow(after.sms_opted_out_at)).toBeLessThan(60);
  });

  it("a member cannot claim a Twilio STOP, or leave the source out", async () => {
    const id = await client();
    for (const set of [
      `sms_opted_out_at = now(), sms_opt_out_source = 'twilio_stop'`,
      `sms_opted_out_at = now()`,
    ]) {
      await expect(
        asMember(OWNER(), `update public.clients set ${set} where id = $1`, [id]),
        set,
      ).rejects.toMatchObject(DENIED);
    }
    expect(await sms(id)).toEqual(NO_SMS);
  });

  it("a member can create a client already withdrawn, but only as the studio's record", async () => {
    const id = randomUUID();
    await asMember(
      OWNER(),
      `insert into public.clients (id, studio_id, name, sms_opted_out_at, sms_opt_out_source)
       values ($1, $2, 'Withdrawn at intake', '2020-01-01T00:00:00Z', 'practitioner')`,
      [id, A.studioId],
    );
    const after = await sms(id);
    expect(after.sms_opt_out_source).toBe("practitioner");
    expect(await secondsFromNow(after.sms_opted_out_at)).toBeLessThan(60);

    await expect(
      asMember(
        OWNER(),
        `insert into public.clients (id, studio_id, name, sms_opted_out_at, sms_opt_out_source)
         values ($1, $2, 'Forged STOP', now(), 'twilio_stop')`,
        [randomUUID(), A.studioId],
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it("after a withdrawal the client is no longer textable", async () => {
    const id = await consenting();
    await asMember(OWNER(), `update public.clients set sms_opt_out_source = 'practitioner' where id = $1`, [id]);
    // The senders' rule: consent recorded AND no opt-out (lib/sms/send-appointment.ts).
    const r = await adminQuery(
      `select (sms_consent_at is not null and sms_opted_out_at is null) as textable from public.clients where id = $1`,
      [id],
    );
    expect(r.rows[0].textable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Ordinary member edits are untouched
// ---------------------------------------------------------------------------
describe("ordinary member edits are untouched", () => {
  it("a member edits name and phone on a consenting, stopped client; SMS fields stay", async () => {
    const id = await stopped();
    const before = await sms(id);
    await asMember(
      PRACTITIONER(),
      `update public.clients set name = 'Renamed', phone = '+14165550199' where id = $1`,
      [id],
    );
    expect(await sms(id)).toEqual(before);
    const r = await adminQuery(`select name, phone from public.clients where id = $1`, [id]);
    expect(r.rows[0]).toEqual({ name: "Renamed", phone: "+14165550199" });
  });

  it("re-sending unchanged SMS values with an edit is accepted", async () => {
    const id = await stopped();
    const before = await sms(id);
    await asMember(
      OWNER(),
      `update public.clients
          set name = 'Same SMS', sms_consent_at = $2, sms_consent_source = $3,
              sms_opted_out_at = $4, sms_opt_out_source = $5
        where id = $1`,
      [id, before.sms_consent_at, before.sms_consent_source, before.sms_opted_out_at, before.sms_opt_out_source],
    );
    expect(await sms(id)).toEqual(before);
  });

  it("a member creates a client with no SMS fields, as the New client form does", async () => {
    const id = randomUUID();
    await asMember(
      OWNER(),
      `insert into public.clients (id, studio_id, name, phone) values ($1, $2, 'Walk-in', '+14165550142')`,
      [id, A.studioId],
    );
    expect(await sms(id)).toEqual(NO_SMS);
  });
});

// ---------------------------------------------------------------------------
// 6. Every governed path keeps working
// ---------------------------------------------------------------------------
describe("every governed path keeps working", () => {
  it("W3, the STOP route (service_role): stamps twilio_stop with its own instant", async () => {
    const id = await consenting();
    const r = await asService(
      `update public.clients set sms_opted_out_at = $2, sms_opt_out_source = 'twilio_stop'
        where id = $1 and sms_opted_out_at is null`,
      [id, STOPPED_AT],
    );
    expect(r.rowCount).toBe(1);
    expect(await sms(id)).toMatchObject({ sms_opted_out_at: STOPPED_AT, sms_opt_out_source: "twilio_stop" });
  });

  it("W3 retried on an already-stopped client is a no-op, not an error", async () => {
    const id = await stopped();
    const r = await asService(
      `update public.clients set sms_opted_out_at = now(), sms_opt_out_source = 'twilio_stop'
        where id = $1 and sms_opted_out_at is null`,
      [id],
    );
    expect(r.rowCount).toBe(0);
    expect((await sms(id)).sms_opted_out_at).toBe(STOPPED_AT);
  });

  it("W2, public booking for an existing client (service_role): records consent once", async () => {
    const id = await client();
    await asService(
      `update public.clients set sms_consent_at = now(), sms_consent_source = 'public_booking' where id = $1`,
      [id],
    );
    expect((await sms(id)).sms_consent_source).toBe("public_booking");
  });

  it("W1, the 0204 booking command for a new client (as service_role): records consent", async () => {
    const f = await bookableStudio();
    const r = await adminTx(async (q) => {
      await q("set local role service_role");
      return q(
        `select * from public.create_public_appointment_for_new_client(
           $1, null, 'Fresh Person', $2, '+15550177', now(), $3, $4::timestamptz, $5, false, null, null)`,
        [f.studioId, `g3-fresh-${f.studioId.slice(0, 8)}@harness.local`, f.serviceId, f.slot, hash64()],
      );
    });
    expect(r.rows[0].result).toBe("created");
    expect(r.rows[0].client_sms_consent_at).not.toBeNull();
    expect((await sms(r.rows[0].client_id)).sms_consent_source).toBe("public_booking");
  });

  it("trusted roles cannot rewrite recorded consent either: it is write-once", async () => {
    const id = await consenting();
    const before = await sms(id);
    for (const set of [
      `sms_consent_at = now()`,
      `sms_consent_source = 'practitioner'`,
      `sms_consent_at = null, sms_consent_source = null`,
    ]) {
      await expect(asService(`update public.clients set ${set} where id = $1`, [id]), set).rejects.toMatchObject(
        IMMUTABLE,
      );
    }
    expect(await sms(id)).toEqual(before);
  });

  it("trusted roles cannot clear an opt-out either: STOP wins", async () => {
    const id = await stopped();
    const before = await sms(id);
    await expect(
      asService(`update public.clients set sms_opted_out_at = null, sms_opt_out_source = null where id = $1`, [id]),
    ).rejects.toMatchObject(IMMUTABLE);
    expect(await sms(id)).toEqual(before);
  });

  it("privileged fixtures and operator inserts keep their existing shape rules", async () => {
    // tests/db/sms-stop-read-beyond-row-limit.db.test.ts inserts an opt-out with
    // no source; only the 0049 source CHECKs bind a privileged writer.
    const id = await client({ sms_opted_out_at: STOPPED_AT });
    expect(await sms(id)).toMatchObject({ sms_opted_out_at: STOPPED_AT, sms_opt_out_source: null });
  });
});

// ---------------------------------------------------------------------------
// 7. Tenancy and the trigger's own shape
// ---------------------------------------------------------------------------
describe("tenancy and the trigger's own shape", () => {
  it("a member of one studio still reaches no row of another (row-level security)", async () => {
    const id = await client({}, B);
    const r = await asMember(
      OWNER(),
      `update public.clients set sms_opted_out_at = now(), sms_opt_out_source = 'practitioner' where id = $1`,
      [id],
    );
    expect(r.rowCount).toBe(0);
    expect(await sms(id)).toEqual(NO_SMS);
  });

  it("no role can call the guard function directly", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const r = await asRole(role, (q) =>
        q(`select has_function_privilege($1, 'public.clients_sms_permission_guard()', 'execute') as ok`, [role]),
      );
      expect(r.rows[0].ok, role).toBe(false);
    }
  });

  it("fires before INSERT, and before an UPDATE of exactly the four SMS columns", async () => {
    const r = await adminQuery(
      `select t.event_manipulation as op, t.action_timing as timing
         from information_schema.triggers t
        where t.event_object_schema = 'public' and t.event_object_table = 'clients'
          and t.trigger_name = 'clients_sms_permission_guard'
        order by 1`,
    );
    expect(r.rows).toEqual([
      { op: "INSERT", timing: "BEFORE" },
      { op: "UPDATE", timing: "BEFORE" },
    ]);
    const cols = await adminQuery(
      `select event_object_column as col from information_schema.triggered_update_columns
        where trigger_schema = 'public' and trigger_name = 'clients_sms_permission_guard' order by 1`,
    );
    expect(cols.rows.map((c) => c.col)).toEqual([
      "sms_consent_at",
      "sms_consent_source",
      "sms_opt_out_source",
      "sms_opted_out_at",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The minimal studio the 0204 command can book: the shape of
// tests/db/new-client-admission-commit-authority.db.test.ts, stamped OPEN.
// ---------------------------------------------------------------------------
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

async function bookableStudio(): Promise<{ studioId: string; serviceId: string; slot: string }> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const serviceId = randomUUID();
  const email = `g3-book-${studioId.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios (id, name, owner_email, timezone, buffer_minutes, slug, public_booking_horizon_months)
     values ($1, 'G3 booking', $2, 'UTC', 0, $3, 3)`,
    [studioId, email, `g3-book-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, 'Owner', $4, 'owner', true)`,
    [randomUUID(), studioId, userId, email],
  );
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'Consultation', 60, true)`,
    [serviceId, studioId],
  );
  await adminQuery(
    `insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '09:00', '17:00', null from generate_series(0, 6) g`,
    [studioId],
  );
  await adminTx(async (q) => {
    await q("select set_config('hone.admission_mode_studio_id', $1, true)", [studioId]);
    await q(
      `update public.studios set new_client_admission_mode = 'open', new_client_admission_mode_set_at = now()
        where id = $1`,
      [studioId],
    );
  });
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 6);
  day.setUTCHours(11, 0, 0, 0);
  return { studioId, serviceId, slot: day.toISOString() };
}

// ---------------------------------------------------------------------------
// Follow-up (Codex P2 on #827): two overlapping public bookings for one
// unconsented client. The booking's stamp is now CONDITIONAL
// (lib/booking/public-consent-stamp.ts); this pins, against the real guard,
// why that is safe and why the old unconditional write was not.
// ---------------------------------------------------------------------------
describe("the public booking's conditional consent stamp under 0211", () => {
  const stampSql = `update public.clients
       set sms_consent_at = $2::timestamptz, sms_consent_source = 'public_booking'
     where id = $1 and sms_consent_at is null and sms_opted_out_at is null
     returning sms_consent_at`;

  it("the first conditional stamp writes; the overlapping second matches no row and raises nothing", async () => {
    const id = await client();
    const first = await asService(stampSql, [id, "2026-10-12T10:00:00.000Z"]);
    expect(first.rowCount).toBe(1);
    const second = await asService(stampSql, [id, "2026-10-12T10:00:00.400Z"]);
    expect(second.rowCount).toBe(0);
    expect((await sms(id)).sms_consent_at).toBe("2026-10-12T10:00:00.000Z");
  });

  it("WHY: the old unconditional second write is refused by the guard (23514), which the booking used to swallow", async () => {
    const id = await client();
    await asService(stampSql, [id, "2026-10-12T10:00:00.000Z"]);
    await expect(
      asService(
        `update public.clients set sms_consent_at = $2::timestamptz, sms_consent_source = 'public_booking' where id = $1`,
        [id, "2026-10-12T10:00:00.400Z"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a client who sent STOP is never stamped", async () => {
    const id = await client({ sms_opted_out_at: STOPPED_AT, sms_opt_out_source: "twilio_stop" });
    const r = await asService(stampSql, [id, "2026-10-12T10:00:00.000Z"]);
    expect(r.rowCount).toBe(0);
    expect((await sms(id)).sms_consent_at).toBeNull();
  });
});
