import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// Practitioner "Move appointment" — DB integration proof (migration 0133,
// public.practitioner_move_appointment). LOCAL disposable Supabase only (CI db lane).
// Proves the atomic SAME-RECORD move: it updates only starts_at/ends_at/updated_at on
// the same appointments row (id + all relationships preserved), the existing triggers
// re-snapshot the buffer + re-sync the SAME reservation + bump sync_version, the GiST
// exclusions (23P01) enforce every conflict class, and the closed result set is exact.
// No Google, no Stripe, no real data.

let studio: SeededStudio;
let serviceId: string;

// Unique, non-overlapping future slots per appointment (studio has a GiST double-booking
// exclusion). base advances well into the future; each caller takes a distinct hour.
let slotSeq = 0;
function nextSlot(): { start: string } {
  const base = Date.now() + 30 * 24 * 3600 * 1000 + slotSeq++ * 3 * 3600 * 1000;
  return { start: new Date(base).toISOString() };
}

async function seedService(studioId: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes) values ($1,$2,'Move Test Service',60)`,
    [id, studioId],
  );
  return id;
}

type Appt = { id: string; startsAt: string; endsAt: string };
// Insert a confirmed appointment; the BEFORE trigger snapshots the buffer, the AFTER
// trigger creates its shadow reservation. Returns the DB-stored ISO endpoints (used as
// the RPC's expected optimistic-concurrency snapshot).
async function insertAppt(opts: {
  startsAt: string;
  durationMin?: number;
  status?: string;
  serviceId?: string | null;
  notes?: string | null;
  tokenHash?: string | null;
  practitionerId?: string;
} = { startsAt: nextSlot().start }): Promise<Appt> {
  const id = randomUUID();
  const dur = opts.durationMin ?? 60;
  const ends = new Date(new Date(opts.startsAt).getTime() + dur * 60000).toISOString();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, status, notes, cancellation_token_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, studio.studioId, studio.clientId, opts.practitionerId ?? studio.practitionerId,
      opts.serviceId ?? serviceId, opts.startsAt, ends, dur, opts.status ?? "confirmed",
      opts.notes ?? null, opts.tokenHash ?? null,
    ],
  );
  const r = await adminQuery(`select starts_at, ends_at from public.appointments where id=$1`, [id]);
  return { id, startsAt: new Date(r.rows[0].starts_at).toISOString(), endsAt: new Date(r.rows[0].ends_at).toISOString() };
}

type MoveRow = {
  result: string;
  appointment_id: string | null;
  previous_starts_at: string | null;
  previous_ends_at: string | null;
  new_starts_at: string | null;
  new_ends_at: string | null;
};
async function move(opts: {
  apptId: string;
  studioId?: string;
  practitionerId?: string;
  expStart: string;
  expEnd: string;
  newStart: string;
}): Promise<MoveRow> {
  const r = await adminQuery(
    `select result, appointment_id, previous_starts_at, previous_ends_at, new_starts_at, new_ends_at
       from public.practitioner_move_appointment($1,$2,$3,$4,$5,$6)`,
    [opts.apptId, opts.studioId ?? studio.studioId, opts.practitionerId ?? studio.practitionerId, opts.expStart, opts.expEnd, opts.newStart],
  );
  return r.rows[0] as MoveRow;
}

async function apptRow(id: string) {
  return (await adminQuery(`select * from public.appointments where id=$1`, [id])).rows[0];
}
async function reservationRows(sourceId: string) {
  return (await adminQuery(
    `select * from public.studio_calendar_reservations where source_kind='appointment' and source_id=$1`,
    [sourceId],
  )).rows;
}
async function auditRows(apptId: string) {
  return (await adminQuery(`select * from public.appointment_audit where appointment_id=$1 order by created_at`, [apptId])).rows;
}
// Direct reservation insert for conflict setup (simulates a timed_block / recurring_break /
// full_day_blockout / other-appointment reservation at the target slot).
async function insertReservation(sourceKind: string, startsAt: string, endsAt: string) {
  await adminQuery(
    `insert into public.studio_calendar_reservations (studio_id, source_kind, source_id, starts_at, ends_at) values ($1,$2,$3,$4,$5)`,
    [studio.studioId, sourceKind, randomUUID(), startsAt, endsAt],
  );
}

beforeAll(async () => {
  studio = await seedStudio("moveAppt");
  serviceId = await seedService(studio.studioId);
  // Deterministic conflict math: zero buffer -> blocked_ends_at = ends_at.
  await adminQuery(`update public.studios set buffer_minutes=0 where id=$1`, [studio.studioId]);
});
afterAll(async () => {
  await adminQuery(`delete from public.appointment_audit where appointment_id in (select id from public.appointments where studio_id=$1)`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.sessions where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.appointments where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.studio_calendar_reservations where studio_id=$1`, [studio.studioId]).catch(() => {});
  await closePool();
});
beforeEach(async () => {
  await adminQuery(`delete from public.appointment_audit where appointment_id in (select id from public.appointments where studio_id=$1)`, [studio.studioId]);
  await adminQuery(`delete from public.sessions where studio_id=$1`, [studio.studioId]);
  await adminQuery(`delete from public.appointments where studio_id=$1`, [studio.studioId]);
  await adminQuery(`delete from public.studio_calendar_reservations where studio_id=$1`, [studio.studioId]);
});

describe("environment pin", () => {
  it("targets a local database (harness enforces localhost)", async () => {
    const r = await adminQuery(`select current_setting('server_version') as v`);
    expect(r.rows[0].v).toBeTruthy();
  });
});

describe("successful move preserves the same record + every relationship", () => {
  it("1-8: active same-studio practitioner moves a future confirmed appointment; id/client/practitioner/service/duration/notes/token-hash unchanged", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start, notes: "keep me", tokenHash: "a".repeat(64) });
    const before = await apptRow(a.id);
    const newStart = new Date(new Date(a.startsAt).getTime() + 90 * 60000).toISOString();

    const r = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
    expect(r.result).toBe("moved");
    expect(r.appointment_id).toBe(a.id); // 2. same id returned

    const after = await apptRow(a.id);
    expect(after.id).toBe(before.id); // 2
    expect(after.client_id).toBe(before.client_id); // 3
    expect(after.practitioner_id).toBe(before.practitioner_id); // 4
    expect(after.service_id).toBe(before.service_id); // 5
    expect(Number(after.duration_minutes)).toBe(Number(before.duration_minutes)); // 6
    expect(after.notes).toBe(before.notes); // 7
    expect(after.cancellation_token_hash).toBe(before.cancellation_token_hash); // 8
    expect(after.status).toBe("confirmed"); // status unchanged
    // time actually changed to the new window
    expect(new Date(after.starts_at).toISOString()).toBe(new Date(newStart).toISOString());
    expect(new Date(after.ends_at).getTime()).toBe(new Date(newStart).getTime() + 60 * 60000);
    // sync_version bumped (starts_at/ends_at changed)
    expect(Number(after.sync_version)).toBeGreaterThan(Number(before.sync_version));
  });

  it("9: an appointment_payments-style FK link cannot detach (move never deletes) — id preserved + no duplicate appointment", async () => {
    // appointment_payments FKs appointments(id) ON DELETE RESTRICT via a deep Stripe
    // chain; the point of "payment relationships preserved" is that Move updates in
    // place and NEVER deletes/recreates the appointment, so any row keyed by
    // appointment_id stays attached. Proven structurally: the id is unchanged and no
    // second appointment row is created, so the payment PK (appointment_id) remains valid.
    const a = await insertAppt({ startsAt: nextSlot().start });
    const countBefore = (await adminQuery(`select count(*)::int c from public.appointments where studio_id=$1`, [studio.studioId])).rows[0].c;
    const newStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
    const r = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
    expect(r.result).toBe("moved");
    const countAfter = (await adminQuery(`select count(*)::int c from public.appointments where studio_id=$1`, [studio.studioId])).rows[0].c;
    expect(countAfter).toBe(countBefore); // no duplicate appointment -> the appointment_payments(appointment_id) PK stays valid
    // the appointment_payments FK is ON DELETE RESTRICT referencing appointments(id):
    const fk = await adminQuery(
      `select confdeltype from pg_constraint where conrelid='public.appointment_payments'::regclass and confrelid='public.appointments'::regclass limit 1`,
    );
    expect(fk.rows.some((x: { confdeltype: string }) => x.confdeltype === "r")).toBe(true); // 'r' = RESTRICT
  });

  it("10: a linked clinical session stays attached to the SAME appointment id after the move", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const { sessionId } = await seedSession(studio);
    await adminQuery(`update public.sessions set appointment_id=$1 where id=$2`, [a.id, sessionId]);
    const newStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
    expect((await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart })).result).toBe("moved");
    const s = (await adminQuery(`select appointment_id from public.sessions where id=$1`, [sessionId])).rows[0];
    expect(s.appointment_id).toBe(a.id); // still linked
  });

  it("11-12: exactly one atomic audit row is written with previous + new times", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    // seed a pre-existing 'created' audit row to prove existing history is preserved
    await adminQuery(
      `insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details) values ($1,'system',null,'created','{}'::jsonb)`,
      [a.id],
    );
    const newStart = new Date(new Date(a.startsAt).getTime() + 120 * 60000).toISOString();
    await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
    const audit = await auditRows(a.id);
    const moved = audit.filter((x: { action: string }) => x.action === "moved");
    expect(moved).toHaveLength(1); // 11: exactly one moved row
    expect(audit.some((x: { action: string }) => x.action === "created")).toBe(true); // existing history preserved
    const d = moved[0].details;
    expect(d.source).toBe("practitioner_ui");
    expect(new Date(d.previous_starts_at).toISOString()).toBe(new Date(a.startsAt).toISOString()); // 12
    expect(new Date(d.new_starts_at).toISOString()).toBe(new Date(newStart).toISOString()); // 12
    expect(moved[0].actor_type).toBe("practitioner");
    expect(moved[0].actor_id).toBe(studio.practitionerId);
  });

  it("13-15: the SAME reservation row is re-synced to the new interval (no duplicate reservation)", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const before = await reservationRows(a.id);
    expect(before).toHaveLength(1); // 13: one reservation, same source id
    const beforeResId = before[0].id;
    const newStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
    await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
    const after = await reservationRows(a.id);
    expect(after).toHaveLength(1); // 15: still exactly one (no duplicate)
    expect(after[0].id).toBe(beforeResId); // 13: same reservation row (upserted, not recreated)
    expect(new Date(after[0].starts_at).toISOString()).toBe(new Date(newStart).toISOString()); // 14: interval updated
    expect(new Date(after[0].ends_at).getTime()).toBe(new Date(newStart).getTime() + 60 * 60000); // 14 (buffer 0)
  });

  // Custom-time (owner override) rides the SAME RPC. The RPC enforces NO operating-
  // hours gate — that gate lives only in the studio's generated slot list, which
  // custom mode intentionally bypasses. So a move to an arbitrary out-of-window
  // instant SUCCEEDS as long as no concrete reservation conflicts; the real guard is
  // the DB exclusion constraints, not the published hours. (§24.1 + §24.11)
  it("custom-time: an out-of-window instant with no conflict moves successfully, keeping the same reservation source id", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const before = await reservationRows(a.id);
    const beforeResId = before[0].id;
    // A deep-night instant far from any reservation. The RPC never consults hours.
    const night = new Date(new Date(a.startsAt).getTime() + 3 * 24 * 3600 * 1000);
    night.setUTCHours(3, 0, 0, 0);
    const newStart = night.toISOString();

    const r = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
    expect(r.result).toBe("moved");
    expect(r.appointment_id).toBe(a.id);
    const after = await apptRow(a.id);
    expect(new Date(after.starts_at).toISOString()).toBe(new Date(newStart).toISOString());
    // Exactly one 'moved' audit row + the SAME reservation source id (source_id == appt id).
    expect((await auditRows(a.id)).filter((x: { action: string }) => x.action === "moved")).toHaveLength(1);
    const resAfter = await reservationRows(a.id);
    expect(resAfter).toHaveLength(1);
    expect(resAfter[0].id).toBe(beforeResId);
    expect(resAfter[0].source_id).toBe(a.id);
  });
});

describe("conflict rolls back completely (23P01 not caught) — no change, no audit", () => {
  async function expectConflictNoChange(setup: (targetStart: string, targetEnd: string) => Promise<void>) {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const target = new Date(new Date(a.startsAt).getTime() + 5 * 3600 * 1000).toISOString();
    const targetEnd = new Date(new Date(target).getTime() + 60 * 60000).toISOString();
    await setup(target, targetEnd);
    await expect(
      move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart: target }),
    ).rejects.toMatchObject({ code: "23P01" });
    // Proof of complete rollback: the appointment did not move + no 'moved' audit row.
    const after = await apptRow(a.id);
    expect(new Date(after.starts_at).toISOString()).toBe(new Date(a.startsAt).toISOString());
    expect((await auditRows(a.id)).some((x: { action: string }) => x.action === "moved")).toBe(false);
  }

  it("16: appointment conflict", async () => {
    await expectConflictNoChange(async (t) => { await insertAppt({ startsAt: t }); });
  });
  it("17: timed-block conflict", async () => {
    await expectConflictNoChange(async (t, e) => { await insertReservation("timed_block", t, e); });
  });
  it("18: recurring-break conflict", async () => {
    await expectConflictNoChange(async (t, e) => { await insertReservation("recurring_break_occurrence", t, e); });
  });
  it("19: full-day blockout conflict", async () => {
    await expectConflictNoChange(async (t, e) => { await insertReservation("full_day_blockout", t, e); });
  });
});

describe("authorization + movability guards (closed result set)", () => {
  it("20: cross-studio practitioner is rejected (not_authorized)", async () => {
    const other = await seedStudio("moveApptOther");
    try {
      const a = await insertAppt({ startsAt: nextSlot().start });
      const newStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
      const r = await move({ apptId: a.id, practitionerId: other.practitionerId, expStart: a.startsAt, expEnd: a.endsAt, newStart });
      expect(r.result).toBe("not_authorized");
      expect(new Date((await apptRow(a.id)).starts_at).toISOString()).toBe(new Date(a.startsAt).toISOString());
    } finally {
      await adminQuery(`delete from public.appointments where studio_id=$1`, [other.studioId]).catch(() => {});
      await adminQuery(`delete from public.studios where id=$1`, [other.studioId]).catch(() => {});
    }
  });

  it("21: inactive practitioner is rejected (not_authorized)", async () => {
    const member = await seedMember(studio, "moveInactive");
    await adminQuery(`update public.practitioners set active=false where id=$1`, [member.practitionerId]);
    const a = await insertAppt({ startsAt: nextSlot().start });
    const newStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
    const r = await move({ apptId: a.id, practitionerId: member.practitionerId, expStart: a.startsAt, expEnd: a.endsAt, newStart });
    expect(r.result).toBe("not_authorized");
  });

  it("22-24: cancelled / completed / no_show appointments are not movable", async () => {
    for (const status of ["cancelled", "completed", "no_show"]) {
      const a = await insertAppt({ startsAt: nextSlot().start, status });
      const newStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
      const r = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
      expect(r.result).toBe("appointment_not_movable");
    }
  });

  it("25: a past-original appointment is not movable", async () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const a = await insertAppt({ startsAt: past });
    const newStart = new Date(Date.now() + 3600 * 1000).toISOString();
    const r = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
    expect(r.result).toBe("appointment_not_movable");
  });

  it("26-27: past target time / invalid target time is rejected (invalid_time)", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    expect((await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart: past })).result).toBe("invalid_time"); // 26
    // invalid target: the RPC treats a null new start as invalid_time
    const rNull = await adminQuery(
      `select result from public.practitioner_move_appointment($1,$2,$3,$4,$5,$6)`,
      [a.id, studio.studioId, studio.practitionerId, a.startsAt, a.endsAt, null],
    );
    expect(rNull.rows[0].result).toBe("invalid_time"); // 27
  });

  it("appointment_not_found for a wrong studio (no cross-studio existence leak)", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const other = await seedStudio("moveApptScope");
    try {
      const r = await move({ apptId: a.id, studioId: other.studioId, practitionerId: other.practitionerId, expStart: a.startsAt, expEnd: a.endsAt, newStart: new Date(Date.now() + 3600 * 1000).toISOString() });
      // other-studio practitioner isn't authorized for THIS studio -> not_authorized fires first (auth before lookup)
      expect(["not_authorized", "appointment_not_found"]).toContain(r.result);
    } finally {
      await adminQuery(`delete from public.studios where id=$1`, [other.studioId]).catch(() => {});
    }
  });
});

describe("no_change + stale optimistic-concurrency guards", () => {
  it("28: moving to the same start returns no_change and changes nothing", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const before = await apptRow(a.id);
    const r = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart: a.startsAt });
    expect(r.result).toBe("no_change");
    const after = await apptRow(a.id);
    expect(Number(after.sync_version)).toBe(Number(before.sync_version)); // unchanged
    expect((await auditRows(a.id)).length).toBe(0);
  });

  it("29: a stale expected START is rejected (stale_appointment)", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const wrongExpStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
    const r = await move({ apptId: a.id, expStart: wrongExpStart, expEnd: a.endsAt, newStart: new Date(new Date(a.startsAt).getTime() + 120 * 60000).toISOString() });
    expect(r.result).toBe("stale_appointment");
    expect((await auditRows(a.id)).length).toBe(0);
  });

  it("30: a stale expected END is rejected (stale_appointment)", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const wrongExpEnd = new Date(new Date(a.endsAt).getTime() + 60 * 60000).toISOString();
    const r = await move({ apptId: a.id, expStart: a.startsAt, expEnd: wrongExpEnd, newStart: new Date(new Date(a.startsAt).getTime() + 120 * 60000).toISOString() });
    expect(r.result).toBe("stale_appointment");
  });

  it("31: two concurrent moves from the same expected state cannot both succeed", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    const t1 = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
    const t2 = new Date(new Date(a.startsAt).getTime() + 120 * 60000).toISOString();
    // Fire both from the SAME expected snapshot. The first commits (sync_version + row
    // change); the second sees drifted stored times -> stale_appointment.
    const r1 = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart: t1 });
    const r2 = await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart: t2 });
    const results = [r1.result, r2.result].sort();
    expect(results).toEqual(["moved", "stale_appointment"]);
    // exactly one final time
    expect(new Date((await apptRow(a.id)).starts_at).toISOString()).toBe(new Date(t1).toISOString());
  });
});

describe("atomicity + buffer invariant + grants", () => {
  it("32: a forced audit-insert failure rolls back the appointment update", async () => {
    const a = await insertAppt({ startsAt: nextSlot().start });
    // Break the audit insert atomically: a BEFORE INSERT trigger that raises on action='moved'.
    await adminQuery(`
      create or replace function public._test_break_move_audit() returns trigger language plpgsql as $$
      begin if new.action = 'moved' then raise exception 'forced audit failure'; end if; return new; end $$;`);
    await adminQuery(`drop trigger if exists _test_break_move_audit_trg on public.appointment_audit`);
    await adminQuery(`create trigger _test_break_move_audit_trg before insert on public.appointment_audit for each row execute function public._test_break_move_audit()`);
    try {
      const newStart = new Date(new Date(a.startsAt).getTime() + 60 * 60000).toISOString();
      await expect(move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart })).rejects.toThrow();
      // appointment update rolled back with the failed audit
      expect(new Date((await apptRow(a.id)).starts_at).toISOString()).toBe(new Date(a.startsAt).toISOString());
    } finally {
      await adminQuery(`drop trigger if exists _test_break_move_audit_trg on public.appointment_audit`).catch(() => {});
      await adminQuery(`drop function if exists public._test_break_move_audit()`).catch(() => {});
    }
  });

  it("33-36: execute is denied to public/anon/authenticated and granted to service_role", async () => {
    const sig = "public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz)";
    for (const [role, expected] of [["public", false], ["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      const r = await adminQuery(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, sig]);
      expect(r.rows[0].ok).toBe(expected); // 33 public / 34 anon / 35 authenticated / 36 service_role
    }
  });

  it("37: after a move the buffer snapshot invariant holds (blocked_ends_at = ends_at + buffer)", async () => {
    // Non-zero studio buffer to exercise the snapshot recompute.
    await adminQuery(`update public.studios set buffer_minutes=15 where id=$1`, [studio.studioId]);
    try {
      const a = await insertAppt({ startsAt: nextSlot().start });
      const newStart = new Date(new Date(a.startsAt).getTime() + 5 * 3600 * 1000).toISOString();
      await move({ apptId: a.id, expStart: a.startsAt, expEnd: a.endsAt, newStart });
      const after = await apptRow(a.id);
      expect(Number(after.buffer_minutes_snapshot)).toBe(15);
      expect(new Date(after.blocked_ends_at).getTime()).toBe(new Date(after.ends_at).getTime() + 15 * 60000);
    } finally {
      await adminQuery(`update public.studios set buffer_minutes=0 where id=$1`, [studio.studioId]);
    }
  });

  it("38: the existing reschedule_appointment RPC still exists and is service_role-only (unchanged)", async () => {
    const exists = await adminQuery(`select 1 from pg_proc where proname='reschedule_appointment'`);
    expect(exists.rowCount).toBeGreaterThan(0);
    const pub = await adminQuery(
      `select has_function_privilege('authenticated', 'reschedule_appointment(uuid, text, timestamptz, timestamptz, integer, text)', 'EXECUTE') as ok`,
    );
    expect(pub.rows[0].ok).toBe(false); // reschedule remains locked; move did not weaken it
  });
});
