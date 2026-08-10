import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedHistoricalAppointmentAudit,
} from "./helpers/harness";

// ===========================================================================
// F5 — the override backfill must select the LATEST qualifying event.
// ===========================================================================
//
// WHY THIS FILE EXISTS. The independent review's only P2 was that F5 was
// proven exclusively by SQL-TEXT assertions: tests/migrations/0174-*.test.ts
// pins that the statement says `max(aa.created_at)` and not `min(...)`. That
// catches a rewrite of the token, but it cannot show that the statement, run
// against a real database over real historical audit rows, actually lands the
// later timestamp on the appointment. This suite does that.
//
// IT RUNS THE MIGRATION'S OWN SQL. The Group 3.5 UPDATE is sliced out of
// supabase/migrations/0174_*.sql at run time and executed verbatim. Nothing
// here reimplements the algorithm — a TypeScript copy of the grouping,
// the ambiguity rule and the timestamp selection would be a second
// implementation that could agree with itself while the migration was wrong,
// which is precisely the failure mode the reviewer was pointing at.
//
// WHY THE BACKFILL CAN BE RE-RUN. It only ever touches rows whose attribution
// is still NULL (`and a.outside_availability_authorized_by_practitioner_id is
// null`), so executing it again inside a test is idempotent and cannot rewrite
// a row the migration already resolved.

const MIGRATION = path.resolve(
  __dirname,
  "../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql",
);

/**
 * Slice the ACTUAL Group 3.5 statement out of the migration.
 *
 * Anchored on the assignment that makes this statement unique, then taken to
 * the first statement terminator. If 0174 is ever restructured this throws
 * rather than silently testing nothing — a test that quietly stops finding its
 * subject is worse than one that fails.
 */
function group35Sql(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const anchor = "update public.appointments a\n   set outside_availability_authorized_by_practitioner_id";
  const start = sql.indexOf(anchor);
  if (start === -1) {
    throw new Error("Group 3.5 backfill not found in 0174 — the anchor moved");
  }
  const end = sql.indexOf(";", start);
  if (end === -1) throw new Error("Group 3.5 backfill has no terminator");
  const stmt = sql.slice(start, end + 1);
  // Guard against slicing something that merely looks right.
  if (!/outside_availability_authorized_at\s*=\s*ev\.at/.test(stmt)) {
    throw new Error("sliced statement does not assign the authorised-at column");
  }
  return stmt;
}

// A studio with TWO practitioners in it (the ambiguity case needs two valid,
// same-studio actors) plus the client/service an appointment requires.
async function seedStudio(label: string) {
  const studioId = randomUUID();
  const ownerUserId = randomUUID();
  const memberUserId = randomUUID();
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;

  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
    ownerUserId, `f5-owner-${suffix}@harness.local`,
  ]);
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
    memberUserId, `f5-member-${suffix}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.studios (id, name, slug, timezone, owner_email)
     values ($1,$2,$3,'America/Toronto',$4)`,
    [studioId, `F5 ${suffix}`, `f5-${suffix}`, `f5-owner-${suffix}@harness.local`],
  );
  const owner = await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values (gen_random_uuid(),$1,$2,'F5 Owner',$3,'owner',true) returning id`,
    [studioId, ownerUserId, `f5-owner-${suffix}@harness.local`],
  );
  const member = await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values (gen_random_uuid(),$1,$2,'F5 Member',$3,'practitioner',true) returning id`,
    [studioId, memberUserId, `f5-member-${suffix}@harness.local`],
  );
  const client = await adminQuery(
    `insert into public.clients (id, studio_id, name) values (gen_random_uuid(),$1,'F5 Client') returning id`,
    [studioId],
  );
  const service = await adminQuery(
    `insert into public.services (studio_id, name, modality, default_duration_minutes, price_cents, active)
     values ($1,'F5 Service','electrolysis',60,0,true) returning id`,
    [studioId],
  );
  return {
    studioId,
    ownerId: owner.rows[0].id as string,
    memberId: member.rows[0].id as string,
    clientId: client.rows[0].id as string,
    serviceId: service.rows[0].id as string,
  };
}

// An appointment flagged as booked outside availability, with EVERY new
// attribution column left NULL — which is what makes the backfill's own guards
// (`booked_outside_availability = true` and `... is null`) the thing under test
// rather than something the fixture pre-satisfied.
async function seedFlaggedAppointment(f: Awaited<ReturnType<typeof seedStudio>>) {
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash, booked_outside_availability)
     values (gen_random_uuid(), $1, $2, $3, $4, now() + interval '10 days',
             now() + interval '10 days 60 minutes', 60, 'confirmed', $5, true)
     returning id`,
    [
      f.studioId, f.ownerId, f.clientId, f.serviceId,
      // The column carries a sha256 HEX digest, not a bare id — the check
      // constraint enforces that shape.
      createHash("sha256").update(randomUUID()).digest("hex"),
    ],
  );
  const id = r.rows[0].id as string;
  const pre = await adminQuery(
    `select outside_availability_authorized_by_practitioner_id p,
            outside_availability_authorized_role r,
            outside_availability_authorized_at a
       from public.appointments where id = $1`,
    [id],
  );
  // The premise every case below depends on.
  expect(pre.rows[0].p).toBeNull();
  expect(pre.rows[0].r).toBeNull();
  expect(pre.rows[0].a).toBeNull();
  return id;
}

// One qualifying historical override event: practitioner actor, the flag the
// backfill keys on, at an exact instant.
async function seedOverrideEvent(
  appointmentId: string,
  actorId: string,
  atIso: string,
) {
  await seedHistoricalAppointmentAudit({
    appointmentId,
    actorType: "practitioner",
    actorId,
    action: "moved",
    details: { outside_availability: "true" },
    createdAtSql: `'${atIso}'::timestamptz`,
  });
}

async function runBackfill() {
  await adminQuery(group35Sql());
}

async function readAttribution(appointmentId: string) {
  const r = await adminQuery(
    `select outside_availability_authorized_by_practitioner_id as actor,
            outside_availability_authorized_role               as role,
            outside_availability_authorized_at                 as at
       from public.appointments where id = $1`,
    [appointmentId],
  );
  return r.rows[0] as { actor: string | null; role: string | null; at: Date | null };
}

const T1 = "2026-03-01T10:00:00Z";
const T2 = "2026-05-20T16:30:00Z"; // strictly later

afterAll(async () => {
  await closePool();
});

describe("F5 — historical override backfill, behavioural", () => {
  it("A. SAME ACTOR, TWO EVENTS -> the LATER timestamp wins", async () => {
    // THE load-bearing case. Both rows are the same practitioner, so the
    // ambiguity rule (count(distinct actor_id) = 1) admits the appointment —
    // which is exactly why "which of the two events?" has to be answered, and
    // why min() vs max() is observable here and nowhere else.
    const f = await seedStudio("same-actor");
    const appt = await seedFlaggedAppointment(f);
    await seedOverrideEvent(appt, f.ownerId, T1);
    await seedOverrideEvent(appt, f.ownerId, T2);

    await runBackfill();

    const got = await readAttribution(appt);
    expect(got.actor).toBe(f.ownerId);
    expect(got.role).toBe("owner");
    // The runtime rewrites this column on every authorising move, so the
    // recovered value must be the LATEST authorisation, not the first.
    expect(got.at?.toISOString()).toBe(new Date(T2).toISOString());
    expect(got.at?.toISOString()).not.toBe(new Date(T1).toISOString());
  });

  it("B. TWO DISTINCT ACTORS -> ambiguous, so nothing is written", async () => {
    const f = await seedStudio("two-actors");
    const appt = await seedFlaggedAppointment(f);
    await seedOverrideEvent(appt, f.ownerId, T1);
    await seedOverrideEvent(appt, f.memberId, T2);

    await runBackfill();

    const got = await readAttribution(appt);
    // An ambiguous authoriser is left unknown rather than resolved by an
    // arbitrary ordering — and the timestamp must not leak out on its own.
    expect(got.actor).toBeNull();
    expect(got.role).toBeNull();
    expect(got.at).toBeNull();
  });

  it("C. NO QUALIFYING EVENT -> nothing is written", async () => {
    const f = await seedStudio("no-event");
    const appt = await seedFlaggedAppointment(f);
    // A practitioner audit row that is NOT an override, plus a client actor:
    // neither satisfies the backfill's predicate.
    await seedHistoricalAppointmentAudit({
      appointmentId: appt,
      actorType: "practitioner",
      actorId: f.ownerId,
      action: "moved",
      details: {},
      createdAtSql: `'${T1}'::timestamptz`,
    });
    await seedHistoricalAppointmentAudit({
      appointmentId: appt,
      actorType: "client",
      actorId: null,
      action: "cancelled",
      details: { outside_availability: "true" },
      createdAtSql: `'${T2}'::timestamptz`,
    });

    await runBackfill();

    const got = await readAttribution(appt);
    expect(got.actor).toBeNull();
    expect(got.role).toBeNull();
    expect(got.at).toBeNull();
  });

  it("D. EXACTLY ONE EVENT -> that actor, that instant", async () => {
    const f = await seedStudio("one-event");
    const appt = await seedFlaggedAppointment(f);
    await seedOverrideEvent(appt, f.memberId, T1);

    await runBackfill();

    const got = await readAttribution(appt);
    expect(got.actor).toBe(f.memberId);
    // 'owner' is a RECOVERED FACT, not a lookup: both commands refuse a
    // non-owner override, so an override audit row proves the actor held owner
    // at that moment even though this practitioner's role reads
    // 'practitioner' today. Asserted here so the recovery stays deliberate.
    expect(got.role).toBe("owner");
    expect(got.at?.toISOString()).toBe(new Date(T1).toISOString());
  });

  it("SAME-STUDIO: the resolved actor really is a practitioner of this studio", async () => {
    // The statement joins practitioners on (id, studio_id), so a resolved
    // actor is same-studio by construction. Asserted rather than assumed, and
    // deliberately not expanded into a cross-studio feature test — B5's
    // existing suite already proves the composite FK refuses a foreign actor.
    const f = await seedStudio("same-studio");
    const appt = await seedFlaggedAppointment(f);
    await seedOverrideEvent(appt, f.ownerId, T1);

    await runBackfill();

    const got = await readAttribution(appt);
    const check = await adminQuery(
      `select count(*)::int n from public.practitioners
        where id = $1 and studio_id = $2`,
      [got.actor, f.studioId],
    );
    expect(check.rows[0].n).toBe(1);
  });
});
