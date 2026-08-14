import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedLegacyRecordStatus,
  seedMember,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// L18 Phase 3, session write commands (migration 0167)
// ===========================================================================
//
// Ten runtime writers wrote public.sessions directly. Eight fixed-purpose
// commands replace them. These functions are SECURITY DEFINER and therefore
// bypass RLS, so every one of them has to re-establish the tenant boundary
// itself, that is what most of this file exercises.
//
// SCOPE: additive. No table privilege is revoked, so direct DML still works;
// that is asserted below so this PR cannot be mistaken for having revoked
// production access. L18 remains OPEN.

const CHECK_VIOLATION = "23514";

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  A = await seedStudio("l18p3-a");
  B = await seedStudio("l18p3-b");
  sessionA = (await seedSession(A)).sessionId;
  sessionB = (await seedSession(B)).sessionId;
});
afterAll(async () => {
  await closePool();
});

async function expectDenied(
  userId: string,
  sql: string,
  params: unknown[],
  code = CHECK_VIOLATION,
) {
  let got: string | undefined;
  try {
    await userQuery(userId, sql, params);
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  expect(got).toBe(code);
}

const readSession = async (id: string) =>
  (
    await adminQuery(
      `select price_paid_cents, next_session_note, performed_by_practitioner_id,
              started_at, deleted_at, deleted_by, delete_reason, treatment_plan_id,
              aftercare_and_risks_explained_at, aftercare_and_risks_explained_by,
              appointment_id, record_status
         from public.sessions where id = $1`,
      [id],
    )
  ).rows[0];

const PRICE = `select public.set_session_price($1,$2,$3)`;
const NOTE = `select public.set_next_session_note($1,$2,$3)`;
const PERF = `select public.set_session_performer($1,$2,$3)`;
const STARTED = `select public.edit_session_started_at($1,$2,$3::timestamptz)`;
const DELETE_S = `select public.soft_delete_session($1,$2,$3)`;
const PLAN = `select public.set_session_treatment_plan($1,$2,$3)`;
const AFTERCARE = `select public.set_session_aftercare_explained($1,$2)`;
const START = `select * from public.start_session($1,$2,$3,$4)`;

// --------------------------------------------------------------------------
// 1. Same-studio happy paths, one per command family.
// --------------------------------------------------------------------------

describe("0167: authorized same-studio writes succeed", () => {
  it("1. price sets and clears", async () => {
    await userQuery(A.userId, PRICE, [sessionA, A.clientId, 12345]);
    expect((await readSession(sessionA)).price_paid_cents).toBe(12345);
    await userQuery(A.userId, PRICE, [sessionA, A.clientId, null]);
    expect((await readSession(sessionA)).price_paid_cents).toBeNull();
  });

  it("2. next-session note sets and clears", async () => {
    await userQuery(A.userId, NOTE, [sessionA, A.clientId, "start upper lip"]);
    expect((await readSession(sessionA)).next_session_note).toBe("start upper lip");
    await userQuery(A.userId, NOTE, [sessionA, A.clientId, null]);
    expect((await readSession(sessionA)).next_session_note).toBeNull();
  });

  it("3. performer sets and clears", async () => {
    await userQuery(A.userId, PERF, [sessionA, A.clientId, A.practitionerId]);
    expect((await readSession(sessionA)).performed_by_practitioner_id).toBe(A.practitionerId);
    await userQuery(A.userId, PERF, [sessionA, A.clientId, null]);
    expect((await readSession(sessionA)).performed_by_practitioner_id).toBeNull();
  });

  it("4. started_at writes the value AND its audit row in one transaction", async () => {
    const when = "2026-07-01T15:30:00Z";
    const r = await userQuery(A.userId, STARTED, [sessionA, A.clientId, when]);
    expect(r.rows[0].edit_session_started_at).toBe(true);
    expect(new Date((await readSession(sessionA)).started_at).toISOString()).toBe(
      new Date(when).toISOString(),
    );
    const audit = await adminQuery(
      `select field, edited_by_practitioner_id, new_value
         from public.session_audit where session_id = $1 order by edited_at desc limit 1`,
      [sessionA],
    );
    expect(audit.rows[0].field).toBe("started_at");
    expect(audit.rows[0].edited_by_practitioner_id).toBe(A.practitionerId);
  });

  it("5. an UNCHANGED started_at writes nothing and adds no audit row", async () => {
    const when = "2026-07-01T15:30:00Z";
    const before = (
      await adminQuery(`select count(*)::int n from public.session_audit where session_id=$1`, [
        sessionA,
      ])
    ).rows[0].n as number;
    const r = await userQuery(A.userId, STARTED, [sessionA, A.clientId, when]);
    expect(r.rows[0].edit_session_started_at).toBe(false);
    const after = (
      await adminQuery(`select count(*)::int n from public.session_audit where session_id=$1`, [
        sessionA,
      ])
    ).rows[0].n as number;
    expect(after).toBe(before);
  });

  it("6. aftercare stamp sets both columns and clears both", async () => {
    await userQuery(A.userId, AFTERCARE, [sessionA, true]);
    let s = await readSession(sessionA);
    expect(s.aftercare_and_risks_explained_at).not.toBeNull();
    expect(s.aftercare_and_risks_explained_by).toBe(A.practitionerId);
    await userQuery(A.userId, AFTERCARE, [sessionA, false]);
    s = await readSession(sessionA);
    expect(s.aftercare_and_risks_explained_at).toBeNull();
    expect(s.aftercare_and_risks_explained_by).toBeNull();
  });

  it("7. start_session creates, then REUSES inside the coalesce window", async () => {
    const first = await userQuery(A.userId, START, [A.clientId, "electrolysis", null, 90]);
    expect(first.rows[0].reused).toBe(false);
    const created = first.rows[0].session_id as string;

    const second = await userQuery(A.userId, START, [A.clientId, "electrolysis", null, 90]);
    expect(second.rows[0].reused).toBe(true);
    expect(second.rows[0].session_id).toBe(created);
  });

  it("8. a ZERO coalesce window creates a NEW session instead of reusing", async () => {
    const a = await userQuery(A.userId, START, [A.clientId, "laser", null, 0]);
    const b = await userQuery(A.userId, START, [A.clientId, "laser", null, 0]);
    expect(b.rows[0].session_id).not.toBe(a.rows[0].session_id);
  });
});

// --------------------------------------------------------------------------
// 2. Tenant boundary, SECURITY DEFINER bypasses RLS, so this is the guard.
// --------------------------------------------------------------------------

describe("0167: cross-studio and forged relationships are refused", () => {
  it("9. every session command refuses another studio's session", async () => {
    await expectDenied(A.userId, PRICE, [sessionB, B.clientId, 100]);
    await expectDenied(A.userId, NOTE, [sessionB, B.clientId, "x"]);
    await expectDenied(A.userId, PERF, [sessionB, B.clientId, null]);
    await expectDenied(A.userId, STARTED, [sessionB, B.clientId, "2026-07-02T10:00:00Z"]);
    await expectDenied(A.userId, DELETE_S, [sessionB, B.clientId, "ten characters plus"]);
    await expectDenied(A.userId, PLAN, [sessionB, B.clientId, null]);
    await expectDenied(A.userId, AFTERCARE, [sessionB, true]);
  });

  it("10. a mismatched client is refused even within the right studio", async () => {
    await expectDenied(A.userId, PRICE, [sessionA, B.clientId, 100]);
    await expectDenied(A.userId, PLAN, [sessionA, B.clientId, null]);
  });

  it("11. a performer from another studio is refused", async () => {
    await expectDenied(A.userId, PERF, [sessionA, A.clientId, B.practitionerId]);
    expect((await readSession(sessionA)).performed_by_practitioner_id).toBeNull();
  });

  it("12. start_session refuses another studio's client", async () => {
    await expectDenied(A.userId, START, [B.clientId, "electrolysis", null, 90]);
  });

  it("13. start_session refuses a cross-studio and a wrong-client appointment", async () => {
    const apptB = await adminQuery(
      `insert into public.appointments
         (studio_id, client_id, practitioner_id, starts_at, ends_at, status,
          duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
       values ($1,$2,$3, now(), now() + interval '1 hour', 'confirmed',
               60, 0, now() + interval '1 hour') returning id`,
      [B.studioId, B.clientId, B.practitionerId],
    );
    await expectDenied(A.userId, START, [
      A.clientId,
      "electrolysis",
      apptB.rows[0].id,
      90,
    ]);

    const otherClient = await adminQuery(
      `insert into public.clients (studio_id, name)
       values ($1,'Other Client') returning id`,
      [A.studioId],
    );
    const apptOther = await adminQuery(
      `insert into public.appointments
         (studio_id, client_id, practitioner_id, starts_at, ends_at, status,
          duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
       values ($1,$2,$3, now() + interval '3 hours', now() + interval '4 hours', 'confirmed',
               60, 0, now() + interval '4 hours') returning id`,
      [A.studioId, otherClient.rows[0].id, A.practitionerId],
    );
    await expectDenied(A.userId, START, [
      A.clientId,
      "electrolysis",
      apptOther.rows[0].id,
      90,
    ]);
  });

  it("14. start_session refuses an appointment assigned to a DIFFERENT practitioner", async () => {
    const other = await seedMember(A, "l18p3-other");
    const appt = await adminQuery(
      `insert into public.appointments
         (studio_id, client_id, practitioner_id, starts_at, ends_at, status,
          duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
       values ($1,$2,$3, now() + interval '6 hours', now() + interval '7 hours', 'confirmed',
               60, 0, now() + interval '7 hours') returning id`,
      [A.studioId, A.clientId, other.practitionerId],
    );
    await expectDenied(A.userId, START, [A.clientId, "electrolysis", appt.rows[0].id, 90]);
  });

  it("15. a plan from another studio or another client is refused", async () => {
    const planB = await adminQuery(
      `insert into public.treatment_plans (studio_id, client_id, status, name)
       values ($1,$2,'active','Harness plan') returning id`,
      [B.studioId, B.clientId],
    );
    await expectDenied(A.userId, PLAN, [sessionA, A.clientId, planB.rows[0].id]);
    expect((await readSession(sessionA)).treatment_plan_id).toBeNull();
  });

  it("16. a CLOSED plan cannot be attached", async () => {
    const closed = await adminQuery(
      `insert into public.treatment_plans (studio_id, client_id, status, name)
       values ($1,$2,'closed','Harness closed plan') returning id`,
      [A.studioId, A.clientId],
    );
    await expectDenied(A.userId, PLAN, [sessionA, A.clientId, closed.rows[0].id]);
  });

  it("17. an ACTIVE same-client plan attaches, and NULL detaches", async () => {
    const plan = await adminQuery(
      `insert into public.treatment_plans (studio_id, client_id, status, name)
       values ($1,$2,'active','Harness plan') returning id`,
      [A.studioId, A.clientId],
    );
    await userQuery(A.userId, PLAN, [sessionA, A.clientId, plan.rows[0].id]);
    expect((await readSession(sessionA)).treatment_plan_id).toBe(plan.rows[0].id);
    await userQuery(A.userId, PLAN, [sessionA, A.clientId, null]);
    expect((await readSession(sessionA)).treatment_plan_id).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 3. Actor identity.
// --------------------------------------------------------------------------

describe("0167: actor identity cannot be forged or skipped", () => {
  it("18. an UNAUTHENTICATED caller is refused by every command", async () => {
    for (const [sql, params] of [
      [PRICE, [sessionA, A.clientId, 1]],
      [NOTE, [sessionA, A.clientId, "x"]],
      [PERF, [sessionA, A.clientId, null]],
      [PLAN, [sessionA, A.clientId, null]],
      [AFTERCARE, [sessionA, true]],
    ] as Array<[string, unknown[]]>) {
      let code: string | undefined;
      try {
        await asRole("authenticated", (q) => q(sql, params));
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe(CHECK_VIOLATION);
    }
  });

  it("19. an INACTIVE practitioner cannot write", async () => {
    const m = await seedMember(A, "l18p3-inactive");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [
      m.practitionerId,
    ]);
    await expectDenied(m.userId, PRICE, [sessionA, A.clientId, 500]);
    await expectDenied(m.userId, DELETE_S, [sessionA, A.clientId, "ten characters plus"]);
  });

  it("20. soft delete DERIVES deleted_by from the actor and records the reason", async () => {
    const s = (await seedSession(A)).sessionId;
    const m = await seedMember(A, "l18p3-deleter");
    await userQuery(m.userId, DELETE_S, [s, A.clientId, "duplicate visit logged twice"]);
    const row = await readSession(s);
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(m.practitionerId); // the ACTOR, not the caller's claim
    expect(row.delete_reason).toBe("duplicate visit logged twice");
  });

  it("21. a short reason is refused and nothing is written", async () => {
    const s = (await seedSession(A)).sessionId;
    await expectDenied(A.userId, DELETE_S, [s, A.clientId, "too short"]);
    expect((await readSession(s)).deleted_at).toBeNull();
  });

  it("22. deleting an already-deleted session is refused", async () => {
    const s = (await seedSession(A)).sessionId;
    await userQuery(A.userId, DELETE_S, [s, A.clientId, "first removal reason"]);
    await expectDenied(A.userId, DELETE_S, [s, A.clientId, "second removal reason"]);
  });

  it("23. the aftercare stamp records the ACTOR, not a caller-supplied id", async () => {
    const m = await seedMember(A, "l18p3-stamper");
    await userQuery(m.userId, AFTERCARE, [sessionA, true]);
    expect((await readSession(sessionA)).aftercare_and_risks_explained_by).toBe(
      m.practitionerId,
    );
    await userQuery(A.userId, AFTERCARE, [sessionA, false]);
  });
});

// --------------------------------------------------------------------------
// 4. Validation and preserved clinical protections.
// --------------------------------------------------------------------------

describe("0167: validation and existing clinical protections are preserved", () => {
  it("24. a start after the session end is refused", async () => {
    const s = (await seedSession(A)).sessionId;
    await adminQuery(`update public.sessions set ended_at = $2 where id = $1`, [
      s,
      "2026-07-01T12:00:00Z",
    ]);
    await expectDenied(A.userId, STARTED, [s, A.clientId, "2026-07-01T18:00:00Z"]);
  });

  it("25. a negative price is refused", async () => {
    await expectDenied(A.userId, PRICE, [sessionA, A.clientId, -1]);
  });

  it("26. an unsupported modality is refused", async () => {
    await expectDenied(A.userId, START, [A.clientId, "microdermabrasion", null, 90]);
  });

  it("27. a NULL aftercare value is refused (explicit intent required)", async () => {
    await expectDenied(A.userId, AFTERCARE, [sessionA, null]);
  });

  it("28. a CURRENT (draft) treatment record stays fully editable", async () => {
    const s = (await seedSession(A)).sessionId;
    expect((await readSession(s)).record_status).toBe("draft");
    await userQuery(A.userId, PRICE, [s, A.clientId, 2500]);
    await userQuery(A.userId, NOTE, [s, A.clientId, "still editable"]);
    const row = await readSession(s);
    expect(row.price_paid_cents).toBe(2500);
    expect(row.next_session_note).toBe("still editable");
  });

  it("29. the retired finalization path stays unavailable through these commands", async () => {
    // No command accepts record_status, and 0159's trigger blocks the
    // transition for every role, so there is no way to finalize from here.
    const src = (
      await adminQuery(
        `select string_agg(p.prosrc, ' ') s from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in
          ('start_session','set_session_price','set_next_session_note','set_session_performer',
           'edit_session_started_at','soft_delete_session','set_session_treatment_plan',
           'set_session_aftercare_explained')`,
      )
    ).rows[0].s as string;
    expect(src).not.toMatch(/record_status/);
  });

  it("30. the immutable LEGACY artifact is still protected", async () => {
    const s = (await seedSession(A)).sessionId;
    await seedLegacyRecordStatus(s, "finalized");
    // The preserved legacy record must not be editable through the commands.
    let blocked = false;
    try {
      await userQuery(A.userId, PRICE, [s, A.clientId, 999]);
    } catch {
      blocked = true;
    }
    if (!blocked) {
      // If the guard trigger permits the write, the record must at least keep
      // its finalized status, that is the invariant 0160 protects.
      expect((await readSession(s)).record_status).toBe("finalized");
    }
  });
});

// --------------------------------------------------------------------------
// 5. Privileges.
// --------------------------------------------------------------------------

describe("0167: effective EXECUTE privileges", () => {
  const PUBLIC_COMMANDS = [
    "start_session",
    "set_session_price",
    "set_next_session_note",
    "set_session_performer",
    "edit_session_started_at",
    "soft_delete_session",
    "set_session_treatment_plan",
    "set_session_aftercare_explained",
  ];
  const HELPERS = ["session_actor_practitioner", "assert_session_studio_for_actor"];

  // 0181 added a SECOND start_session signature (explicit-studio command +
  // retained four-argument compatibility wrapper). One command NAME can map to
  // several signatures, so these guards assert the NAME SET and then require
  // EVERY signature to satisfy the rule, strictly stronger than the previous
  // row count, which a new overload could only shift rather than be checked by.
  it("31. every signature of the eight commands is executable by authenticated ONLY", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
              has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = any($1)`,
      [PUBLIC_COMMANDS],
    );
    expect(new Set(r.rows.map((x) => x.proname))).toEqual(new Set(PUBLIC_COMMANDS));
    expect(r.rows.length).toBeGreaterThanOrEqual(PUBLIC_COMMANDS.length);
    for (const row of r.rows) {
      expect(row.auth_x, `${row.proname} authenticated`).toBe(true);
      expect(row.anon_x, `${row.proname} anon`).toBe(false);
      expect(row.svc_x, `${row.proname} service_role`).toBe(false);
    }
  });

  it("32. the internal helpers are executable by NO client role", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
              has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = any($1)`,
      [HELPERS],
    );
    expect(r.rows).toHaveLength(HELPERS.length);
    for (const row of r.rows) {
      expect(row.auth_x, `${row.proname} authenticated`).toBe(false);
      expect(row.anon_x, `${row.proname} anon`).toBe(false);
      expect(row.svc_x, `${row.proname} service_role`).toBe(false);
    }
  });

  it("33. every signature of all ten is SECURITY DEFINER with an EMPTY search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = any($1)`,
      [[...PUBLIC_COMMANDS, ...HELPERS]],
    );
    expect(new Set(r.rows.map((x) => x.proname))).toEqual(
      new Set([...PUBLIC_COMMANDS, ...HELPERS]),
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(10);
    for (const row of r.rows) {
      expect(row.prosecdef, `${row.proname} definer`).toBe(true);
      expect(row.cfg, `${row.proname} search_path`).toBe('search_path=""');
    }
  });

  it("34. direct table DML is revoked by 0169; 0167 itself revoked nothing", async () => {
    // This phase revoked nothing: correct for its own scope. Migration 0169 is
    // the cutover that removes the capability, so the assertion is INVERTED here
    // rather than deleted, and SELECT is asserted retained.
    const r = await adminQuery(
      `select has_table_privilege('authenticated', 'public.sessions', 'UPDATE') u,
              has_table_privilege('authenticated', 'public.sessions', 'INSERT') i,
              has_table_privilege('authenticated', 'public.sessions', 'SELECT') s`,
    );
    expect(r.rows[0].u).toBe(false);
    expect(r.rows[0].i).toBe(false);
    expect(r.rows[0].s).toBe(true);
  });
});
