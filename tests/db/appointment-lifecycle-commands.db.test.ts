import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// Appointment boundary B2 — T6.1..T6.7
// Behavioural coverage for the three lifecycle commands
// ===========================================================================
//
// Before this file, `mark_appointment_complete` (0032:4052),
// `mark_appointment_no_show` (0033:334) and
// `practitioner_cancel_appointment` (0033:241) had NO behavioural test
// anywhere in the repository. The only tests/db reference was a `prosrc`
// text scan and a test named for an RPC it never invoked
// (public-booking-concurrency.db.test.ts, corrected in this same PR).
//
// That gap is dangerous in a specific way: the two 0033 commands RETURN
// SENTINEL STRINGS rather than raising. A caller that ignores the return
// value turns a refusal into a silent no-op, and no error ever surfaces.
// So every assertion below checks the DATABASE ROW, never only the
// returned sentinel.
//
// These tests exercise the REAL installed functions against the real
// migrated local stack. They never inspect pg_proc.prosrc and never
// re-implement a command's logic in TypeScript.
//
// This file adds no migration and changes no application code.

// ---------------------------------------------------------------------------
// Local fixtures. Deliberately NOT added to tests/db/helpers/harness.ts:
// touching tests/db/helpers/** sets full_matrix_required in
// scripts/classify-changes.mjs, which would widen CI for a test-only PR.
// ---------------------------------------------------------------------------

// 64 lowercase hex chars — exactly what appointments_cancellation_token_hash_check
// (`null or ~ '^[a-f0-9]{64}$'`) demands. The hash column also carries a partial
// UNIQUE index, so this is called fresh per appointment and never hoisted.
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

// Every appointment this file creates gets a UNIQUE whole-day offset from
// now(). `no_overlapping_appointments_studio_wide` is an EXCLUDE constraint
// over (studio_id, tstzrange(starts_at, ends_at)) WHERE status='confirmed'
// and capacity_enabled=false — which is exactly the posture here — so two
// fixtures sharing a slot would fail the INSERT with 23P01 and a test would
// then be measuring the constraint instead of the command. Unique day
// offsets make that structurally impossible.
let dayCursor = 0;
function nextDayOffset(): number {
  dayCursor += 1;
  return dayCursor;
}

type ApptStatus = "confirmed" | "cancelled" | "completed" | "no_show";

// Direct service-role/admin insert. Deliberately bypasses the creation
// commands: this suite is about the LIFECYCLE commands, and a fixture built
// through another command would couple these tests to that command's own
// availability, horizon and slot rules.
//
// All timestamps are computed by the DATABASE from now(), never from the Node
// process clock, so a slow CI runner or a clock skew between the test process
// and Postgres cannot make a time-gated assertion flaky.
async function mkAppt(opts: {
  studio: SeededStudio;
  when: "past" | "future";
  status?: ApptStatus;
  practitionerId?: string | null;
}): Promise<string> {
  const offset = nextDayOffset();
  // Interpolating a bare '+'/'-' operator is safe: the value is chosen by this
  // function from a two-element literal union, never from test data.
  const sign = opts.when === "past" ? "-" : "+";
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3,
             now() ${sign} make_interval(days => $4::int),
             now() ${sign} make_interval(days => $4::int) + interval '60 minutes',
             60, $5, $6)
     returning id`,
    [
      opts.studio.studioId,
      opts.practitionerId === undefined
        ? opts.studio.practitionerId
        : opts.practitionerId,
      opts.studio.clientId,
      offset,
      opts.status ?? "confirmed",
      hash64(),
    ],
  );
  return r.rows[0].id as string;
}

type ApptSnapshot = {
  // to_jsonb of the ENTIRE appointments row. Deliberately not a hand-picked
  // subset of columns: "this refusal changed nothing" is a claim about the
  // whole row, and a subset would miss a command that quietly cleared
  // cancellation_token_hash, bumped sync_version, or touched one of the ~20
  // delivery/claim columns on its way to returning a refusal sentinel.
  row: Record<string, unknown>;
  auditCount: number;
};

const statusOf = (s: ApptSnapshot) => s.row.status as string;

// The authority for every refusal assertion. A sentinel string is a claim;
// this is the measurement.
async function snapshot(id: string): Promise<ApptSnapshot> {
  const r = await adminQuery(
    `select to_jsonb(a) as row,
            (select count(*)::int from public.appointment_audit aa
              where aa.appointment_id = a.id) as audit_count
       from public.appointments a
      where a.id = $1`,
    [id],
  );
  expect(r.rowCount, `snapshot target ${id} must exist`).toBe(1);
  return {
    row: r.rows[0].row as Record<string, unknown>,
    auditCount: r.rows[0].audit_count as number,
  };
}

// T6.7's assertion, factored so every refusal path in the file uses the
// identical, complete comparison rather than a per-test subset.
function expectUnchanged(
  before: ApptSnapshot,
  after: ApptSnapshot,
  label: string,
): void {
  expect(
    after.row,
    `${label}: NO column of the appointments row may change`,
  ).toEqual(before.row);
  expect(
    after.auditCount,
    `${label}: appointment_audit row count must not change`,
  ).toBe(before.auditCount);
}

async function auditRows(apptId: string): Promise<
  Array<{
    actor_type: string;
    actor_id: string | null;
    action: string;
    details: Record<string, unknown> | null;
    created_at: Date;
  }>
> {
  const r = await adminQuery(
    `select actor_type, actor_id, action, details, created_at
       from public.appointment_audit
      where appointment_id = $1
      order by created_at, action`,
    [apptId],
  );
  return r.rows;
}

// --- the three commands under test, called exactly as the app calls them ----

// Raises on refusal (42501 / P0002); returns void on success.
function markComplete(
  apptId: string,
  studioId: string,
  practitionerId: string,
): Promise<unknown> {
  return adminQuery(`select public.mark_appointment_complete($1, $2, $3)`, [
    apptId,
    studioId,
    practitionerId,
  ]);
}

// Returns a sentinel: 'marked' | 'too_early' | 'not_authorized' | 'wrong_status'.
async function markNoShow(
  apptId: string,
  studioId: string,
  practitionerId: string,
): Promise<string> {
  const r = await adminQuery(
    `select public.mark_appointment_no_show($1, $2, $3) as result`,
    [apptId, studioId, practitionerId],
  );
  return r.rows[0].result as string;
}

// Returns a sentinel:
// 'cancelled' | 'already_cancelled' | 'not_cancelable' | 'not_authorized'.
async function cancelAppt(
  apptId: string,
  studioId: string,
  practitionerId: string,
  reason: string | null,
): Promise<string> {
  const r = await adminQuery(
    `select public.practitioner_cancel_appointment($1, $2, $3, $4) as result`,
    [apptId, studioId, practitionerId, reason],
  );
  return r.rows[0].result as string;
}

let A: SeededStudio;
let B: SeededStudio;
let memberA: { userId: string; practitionerId: string };
let inactiveA: { userId: string; practitionerId: string };

beforeAll(async () => {
  A = await seedStudio("lifecycle-a");
  B = await seedStudio("lifecycle-b");
  memberA = await seedMember(A, "lifecycle-a-member");
  inactiveA = await seedMember(A, "lifecycle-a-inactive");
  await adminQuery(`update public.practitioners set active = false where id = $1`, [
    inactiveA.practitionerId,
  ]);
  // buffer_minutes defaults to 15. Zeroing it removes appointments_enforce_buffer_trg
  // (HB001) as a possible reason a fixture INSERT fails, so a refusal observed
  // below can only have come from the command itself.
  for (const s of [A, B]) {
    await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [
      s.studioId,
    ]);
  }
});

afterAll(async () => {
  await closePool();
});

// ===========================================================================
// T6.1 — mark_appointment_complete: the actor must be an ACTIVE member
//        of the studio the appointment belongs to (0032:4064-4069)
// ===========================================================================

describe("T6.1 mark_appointment_complete — unauthorized actor", () => {
  it("refuses a practitioner belonging to a DIFFERENT studio (42501, documented message)", async () => {
    // Fully eligible appointment: past + confirmed. The only thing wrong with
    // this call is the actor, so a refusal can only be the membership gate.
    const id = await mkAppt({ studio: A, when: "past" });
    const before = await snapshot(id);

    await expect(
      markComplete(id, A.studioId, B.practitionerId),
    ).rejects.toMatchObject({
      code: "42501",
      message: "practitioner is not an active member of this studio",
    });

    expectUnchanged(before, await snapshot(id), "T6.1 foreign practitioner");
  });

  it("refuses an INACTIVE practitioner of the appointment's own studio", async () => {
    const id = await mkAppt({ studio: A, when: "past" });
    const before = await snapshot(id);

    await expect(
      markComplete(id, A.studioId, inactiveA.practitionerId),
    ).rejects.toMatchObject({
      code: "42501",
      message: "practitioner is not an active member of this studio",
    });

    expectUnchanged(before, await snapshot(id), "T6.1 inactive practitioner");
  });

  it("positive control: an ACTIVE practitioner of the studio completes an eligible appointment", async () => {
    // Deliberately the non-owner member: the gate is `active = true`, not the
    // owner role, and a test that only ever used the owner could not tell the
    // difference.
    const id = await mkAppt({ studio: A, when: "past" });
    await markComplete(id, A.studioId, memberA.practitionerId);

    const after = await snapshot(id);
    expect(statusOf(after)).toBe("completed");
    expect(after.auditCount).toBe(1);
  });
});

// ===========================================================================
// T6.2 — mark_appointment_complete: appointment scope (0032:4072-4078)
// ===========================================================================

describe("T6.2 mark_appointment_complete — appointment scope", () => {
  it("an unknown appointment id raises P0002 'appointment not found'", async () => {
    await expect(
      markComplete(randomUUID(), A.studioId, A.practitionerId),
    ).rejects.toMatchObject({
      code: "P0002",
      message: "appointment not found",
    });
  });

  it("an appointment in ANOTHER studio is indistinguishable from not found", async () => {
    // The actor is legitimately active in the studio that is passed in, so the
    // membership gate at 0032:4064 PASSES and execution actually reaches the
    // appointment-scope lookup. Without that, this test would silently be a
    // second copy of T6.1.
    const bId = await mkAppt({ studio: B, when: "past" });
    const before = await snapshot(bId);

    await expect(
      markComplete(bId, A.studioId, A.practitionerId),
    ).rejects.toMatchObject({
      code: "P0002",
      message: "appointment not found",
    });

    // Studio B's row is untouched — the refusal did not reach any write.
    expectUnchanged(before, await snapshot(bId), "T6.2 cross-studio appointment");
  });

  it("the unknown-id and wrong-studio failures are byte-identical (no existence oracle)", async () => {
    const bId = await mkAppt({ studio: B, when: "past" });
    const unknown = await markComplete(
      randomUUID(),
      A.studioId,
      A.practitionerId,
    ).catch((e: { code?: string; message?: string }) => e);
    const foreign = await markComplete(bId, A.studioId, A.practitionerId).catch(
      (e: { code?: string; message?: string }) => e,
    );
    const u = unknown as { code?: string; message?: string };
    const f = foreign as { code?: string; message?: string };
    expect(u.code).toBe("P0002");
    expect(f.code).toBe(u.code);
    expect(f.message).toBe(u.message);
  });
});

// ===========================================================================
// T6.3 — mark_appointment_complete: status and time gates (0032:4079-4084)
// ===========================================================================

describe("T6.3 mark_appointment_complete — status and time gates", () => {
  // Each source status is seeded in the PAST, so ends_at > now() can never be
  // the reason for the refusal: the status gate at 0032:4079 is genuinely the
  // first control reached.
  const STATUS_CASES: Array<{ status: ApptStatus; label: string }> = [
    { status: "cancelled", label: "cancelled" },
    { status: "no_show", label: "no_show" },
    { status: "completed", label: "completed" },
  ];

  it("exercises every non-confirmed source status", () => {
    // Anti-vacuity guard for the table below (see tests/db/appointments-tenant-
    // consistency.db.test.ts:103 for the residue pattern this prevents).
    expect(STATUS_CASES).toHaveLength(3);
  });

  it.each(STATUS_CASES)(
    "refuses a $label appointment with P0002 and names the current status",
    async ({ status }) => {
      const id = await mkAppt({ studio: A, when: "past", status });
      const before = await snapshot(id);

      await expect(
        markComplete(id, A.studioId, A.practitionerId),
      ).rejects.toMatchObject({
        code: "P0002",
        message: `appointment is not confirmed (current: ${status})`,
      });

      expectUnchanged(before, await snapshot(id), `T6.3 ${status} source`);
    },
  );

  it("refuses a CONFIRMED appointment whose ends_at is still in the future", async () => {
    // Valid source status, so the status gate passes and the ends_at gate at
    // 0032:4082 is the control actually under test.
    const id = await mkAppt({ studio: A, when: "future" });
    const before = await snapshot(id);

    await expect(
      markComplete(id, A.studioId, A.practitionerId),
    ).rejects.toMatchObject({
      code: "P0002",
      message: "appointment has not yet ended",
    });

    expectUnchanged(before, await snapshot(id), "T6.3 future appointment");
  });

  it("positive control: a PAST CONFIRMED appointment becomes completed with exactly one marked_complete audit row", async () => {
    const id = await mkAppt({ studio: A, when: "past" });
    const before = await snapshot(id);
    expect(statusOf(before)).toBe("confirmed");
    expect(before.auditCount).toBe(0);

    await markComplete(id, A.studioId, A.practitionerId);

    const after = await snapshot(id);
    expect(statusOf(after)).toBe("completed");

    // Multiplicity matters: a set comparison would hide a duplicate insert.
    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("marked_complete");
    expect(rows[0].actor_type).toBe("practitioner");
    expect(rows[0].actor_id).toBe(A.practitionerId);
  });
});

// ===========================================================================
// T6.4 — practitioner_cancel_appointment: every documented sentinel
//        (0033:241-311)
// ===========================================================================

describe("T6.4 practitioner_cancel_appointment — sentinels", () => {
  it("'not_authorized' for a practitioner of another studio", async () => {
    const id = await mkAppt({ studio: A, when: "future" });
    const before = await snapshot(id);

    expect(await cancelAppt(id, A.studioId, B.practitionerId, "nope")).toBe(
      "not_authorized",
    );
    expectUnchanged(before, await snapshot(id), "T6.4 not_authorized (foreign)");
  });

  it("'not_authorized' for an INACTIVE practitioner of the studio", async () => {
    const id = await mkAppt({ studio: A, when: "future" });
    const before = await snapshot(id);

    expect(
      await cancelAppt(id, A.studioId, inactiveA.practitionerId, "nope"),
    ).toBe("not_authorized");
    expectUnchanged(before, await snapshot(id), "T6.4 not_authorized (inactive)");
  });

  it("'not_cancelable' for an appointment id that exists nowhere (0033:269-271)", async () => {
    // Documented branch the audit's own T6.4 summary omits: a missing row
    // returns 'not_cancelable', NOT 'not_authorized'.
    expect(
      await cancelAppt(randomUUID(), A.studioId, A.practitionerId, "nope"),
    ).toBe("not_cancelable");
  });

  it("'not_cancelable' for a REAL appointment belonging to another studio", async () => {
    // The scope half of the same lookup. A random uuid exercises only
    // `a.id = p_appointment_id`; only a real foreign row exercises
    // `and a.studio_id = p_studio_id` (0033:267). Without this, deleting the
    // studio predicate from the command would leave the whole suite green
    // while a practitioner could cancel another studio's appointment.
    const bId = await mkAppt({ studio: B, when: "future" });
    const before = await snapshot(bId);

    // Actor is legitimately active in the studio passed in, so the
    // not_authorized gate at 0033:255-262 passes and the row lookup is reached.
    expect(await cancelAppt(bId, A.studioId, A.practitionerId, "nope")).toBe(
      "not_cancelable",
    );
    expectUnchanged(before, await snapshot(bId), "T6.4 cross-studio cancel");
  });

  it("'not_cancelable' for a COMPLETED appointment", async () => {
    // Future-dated so the started-guard at 0033:287 cannot be the reason.
    const id = await mkAppt({ studio: A, when: "future", status: "completed" });
    const before = await snapshot(id);

    expect(await cancelAppt(id, A.studioId, A.practitionerId, "nope")).toBe(
      "not_cancelable",
    );
    expectUnchanged(before, await snapshot(id), "T6.4 not_cancelable (completed)");
  });

  it("'not_cancelable' for a NO_SHOW appointment", async () => {
    const id = await mkAppt({ studio: A, when: "future", status: "no_show" });
    const before = await snapshot(id);

    expect(await cancelAppt(id, A.studioId, A.practitionerId, "nope")).toBe(
      "not_cancelable",
    );
    expectUnchanged(before, await snapshot(id), "T6.4 not_cancelable (no_show)");
  });

  it("'not_cancelable' once the appointment has STARTED (0033:287)", async () => {
    // status is 'confirmed' and the actor is authorized, so the only control
    // left that can fire is starts_at <= now().
    const id = await mkAppt({ studio: A, when: "past" });
    const before = await snapshot(id);
    expect(statusOf(before)).toBe("confirmed");

    expect(await cancelAppt(id, A.studioId, A.practitionerId, "nope")).toBe(
      "not_cancelable",
    );
    expectUnchanged(before, await snapshot(id), "T6.4 not_cancelable (started)");
  });

  it("'cancelled' on a future confirmed appointment, attributing the OWNER role", async () => {
    const id = await mkAppt({ studio: A, when: "future" });
    const result = await cancelAppt(
      id,
      A.studioId,
      A.practitionerId,
      "client asked",
    );
    expect(result).toBe("cancelled");

    const after = await snapshot(id);
    expect(statusOf(after)).toBe("cancelled");
    expect(after.row.cancelled_at).not.toBeNull();
    // cancelled_by is read from the LIVE practitioners row (0033:294), never
    // from a caller-supplied value. The seeded studio owner has role 'owner'.
    expect(after.row.cancelled_by).toBe("owner");
    expect(after.row.cancellation_reason).toBe("client asked");

    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("cancelled");
    expect(rows[0].actor_type).toBe("practitioner");
    expect(rows[0].actor_id).toBe(A.practitionerId);
    expect(rows[0].details).toMatchObject({
      reason: "client asked",
      role: "owner",
      source: "practitioner_action",
    });
  });

  it("'cancelled' by a NON-OWNER member attributes the 'practitioner' role", async () => {
    // Proves cancelled_by is genuinely derived from the actor's live role and
    // is not a constant that happens to match the owner fixture.
    const id = await mkAppt({ studio: A, when: "future" });
    expect(
      await cancelAppt(id, A.studioId, memberA.practitionerId, "member cancel"),
    ).toBe("cancelled");

    const after = await snapshot(id);
    expect(after.row.cancelled_by).toBe("practitioner");

    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(memberA.practitionerId);
    expect(rows[0].details).toMatchObject({ role: "practitioner" });
  });

  it("'already_cancelled' on a second call, and the second call writes NO second audit row", async () => {
    const id = await mkAppt({ studio: A, when: "future" });
    expect(await cancelAppt(id, A.studioId, A.practitionerId, "first")).toBe(
      "cancelled",
    );

    const afterFirst = await snapshot(id);
    expect(afterFirst.auditCount).toBe(1);

    expect(await cancelAppt(id, A.studioId, A.practitionerId, "second")).toBe(
      "already_cancelled",
    );

    // The short-circuit at 0033:273-275 must leave everything the first call
    // wrote exactly as it was — including cancellation_reason, which a second
    // UPDATE would have overwritten with 'second'.
    expectUnchanged(
      afterFirst,
      await snapshot(id),
      "T6.4 already_cancelled second call",
    );
    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ reason: "first" });
  });
});

// ===========================================================================
// T6.5 — mark_appointment_no_show: every documented sentinel (0033:334-389)
// ===========================================================================

describe("T6.5 mark_appointment_no_show — sentinels", () => {
  it("'not_authorized' for a practitioner of another studio", async () => {
    const id = await mkAppt({ studio: A, when: "past" });
    const before = await snapshot(id);

    expect(await markNoShow(id, A.studioId, B.practitionerId)).toBe(
      "not_authorized",
    );
    expectUnchanged(before, await snapshot(id), "T6.5 not_authorized (foreign)");
  });

  it("'not_authorized' for an INACTIVE practitioner of the studio", async () => {
    const id = await mkAppt({ studio: A, when: "past" });
    const before = await snapshot(id);

    expect(await markNoShow(id, A.studioId, inactiveA.practitionerId)).toBe(
      "not_authorized",
    );
    expectUnchanged(before, await snapshot(id), "T6.5 not_authorized (inactive)");
  });

  const WRONG_STATUS_CASES: Array<{ status: ApptStatus }> = [
    { status: "cancelled" },
    { status: "completed" },
    { status: "no_show" },
  ];

  it("exercises every non-confirmed source status", () => {
    expect(WRONG_STATUS_CASES).toHaveLength(3);
  });

  it.each(WRONG_STATUS_CASES)(
    "'wrong_status' for a $status appointment",
    async ({ status }) => {
      // Past-dated: ends_at <= now(), so the too_early guard at 0033:369 cannot
      // fire and the status gate at 0033:365 is what is measured.
      const id = await mkAppt({ studio: A, when: "past", status });
      const before = await snapshot(id);

      expect(await markNoShow(id, A.studioId, A.practitionerId)).toBe(
        "wrong_status",
      );
      expectUnchanged(before, await snapshot(id), `T6.5 wrong_status (${status})`);
    },
  );

  it("'wrong_status' for an appointment id that exists nowhere (0033:361-363)", async () => {
    expect(await markNoShow(randomUUID(), A.studioId, A.practitionerId)).toBe(
      "wrong_status",
    );
  });

  it("'wrong_status' for a REAL past confirmed appointment belonging to another studio", async () => {
    // Pins `and a.studio_id = p_studio_id` at 0033:359. The row is seeded PAST
    // and CONFIRMED — i.e. fully eligible on every dimension except tenancy —
    // so if the studio predicate were dropped this call would return 'marked'
    // and mutate another studio's appointment.
    const bId = await mkAppt({ studio: B, when: "past" });
    const before = await snapshot(bId);
    expect(statusOf(before)).toBe("confirmed");

    expect(await markNoShow(bId, A.studioId, A.practitionerId)).toBe(
      "wrong_status",
    );
    expectUnchanged(before, await snapshot(bId), "T6.5 cross-studio no-show");
  });

  it("'too_early' while ends_at is still in the future", async () => {
    const id = await mkAppt({ studio: A, when: "future" });
    const before = await snapshot(id);
    expect(statusOf(before)).toBe("confirmed");

    expect(await markNoShow(id, A.studioId, A.practitionerId)).toBe("too_early");
    expectUnchanged(before, await snapshot(id), "T6.5 too_early");
  });

  it("'marked' for an eligible past confirmed appointment, with one marked_no_show audit row", async () => {
    const id = await mkAppt({ studio: A, when: "past" });
    expect(await markNoShow(id, A.studioId, memberA.practitionerId)).toBe(
      "marked",
    );

    const after = await snapshot(id);
    expect(statusOf(after)).toBe("no_show");
    // The command writes ONLY status + updated_at (0033:373-376). A no-show is
    // not a cancellation, so none of the cancellation columns may be invented.
    expect(after.row.cancelled_at).toBeNull();
    expect(after.row.cancelled_by).toBeNull();
    expect(after.row.cancellation_reason).toBeNull();

    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("marked_no_show");
    expect(rows[0].actor_type).toBe("practitioner");
    expect(rows[0].actor_id).toBe(memberA.practitionerId);
    expect(rows[0].details).toMatchObject({ source: "manual" });

    // The actor named in the audit row really is an ACTIVE practitioner of the
    // appointment's studio — actor_id is a bare uuid with no FK (0010:221), so
    // nothing in the schema enforces this.
    const actor = await adminQuery(
      `select 1 from public.practitioners p
        join public.appointments a on a.studio_id = p.studio_id
       where p.id = $1 and a.id = $2 and p.active = true`,
      [rows[0].actor_id, id],
    );
    expect(actor.rowCount).toBe(1);
  });
});

// ===========================================================================
// T6.6 — EXECUTE grant matrix (0032:4099-4102, 0033:314-317, 0033:392-395)
// ===========================================================================

describe("T6.6 EXECUTE grants — service_role only", () => {
  // Resolved from the migrations' own revoke/grant statements, not guessed:
  // 0032:4099 + 0033:402, 0033:392, 0033:314.
  const SIGNATURES = [
    "public.mark_appointment_complete(uuid, uuid, uuid)",
    "public.mark_appointment_no_show(uuid, uuid, uuid)",
    "public.practitioner_cancel_appointment(uuid, uuid, uuid, text)",
  ];

  it("all three signatures resolve to an installed function", async () => {
    // If a signature were wrong, every has_function_privilege probe below
    // would raise rather than measure, and a typo'd argument list would look
    // like a broken test rather than a false pass.
    expect(SIGNATURES).toHaveLength(3);
    for (const sig of SIGNATURES) {
      const r = await adminQuery(`select $1::regprocedure::oid as oid`, [sig]);
      expect(Number(r.rows[0].oid), `${sig} must exist`).toBeGreaterThan(0);
    }
  });

  it("each command name has exactly ONE installed overload", async () => {
    // A privilege probe is per-oid. An overload added by a later migration is
    // a DIFFERENT oid with its own ACL, and Supabase's ALTER DEFAULT PRIVILEGES
    // grants EXECUTE to anon, authenticated AND service_role at function-create
    // time — so a new overload would arrive browser-callable while every probe
    // below, bound to the old signature, stayed green. CLAUDE.md §5 records
    // that exact miss happening twice (0129 for anon, 0164 for service_role).
    for (const name of [
      "mark_appointment_complete",
      "mark_appointment_no_show",
      "practitioner_cancel_appointment",
    ]) {
      const r = await adminQuery(
        `select count(*)::int as n
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [name],
      );
      expect(r.rows[0].n, `public.${name} must have exactly one overload`).toBe(1);
    }
  });

  it.each(SIGNATURES)("%s is denied to public / anon / authenticated", async (sig) => {
    const r = await adminQuery(
      `select has_function_privilege('public',        $1, 'execute') as pub,
              has_function_privilege('anon',          $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as authenticated,
              has_function_privilege('service_role',  $1, 'execute') as service_role,
              (select p.proacl is null from pg_proc p where p.oid = $1::regprocedure)
                as acl_is_null,
              coalesce((select count(*)::int
                          from pg_proc p, aclexplode(p.proacl) a
                         where p.oid = $1::regprocedure and a.grantee = 0), 0) as public_grants
      `,
      [sig],
    );
    const row = r.rows[0];

    // has_function_privilege('public', ...) is the AUTHORITATIVE PUBLIC probe.
    // An aclexplode(grantee = 0) count on its own is NOT: when proacl is NULL
    // the function carries Postgres' DEFAULT privileges, under which PUBLIC
    // HOLDS EXECUTE — and aclexplode(NULL) yields zero rows, so a grantee=0
    // count of 0 would read as "revoked" for the one state in which PUBLIC is
    // most dangerous. Measured directly on this stack against a throwaway
    // default-privilege function: proacl null -> public_grants 0 but
    // has_function_privilege('public', …) TRUE.
    expect(row.acl_is_null, `${sig}: proacl must be explicit, not default`).toBe(
      false,
    );
    expect(row.pub, `${sig}: PUBLIC must NOT have EXECUTE`).toBe(false);
    expect(row.public_grants, `${sig}: PUBLIC must hold no explicit grant`).toBe(0);
    expect(row.anon, `${sig}: anon must NOT have EXECUTE`).toBe(false);
    expect(row.authenticated, `${sig}: authenticated must NOT have EXECUTE`).toBe(
      false,
    );
    expect(row.service_role, `${sig}: service_role MUST have EXECUTE`).toBe(true);
  });

  it("a real invocation as `authenticated` is refused at the PRIVILEGE layer, not by the command body", async () => {
    // This discriminator is mandatory. mark_appointment_complete raises 42501
    // ITSELF for a non-member actor (0032:4068), so SQLSTATE alone cannot tell
    // "EXECUTE denied" apart from "the function ran and refused the actor" —
    // which is exactly the false pass a granted EXECUTE would produce.
    //
    // asUser, NOT asRole. asRole ALWAYS rolls back, which would make the
    // post-state assertion below structurally incapable of failing: a granted
    // EXECUTE would let this SECURITY DEFINER function run to completion and
    // the rollback would erase the evidence. asUser commits on success, so if
    // the call ever stopped being refused the mutation would persist and the
    // post-state assertion would genuinely catch it.
    const id = await mkAppt({ studio: A, when: "past" });

    const err = await asUser(A.userId, (q) =>
      q(`select public.mark_appointment_complete($1, $2, $3)`, [
        id,
        A.studioId,
        A.practitionerId,
      ]),
    ).catch((e: { code?: string; message?: string }) => e);

    const e = err as { code?: string; message?: string };
    expect(e.code).toBe("42501");
    expect(e.message).toMatch(/permission denied for function/i);
    expect(e.message).not.toMatch(/active member of this studio/i);

    // Durable state: the actor IS an active member of this studio and the
    // appointment IS eligible, so if EXECUTE were ever granted the call would
    // SUCCEED and this row would be 'completed' with an audit row.
    const after = await snapshot(id);
    expect(statusOf(after)).toBe("confirmed");
    expect(after.auditCount).toBe(0);
  });

  it("a real invocation of each sentinel-returning command as `authenticated` is refused too", async () => {
    // Same reasoning: these two are seeded eligible (future confirmed, active
    // same-studio actor), so a granted EXECUTE would cancel / refuse-and-return
    // rather than raise, and asUser would commit the result.
    for (const sql of [
      `select public.mark_appointment_no_show($1, $2, $3)`,
      `select public.practitioner_cancel_appointment($1, $2, $3, null)`,
    ]) {
      const id = await mkAppt({ studio: A, when: "future" });
      const err = await asUser(A.userId, (q) =>
        q(sql, [id, A.studioId, A.practitionerId]),
      ).catch((e: { code?: string; message?: string }) => e);
      const e = err as { code?: string; message?: string };
      expect(e.code, sql).toBe("42501");
      expect(e.message, sql).toMatch(/permission denied for function/i);

      const after = await snapshot(id);
      expect(statusOf(after), sql).toBe("confirmed");
      expect(after.auditCount, sql).toBe(0);
    }
  });
});

// ===========================================================================
// T6.7 — rollback / no-op invariant on EVERY refusal path
// ===========================================================================
//
// T6.1-T6.5 already assert the post-state inline. This block re-runs every
// refusal path as one explicit, uniform sweep so the invariant is stated once,
// in one place, over the complete set — and so a newly added refusal branch
// has an obvious home.

describe("T6.7 refusals are complete no-ops", () => {
  type RefusalCase = {
    name: string;
    // Build a fixture and return its id plus the call to make.
    run: () => Promise<{ id: string; before: ApptSnapshot }>;
  };

  const CASES: RefusalCase[] = [
    {
      name: "complete / foreign practitioner",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past" });
        const before = await snapshot(id);
        await markComplete(id, A.studioId, B.practitionerId).catch(() => undefined);
        return { id, before };
      },
    },
    {
      name: "complete / inactive practitioner",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past" });
        const before = await snapshot(id);
        await markComplete(id, A.studioId, inactiveA.practitionerId).catch(
          () => undefined,
        );
        return { id, before };
      },
    },
    {
      name: "complete / cancelled source",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past", status: "cancelled" });
        const before = await snapshot(id);
        await markComplete(id, A.studioId, A.practitionerId).catch(() => undefined);
        return { id, before };
      },
    },
    {
      name: "complete / no_show source",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past", status: "no_show" });
        const before = await snapshot(id);
        await markComplete(id, A.studioId, A.practitionerId).catch(() => undefined);
        return { id, before };
      },
    },
    {
      name: "complete / already completed",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past", status: "completed" });
        const before = await snapshot(id);
        await markComplete(id, A.studioId, A.practitionerId).catch(() => undefined);
        return { id, before };
      },
    },
    {
      name: "complete / not yet ended",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "future" });
        const before = await snapshot(id);
        await markComplete(id, A.studioId, A.practitionerId).catch(() => undefined);
        return { id, before };
      },
    },
    {
      name: "cancel / not_authorized",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "future" });
        const before = await snapshot(id);
        await cancelAppt(id, A.studioId, B.practitionerId, "x");
        return { id, before };
      },
    },
    {
      name: "cancel / not_cancelable (completed)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "future", status: "completed" });
        const before = await snapshot(id);
        await cancelAppt(id, A.studioId, A.practitionerId, "x");
        return { id, before };
      },
    },
    {
      name: "cancel / not_cancelable (no_show)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "future", status: "no_show" });
        const before = await snapshot(id);
        await cancelAppt(id, A.studioId, A.practitionerId, "x");
        return { id, before };
      },
    },
    {
      name: "cancel / not_cancelable (already started)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past" });
        const before = await snapshot(id);
        await cancelAppt(id, A.studioId, A.practitionerId, "x");
        return { id, before };
      },
    },
    {
      name: "no_show / not_authorized",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past" });
        const before = await snapshot(id);
        await markNoShow(id, A.studioId, B.practitionerId);
        return { id, before };
      },
    },
    {
      name: "no_show / wrong_status (cancelled)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past", status: "cancelled" });
        const before = await snapshot(id);
        await markNoShow(id, A.studioId, A.practitionerId);
        return { id, before };
      },
    },
    {
      name: "no_show / wrong_status (completed)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past", status: "completed" });
        const before = await snapshot(id);
        await markNoShow(id, A.studioId, A.practitionerId);
        return { id, before };
      },
    },
    {
      name: "no_show / wrong_status (no_show source)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past", status: "no_show" });
        const before = await snapshot(id);
        await markNoShow(id, A.studioId, A.practitionerId);
        return { id, before };
      },
    },
    {
      name: "no_show / too_early",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "future" });
        const before = await snapshot(id);
        await markNoShow(id, A.studioId, A.practitionerId);
        return { id, before };
      },
    },
    {
      name: "cancel / not_authorized (inactive actor)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "future" });
        const before = await snapshot(id);
        await cancelAppt(id, A.studioId, inactiveA.practitionerId, "x");
        return { id, before };
      },
    },
    {
      name: "no_show / not_authorized (inactive actor)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "past" });
        const before = await snapshot(id);
        await markNoShow(id, A.studioId, inactiveA.practitionerId);
        return { id, before };
      },
    },
    {
      name: "cancel / already_cancelled (second call)",
      run: async () => {
        const id = await mkAppt({ studio: A, when: "future" });
        // First call legitimately cancels; the SECOND call is the refusal
        // under test, so the snapshot is taken AFTER the first one.
        await cancelAppt(id, A.studioId, A.practitionerId, "first");
        const before = await snapshot(id);
        await cancelAppt(id, A.studioId, A.practitionerId, "second");
        return { id, before };
      },
    },
    {
      name: "cancel / not_cancelable (row in another studio)",
      run: async () => {
        const id = await mkAppt({ studio: B, when: "future" });
        const before = await snapshot(id);
        await cancelAppt(id, A.studioId, A.practitionerId, "x");
        return { id, before };
      },
    },
    {
      name: "no_show / wrong_status (row in another studio)",
      run: async () => {
        const id = await mkAppt({ studio: B, when: "past" });
        const before = await snapshot(id);
        await markNoShow(id, A.studioId, A.practitionerId);
        return { id, before };
      },
    },
    {
      name: "complete / row in another studio",
      run: async () => {
        const id = await mkAppt({ studio: B, when: "past" });
        const before = await snapshot(id);
        await markComplete(id, A.studioId, A.practitionerId).catch(() => undefined);
        return { id, before };
      },
    },
  ];

  it("the table covers every refusal branch that HAS a row to leave unchanged", () => {
    // Every refusal branch of the three commands, EXCEPT the three
    // "appointment id exists nowhere" branches — those have no row to snapshot,
    // so the no-op claim is meaningless for them and they are asserted inline
    // instead (T6.2, T6.4, T6.5).
    //
    // Enumerated against the command sources rather than counted loosely:
    //   mark_appointment_complete (0032:4052) — foreign actor, inactive actor,
    //     cancelled source, no_show source, completed source, not yet ended,
    //     row in another studio                                        = 7
    //   practitioner_cancel_appointment (0033:241) — not_authorized (foreign),
    //     not_authorized (inactive), already_cancelled, completed source,
    //     no_show source, already started, row in another studio       = 7
    //   mark_appointment_no_show (0033:334) — not_authorized (foreign),
    //     not_authorized (inactive), cancelled source, completed source,
    //     no_show source, too_early, row in another studio             = 7
    expect(CASES).toHaveLength(21);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
    const byCommand = (prefix: string) =>
      CASES.filter((c) => c.name.startsWith(prefix)).length;
    expect(byCommand("complete /")).toBe(7);
    expect(byCommand("cancel /")).toBe(7);
    expect(byCommand("no_show /")).toBe(7);
  });

  it.each(CASES)(
    "$name leaves status, cancellation fields, timestamps and audit count untouched",
    async ({ name, run }) => {
      const { id, before } = await run();
      expectUnchanged(before, await snapshot(id), `T6.7 ${name}`);
    },
  );
});
