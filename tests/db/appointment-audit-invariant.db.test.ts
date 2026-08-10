import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";

// ===========================================================================
// Appointment boundary B2 — T5.1..T5.6
// The audit invariant, measured across ALL eight appointment commands
// ===========================================================================
//
// Per-command audit assertions already exist in isolation
// (public-appointment-command.db.test.ts:143, public-reschedule-command.db.test.ts:292/739,
// practitioner-move-appointment.db.test.ts:97). Nothing measured the INVARIANT
// across commands, which is what this file adds.
//
// One precision on the audit's wording. It groups eight commands under
// "every status change writes an audit row", but `move_or_reassign_appointment`
// is an audited lifecycle mutation that does NOT normally change `status` —
// a move keeps the appointment 'confirmed'. Requiring a status change from it
// would be wrong. So the invariant is split in two:
//
//   T5.1a  every successful lifecycle mutation writes its expected audit row;
//   T5.1b  every successful STATUS TRANSITION strictly increases the
//          appointment's audit-row count.
//
// `actor_id` is a bare uuid with no foreign key and no correlation to
// `actor_type` (0010:220-221) — only `actor_type` is CHECKed. T5.3 is the only
// place in the repository where that correlation is asserted at all.
//
// This file adds no migration and changes no application code.

// ---------------------------------------------------------------------------
// Local fixtures. Deliberately NOT added to tests/db/helpers/harness.ts:
// touching tests/db/helpers/** sets full_matrix_required in
// scripts/classify-changes.mjs, which would widen CI for a test-only PR.
// ---------------------------------------------------------------------------

// 64 lowercase hex — appointments_cancellation_token_hash_check demands
// `^[a-f0-9]{64}$`, and the column carries a GLOBAL partial unique index, so
// this is called fresh per appointment and never hoisted into a const.
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

// Millisecond-clean whole UTC hours, relative to today.
//
// Both public commands refuse anything else:
//   * `create_public_appointment` rejects sub-millisecond input outright
//     (`p_starts_at is distinct from date_trunc('milliseconds', p_starts_at)`)
//     rather than truncating it, and only accepts exact members of
//     public_booking_slot_candidates() — hourly anchors from the 00:00 open;
//   * both enforce a booking horizon of public_booking_horizon_months * 31
//     days, which is why nothing here uses the repo's usual fixed far-future
//     date (2031-…) — that would return 'outside_horizon'.
//
// The Node clock only SELECTS a slot here; no assertion is made against it.
// Every temporal assertion in this file reads the database clock (T5.4).
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

// One self-contained studio per behavioural test. Sharing a studio across
// tests would put every fixture under the same studio-wide GiST exclusion
// (`no_overlapping_appointments_studio_wide`, active while capacity is off),
// so an unrelated earlier booking could become the reason a later one fails.
async function seedFixture(label: string): Promise<Fixture> {
  const studioId = randomUUID();
  const ownerUserId = randomUUID();
  const ownerId = randomUUID();
  const memberUserId = randomUUID();
  const memberId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const tag = `${label}-${studioId.slice(0, 8)}`;
  const ownerEmail = `${tag}-owner@harness.local`;
  const memberEmail = `${tag}-member@harness.local`;

  // auth.users FIRST — practitioners.user_id is an FK.
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    ownerUserId,
    ownerEmail,
  ]);
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    memberUserId,
    memberEmail,
  ]);

  // buffer_minutes = 0 so appointment_buffer_conflict / HB001 can never be the
  // reason a command refuses; capacity stays at its default OFF, which is the
  // shipped posture for every studio today.
  await adminQuery(
    `insert into public.studios
       (id, name, owner_email, timezone, buffer_minutes, slug,
        public_booking_horizon_months)
     values ($1, $2, $3, 'UTC', 0, $4, 3)`,
    [studioId, `Harness ${label}`, ownerEmail, tag],
  );

  // Exactly ONE active owner: create_public_appointment derives the
  // practitioner from that row, and with two active owners it would derive
  // NULL instead (deliberately, never an arbitrary winner).
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'owner', true)`,
    [ownerId, studioId, ownerUserId, `Owner ${label}`, ownerEmail],
  );
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'practitioner', true)`,
    [memberId, studioId, memberUserId, `Member ${label}`, memberEmail],
  );

  await adminQuery(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [clientId, studioId, `Client ${label}`, `${tag}-client@harness.local`],
  );

  await adminQuery(
    `insert into public.services
       (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1, $2, 'Consultation', 60, 0, true)`,
    [serviceId, studioId],
  );

  // Studio-wide availability (practitioner_id NULL) every day. The public
  // commands' readiness gate, window lookup and slot generator all filter
  // `practitioner_id is null`, so a practitioner-scoped row would not satisfy
  // them. No service_practitioners rows are seeded: the eligibility check only
  // fires when a service HAS at least one, so leaving it empty keeps
  // 'not_eligible' unreachable.
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '00:00', '23:59', null from generate_series(0,6) g`,
    [studioId],
  );

  return {
    studioId,
    ownerUserId,
    ownerId,
    memberUserId,
    memberId,
    clientId,
    serviceId,
  };
}

// Direct admin insert, used only where the target of a lifecycle command has
// to already exist in a specific state.
async function mkAppt(
  f: Fixture,
  opts: {
    startsAt: string;
    status?: "confirmed" | "cancelled" | "completed" | "no_show";
    practitionerId?: string | null;
    tokenHash?: string;
  },
): Promise<{ id: string; tokenHash: string }> {
  const tokenHash = opts.tokenHash ?? hash64();
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz,
             $5::timestamptz + interval '60 minutes', 60, $6, $7)
     returning id`,
    [
      f.studioId,
      opts.practitionerId === undefined ? f.ownerId : opts.practitionerId,
      f.clientId,
      f.serviceId,
      opts.startsAt,
      opts.status ?? "confirmed",
      tokenHash,
    ],
  );
  return { id: r.rows[0].id as string, tokenHash };
}

type AuditRow = {
  appointment_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  created_at: Date;
};

async function auditRows(apptId: string): Promise<AuditRow[]> {
  const r = await adminQuery(
    `select appointment_id, actor_type, actor_id, action, details, created_at
       from public.appointment_audit
      where appointment_id = $1
      order by created_at, action`,
    [apptId],
  );
  return r.rows as AuditRow[];
}

async function auditCount(apptId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int as n from public.appointment_audit where appointment_id = $1`,
    [apptId],
  );
  return r.rows[0].n as number;
}

async function statusOf(apptId: string): Promise<string> {
  const r = await adminQuery(
    `select status from public.appointments where id = $1`,
    [apptId],
  );
  expect(r.rowCount, `appointment ${apptId} must exist`).toBe(1);
  return r.rows[0].status as string;
}

// Exact starts_at/ends_at as TEXT. move_or_reassign_appointment compares its
// p_expected_* arguments with `is distinct from`, so a value round-tripped
// through a JS Date (millisecond precision) could silently become
// 'stale_appointment' on a row with microsecond precision.
async function exactTimes(
  apptId: string,
): Promise<{ startsAt: string; endsAt: string }> {
  const r = await adminQuery(
    `select starts_at::text as s, ends_at::text as e
       from public.appointments where id = $1`,
    [apptId],
  );
  return { startsAt: r.rows[0].s as string, endsAt: r.rows[0].e as string };
}

afterAll(async () => {
  await closePool();
});

// ===========================================================================
// The denominator — which installed functions can write appointment_audit
// ===========================================================================

describe("the set of installed appointment_audit writers is pinned", () => {
  // Everything else in this file is closed over the EIGHT commands the
  // boundary audit scopes. That is a scope, not a census — and an invariant
  // asserted over a scope silently stops covering the domain the moment a new
  // writer is installed. This test is the tripwire that makes that visible.
  //
  // NOTE the ninth entry. The legacy v1 `reschedule_appointment` is still
  // installed and still service_role-EXECUTABLE (it is deliberately retained,
  // and pinned as un-dropped / un-revoked by
  // tests/security/public-reschedule-command-guard.test.ts). B2 does not drive
  // it: it is superseded by reschedule_appointment_v2 and the app no longer
  // calls it. Listing it here is the honest alternative to a completeness
  // claim that quietly excludes it.
  const EXPECTED_WRITERS = [
    "create_internal_appointment_v2",
    "create_public_appointment",
    "mark_appointment_complete",
    "mark_appointment_no_show",
    "move_or_reassign_appointment",
    "practitioner_cancel_appointment",
    "public_cancel_appointment_with_token",
    "reschedule_appointment", // legacy v1 — installed, not driven by B2
    "reschedule_appointment_v2",
    // B4 / 0173. The repair commands write audit rows through the shared
    // `write_appointment_audit` helper rather than inlining the INSERT, so the
    // census grows by exactly ONE even though TWO commands landed:
    // `revert_appointment_outcome` and `set_appointment_notes` both `perform`
    // this helper, and neither one's prosrc contains the insert text. That is
    // the centralisation working as intended — a future B5 audit change has one
    // insertion point to migrate, and this list stays legible.
    "write_appointment_audit",
  ];

  it("exactly these ten functions insert into public.appointment_audit", async () => {
    const r = await adminQuery(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosrc ~* 'insert into public.appointment_audit'
        order by p.proname`,
    );
    expect(r.rows.map((x) => x.proname as string)).toEqual(EXPECTED_WRITERS);
  });

  it("no TRIGGER writes appointment_audit — every ROW is still written explicitly by a command", async () => {
    // RESTATED AT B5/0174, because the old form ("appointment_audit has zero
    // triggers") is now false while the property it was protecting is
    // untouched.
    //
    // The property is: no trigger INVENTS AN AUDIT EVENT. 0174 added two
    // triggers to appointment_audit, and neither inserts a row — one derives
    // trusted FIELDS on a row a command is already inserting, the other refuses
    // mutation. So the assertion moves from "no triggers exist" to the thing
    // that actually matters: nothing on either table INSERTS into
    // appointment_audit.
    //
    // This is also the guard against the architecture 0174's header explicitly
    // rejected — a generic `appointments` UPDATE trigger that infers a business
    // action from an arbitrary row change and writes an audit event from it.
    const t = await adminQuery(
      `select g.tgname, p.prosrc
         from pg_trigger g join pg_proc p on p.oid = g.tgfoid
        where g.tgrelid = 'public.appointment_audit'::regclass and not g.tgisinternal
        order by g.tgname`,
    );
    expect(t.rows.map((r) => r.tgname)).toEqual([
      "appointment_audit_append_only",
      "appointment_audit_derive_trusted_fields_trg",
    ]);
    for (const row of t.rows) {
      expect(
        /insert\s+into\s+(public\.)?appointment_audit/i.test(row.prosrc as string),
        `${row.tgname} must not INSERT an audit event`,
      ).toBe(false);
    }

    // Unchanged and still load-bearing: appointments carries no trigger that
    // touches appointment_audit at all.
    const onAppointments = await adminQuery(
      `select t.tgname
         from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'public.appointments'::regclass
          and not t.tgisinternal
          and p.prosrc ~* 'appointment_audit'`,
    );
    expect(onAppointments.rowCount).toBe(0);
  });

  it("the eight commands B2 drives are a strict subset of the installed writers", () => {
    const DRIVEN = EXPECTED_WRITERS.filter(
      (n) =>
        n !== "reschedule_appointment" &&
        // B4 / 0173. `write_appointment_audit` is a shared INSERT helper, not a
        // lifecycle command: it takes an already-decided action + details and
        // has no gates of its own, so B2 does not — and should not — drive it.
        // Its callers (revert_appointment_outcome, set_appointment_notes) are
        // B4 commands with their own suite,
        // tests/db/appointment-repair-commands.db.test.ts.
        n !== "write_appointment_audit",
    );
    expect(DRIVEN).toHaveLength(8);
    for (const d of DRIVEN) expect(EXPECTED_WRITERS).toContain(d);
  });
});

// ===========================================================================
// T5.1a — every successful lifecycle mutation writes its expected audit row
// ===========================================================================
//
// Each block: snapshot state + audit count, run the REAL command, assert the
// intended mutation happened, then assert the exact audit delta. Multiplicity
// is asserted with array lengths, never with a Set — a duplicate insert must
// not be able to hide.

describe("T5.1a create_internal_appointment_v2 — one appointment, one 'created' row", () => {
  it("creates the appointment and exactly one audit row naming the ACTOR practitioner", async () => {
    const f = await seedFixture("t51-internal");
    const before = await adminQuery(
      `select count(*)::int as n from public.appointments where studio_id = $1`,
      [f.studioId],
    );
    expect(before.rows[0].n).toBe(0);

    const r = await adminQuery(
      `select * from public.create_internal_appointment_v2(
         $1, $2, $3, $4, $5, $6::timestamptz, $7, null, null, false)`,
      [
        f.studioId,
        f.ownerId, // p_actor_practitioner_id
        f.memberId, // p_target_practitioner_id
        f.clientId,
        f.serviceId,
        at(7, 10),
        hash64(),
      ],
    );
    expect(r.rows[0].result).toBe("created");
    const id = r.rows[0].appointment_id as string;

    expect(await statusOf(id)).toBe("confirmed");
    const after = await adminQuery(
      `select count(*)::int as n from public.appointments where studio_id = $1`,
      [f.studioId],
    );
    expect(after.rows[0].n).toBe(1);

    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("created");
    expect(rows[0].actor_type).toBe("practitioner");
    // The ACTOR, never the target — the target lands only inside details.
    expect(rows[0].actor_id).toBe(f.ownerId);
    expect(rows[0].details).toMatchObject({
      source: "internal_booking_command_v2",
      target_practitioner_id: f.memberId,
    });
  });
});

describe("T5.1a create_public_appointment — one appointment, one 'created' row", () => {
  it("creates the appointment and exactly one audit row with a CLIENT actor", async () => {
    const f = await seedFixture("t51-public");
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,null)`,
      [f.studioId, f.clientId, f.serviceId, at(7, 11), hash64(), "hello"],
    );
    expect(r.rows[0].result).toBe("created");
    const id = r.rows[0].appointment_id as string;

    expect(await statusOf(id)).toBe("confirmed");

    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("created");
    expect(rows[0].actor_type).toBe("client");
    expect(rows[0].actor_id).toBeNull();
    expect(rows[0].details).toMatchObject({ source: "public_booking" });
  });
});

describe("T5.1a reschedule_appointment_v2 — cancel the original, create the successor", () => {
  it("writes 'cancelled' on the original and 'created' on the successor — two rows total", async () => {
    const f = await seedFixture("t51-resched");
    const original = await mkAppt(f, { startsAt: at(10, 14) });
    expect(await auditCount(original.id)).toBe(0);

    const r = await adminQuery(
      `select * from public.reschedule_appointment_v2($1,$2,$3::timestamptz,$4,$5,$6)`,
      [original.id, original.tokenHash, at(11, 10), hash64(), true, null],
    );
    expect(r.rows[0].result).toBe("success");
    const successorId = r.rows[0].new_appointment_id as string;
    expect(successorId).toBeTruthy();
    expect(successorId).not.toBe(original.id);

    // The intended mutation.
    expect(await statusOf(original.id)).toBe("cancelled");
    expect(await statusOf(successorId)).toBe("confirmed");

    // The audit delta, per appointment id — exactly one row each.
    const originalRows = await auditRows(original.id);
    expect(originalRows).toHaveLength(1);
    expect(originalRows[0].action).toBe("cancelled");
    expect(originalRows[0].details).toMatchObject({
      reason: "rescheduled",
      source: "reschedule_link",
      new_appointment_id: successorId,
    });

    const successorRows = await auditRows(successorId);
    expect(successorRows).toHaveLength(1);
    expect(successorRows[0].action).toBe("created");
    expect(successorRows[0].details).toMatchObject({
      source: "reschedule_link",
      original_appointment_id: original.id,
    });
  });
});

describe("T5.1a move_or_reassign_appointment — audited, but NOT a status change", () => {
  it("move-only: the appointment stays confirmed, the time changes, one 'moved' row", async () => {
    const f = await seedFixture("t51-move");
    const appt = await mkAppt(f, { startsAt: at(12, 9) });
    const t = await exactTimes(appt.id);
    const newStart = at(13, 9);

    const r = await adminQuery(
      `select * from public.move_or_reassign_appointment(
         $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
      [appt.id, f.studioId, f.ownerId, null, t.startsAt, t.endsAt, newStart],
    );
    expect(r.rows[0].result).toBe("moved");

    // The precision this file exists for: an audited mutation with NO status
    // transition. Requiring a status change here would be wrong.
    expect(await statusOf(appt.id)).toBe("confirmed");
    const moved = await exactTimes(appt.id);
    expect(new Date(moved.startsAt).toISOString()).toBe(newStart);

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("moved");
    expect(rows[0].actor_type).toBe("practitioner");
    expect(rows[0].actor_id).toBe(f.ownerId);
    expect(rows[0].details).toMatchObject({
      source: "internal_move_reassign_command",
    });
  });

  it("reassign-only: the practitioner changes, the time does not, one 'reassigned' row", async () => {
    const f = await seedFixture("t51-reassign");
    const appt = await mkAppt(f, { startsAt: at(12, 15) });
    const t = await exactTimes(appt.id);

    // p_new_starts_at is the CURRENT start, so v_time_move is false and the
    // command classifies this as a pure reassignment.
    const r = await adminQuery(
      `select * from public.move_or_reassign_appointment(
         $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
      [appt.id, f.studioId, f.ownerId, f.memberId, t.startsAt, t.endsAt, t.startsAt],
    );
    expect(r.rows[0].result).toBe("reassigned");

    const row = await adminQuery(
      `select practitioner_id, starts_at::text as s, status
         from public.appointments where id = $1`,
      [appt.id],
    );
    expect(row.rows[0].practitioner_id).toBe(f.memberId);
    expect(row.rows[0].s).toBe(t.startsAt);
    expect(row.rows[0].status).toBe("confirmed");

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("reassigned");
  });

  it("move AND reassign: one 'moved_and_reassigned' row", async () => {
    const f = await seedFixture("t51-move-reassign");
    const appt = await mkAppt(f, { startsAt: at(12, 20) });
    const t = await exactTimes(appt.id);
    const newStart = at(14, 8);

    const r = await adminQuery(
      `select * from public.move_or_reassign_appointment(
         $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
      [appt.id, f.studioId, f.ownerId, f.memberId, t.startsAt, t.endsAt, newStart],
    );
    expect(r.rows[0].result).toBe("moved_and_reassigned");

    const row = await adminQuery(
      `select practitioner_id, starts_at::text as s, status
         from public.appointments where id = $1`,
      [appt.id],
    );
    expect(row.rows[0].practitioner_id).toBe(f.memberId);
    expect(new Date(row.rows[0].s).toISOString()).toBe(newStart);
    expect(row.rows[0].status).toBe("confirmed");

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("moved_and_reassigned");
  });
});

describe("T5.1a public_cancel_appointment_with_token — one 'cancelled' row", () => {
  it("cancels the appointment and writes exactly one client-actor audit row", async () => {
    const f = await seedFixture("t51-tokencancel");
    const appt = await mkAppt(f, { startsAt: at(9, 13) });
    expect(await auditCount(appt.id)).toBe(0);

    // p_token IS the stored hash — the lookup is
    // `where a.cancellation_token_hash = p_token`, not a hash of a raw token.
    const r = await adminQuery(
      `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [appt.tokenHash, "schedule_conflict", "Schedule conflict", "sorry", true],
    );
    expect(r.rows[0].result).toBe("cancelled");

    expect(await statusOf(appt.id)).toBe("cancelled");

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("cancelled");
    expect(rows[0].actor_type).toBe("client");
    expect(rows[0].actor_id).toBeNull();
    expect(rows[0].details).toMatchObject({ source: "public_token" });
  });
});

describe("T5.1a practitioner_cancel_appointment / mark_appointment_complete / mark_appointment_no_show", () => {
  it("practitioner cancel writes exactly one 'cancelled' row", async () => {
    const f = await seedFixture("t51-praccancel");
    const appt = await mkAppt(f, { startsAt: at(8, 9) });

    const r = await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4) as result`,
      [appt.id, f.studioId, f.ownerId, "clinic closed"],
    );
    expect(r.rows[0].result).toBe("cancelled");
    expect(await statusOf(appt.id)).toBe("cancelled");

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("cancelled");
    expect(rows[0].details).toMatchObject({ source: "practitioner_action" });
  });

  it("mark complete writes exactly one 'marked_complete' row", async () => {
    const f = await seedFixture("t51-complete");
    const appt = await mkAppt(f, { startsAt: at(-3, 9) });

    await adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [
      appt.id,
      f.studioId,
      f.ownerId,
    ]);
    expect(await statusOf(appt.id)).toBe("completed");

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("marked_complete");
  });

  it("mark no-show writes exactly one 'marked_no_show' row", async () => {
    const f = await seedFixture("t51-noshow");
    const appt = await mkAppt(f, { startsAt: at(-4, 9) });

    const r = await adminQuery(
      `select public.mark_appointment_no_show($1,$2,$3) as result`,
      [appt.id, f.studioId, f.ownerId],
    );
    expect(r.rows[0].result).toBe("marked");
    expect(await statusOf(appt.id)).toBe("no_show");

    const rows = await auditRows(appt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("marked_no_show");
  });
});

// ===========================================================================
// T5.1b — every successful STATUS TRANSITION strictly increases the audit count
// ===========================================================================

describe("T5.1b status transition implies a strictly greater audit count", () => {
  type Transition = {
    name: string;
    // Returns the appointment whose status changed, plus its before/after.
    run: () => Promise<{
      id: string;
      statusBefore: string;
      auditBefore: number;
      statusAfter: string;
      auditAfter: number;
    }>;
  };

  async function measure(
    id: string,
    act: () => Promise<unknown>,
  ): Promise<{
    id: string;
    statusBefore: string;
    auditBefore: number;
    statusAfter: string;
    auditAfter: number;
  }> {
    const statusBefore = await statusOf(id);
    const auditBefore = await auditCount(id);
    await act();
    return {
      id,
      statusBefore,
      auditBefore,
      statusAfter: await statusOf(id),
      auditAfter: await auditCount(id),
    };
  }

  const TRANSITIONS: Transition[] = [
    {
      name: "confirmed -> cancelled (practitioner_cancel_appointment)",
      run: async () => {
        const f = await seedFixture("t51b-praccancel");
        const a = await mkAppt(f, { startsAt: at(15, 9) });
        return measure(a.id, () =>
          adminQuery(
            `select public.practitioner_cancel_appointment($1,$2,$3,$4)`,
            [a.id, f.studioId, f.ownerId, "x"],
          ),
        );
      },
    },
    {
      name: "confirmed -> cancelled (public_cancel_appointment_with_token)",
      run: async () => {
        const f = await seedFixture("t51b-tokencancel");
        const a = await mkAppt(f, { startsAt: at(15, 11) });
        return measure(a.id, () =>
          adminQuery(
            `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
            [a.tokenHash, "r", "R", "n", false],
          ),
        );
      },
    },
    {
      name: "confirmed -> cancelled (reschedule_appointment_v2, original)",
      run: async () => {
        const f = await seedFixture("t51b-resched");
        const a = await mkAppt(f, { startsAt: at(16, 9) });
        return measure(a.id, () =>
          adminQuery(
            `select * from public.reschedule_appointment_v2($1,$2,$3::timestamptz,$4,$5,$6)`,
            [a.id, a.tokenHash, at(17, 9), hash64(), true, null],
          ),
        );
      },
    },
    {
      name: "confirmed -> completed (mark_appointment_complete)",
      run: async () => {
        const f = await seedFixture("t51b-complete");
        const a = await mkAppt(f, { startsAt: at(-5, 9) });
        return measure(a.id, () =>
          adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [
            a.id,
            f.studioId,
            f.ownerId,
          ]),
        );
      },
    },
    {
      name: "confirmed -> no_show (mark_appointment_no_show)",
      run: async () => {
        const f = await seedFixture("t51b-noshow");
        const a = await mkAppt(f, { startsAt: at(-6, 9) });
        return measure(a.id, () =>
          adminQuery(`select public.mark_appointment_no_show($1,$2,$3)`, [
            a.id,
            f.studioId,
            f.ownerId,
          ]),
        );
      },
    },
  ];

  it("covers every status-changing command among the eight B2 drives", () => {
    // Anti-vacuity: a table-driven block whose table is empty or short passes
    // silently. Five status-changing paths among the eight in scope; creation
    // is covered by T5.1a (no prior status to transition from) and
    // move/reassign deliberately does not change status.
    //
    // "among the eight B2 drives" is load-bearing wording, not hedging: the
    // legacy v1 reschedule_appointment ALSO changes status and ALSO writes
    // audit rows, and is deliberately out of scope here. The installed-writer
    // census at the top of this file is what keeps that exclusion visible.
    expect(TRANSITIONS).toHaveLength(5);
    expect(new Set(TRANSITIONS.map((t) => t.name)).size).toBe(TRANSITIONS.length);
  });

  it.each(TRANSITIONS)("$name", async ({ run }) => {
    const m = await run();
    expect(m.statusAfter).not.toBe(m.statusBefore);
    expect(m.auditAfter).toBeGreaterThan(m.auditBefore);
  });
});

// ===========================================================================
// T5.2 — exact action vocabulary
// ===========================================================================

describe("T5.2 the action vocabulary is pinned to exact literals", () => {
  // Load-bearing: app/(app)/calendar/[id]/page.tsx filters the audit table on
  // `.eq("action", "cancelled")` to render cancellation context. A rename that
  // looked harmless — 'appointment_cancelled', 'cancel' — would silently blank
  // that surface with no error anywhere.
  const EXPECTED = [
    "cancelled",
    "created",
    "marked_complete",
    "marked_no_show",
    "moved",
    "moved_and_reassigned",
    "reassigned",
  ];

  it("the eight commands emit exactly this action set, and nothing else", async () => {
    const f = await seedFixture("t52-vocab");
    const observed = new Set<string>();
    const record = async (id: string) => {
      for (const row of await auditRows(id)) observed.add(row.action);
    };

    // created (internal)
    const internal = await adminQuery(
      `select * from public.create_internal_appointment_v2(
         $1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
      [f.studioId, f.ownerId, f.ownerId, f.clientId, f.serviceId, at(20, 8), hash64()],
    );
    expect(internal.rows[0].result).toBe("created");
    await record(internal.rows[0].appointment_id as string);

    // created (public)
    const pub = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, at(20, 10), hash64()],
    );
    expect(pub.rows[0].result).toBe("created");
    await record(pub.rows[0].appointment_id as string);

    // moved / reassigned / moved_and_reassigned
    const mv = await mkAppt(f, { startsAt: at(21, 8) });
    let t = await exactTimes(mv.id);
    const moved = await adminQuery(
      `select * from public.move_or_reassign_appointment(
         $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
      [mv.id, f.studioId, f.ownerId, null, t.startsAt, t.endsAt, at(21, 12)],
    );
    expect(moved.rows[0].result).toBe("moved");

    t = await exactTimes(mv.id);
    const reassigned = await adminQuery(
      `select * from public.move_or_reassign_appointment(
         $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
      [mv.id, f.studioId, f.ownerId, f.memberId, t.startsAt, t.endsAt, t.startsAt],
    );
    expect(reassigned.rows[0].result).toBe("reassigned");

    t = await exactTimes(mv.id);
    const both = await adminQuery(
      `select * from public.move_or_reassign_appointment(
         $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
      [mv.id, f.studioId, f.ownerId, f.ownerId, t.startsAt, t.endsAt, at(22, 8)],
    );
    expect(both.rows[0].result).toBe("moved_and_reassigned");
    await record(mv.id);

    // cancelled (practitioner)
    const pc = await mkAppt(f, { startsAt: at(23, 8) });
    await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4)`,
      [pc.id, f.studioId, f.ownerId, "x"],
    );
    await record(pc.id);

    // cancelled (public token)
    const tc = await mkAppt(f, { startsAt: at(23, 10) });
    await adminQuery(
      `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [tc.tokenHash, "r", "R", "n", false],
    );
    await record(tc.id);

    // cancelled + created (reschedule)
    const rs = await mkAppt(f, { startsAt: at(24, 8) });
    const resched = await adminQuery(
      `select * from public.reschedule_appointment_v2($1,$2,$3::timestamptz,$4,$5,$6)`,
      [rs.id, rs.tokenHash, at(25, 8), hash64(), true, null],
    );
    expect(resched.rows[0].result).toBe("success");
    await record(rs.id);
    await record(resched.rows[0].new_appointment_id as string);

    // marked_complete / marked_no_show
    const mc = await mkAppt(f, { startsAt: at(-7, 8) });
    await adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [
      mc.id,
      f.studioId,
      f.ownerId,
    ]);
    await record(mc.id);

    const ns = await mkAppt(f, { startsAt: at(-8, 8) });
    await adminQuery(`select public.mark_appointment_no_show($1,$2,$3)`, [
      ns.id,
      f.studioId,
      f.ownerId,
    ]);
    await record(ns.id);

    // Exact equality in both directions: a NEW action string fails just as
    // loudly as a renamed one.
    expect([...observed].sort()).toEqual(EXPECTED);
  });

  it("the literal the appointment page filters on is exactly 'cancelled'", async () => {
    const f = await seedFixture("t52-cancelled-literal");
    const appt = await mkAppt(f, { startsAt: at(26, 9) });
    await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4)`,
      [appt.id, f.studioId, f.ownerId, "x"],
    );

    // Exact match, not a substring: 'cancelled_by_client' contains
    // 'cancelled' and would pass a regex while failing the app's `.eq()`.
    const exact = await adminQuery(
      `select count(*)::int as n from public.appointment_audit
        where appointment_id = $1 and action = 'cancelled'`,
      [appt.id],
    );
    expect(exact.rows[0].n).toBe(1);
  });
});

// ===========================================================================
// T5.3 — the actor model, NOT generalised across the public/internal split
// ===========================================================================

describe("T5.3 actor model — internal practitioner commands", () => {
  type InternalCase = {
    name: string;
    run: (f: Fixture) => Promise<{ apptId: string; expectedActor: string }>;
  };

  const CASES: InternalCase[] = [
    {
      name: "create_internal_appointment_v2",
      run: async (f) => {
        const r = await adminQuery(
          `select * from public.create_internal_appointment_v2(
             $1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
          [f.studioId, f.ownerId, f.memberId, f.clientId, f.serviceId, at(30, 9), hash64()],
        );
        expect(r.rows[0].result).toBe("created");
        return {
          apptId: r.rows[0].appointment_id as string,
          expectedActor: f.ownerId,
        };
      },
    },
    {
      name: "move_or_reassign_appointment",
      run: async (f) => {
        const a = await mkAppt(f, { startsAt: at(31, 9) });
        const t = await exactTimes(a.id);
        const r = await adminQuery(
          `select * from public.move_or_reassign_appointment(
             $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
          [a.id, f.studioId, f.ownerId, null, t.startsAt, t.endsAt, at(32, 9)],
        );
        expect(r.rows[0].result).toBe("moved");
        return { apptId: a.id, expectedActor: f.ownerId };
      },
    },
    {
      name: "practitioner_cancel_appointment",
      run: async (f) => {
        const a = await mkAppt(f, { startsAt: at(33, 9) });
        const r = await adminQuery(
          `select public.practitioner_cancel_appointment($1,$2,$3,$4) as result`,
          [a.id, f.studioId, f.memberId, "x"],
        );
        expect(r.rows[0].result).toBe("cancelled");
        return { apptId: a.id, expectedActor: f.memberId };
      },
    },
    {
      name: "mark_appointment_complete",
      run: async (f) => {
        const a = await mkAppt(f, { startsAt: at(-9, 9) });
        await adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [
          a.id,
          f.studioId,
          f.memberId,
        ]);
        return { apptId: a.id, expectedActor: f.memberId };
      },
    },
    {
      name: "mark_appointment_no_show",
      run: async (f) => {
        const a = await mkAppt(f, { startsAt: at(-10, 9) });
        const r = await adminQuery(
          `select public.mark_appointment_no_show($1,$2,$3) as result`,
          [a.id, f.studioId, f.memberId],
        );
        expect(r.rows[0].result).toBe("marked");
        return { apptId: a.id, expectedActor: f.memberId };
      },
    },
  ];

  it("covers every internal command that writes an audit row", () => {
    expect(CASES).toHaveLength(5);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  it.each(CASES)(
    "$name: actor_type='practitioner' and actor_id is the supplied active same-studio practitioner",
    async ({ name, run }) => {
      const f = await seedFixture(`t53-${name.slice(0, 12)}`);
      const { apptId, expectedActor } = await run(f);

      const rows = await auditRows(apptId);
      expect(rows.length, name).toBeGreaterThanOrEqual(1);
      const row = rows[rows.length - 1];

      expect(row.actor_type, name).toBe("practitioner");
      expect(row.actor_id, name).not.toBeNull();
      // It equals the actor the currently deployed command path supplied.
      expect(row.actor_id, name).toBe(expectedActor);

      // ...and that uuid really does resolve to an ACTIVE practitioner of the
      // appointment's OWN studio. Nothing in the schema enforces this:
      // actor_id is a bare uuid with no FK (0010:221) and no correlation to
      // actor_type. This is the only place the correlation is asserted.
      const resolved = await adminQuery(
        `select p.active, p.studio_id
           from public.practitioners p
          where p.id = $1`,
        [row.actor_id],
      );
      expect(resolved.rowCount, `${name}: actor_id must resolve`).toBe(1);
      expect(resolved.rows[0].active, name).toBe(true);
      expect(resolved.rows[0].studio_id, name).toBe(f.studioId);

      const appt = await adminQuery(
        `select studio_id from public.appointments where id = $1`,
        [apptId],
      );
      expect(appt.rows[0].studio_id, name).toBe(resolved.rows[0].studio_id);
    },
  );
});

describe("T5.3 actor model — public / token commands (current schema truth)", () => {
  // Pinned as-is, deliberately. PR #520's D6 would change this; implementing
  // that future model is NOT B2's job, and changing public audit rows to carry
  // client_id belongs to later implementation work.
  it("create_public_appointment writes actor_type='client' with a NULL actor_id", async () => {
    const f = await seedFixture("t53-pubcreate");
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, at(35, 9), hash64()],
    );
    expect(r.rows[0].result).toBe("created");
    const rows = await auditRows(r.rows[0].appointment_id as string);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("client");
    expect(rows[0].actor_id).toBeNull();
  });

  it("public_cancel_appointment_with_token writes actor_type='client' with a NULL actor_id", async () => {
    const f = await seedFixture("t53-tokencancel");
    const a = await mkAppt(f, { startsAt: at(36, 9) });
    await adminQuery(
      `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
      [a.tokenHash, "r", "R", "n", false],
    );
    const rows = await auditRows(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("client");
    expect(rows[0].actor_id).toBeNull();
  });

  it("reschedule_appointment_v2 writes actor_type='client' with NULL actor_id on BOTH rows", async () => {
    const f = await seedFixture("t53-resched");
    const a = await mkAppt(f, { startsAt: at(37, 9) });
    const r = await adminQuery(
      `select * from public.reschedule_appointment_v2($1,$2,$3::timestamptz,$4,$5,$6)`,
      [a.id, a.tokenHash, at(38, 9), hash64(), true, null],
    );
    expect(r.rows[0].result).toBe("success");

    for (const id of [a.id, r.rows[0].new_appointment_id as string]) {
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_type).toBe("client");
      expect(rows[0].actor_id).toBeNull();
    }
  });

  it("the practitioner and client actor models are genuinely different", async () => {
    // Guards against the conflation the audit warns about: a single
    // "actor_type is always 'practitioner'" expectation applied everywhere
    // would pass on internal commands and quietly mis-describe the public ones.
    const f = await seedFixture("t53-split");
    const internal = await adminQuery(
      `select * from public.create_internal_appointment_v2(
         $1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
      [f.studioId, f.ownerId, f.ownerId, f.clientId, f.serviceId, at(40, 9), hash64()],
    );
    const pub = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, at(40, 11), hash64()],
    );
    const iRow = (await auditRows(internal.rows[0].appointment_id as string))[0];
    const pRow = (await auditRows(pub.rows[0].appointment_id as string))[0];

    expect(iRow.action).toBe(pRow.action); // both 'created'
    expect(iRow.actor_type).not.toBe(pRow.actor_type);
    expect(iRow.actor_id).not.toBeNull();
    expect(pRow.actor_id).toBeNull();
  });
});

// ===========================================================================
// T5.4 — created_at is server-generated at command execution time
// ===========================================================================

describe("T5.4 audit created_at is a server transaction timestamp", () => {
  // `created_at` is a plain writable column with only a default (0010:224),
  // so nothing in the schema stops a caller supplying a historical value.
  // The bracket below is measured with the DATABASE clock on both sides —
  // never the Node process clock — and it is deliberately TIGHT: a wide
  // tolerance would let a back-dated timestamp pass.
  async function dbClock(): Promise<Date> {
    const r = await adminQuery(`select clock_timestamp() as t`);
    return r.rows[0].t as Date;
  }

  type Case = {
    name: string;
    run: (f: Fixture) => Promise<string>; // returns the appointment id
  };

  const CASES: Case[] = [
    {
      name: "practitioner_cancel_appointment",
      run: async (f) => {
        const a = await mkAppt(f, { startsAt: at(45, 9) });
        await adminQuery(
          `select public.practitioner_cancel_appointment($1,$2,$3,$4)`,
          [a.id, f.studioId, f.ownerId, "x"],
        );
        return a.id;
      },
    },
    {
      name: "mark_appointment_complete",
      run: async (f) => {
        const a = await mkAppt(f, { startsAt: at(-11, 9) });
        await adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [
          a.id,
          f.studioId,
          f.ownerId,
        ]);
        return a.id;
      },
    },
    {
      name: "public_cancel_appointment_with_token",
      run: async (f) => {
        const a = await mkAppt(f, { startsAt: at(46, 9) });
        await adminQuery(
          `select * from public.public_cancel_appointment_with_token($1,$2,$3,$4,$5)`,
          [a.tokenHash, "r", "R", "n", false],
        );
        return a.id;
      },
    },
  ];

  it("covers one command per actor family plus a raising command", () => {
    expect(CASES).toHaveLength(3);
  });

  it.each(CASES)(
    "$name: created_at lies inside the clock_timestamp() bracket around the call",
    async ({ name, run }) => {
      const f = await seedFixture(`t54-${name.slice(0, 10)}`);
      const before = await dbClock();
      const apptId = await run(f);
      const after = await dbClock();

      const rows = await auditRows(apptId);
      expect(rows.length, name).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        // The command and its audit INSERT share one transaction, so created_at
        // is that transaction's now() — necessarily at or after the bracket's
        // opening read and at or before its closing read.
        expect(
          row.created_at.getTime(),
          `${name}: created_at ${row.created_at.toISOString()} must be >= ${before.toISOString()}`,
        ).toBeGreaterThanOrEqual(before.getTime());
        expect(
          row.created_at.getTime(),
          `${name}: created_at ${row.created_at.toISOString()} must be <= ${after.toISOString()}`,
        ).toBeLessThanOrEqual(after.getTime());
      }
    },
  );

  it("B5/0174: a back-dated INSERT is SILENTLY OVERWRITTEN — both rows land inside the bracket", async () => {
    // THE PREMISE OF THIS TEST INVERTED AT B5/0174, and the inversion is the
    // assertion.
    //
    // Before 0174, `created_at` was a plain writable column with only a default
    // (0010:224), so a forged INSERT kept its chosen timestamp — and PR #521
    // §16.8 row 7 showed that a forged row therefore WINS the
    // `order by created_at desc limit 1` that drives the cancellation-insight
    // card, making this UI-reachable content control rather than mere
    // record forgery.
    //
    // 0174's BEFORE INSERT derive trigger now overwrites the caller's value
    // with the database clock unconditionally. Note it OVERWRITES rather than
    // REJECTS: the caller gets no error and cannot even distinguish "my
    // timestamp was honoured" from "mine was discarded", which is strictly
    // safer than a refusal that leaks the rule.
    //
    // The bracket is still the measuring instrument, and the 60-second offset
    // is still deliberate: a trigger that had silently stopped firing would put
    // the forged row 60 seconds BEFORE `before`, and this test would go red.
    const f = await seedFixture("t54-backdate");
    const a = await mkAppt(f, { startsAt: at(47, 9) });

    const before = await dbClock();
    await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4)`,
      [a.id, f.studioId, f.ownerId, "x"],
    );
    await adminQuery(
      `insert into public.appointment_audit
         (appointment_id, actor_type, actor_id, action, details, created_at)
       values ($1, 'practitioner', $2, 'marked_complete', '{"forged":true}'::jsonb,
               now() - interval '60 seconds')`,
      [a.id, f.ownerId],
    );
    const after = await dbClock();

    const rows = await auditRows(a.id);
    expect(rows).toHaveLength(2);
    const real = rows.find((r) => r.action === "cancelled")!;
    const forged = rows.find((r) => r.action === "marked_complete")!;

    // The command-written row is inside the bracket...
    expect(real.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(real.created_at.getTime()).toBeLessThanOrEqual(after.getTime());
    // ...and so is the row that ASKED to be 60 seconds old. Back-dating is no
    // longer expressible.
    expect(
      forged.created_at.getTime(),
      "a back-dated INSERT must be dragged forward to the database clock",
    ).toBeGreaterThanOrEqual(before.getTime());
    expect(forged.created_at.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ===========================================================================
// T5.5 — KNOWN OPEN INVARIANT: a direct service_role write is UNAUDITED
// ===========================================================================

describe("T5.5 raw service_role lifecycle DML is DENIED, and the governed command audits once", () => {
  // ---------------------------------------------------------------------
  // B5 / 0174 REPLACED THIS BLOCK'S PREMISE. It is not an `it.fails` that
  // was flipped to `it` — the old body could not be reused at all, and
  // leaving it would have been worse than deleting it.
  //
  // WHAT THE OLD CONTRACT SAID (B2, migration 0173 and earlier):
  //   "a direct service_role status UPDATE succeeds but writes no audit
  //    row"  — shipped as an it.fails() expected failure whose stated goal
  //    was that such a write SHOULD write an audit row.
  //
  // WHY THAT GOAL WAS WRONG, and was never going to be met:
  //   the only way to audit an arbitrary direct UPDATE is a generic
  //   `appointments` trigger that INFERS a business action from a row diff.
  //   0174's header rejects that architecture explicitly: it yields
  //   duplicated, low-quality events with no reason, no source and a guessed
  //   action, and it makes the semantic command layer non-authoritative.
  //
  // WHAT B5 DID INSTEAD — close the write rather than audit it:
  //   0174 GROUP 10 revokes service_role's table-level INSERT/UPDATE/DELETE
  //   on public.appointments. The premise of the old test ("the direct write
  //   really does succeed") is therefore FALSE on this schema, which is why
  //   the old PASSING CONTROL had to go too — it asserted the bypass exists.
  //
  // The eight assertions below are the replacement contract, in order.
  // ---------------------------------------------------------------------

  it("1-4: the raw write is REFUSED by privilege, and neither the row nor the audit trail moves", async () => {
    const f = await seedFixture("t55-denied");
    const a = await mkAppt(f, { startsAt: at(-12, 9) });
    expect(await auditCount(a.id)).toBe(0);

    const rowBefore = await adminQuery(
      `select to_jsonb(x.*) j from public.appointments x where x.id = $1`,
      [a.id],
    );

    const failure = await asRole("service_role", async (q) => {
      try {
        await q(
          `update public.appointments set status = 'completed', updated_at = now()
            where id = $1`,
          [a.id],
        );
        return null;
      } catch (e) {
        return e as { code?: string; message?: string };
      }
    });

    // (1) refused, and (2) it is a genuine PRIVILEGE denial — not an RLS
    // refusal wearing the same 42501, and not a trigger raising it.
    expect(failure, "the raw service_role status UPDATE must be refused").not.toBeNull();
    expect(failure!.code).toBe("42501");
    expect(failure!.message).toMatch(/permission denied for table appointments/i);
    expect(failure!.message).not.toMatch(/row-level security/i);

    // (3) the appointment row is byte-identical...
    const rowAfter = await adminQuery(
      `select to_jsonb(x.*) j from public.appointments x where x.id = $1`,
      [a.id],
    );
    expect(JSON.stringify(rowAfter.rows[0].j)).toBe(
      JSON.stringify(rowBefore.rows[0].j),
    );
    // (4) ...and no audit row appeared either.
    expect(await auditCount(a.id)).toBe(0);
  });

  it("5-6: the GOVERNED equivalent succeeds and emits EXACTLY ONE semantic audit row", async () => {
    // Without this the block above would pass equally well on a database where
    // appointments had simply stopped working. The command is the replacement
    // for the capability that was just denied.
    const f = await seedFixture("t55-governed");
    const a = await mkAppt(f, { startsAt: at(-14, 9) });
    expect(await auditCount(a.id)).toBe(0);

    // mark_appointment_complete RETURNS void — success is proven by the row
    // and the audit delta below, never by a return code.
    await adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [
      a.id,
      f.studioId,
      f.ownerId,
    ]);

    const status = await adminQuery(
      `select status from public.appointments where id = $1`,
      [a.id],
    );
    expect(status.rows[0].status).toBe("completed");

    // EXACTLY one, asserted as an array length so a duplicate cannot hide, and
    // the action is the SEMANTIC one — not a generic "status changed".
    const rows = await auditRows(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("marked_complete");
    expect(rows[0].actor_type).toBe("practitioner");
    expect(rows[0].actor_id).toBe(f.ownerId);
  });

  it("7: the TEMPORARY B8 postcare exception still works — and only for its six columns", async () => {
    // 0174 GROUP 10.2. This grant is what keeps the seven direct postcare
    // writers alive until B8/0177 replaces them; if it were missing, postcare
    // email would break silently in production.
    const f = await seedFixture("t55-postcare");
    const a = await mkAppt(f, { startsAt: at(-15, 9) });

    const ok = await asRole("service_role", async (q) => {
      const r = await q(
        `update public.appointments
            set postcare_email_claimed_at      = now(),
                postcare_email_last_attempt_at = now(),
                postcare_email_send_attempts   = 1,
                postcare_email_sent_at         = now(),
                postcare_email_failed_at       = null,
                postcare_email_last_error      = null
          where id = $1`,
        [a.id],
      );
      return r.rowCount;
    });
    expect(ok, "the six postcare columns must remain writable").toBe(1);

    // A seventh column smuggled into the SAME statement fails the WHOLE
    // statement — this is enforced by PostgreSQL column privileges, not by
    // convention, so it cannot drift.
    const smuggled = await asRole("service_role", async (q) => {
      try {
        await q(
          `update public.appointments
              set postcare_email_sent_at = now(), status = 'completed'
            where id = $1`,
          [a.id],
        );
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    });
    expect(smuggled, "a seventh column must not ride along").not.toBeNull();
    expect(smuggled!.code).toBe("42501");
  });

  it("8: B3's browser posture is untouched by any of the above", async () => {
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.appointments','SELECT') s,
              has_table_privilege('authenticated','public.appointments','UPDATE') u,
              has_table_privilege('anon','public.appointments','SELECT') s2,
              has_table_privilege('anon','public.appointments','UPDATE') u2`,
    );
    expect(r.rows[0].s, "authenticated keeps SELECT").toBe(true);
    expect(r.rows[0].u, "authenticated still has no UPDATE").toBe(false);
    expect(r.rows[0].s2, "anon keeps SELECT").toBe(true);
    expect(r.rows[0].u2, "anon still has no UPDATE").toBe(false);
  });
});

// ===========================================================================
// T5.6 — an existing audit row cannot be UPDATEd or DELETEd by a member
// ===========================================================================
//
// SCOPE, stated precisely, because the shorthand "audit rows are
// member-immutable" would be FALSE. This block proves that an existing row
// cannot be modified or removed by an authenticated member. It does NOT prove
// the table is append-only-and-trustworthy, because it is not:
//
//   `authenticated` held the INSERT table grant, and
//   `appointment_audit_member_insert` (0010:291-299) had a WITH CHECK that
//   constrained only `appointment_id`. Nothing constrained `actor_type`,
//   `actor_id`, `action`, `details` or `created_at`, and `actor_id` has no FK.
//   So a member could APPEND a forged row — that is P1-3 in the boundary audit.
//
// B2 SHIPPED BEFORE THAT WAS CLOSED. It is closed now: B3 / migration 0172
// revoked INSERT, UPDATE and DELETE from `anon` and `authenticated` on this
// table and dropped `appointment_audit_member_insert`. The forged-append case
// is proven refused in tests/db/appointment-boundary-revocation.db.test.ts.
//
// WHAT CHANGED FOR THE BLOCK BELOW. The UPDATE/DELETE refusal used to be RLS
// default-deny — `authenticated` held those verbs, 0010 created only SELECT and
// INSERT policies, so the statements matched no rows and returned rowCount 0
// without erroring. After 0172 they are refused at the PRIVILEGE layer and
// RAISE. The assertions therefore move from "zero rows affected" to "42501",
// and each write runs in its own transaction: a raised error aborts the
// surrounding transaction, so issuing both writes in one `asUser` callback
// would report 25P02 for the second and prove nothing about it.

describe("T5.6 appointment_audit rows cannot be UPDATEd or DELETEd by a member", () => {
  it("a member can READ the row (positive control) but neither UPDATE nor DELETE it", async () => {
    const f = await seedFixture("t56-immutable");
    const a = await mkAppt(f, { startsAt: at(50, 9) });
    await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4)`,
      [a.id, f.studioId, f.ownerId, "original reason"],
    );

    const seeded = await auditRows(a.id);
    expect(seeded).toHaveLength(1);
    const auditId = await adminQuery(
      `select id from public.appointment_audit where appointment_id = $1`,
      [a.id],
    );
    const rowId = auditId.rows[0].id as string;

    // NOT service_role: that bypasses RLS entirely and retains every privilege,
    // so it would make this test measure nothing. This is the authenticated
    // member path.
    //
    // Positive control FIRST, in its own transaction — the row IS readable, so
    // a refusal below is about the write verb and not about the query shape or
    // a broken identity.
    const read = await asUser(f.ownerUserId, (q) =>
      q(`select id, action from public.appointment_audit where id = $1`, [rowId]),
    );
    expect(read.rowCount).toBe(1);
    expect(read.rows[0].action).toBe("cancelled");

    /** Run one write as the member and report how it failed, or null. */
    const attempt = async (sql: string): Promise<{ code?: string; message?: string } | null> => {
      try {
        await asUser(f.ownerUserId, (q) => q(sql, [rowId]));
        return null;
      } catch (e) {
        return e as { code?: string; message?: string };
      }
    };

    for (const [label, sql] of [
      ["UPDATE", `update public.appointment_audit set action = 'tampered' where id = $1`],
      ["DELETE", `delete from public.appointment_audit where id = $1`],
    ] as const) {
      const failure = await attempt(sql);
      // Before 0172 this returned rowCount 0 and `failure` would be null.
      expect(failure, `${label} must be refused, not silently affect zero rows`).not.toBeNull();
      expect(failure!.code, `${label} SQLSTATE`).toBe("42501");
      // An RLS WITH CHECK violation raises 42501 too, so the message is the
      // only thing that proves this is the privilege layer.
      expect(failure!.message, `${label} must be a PRIVILEGE denial`).toMatch(
        /permission denied/i,
      );
      expect(failure!.message, `${label} must not be an RLS refusal`).not.toMatch(
        /row-level security/i,
      );
    }

    // The authority: asUser COMMITS on success, so if either statement had
    // taken effect it would be visible here.
    const surviving = await auditRows(a.id);
    expect(surviving).toHaveLength(1);
    expect(surviving[0].action).toBe("cancelled");
    expect(surviving[0].details).toMatchObject({ reason: "original reason" });
  });

  it("a member of ANOTHER studio cannot even read the row", async () => {
    const f = await seedFixture("t56-own");
    const other = await seedFixture("t56-other");
    const a = await mkAppt(f, { startsAt: at(51, 9) });
    await adminQuery(
      `select public.practitioner_cancel_appointment($1,$2,$3,$4)`,
      [a.id, f.studioId, f.ownerId, "x"],
    );

    const own = await asUser(f.ownerUserId, (q) =>
      q(`select id from public.appointment_audit where appointment_id = $1`, [a.id]),
    );
    expect(own.rowCount).toBe(1); // positive control

    const foreign = await asUser(other.ownerUserId, (q) =>
      q(`select id from public.appointment_audit where appointment_id = $1`, [a.id]),
    );
    expect(foreign.rowCount).toBe(0);
  });
});
