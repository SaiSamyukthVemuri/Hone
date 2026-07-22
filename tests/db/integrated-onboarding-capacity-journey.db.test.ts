import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioB,
  type SynthPractitioner,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// ===========================================================================
// Integration RELEASE CANDIDATE — combined onboarding-v2 + multi-practitioner
// capacity journey in ONE studio, against the real migrated 0150 DB.
// ===========================================================================
//
// A single studio S with ALL THREE feature flags ON:
//   onboarding_v2_enabled, practitioner_capacity_enabled,
//   practitioner_capacity_booking_enabled.
// Seeded practitioners: owner O, active A, active B, INACTIVE C.
// Services: "AB" (eligible for A + B) and "A" (eligible for A only).
//
// The ordered `describe` proves the two features co-exist and stay decoupled:
//   1. onboarding completion is browser-write-guarded (42501),
//   2. it completes EXACTLY once via the trusted service-role command + celebrates once,
//   3-8. per-practitioner availability, parallel booking, collision rollback,
//        time-move, same-time reassign, and move+reassign all behave, then
//   9. integrity (no duplicate membership / onboarding / appt / reservation; exact audit),
//   10. flag independence (disabling capacity leaves onboarding + data dormant, not deleted).
//
// Reuses the EXACT harness + synth-fleet conventions (randomUUID ids, cleanup by
// id, fixed 2031 fixtures, UTC studio) of the existing DB suites so it RUNS on
// the live local stack. Never Willow, never production.

let S: SynthStudio;
let abService = ""; // service "AB" — eligible for A + B
let aService = ""; // service "A"  — eligible for A only

// Journey state carried across the ordered `it` blocks.
let apptA = ""; // appointment created for practitioner A
let apptB = ""; // appointment created for practitioner B
let sA = ""; // apptA current starts_at (::text) — the stale-check snapshot
let eA = ""; // apptA current ends_at   (::text)
let completedAt = ""; // onboarding completed_at snapshot (must never move once set)

const owner = () => S.practitioners.find((p) => p.role === "owner")!;
const A = () => S.practitioners[1];
const Bp = () => S.practitioners[2];
const C = () => S.practitioners[3];

// A safe far-future instant on a fixed date (UTC studio), matching the capacity suites.
const T = (hhmm: string) => `2031-09-15T${hhmm}:00.000Z`;
// A valid 64-char lowercase-hex token hash (appointments_cancellation_token_hash_check).
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

// --- save_weekly_availability(p_studio_id, p_scope_practitioner_id, p_days jsonb) ---
const saveWeekly = (scope: string | null, days: unknown[]) =>
  adminQuery(`select public.save_weekly_availability($1,$2,$3::jsonb) r`, [
    S.studioId,
    scope,
    JSON.stringify(days),
  ]).then((r) => r.rows[0].r as string);
const week = (open: string, close: string) =>
  Array.from({ length: 7 }, (_, dow) => ({
    day_of_week: dow,
    is_open: true,
    open_time: open,
    close_time: close,
  }));
const availRows = (scope: string | null) =>
  adminQuery(
    `select day_of_week from public.studio_availability_default
      where studio_id=$1 and practitioner_id is not distinct from $2`,
    [S.studioId, scope],
  ).then((r) => r.rows);

// --- create_internal_appointment_v2 (0146): authoritative-duration booking. ---
type BookOut =
  | { ok: true; result: string; id: string | null }
  | { ok: false; code: string | undefined };
const bookV2 = (actor: string, target: string, start: string, service: string): Promise<BookOut> =>
  adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`,
    [S.studioId, actor, target, S.clientId, service, start, hash64(), null, null, false],
  )
    .then((r) => ({
      ok: true as const,
      result: r.rows[0].result as string,
      id: r.rows[0].appointment_id as string | null,
    }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));

// --- move_or_reassign_appointment (0148): 7-arg call (8th outside-avail defaults false). ---
type MoveOut =
  | { ok: true; result: string; row: Record<string, unknown> }
  | { ok: false; code: string | undefined };
const move = (
  apptId: string,
  actor: string,
  target: string,
  expStart: string,
  expEnd: string,
  newStart: string,
): Promise<MoveOut> =>
  adminQuery(
    `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
    [apptId, S.studioId, actor, target, expStart, expEnd, newStart],
  )
    .then((r) => ({ ok: true as const, result: r.rows[0].result as string, row: r.rows[0] as Record<string, unknown> }))
    .catch((e) => ({ ok: false as const, code: (e as { code?: string }).code }));

const apptTimes = (id: string) =>
  adminQuery(
    `select practitioner_id, starts_at::text s, ends_at::text e from public.appointments where id=$1`,
    [id],
  ).then((r) => r.rows[0] as { practitioner_id: string; s: string; e: string });
const resKey = (id: string) =>
  adminQuery(
    `select resource_key from public.studio_calendar_reservations
      where source_kind='appointment' and source_id=$1`,
    [id],
  ).then((r) => r.rows.map((x) => x.resource_key as string));
const auditActions = (id: string) =>
  adminQuery(
    `select action from public.appointment_audit where appointment_id=$1 order by created_at, id`,
    [id],
  ).then((r) => r.rows.map((x) => x.action as string));
const onboardingRow = () =>
  adminQuery(
    `select status, completed_at::text ca, celebrated_at::text cel
       from public.studio_onboarding where studio_id=$1`,
    [S.studioId],
  ).then((r) => r.rows[0] as { status: string; ca: string | null; cel: string | null });

beforeAll(async () => {
  // Owner O + active A (index 1) + active B (index 2).
  S = await seedSynthStudioB();
  // Add the INACTIVE practitioner C, and push it into practitioners so cleanup by
  // id (dropSynthStudio) tears down its fake auth user too.
  const c = await seedMember(S, "rc-inactive-c");
  const cPr: SynthPractitioner = {
    userId: c.userId,
    practitionerId: c.practitionerId,
    role: "practitioner",
    email: `synth-c-${c.userId.slice(0, 8)}@synth.local`,
  };
  S.practitioners.push(cPr);
  await adminQuery(`update public.practitioners set active = false where id = $1`, [c.practitionerId]);

  // ALL THREE flags ON. capacity+booking set together (studios_capacity_booking_valid);
  // service-role/superuser bypasses the operator guards on onboarding_v2 + capacity.
  await adminQuery(
    `update public.studios
        set onboarding_v2_enabled = true,
            practitioner_capacity_enabled = true,
            practitioner_capacity_booking_enabled = true,
            timezone = 'UTC',
            buffer_minutes = 0
      where id = $1`,
    [S.studioId],
  );

  // Service "AB": the 0134 AFTER-INSERT default-eligibility trigger already made
  // every ACTIVE practitioner (O, A, B — not inactive C) eligible; keep ONLY A + B.
  const ab = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'AB',30,0,true) returning id`,
    [randomUUID(), S.studioId],
  );
  abService = ab.rows[0].id as string;
  await adminQuery(
    `delete from public.service_practitioners where service_id=$1 and practitioner_id not in ($2,$3)`,
    [abService, A().practitionerId, Bp().practitionerId],
  );

  // Service "A": keep ONLY A eligible.
  const aSvc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'A',30,0,true) returning id`,
    [randomUUID(), S.studioId],
  );
  aService = aSvc.rows[0].id as string;
  await adminQuery(
    `delete from public.service_practitioners where service_id=$1 and practitioner_id <> $2`,
    [aService, A().practitionerId],
  );
});

afterAll(async () => {
  if (S) await dropSynthStudio(S);
  await closePool();
});

describe("RC combined onboarding-v2 + capacity journey (single studio, all flags ON)", () => {
  it("1) onboarding completion is browser-guarded: an owner direct write to the lifecycle fields is REJECTED (42501)", async () => {
    // Owner seeds an in-progress wizard row — allowed by owner-write RLS (no lifecycle field set).
    await asUser(owner().userId, (q) =>
      q(
        `insert into public.studio_onboarding (studio_id, current_step, status)
         values ($1, 'service', 'in_progress')`,
        [S.studioId],
      ),
    );
    // Direct browser write of completed_at → lifecycle guard raises 42501 (trusted-server-only).
    const e1 = await asUser(owner().userId, (q) =>
      q(`update public.studio_onboarding set completed_at = now() where studio_id=$1`, [S.studioId]),
    )
      .then(() => null)
      .catch((e) => e as { code?: string; message?: string });
    expect(e1?.code).toBe("42501");
    expect(e1?.message).toMatch(/trusted-server-only/i);
    // Direct browser transition to status='completed' → also refused.
    const e2 = await asUser(owner().userId, (q) =>
      q(`update public.studio_onboarding set status='completed' where studio_id=$1`, [S.studioId]),
    )
      .then(() => null)
      .catch((e) => e as { code?: string });
    expect(e2?.code).toBe("42501");
    // Nothing changed: still in_progress, no completion stamp.
    const row = await onboardingRow();
    expect(row.status).toBe("in_progress");
    expect(row.ca).toBeNull();
  });

  it("2) onboarding completes EXACTLY once via admin_complete_onboarding, then celebrates once (service_role)", async () => {
    const first = await adminQuery(`select public.admin_complete_onboarding($1,$2) as t`, [
      owner().userId,
      S.studioId,
    ]);
    expect(first.rows[0].t).toBe(true);
    const afterFirst = await onboardingRow();
    expect(afterFirst.status).toBe("completed");
    expect(afterFirst.ca).not.toBeNull();
    completedAt = afterFirst.ca as string;

    // Idempotent: a second completion is a no-op (false) and does NOT move completed_at.
    const second = await adminQuery(`select public.admin_complete_onboarding($1,$2) as t`, [
      owner().userId,
      S.studioId,
    ]);
    expect(second.rows[0].t).toBe(false);
    expect((await onboardingRow()).ca).toBe(completedAt);

    // Celebration stamps exactly once.
    const cel1 = await adminQuery(`select public.admin_mark_onboarding_celebrated($1,$2) as t`, [
      owner().userId,
      S.studioId,
    ]);
    expect(cel1.rows[0].t).toBe(true);
    const cel2 = await adminQuery(`select public.admin_mark_onboarding_celebrated($1,$2) as t`, [
      owner().userId,
      S.studioId,
    ]);
    expect(cel2.rows[0].t).toBe(false);
    expect((await onboardingRow()).cel).not.toBeNull();
  });

  it("3) per-practitioner weekly availability is configured for A then B via save_weekly_availability", async () => {
    expect(await saveWeekly(A().practitionerId, week("08:00", "20:00"))).toBe("ok");
    expect(await saveWeekly(Bp().practitionerId, week("08:00", "20:00"))).toBe("ok");
    expect(await availRows(A().practitionerId)).toHaveLength(7);
    expect(await availRows(Bp().practitionerId)).toHaveLength(7);
  });

  it("4) A and B are booked at the SAME clock time — BOTH succeed (distinct practitioners, no double-booking)", async () => {
    const ra = await bookV2(owner().practitionerId, A().practitionerId, T("10:00"), abService);
    expect(ra).toMatchObject({ ok: true, result: "created" });
    const rb = await bookV2(owner().practitionerId, Bp().practitionerId, T("10:00"), abService);
    expect(rb).toMatchObject({ ok: true, result: "created" });
    if (!ra.ok || !rb.ok) throw new Error("booking did not succeed");
    apptA = ra.id!;
    apptB = rb.id!;

    const ta = await apptTimes(apptA);
    const tb = await apptTimes(apptB);
    expect(ta.practitioner_id).toBe(A().practitionerId);
    expect(tb.practitioner_id).toBe(Bp().practitionerId);
    expect(ta.s).toContain("10:00:00");
    expect(tb.s).toContain("10:00:00");
    sA = ta.s;
    eA = ta.e;
    // One shadow reservation each, keyed to its OWN practitioner (capacity ON).
    expect(await resKey(apptA)).toEqual([A().practitionerId]);
    expect(await resKey(apptB)).toEqual([Bp().practitionerId]);
    // Eligibility scoping holds: service "A" (A-only) cannot be assigned to B
    // (soft 'not_eligible', no appointment created).
    expect(
      await bookV2(owner().practitionerId, Bp().practitionerId, T("18:00"), aService),
    ).toMatchObject({ ok: true, result: "not_eligible" });
  });

  it("5) booking A AGAIN at A's existing time collides (23P01) and rolls back — A's original appt + reservation preserved", async () => {
    const dup = await bookV2(owner().practitionerId, A().practitionerId, T("10:00"), abService);
    expect(dup).toMatchObject({ ok: false, code: "23P01" }); // per-resource GiST exclusion
    // Original is intact — nothing partial committed.
    const ta = await apptTimes(apptA);
    expect(ta.practitioner_id).toBe(A().practitionerId);
    expect(ta.s).toContain("10:00:00");
    expect(await resKey(apptA)).toEqual([A().practitionerId]);
    // No phantom second appointment for A.
    const cnt = await adminQuery(
      `select count(*)::int c from public.appointments where studio_id=$1 and practitioner_id=$2`,
      [S.studioId, A().practitionerId],
    );
    expect(cnt.rows[0].c).toBe(1);
  });

  it("6) time-only move of A's appointment (same practitioner) succeeds; audit records a move", async () => {
    const r = await move(apptA, owner().practitionerId, A().practitionerId, sA, eA, T("11:00"));
    expect(r).toMatchObject({ ok: true, result: "moved" });
    const ta = await apptTimes(apptA);
    expect(ta.practitioner_id).toBe(A().practitionerId); // practitioner unchanged
    expect(ta.s).toContain("11:00:00"); // new time
    sA = ta.s;
    eA = ta.e;
    expect(await auditActions(apptA)).toEqual(["created", "moved"]);
  });

  it("7) same-time reassignment A->B succeeds; practitioner becomes B, time unchanged; audit records a reassignment", async () => {
    const r = await move(apptA, owner().practitionerId, Bp().practitionerId, sA, eA, sA);
    expect(r).toMatchObject({ ok: true, result: "reassigned" });
    const ta = await apptTimes(apptA);
    expect(ta.practitioner_id).toBe(Bp().practitionerId); // now B
    expect(ta.s).toContain("11:00:00"); // time unchanged
    expect(await resKey(apptA)).toEqual([Bp().practitionerId]); // re-keyed to B, no orphan on A
    sA = ta.s;
    eA = ta.e;
    expect(await auditActions(apptA)).toEqual(["created", "moved", "reassigned"]);
  });

  it("8) move-and-reassign (new time AND back to A) in one call succeeds; audit records moved_and_reassigned", async () => {
    const r = await move(apptA, owner().practitionerId, A().practitionerId, sA, eA, T("12:00"));
    expect(r).toMatchObject({ ok: true, result: "moved_and_reassigned" });
    const ta = await apptTimes(apptA);
    expect(ta.practitioner_id).toBe(A().practitionerId); // back to A
    expect(ta.s).toContain("12:00:00"); // new time
    sA = ta.s;
    eA = ta.e;
    expect(await auditActions(apptA)).toEqual(["created", "moved", "reassigned", "moved_and_reassigned"]);
  });

  it("9) integrity: no duplicate membership / onboarding / appointment / reservation; audit is exactly the expected set", async () => {
    // One row per practitioner (O, A, B, C) — no duplicate membership.
    const members = await adminQuery(
      `select count(*)::int c, count(distinct id)::int d from public.practitioners where studio_id=$1`,
      [S.studioId],
    );
    expect(members.rows[0].c).toBe(4);
    expect(members.rows[0].d).toBe(4);

    // Exactly one studio_onboarding row for S.
    const ob = await adminQuery(
      `select count(*)::int c from public.studio_onboarding where studio_id=$1`,
      [S.studioId],
    );
    expect(ob.rows[0].c).toBe(1);

    // Exactly two appointments (A's + B's), each with exactly one shadow reservation.
    const appts = await adminQuery(`select id from public.appointments where studio_id=$1 order by id`, [
      S.studioId,
    ]);
    expect(appts.rows).toHaveLength(2);
    for (const row of appts.rows) {
      const res = await adminQuery(
        `select count(*)::int c from public.studio_calendar_reservations
          where source_kind='appointment' and source_id=$1`,
        [row.id],
      );
      expect(res.rows[0].c).toBe(1);
    }

    // Audit is EXACTLY the expected set — no phantom rows from the rolled-back collision.
    expect(await auditActions(apptA)).toEqual(["created", "moved", "reassigned", "moved_and_reassigned"]);
    expect(await auditActions(apptB)).toEqual(["created"]);
  });

  it("10) flag independence: disabling both capacity flags leaves onboarding completion + availability + appointments intact (dormant, not deleted)", async () => {
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled=false,
         practitioner_capacity_booking_enabled=false where id=$1`,
      [S.studioId],
    );
    const flags = await adminQuery(
      `select practitioner_capacity_enabled cap, practitioner_capacity_booking_enabled book,
              onboarding_v2_enabled ob from public.studios where id=$1`,
      [S.studioId],
    );
    expect(flags.rows[0].cap).toBe(false);
    expect(flags.rows[0].book).toBe(false);

    // (a) onboarding completion is NOT coupled to the capacity flags.
    const ob = await onboardingRow();
    expect(ob.status).toBe("completed");
    expect(ob.ca).toBe(completedAt); // completed_at UNCHANGED

    // (b) scoped availability + appointments still exist (dormant, not deleted).
    expect(await availRows(A().practitionerId)).toHaveLength(7);
    expect(await availRows(Bp().practitionerId)).toHaveLength(7);
    const appts = await adminQuery(`select id from public.appointments where studio_id=$1`, [S.studioId]);
    expect(appts.rows).toHaveLength(2);
    // Reference C so an unused-binding lint can't fire; C stayed inactive throughout.
    expect(C().role).toBe("practitioner");
  });
});
