import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedHistoricalAppointmentAudit,
} from "./helpers/harness";

// ===========================================================================
// APPOINTMENT BOUNDARY B5, migration 0174 behavioural proof, fresh chain.
// ===========================================================================
//
// 0174 does four things, and this suite proves each of them against the REAL
// migrated database rather than against the migration's text (that is
// tests/migrations/0174-appointment-attribution-audit-integrity.test.ts):
//
//   1. ATTRIBUTION   who created / cancelled / authorised an override is on the
//                    appointment row, same-studio-constrained, and NEVER
//                    invented for a client actor.
//   2. DURABILITY    an audit row outlives its appointment and stays
//                    tenant-authorizable.
//   3. INTEGRITY     audit rows are append-only and their created_at is the
//                    database's, not the caller's.
//   4. AUTHORITY     raw service_role lifecycle DML is denied; the governed
//                    command is the only path.
//
// THE TRAPS THIS SUITE IS BUILT AROUND, inherited from the B2/B3 suites:
//
//   * `asRole()` ALWAYS ROLLS BACK (helpers/harness.ts). Any state a probe
//     needs to observe must be observed INSIDE the callback. A count taken
//     after `asRole` returns measures the pre-command world and proves nothing.
//   * A ZERO-ROW WRITE LOOKS LIKE SUCCESS. Refusal probes use predicates that
//     match a REAL row, so a retained privilege shows up as a passing statement
//     rather than as a silent rowCount 0.
//   * `42501` DOES NOT MEAN "PRIVILEGE". An RLS WITH CHECK violation raises it
//     too. Privilege refusals assert the MESSAGE and reject /row-level
//     security/i.
//   * EVERY refusal is paired with a POSITIVE CONTROL. A suite that only
//     asserts rejection passes equally well against a table that does not
//     exist.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

function at(days: number, hh: number, mm = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

type Fixture = {
  studioId: string;
  ownerUserId: string;
  ownerId: string;
  memberUserId: string;
  memberId: string;
  clientId: string;
  serviceId: string;
};

// One self-contained studio per test: every fixture otherwise shares the
// studio-wide GiST exclusion and an unrelated earlier booking becomes the
// reason a later one fails.
async function seedFixture(label: string): Promise<Fixture> {
  const studioId = randomUUID();
  const ownerUserId = randomUUID();
  const ownerId = randomUUID();
  const memberUserId = randomUUID();
  const memberId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const tag = `b5-${label}-${studioId.slice(0, 8)}`;
  const ownerEmail = `${tag}-owner@harness.local`;
  const memberEmail = `${tag}-member@harness.local`;

  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
    ownerUserId,
    ownerEmail,
  ]);
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
    memberUserId,
    memberEmail,
  ]);
  await adminQuery(
    `insert into public.studios
       (id, name, owner_email, timezone, buffer_minutes, slug, public_booking_horizon_months)
     values ($1,$2,$3,'UTC',0,$4,3)`,
    [studioId, `B5 ${label}`, ownerEmail, tag],
  );
  // Exactly ONE active owner: create_public_appointment derives the
  // practitioner from that row and would derive NULL with two.
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,$4,$5,'owner',true)`,
    [ownerId, studioId, ownerUserId, `Owner ${label}`, ownerEmail],
  );
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,$4,$5,'practitioner',true)`,
    [memberId, studioId, memberUserId, `Member ${label}`, memberEmail],
  );
  await adminQuery(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [clientId, studioId, `Client ${label}`, `${tag}-client@harness.local`],
  );
  await adminQuery(
    `insert into public.services
       (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Consultation',60,0,true)`,
    [serviceId, studioId],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '00:00', '23:59', null from generate_series(0,6) g`,
    [studioId],
  );

  return { studioId, ownerUserId, ownerId, memberUserId, memberId, clientId, serviceId };
}

async function mkAppt(
  f: Fixture,
  opts: { startsAt: string; status?: string; tokenHash?: string },
): Promise<{ id: string; tokenHash: string }> {
  const tokenHash = opts.tokenHash ?? hash64();
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz,
             $5::timestamptz + interval '60 minutes', 60, $6, $7)
     returning id`,
    [f.studioId, f.ownerId, f.clientId, f.serviceId, opts.startsAt, opts.status ?? "confirmed", tokenHash],
  );
  return { id: r.rows[0].id as string, tokenHash };
}

async function apptRow(id: string): Promise<Record<string, unknown>> {
  const r = await adminQuery(
    `select * from public.appointments where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function auditRows(apptId: string): Promise<Record<string, unknown>[]> {
  const r = await adminQuery(
    `select * from public.appointment_audit where appointment_id = $1 order by created_at`,
    [apptId],
  );
  return r.rows;
}

/** Book through the internal command. Returns the new appointment id. */
async function internalCreate(
  f: Fixture,
  opts: { startsAt: string; actorId?: string; outsideHours?: boolean } = {
    startsAt: at(30, 10),
  },
): Promise<{ result: string; id: string | null }> {
  const r = await adminQuery(
    `select * from public.create_internal_appointment_v2(
       $1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,$8)`,
    [
      f.studioId,
      opts.actorId ?? f.ownerId,
      f.ownerId,
      f.clientId,
      f.serviceId,
      opts.startsAt,
      hash64(),
      opts.outsideHours ?? false,
    ],
  );
  return {
    result: r.rows[0].result as string,
    id: (r.rows[0].appointment_id as string | null) ?? null,
  };
}

afterAll(async () => {
  await closePool();
});

// ===========================================================================
// 1. ATTRIBUTION
// ===========================================================================

describe("B5 attribution: created_by_practitioner_id", () => {
  it("an INTERNAL booking records the server-resolved ACTOR as creator", async () => {
    const f = await seedFixture("create-internal");
    const { result, id } = await internalCreate(f, { startsAt: at(30, 10) });
    expect(result).toBe("created");

    const row = await apptRow(id!);
    expect(row.created_by_practitioner_id).toBe(f.ownerId);
    // The creator is the ACTOR, and this fixture books FOR the owner, so the
    // next test proves actor != target rather than relying on this one.
    expect(row.cancelled_by_practitioner_id).toBeNull();
  });

  it("the creator is the ACTOR, not the appointment's assigned practitioner", async () => {
    // The single most dangerous available shortcut is inferring the creator
    // from appointments.practitioner_id. An owner booking INTO a colleague's
    // column is where those two values diverge.
    const f = await seedFixture("create-actor-not-target");
    const r = await adminQuery(
      `select * from public.create_internal_appointment_v2(
         $1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
      [f.studioId, f.ownerId, f.memberId, f.clientId, f.serviceId, at(31, 10), hash64()],
    );
    expect(r.rows[0].result).toBe("created");

    const row = await apptRow(r.rows[0].appointment_id as string);
    expect(row.practitioner_id, "assigned to the MEMBER").toBe(f.memberId);
    expect(row.created_by_practitioner_id, "created by the OWNER").toBe(f.ownerId);
  });

  it("a PUBLIC booking leaves the practitioner creator NULL, no manufactured actor", async () => {
    const f = await seedFixture("create-public");
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, at(32, 10), hash64()],
    );
    expect(r.rows[0].result).toBe("created");
    const id = r.rows[0].appointment_id as string;

    const row = await apptRow(id);
    expect(
      row.created_by_practitioner_id,
      "a public actor must NEVER be given a practitioner identity",
    ).toBeNull();

    // POSITIVE CONTROL: the appointment really was created and the fact IS
    // recorded, as actor_type 'client'. NULL here is a truthful record, not a
    // dropped write.
    const audit = await auditRows(id);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_type).toBe("client");
    expect(audit[0].actor_id).toBeNull();
    expect(audit[0].actor_practitioner_id).toBeNull();
    // And the row is genuinely assigned to the derived practitioner, proving
    // the NULL above is not simply "nothing was written anywhere".
    expect(row.practitioner_id).toBe(f.ownerId);
  });
});

// RETIRED (B6 / 0175). This block proved that the two LEGACY appointment RPCs,
// create_internal_appointment and practitioner_move_appointment, also wrote
// correct B5 attribution, precisely because B5 could not retire them and a
// still-installed legacy writer could otherwise emit a malformed row. Its own
// comment named B6 as the owner of that retirement.
//
// B6 dropped both by exact signature after a zero-caller census, so there is no
// legacy writer left to inherit anything. The attribution property itself is
// unaffected and remains proven against the governed successors elsewhere in
// this same file, and the drops are pinned by
// tests/migrations/0175-appointment-transition-integrity.test.ts plus the
// pg_proc absence check in tests/db/appointment-transition-integrity.db.test.ts.

describe("B5 attribution: cancelled_by_practitioner_id", () => {
  it("a PRACTITIONER cancellation records WHICH practitioner, and keeps the role word", async () => {
    const f = await seedFixture("cancel-prac");
    const appt = await mkAppt(f, { startsAt: at(33, 10) });

    const r = await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4) result`,
      [appt.id, f.studioId, f.ownerId, "clinic closed"],
    );
    expect(r.rows[0].result).toBe("cancelled");

    const row = await apptRow(appt.id);
    expect(row.cancelled_by_practitioner_id).toBe(f.ownerId);
    // The role word is COMPLEMENTED, never replaced, it is what distinguishes
    // client- from practitioner-initiated and it is server-derived.
    expect(row.cancelled_by).toBe("owner");
    expect(row.status).toBe("cancelled");
  });

  it("a CLIENT-TOKEN cancellation leaves the practitioner canceller NULL", async () => {
    const f = await seedFixture("cancel-token");
    const appt = await mkAppt(f, { startsAt: at(34, 10) });

    const r = await adminQuery(
      `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [appt.tokenHash, "schedule_conflict", "Schedule conflict", "sorry", true],
    );
    expect(r.rows[0].result).toBe("cancelled");

    const row = await apptRow(appt.id);
    expect(row.status, "POSITIVE CONTROL: it really was cancelled").toBe("cancelled");
    expect(
      row.cancelled_by_practitioner_id,
      "the real actor is the CLIENT, do not fake a practitioner",
    ).toBeNull();
  });

  it("a PUBLIC RESCHEDULE follows the REAL actor: client on both legs", async () => {
    // The predecessor is cancelled and a successor created, both by the client
    // holding the token. B5 must not invent a practitioner for either leg
    // merely because the successor lands in a practitioner's column.
    const f = await seedFixture("reschedule");
    const appt = await mkAppt(f, { startsAt: at(35, 10) });
    const newHash = hash64();

    const r = await adminQuery(
      `select * from public.reschedule_appointment_v2($1,$2,$3::timestamptz,$4,true,null)`,
      [appt.id, appt.tokenHash, at(36, 10), newHash],
    );
    expect(r.rows[0].result, "POSITIVE CONTROL: the reschedule really happened").toBe(
      "success",
    );

    const predecessor = await apptRow(appt.id);
    expect(predecessor.status).toBe("cancelled");
    expect(predecessor.cancelled_by).toBe("client");
    expect(
      predecessor.cancelled_by_practitioner_id,
      "predecessor cancelled BY THE CLIENT",
    ).toBeNull();

    const successorId = r.rows[0].new_appointment_id as string;
    const successor = await apptRow(successorId);
    expect(successor.practitioner_id, "successor IS assigned to a practitioner").toBe(
      f.ownerId,
    );
    expect(
      successor.created_by_practitioner_id,
      "...but it was CREATED by the client, so the creator stays NULL",
    ).toBeNull();
  });
});

describe("B5 attribution: the outside-hours override actor (PR #520 D3)", () => {
  it("an owner override records the authoriser, the role AT THE TIME, and when", async () => {
    const f = await seedFixture("override-set");
    // 03:00 is inside this fixture's 00:00-23:59 availability, so the override
    // flag is exercised on its own terms rather than needing a closed day: the
    // command writes the attribution whenever the caller ASKS for the override.
    const { result, id } = await internalCreate(f, {
      startsAt: at(37, 3),
      outsideHours: true,
    });
    expect(result).toBe("created");

    const row = await apptRow(id!);
    expect(row.booked_outside_availability).toBe(true);
    expect(row.outside_availability_authorized_by_practitioner_id).toBe(f.ownerId);
    expect(row.outside_availability_authorized_role).toBe("owner");
    expect(row.outside_availability_authorized_at).toBeInstanceOf(Date);
  });

  it("a NON-override booking carries no override attribution at all", async () => {
    const f = await seedFixture("override-unset");
    const { id } = await internalCreate(f, { startsAt: at(38, 10) });
    const row = await apptRow(id!);
    expect(row.booked_outside_availability).toBe(false);
    expect(row.outside_availability_authorized_by_practitioner_id).toBeNull();
    expect(row.outside_availability_authorized_role).toBeNull();
    expect(row.outside_availability_authorized_at).toBeNull();
  });

  it("a MOVE that no longer needs the override CLEARS the stale authoriser", async () => {
    // PR #520 A-P2-01, stated exactly: "a later move preserves it silently".
    const f = await seedFixture("override-cleared");
    const { id } = await internalCreate(f, { startsAt: at(39, 3), outsideHours: true });
    const before = await apptRow(id!);
    expect(before.outside_availability_authorized_by_practitioner_id).toBe(f.ownerId);

    const r = await adminQuery(
      `select * from public.move_or_reassign_appointment(
         $1,$2,$3,null,$4::timestamptz,$5::timestamptz,$6::timestamptz,false)`,
      [id, f.studioId, f.ownerId, before.starts_at, before.ends_at, at(40, 11)],
    );
    expect(r.rows[0].result).toBe("moved");

    const after = await apptRow(id!);
    expect(after.booked_outside_availability).toBe(false);
    expect(
      after.outside_availability_authorized_by_practitioner_id,
      "a cleared flag must not keep its authoriser",
    ).toBeNull();
    expect(after.outside_availability_authorized_role).toBeNull();
    expect(after.outside_availability_authorized_at).toBeNull();
  });

  it("the coherence CHECK refuses override attribution on a non-override row", async () => {
    const f = await seedFixture("override-ck");
    const appt = await mkAppt(f, { startsAt: at(41, 10) });
    await expect(
      adminQuery(
        `update public.appointments
            set outside_availability_authorized_by_practitioner_id = $2,
                outside_availability_authorized_role = 'owner',
                outside_availability_authorized_at = now()
          where id = $1`,
        [appt.id, f.ownerId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "appointments_outside_availability_attribution_ck",
    });
  });
});

describe("B5 attribution: the same-studio FKs", () => {
  it("ACCEPTS a same-studio practitioner in every attribution column", async () => {
    // The positive control for the three rejections below. Without it they
    // would pass on a schema where the columns simply did not accept anything.
    const f = await seedFixture("fk-same-studio");
    const appt = await mkAppt(f, { startsAt: at(42, 10) });
    await expect(
      adminQuery(
        `update public.appointments
            set created_by_practitioner_id = $2, cancelled_by_practitioner_id = $3
          where id = $1`,
        [appt.id, f.ownerId, f.memberId],
      ),
    ).resolves.toBeDefined();

    const row = await apptRow(appt.id);
    expect(row.created_by_practitioner_id).toBe(f.ownerId);
    expect(row.cancelled_by_practitioner_id).toBe(f.memberId);
  });

  for (const col of [
    "created_by_practitioner_id",
    "cancelled_by_practitioner_id",
    "outside_availability_authorized_by_practitioner_id",
  ]) {
    it(`REJECTS a cross-studio practitioner in ${col}`, async () => {
      const a = await seedFixture(`fk-x-${col.slice(0, 6)}-a`);
      const b = await seedFixture(`fk-x-${col.slice(0, 6)}-b`);
      const appt = await mkAppt(a, { startsAt: at(43, 10) });

      // Studio B's practitioner is a perfectly real practitioner, it is the
      // TENANT pairing the composite FK refuses, which is exactly the identity
      // corruption the composite shape exists to prevent.
      //
      // The override column additionally has to satisfy its coherence CHECK
      // before the FK can be the thing that fires; otherwise the test would
      // pass on 23514 and prove nothing about tenancy.
      const extra =
        col === "outside_availability_authorized_by_practitioner_id"
          ? `, booked_outside_availability = true,
             outside_availability_authorized_role = 'owner',
             outside_availability_authorized_at = now()`
          : "";
      await expect(
        adminQuery(
          `update public.appointments set ${col} = $2${extra} where id = $1`,
          [appt.id, b.ownerId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  }

  it("a practitioner who CREATED an appointment cannot be deleted (RESTRICT)", async () => {
    const f = await seedFixture("fk-restrict");
    const { id } = await internalCreate(f, { startsAt: at(44, 10) });
    expect((await apptRow(id!)).created_by_practitioner_id).toBe(f.ownerId);

    await expect(
      adminQuery(`delete from public.practitioners where id = $1`, [f.ownerId]),
    ).rejects.toMatchObject({ code: "23503" });

    // POSITIVE CONTROL: an UNINVOLVED practitioner in the same studio deletes
    // fine, so the refusal above is the attribution FK and not a blanket ban.
    await expect(
      adminQuery(`delete from public.practitioners where id = $1`, [f.memberId]),
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// 2. AUDIT ACTOR MODEL
// ===========================================================================

describe("B5 audit actor: derived, validated, never invented", () => {
  it("a practitioner audit row carries a valid actor_practitioner_id", async () => {
    const f = await seedFixture("actor-prac");
    const { id } = await internalCreate(f, { startsAt: at(45, 10) });
    const rows = await auditRows(id!);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("practitioner");
    expect(rows[0].actor_id).toBe(f.ownerId);
    expect(rows[0].actor_practitioner_id).toBe(f.ownerId);
    expect(rows[0].studio_id).toBe(f.studioId);
  });

  it("a CLIENT actor never acquires a practitioner correlation", async () => {
    const f = await seedFixture("actor-client");
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, at(46, 10), hash64()],
    );
    const rows = await auditRows(r.rows[0].appointment_id as string);
    expect(rows[0].actor_type).toBe("client");
    expect(rows[0].actor_practitioner_id).toBeNull();
  });

  it("a CROSS-STUDIO actor_id is dropped to NULL, not written and not raised", async () => {
    // The derive trigger validates against the DERIVED studio and falls back to
    // NULL. That is deliberately softer than letting the FK raise: a malformed
    // actor must not be able to abort a legitimate business transaction, and a
    // NULL correlation is a truthful "unknown".
    const a = await seedFixture("actor-x-a");
    const b = await seedFixture("actor-x-b");
    const appt = await mkAppt(a, { startsAt: at(47, 10) });

    await adminQuery(
      `insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
       values ($1,'practitioner',$2,'created','{}'::jsonb)`,
      [appt.id, b.ownerId],
    );

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id, "the historical bare actor_id is preserved as written").toBe(
      b.ownerId,
    );
    expect(
      rows[0].actor_practitioner_id,
      "but the durable correlation refuses a foreign tenant",
    ).toBeNull();
    expect(rows[0].studio_id, "and the tenant is the APPOINTMENT's, not the actor's").toBe(
      a.studioId,
    );
  });

  it("a caller-supplied actor_practitioner_id is OVERWRITTEN, not trusted", async () => {
    const f = await seedFixture("actor-forge");
    const appt = await mkAppt(f, { startsAt: at(48, 10) });

    await adminQuery(
      `insert into public.appointment_audit
         (appointment_id, actor_type, actor_id, actor_practitioner_id, action, details)
       values ($1,'client',null,$2,'cancelled','{}'::jsonb)`,
      [appt.id, f.ownerId],
    );

    const rows = await auditRows(appt.id);
    expect(
      rows[0].actor_practitioner_id,
      "a client row may not carry a practitioner, however hard the caller tries",
    ).toBeNull();
  });

  it("the actor-type correlation constraint refuses a practitioner id on a system row", async () => {
    const f = await seedFixture("actor-ck");
    const appt = await mkAppt(f, { startsAt: at(49, 10) });
    // Written with the derive trigger disabled would be the only way in; here
    // we prove the CONSTRAINT itself exists and bites, independently of the
    // trigger, so removing the trigger cannot silently open this.
    await expect(
      adminQuery(
        `insert into public.appointment_audit
           (appointment_id, studio_id, actor_type, actor_id, action)
         values ($1,$2,'system',$3,'created')`,
        [appt.id, f.studioId, f.ownerId],
      ),
    ).rejects.toMatchObject({ constraint: "appointment_audit_actor_id_type_ck" });
  });
});

// ===========================================================================
// 3. TENANT DURABILITY + PARENT DELETE
// ===========================================================================

describe("B5 durability: an audit row outlives its appointment", () => {
  // ---------------------------------------------------------------------
  // THESE TWO TESTS ARE DELIBERATELY SPLIT, and the split is the point.
  //
  // Three different defects all break "parent delete", and a single combined
  // test reports the SAME failing name for two of them, which makes the
  // report useless for telling them apart:
  //
  //   A. the FK is CASCADE again      -> the delete SUCCEEDS, the audit row is
  //                                      ERASED.        => (1) green, (2) RED
  //   B. append-only removed          -> unrelated here; caught uniquely by
  //                                      "even the table OWNER cannot UPDATE".
  //   C. append-only too BROAD        -> the RI update is refused, so the
  //                                      delete itself FAILS. => (1) RED
  //
  // So: (1) RED means C. (1) green + (2) RED means A. The pair discriminates.
  // ---------------------------------------------------------------------

  it("(0) the parent FK is ON DELETE SET NULL, never CASCADE", async () => {
    // The discriminator between failure modes A and C, which are otherwise
    // indistinguishable from the report: BOTH make the parent delete fail.
    //
    // Under a restored CASCADE the delete does NOT quietly erase the audit row,
    // the append-only DELETE arm refuses the cascade and the whole statement
    // raises. That is the "sequencing is load-bearing" hazard from PR #521
    // showing up as a hard failure, which is the safe direction, but it means
    // (1) and (2) alone cannot say WHICH defect is present. This test can: it
    // is RED under A and GREEN under C.
    const r = await adminQuery(
      `select confdeltype from pg_constraint
        where conrelid = 'public.appointment_audit'::regclass
          and conname = 'appointment_audit_appointment_id_fkey'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].confdeltype, "n = SET NULL; c = CASCADE").toBe("n");
  });

  it("(1) the parent DELETE is PERMITTED, the append-only guard does not block the FK detach", async () => {
    // Isolates failure mode C. PostgreSQL referential actions do NOT bypass
    // user triggers: ON DELETE SET NULL is implemented as an ordinary UPDATE
    // against appointment_audit, and a naive "reject every UPDATE" guard makes
    // every appointment delete in the tree fail.
    const f = await seedFixture("parent-delete-permitted");
    const { id } = await internalCreate(f, { startsAt: at(50, 10) });
    expect((await auditRows(id!)).length, "there is an audit row to detach").toBe(1);

    await expect(
      adminQuery(`delete from public.appointments where id = $1`, [id]),
      "the delete must not be blocked by the append-only guard",
    ).resolves.toBeDefined();

    expect(
      (await adminQuery(`select 1 from public.appointments where id = $1`, [id])).rowCount,
      "the appointment really is gone",
    ).toBe(0);
  });

  it("(2) the audit row SURVIVES that delete, fully intact but detached", async () => {
    // Isolates failure mode A. Under a restored CASCADE the delete above still
    // succeeds, so only this test goes red.
    const f = await seedFixture("parent-delete-survives");
    const { id } = await internalCreate(f, { startsAt: at(50, 12) });
    const before = (await auditRows(id!))[0];
    expect(before).toBeDefined();

    await adminQuery(`delete from public.appointments where id = $1`, [id]);

    const after = await adminQuery(
      `select * from public.appointment_audit where id = $1`,
      [before.id],
    );
    expect(after.rowCount, "the audit row SURVIVED its parent").toBe(1);
    const row = after.rows[0];
    expect(row.appointment_id, "detached").toBeNull();
    expect(row.studio_id, "tenant retained").toBe(f.studioId);
    expect(row.action).toBe(before.action);
    expect(JSON.stringify(row.details)).toBe(JSON.stringify(before.details));
    expect(row.actor_type).toBe(before.actor_type);
    expect(row.actor_practitioner_id).toBe(before.actor_practitioner_id);
    expect(new Date(row.created_at as string).getTime()).toBe(
      new Date(before.created_at as string).getTime(),
    );
  });

  it("the studio FK is RESTRICT, a tenant with history cannot be silently erased", async () => {
    const f = await seedFixture("studio-restrict");
    await internalCreate(f, { startsAt: at(51, 10) });
    await expect(
      adminQuery(`delete from public.studios where id = $1`, [f.studioId]),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "appointment_audit_studio_fk",
    });
  });
});

describe("B5 durability: RLS reads through studio_id, including orphans", () => {
  it("own-studio audit is visible to a member; foreign-studio audit is not, live AND orphaned", async () => {
    const a = await seedFixture("rls-a");
    const b = await seedFixture("rls-b");

    const liveA = await internalCreate(a, { startsAt: at(52, 10) });
    const orphanA = await internalCreate(a, { startsAt: at(53, 10) });
    const liveB = await internalCreate(b, { startsAt: at(52, 12) });
    const orphanB = await internalCreate(b, { startsAt: at(53, 12) });

    const idOf = async (apptId: string) => (await auditRows(apptId))[0].id as string;
    const liveAAudit = await idOf(liveA.id!);
    const orphanAAudit = await idOf(orphanA.id!);
    const liveBAudit = await idOf(liveB.id!);
    const orphanBAudit = await idOf(orphanB.id!);

    // Orphan two of them by deleting their parents.
    await adminQuery(`delete from public.appointments where id = $1`, [orphanA.id]);
    await adminQuery(`delete from public.appointments where id = $1`, [orphanB.id]);

    const seen = await asUser(a.ownerUserId, async (q) => {
      const r = await q(
        `select id from public.appointment_audit where id = any($1::uuid[])`,
        [[liveAAudit, orphanAAudit, liveBAudit, orphanBAudit]],
      );
      return new Set(r.rows.map((x: Record<string, unknown>) => x.id as string));
    });

    expect(seen.has(liveAAudit), "own-studio LIVE audit must be visible").toBe(true);
    expect(
      seen.has(orphanAAudit),
      "own-studio ORPHANED audit must remain visible, the whole point of 0174",
    ).toBe(true);
    expect(seen.has(liveBAudit), "other-studio LIVE audit must be hidden").toBe(false);
    expect(
      seen.has(orphanBAudit),
      "other-studio ORPHANED audit must stay hidden",
    ).toBe(false);
  });
});

// ===========================================================================
// 4. APPEND-ONLY + TRUSTED created_at
// ===========================================================================

describe("B5 integrity: appointment_audit is structurally append-only", () => {
  it("even the table OWNER cannot UPDATE or DELETE an audit row", async () => {
    // Structural, not privilege-based. This is what survives a privilege being
    // re-granted out of band by platform tooling (0172:150-152).
    const f = await seedFixture("append-owner");
    const { id } = await internalCreate(f, { startsAt: at(54, 10) });
    const auditId = (await auditRows(id!))[0].id as string;

    await expect(
      adminQuery(`update public.appointment_audit set action = 'tampered' where id = $1`, [
        auditId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      adminQuery(`delete from public.appointment_audit where id = $1`, [auditId]),
    ).rejects.toMatchObject({ code: "42501" });

    // POSITIVE CONTROL: the row is readable and unchanged, so the refusals
    // above are not "the row does not exist".
    const rows = await auditRows(id!);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("created");
  });

  it("service_role cannot INSERT, UPDATE or DELETE an audit row", async () => {
    const f = await seedFixture("append-svc");
    const { id } = await internalCreate(f, { startsAt: at(55, 10) });
    const auditId = (await auditRows(id!))[0].id as string;

    const probes: { what: string; sql: string; params: unknown[] }[] = [
      {
        what: "UPDATE",
        sql: `update public.appointment_audit set action='tampered' where id = $1`,
        params: [auditId],
      },
      {
        what: "DELETE",
        sql: `delete from public.appointment_audit where id = $1`,
        params: [auditId],
      },
      {
        what: "INSERT",
        sql: `insert into public.appointment_audit (appointment_id, actor_type, action) values ($1,'system','forged')`,
        params: [id],
      },
    ];

    for (const { what, sql, params } of probes) {
      const failure = await asRole("service_role", async (q) => {
        try {
          await q(sql, params);
          return null;
        } catch (e) {
          return e as { code?: string; message?: string };
        }
      });
      expect(failure, `service_role ${what} must be refused`).not.toBeNull();
      expect(failure!.code).toBe("42501");
      expect(failure!.message, `${what} must be a PRIVILEGE denial`).toMatch(
        /permission denied for table appointment_audit/i,
      );
      expect(failure!.message).not.toMatch(/row-level security/i);
    }
  });

  it("the append-only exception is EXACTLY the FK detach, a gratuitous detach is refused", async () => {
    // The rule permits appointment_id NOT NULL -> NULL only when the parent is
    // ALREADY GONE. Without that clause it would be a general "orphan any row"
    // bypass that hides a live audit row from the appointment detail view.
    const f = await seedFixture("append-detach");
    const { id } = await internalCreate(f, { startsAt: at(56, 10) });
    const auditId = (await auditRows(id!))[0].id as string;

    await expect(
      adminQuery(`update public.appointment_audit set appointment_id = null where id = $1`, [
        auditId,
      ]),
      "detaching a LIVE row must be refused",
    ).rejects.toMatchObject({ code: "42501" });

    // ...and the identical shape SUCCEEDS as a referential action once the
    // parent is deleted. Same statement shape, different world.
    await expect(
      adminQuery(`delete from public.appointments where id = $1`, [id]),
    ).resolves.toBeDefined();
    const after = await adminQuery(
      `select appointment_id from public.appointment_audit where id = $1`,
      [auditId],
    );
    expect(after.rows[0].appointment_id).toBeNull();
  });

  it("the exception cannot be widened into a general edit: no other column may change with it", async () => {
    const f = await seedFixture("append-widen");
    const { id } = await internalCreate(f, { startsAt: at(57, 10) });
    const auditId = (await auditRows(id!))[0].id as string;

    // Even with the parent gone, changing anything ELSE alongside the detach is
    // refused, the guard compares the whole row, not a column list.
    await adminQuery(`delete from public.appointments where id = $1`, [id]);
    await expect(
      adminQuery(
        `update public.appointment_audit set appointment_id = null, action = 'tampered' where id = $1`,
        [auditId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("B5 integrity: created_at is the database's, not the caller's", () => {
  it("a back-dated INSERT is silently dragged forward to the database clock", async () => {
    const f = await seedFixture("createdat-forge");
    const appt = await mkAppt(f, { startsAt: at(58, 10) });

    const before = await adminQuery(`select now() n`);
    await adminQuery(
      `insert into public.appointment_audit
         (appointment_id, actor_type, actor_id, action, details, created_at)
       values ($1,'practitioner',$2,'marked_complete','{"forged":true}'::jsonb,
               '1999-01-01T00:00:00Z'::timestamptz)`,
      [appt.id, f.ownerId],
    );
    const after = await adminQuery(`select now() n`);

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    const ts = new Date(rows[0].created_at as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(new Date(before.rows[0].n as string).getTime());
    expect(ts).toBeLessThanOrEqual(new Date(after.rows[0].n as string).getTime());
  });

  it("a governed command's audit timestamp lies inside the database-time bracket", async () => {
    const f = await seedFixture("createdat-command");
    const before = await adminQuery(`select now() n`);
    const { id } = await internalCreate(f, { startsAt: at(59, 10) });
    const after = await adminQuery(`select now() n`);

    const rows = await auditRows(id!);
    const ts = new Date(rows[0].created_at as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(new Date(before.rows[0].n as string).getTime());
    expect(ts).toBeLessThanOrEqual(new Date(after.rows[0].n as string).getTime());
  });

  it("historical fixtures exist ONLY in the harness, no runtime path can set created_at", async () => {
    // B4's repair window is measured from created_at DESC, so tests genuinely
    // need old rows. They get them by disabling the derive trigger as the table
    // OWNER, a capability that ships in no migration and that anon,
    // authenticated and service_role cannot reach.
    const f = await seedFixture("createdat-fixture");
    const appt = await mkAppt(f, { startsAt: at(60, 10) });

    await seedHistoricalAppointmentAudit({
      appointmentId: appt.id,
      actorType: "practitioner",
      actorId: f.ownerId,
      action: "marked_complete",
      createdAtSql: "now() - interval '10 days'",
    });

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    const age = Date.now() - new Date(rows[0].created_at as string).getTime();
    expect(age, "the fixture really did seed a historical row").toBeGreaterThan(
      9 * 24 * 60 * 60 * 1000,
    );

    // And the trigger is BACK ON afterwards, the fixture must not leave the
    // table unprotected for every later test in the lane.
    await adminQuery(
      `insert into public.appointment_audit
         (appointment_id, actor_type, actor_id, action, created_at)
       values ($1,'practitioner',$2,'cancelled','1999-01-01T00:00:00Z'::timestamptz)`,
      [appt.id, f.ownerId],
    );
    const reCheck = (await auditRows(appt.id)).find((r) => r.action === "cancelled")!;
    expect(
      new Date(reCheck.created_at as string).getFullYear(),
      "the derive trigger must be re-enabled after the fixture",
    ).toBeGreaterThan(2020);
  });

  it("no RUNTIME function accepts a created_at parameter for appointment_audit", async () => {
    // The structural version of the rule above: if a future change adds a
    // "set the audit timestamp" RPC to satisfy a test, this fails.
    const r = await adminQuery(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosrc ~* 'appointment_audit'
          and pg_get_function_identity_arguments(p.oid) ~* 'created_at'
        order by p.proname`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual([]);
  });
});
