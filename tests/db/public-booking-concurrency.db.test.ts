import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// TWO-CONNECTION CONCURRENCY PROOFS for create_public_appointment.
// ===========================================================================
//
// THE RACE THIS CLOSES. A conflict-derived candidate exists only BECAUSE some
// appointment generates it: an appointment ending 14:00 with a 30-minute buffer
// is what makes 14:30 an offered start. Structural calendar writers all take the
// studio capacity advisory lock, but the appointment LIFECYCLE writers do not,
// public_cancel_appointment_with_token, practitioner_cancel_appointment,
// mark_appointment_complete, mark_appointment_no_show and reschedule_appointment
// each lock only their own appointment row.
//
// So a cancellation could land between membership validation and the insert,
// removing the very source that made the slot legal. Nothing else would reject
// it: with the conflict gone there is no overlap for the GiST exclusion and no
// gap for HB001.
//
// The command now locks the window's appointment SOURCE rows FOR UPDATE, in id
// order, before deriving the candidate set. These tests prove the blocking
// actually happens rather than inferring it from source text.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

/** Poll pg_stat_activity until `pid` is actually waiting on a lock. */
async function waitUntilBlocked(pid: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await adminQuery(
      `select wait_event_type, state from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

type Fixture = {
  studioId: string;
  ownerId: string;
  clientId: string;
  serviceId: string;
  blockerId: string;
  candidate: string;
};

/**
 * A studio open 09:00-17:00 UTC with a 30-minute buffer, holding one appointment
 * whose buffered end produces a conflict-derived candidate that is NOT on the
 * hourly fallback grid.
 */
async function seedWithConflictCandidate(label: string): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;

  await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios (id,name,owner_email,timezone,buffer_minutes,slug,public_booking_horizon_months)
     values ($1,$2,$3,'UTC',30,$4,3)`,
    [studioId, `Conc ${label}`, email, `${label}-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
     values ($1,$2,$3,'Owner',$4,'owner',true)`,
    [ownerId, studioId, userId, email],
  );
  await adminQuery(`insert into public.clients (id,studio_id,name,email) values ($1,$2,'C',$3)`, [
    clientId,
    studioId,
    `c-${studioId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.services (id,studio_id,name,default_duration_minutes,active)
     values ($1,$2,'Service',60,true)`,
    [serviceId, studioId],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
     select $1,g,true,'09:00','17:00',null from generate_series(0,6) g`,
    [studioId],
  );

  // Blocker 13:00-14:00 in five days. Buffer 30 => protected end 14:30, which is
  // an offered candidate but is NOT one of the 09:00/10:00/... hourly anchors.
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 5);
  const at = (h: number, m = 0) => {
    const d = new Date(day);
    d.setUTCHours(h, m, 0, 0);
    return d.toISOString();
  };
  const blocker = await adminQuery(
    `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
    [studioId, clientId, serviceId, at(13), hash64()],
  );
  if (blocker.rows[0].result !== "created") {
    throw new Error(`blocker seed failed: ${blocker.rows[0].result}`);
  }
  return {
    studioId,
    ownerId,
    clientId,
    serviceId,
    blockerId: blocker.rows[0].appointment_id,
    candidate: at(14, 30),
  };
}

afterAll(async () => {
  await closePool();
});

describe("Test A: a cancellation of the candidate's SOURCE blocks on the create", () => {
  it("B waits while A holds the source-row lock, and the final state is a valid serial order", async () => {
    const f = await seedWithConflictCandidate("race-a");

    // Sanity: 14:30 is a genuine conflict-derived candidate right now.
    const pre = await adminQuery(
      `select 1 from public.public_booking_slot_candidates($1,$2::date,60) c where c = $3::timestamptz`,
      [f.studioId, f.candidate.slice(0, 10), f.candidate],
    );
    expect(pre.rowCount, "14:30 must be an offered candidate before the race").toBe(1);

    const A = await conn();
    const B = await conn();
    try {
      const bPid = (await B.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;

      // A: open a transaction and take the command's locks WITHOUT committing.
      await A.query("begin");
      await A.query(
        `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
        [f.studioId, f.clientId, f.serviceId, f.candidate, hash64()],
      );

      // B: try to cancel the source appointment. It must BLOCK on A's row lock.
      const bPromise = B.query(
        `update public.appointments set status='cancelled', cancelled_at=now(), cancelled_by='client'
          where id = $1`,
        [f.blockerId],
      );
      const blocked = await waitUntilBlocked(bPid);
      expect(blocked, "the cancellation must WAIT on the create's source-row lock").toBe(true);

      // A commits; B then proceeds.
      await A.query("commit");
      await bPromise;

      // Final state is the valid serial order A-then-B: the new appointment
      // exists (it was a legal candidate when A ran) and the source is cancelled.
      const created = await adminQuery(
        `select count(*)::int n from public.appointments
          where studio_id=$1 and starts_at=$2::timestamptz and status='confirmed'`,
        [f.studioId, f.candidate],
      );
      expect(created.rows[0].n).toBe(1);
      const src = await adminQuery(`select status from public.appointments where id=$1`, [
        f.blockerId,
      ]);
      expect(src.rows[0].status).toBe("cancelled");
    } finally {
      await A.query("rollback").catch(() => undefined);
      await A.end();
      await B.end();
    }
  }, 30_000);
});

describe("Test B: when the cancellation wins first, the candidate is correctly refused", () => {
  it("returns not_a_public_slot and creates no appointment, audit row or reservation", async () => {
    const f = await seedWithConflictCandidate("race-b");

    // Cancel the source BEFORE the create runs at all.
    await adminQuery(
      `update public.appointments set status='cancelled', cancelled_at=now(), cancelled_by='client'
        where id=$1`,
      [f.blockerId],
    );

    const before = await adminQuery(
      `select (select count(*) from public.appointments where studio_id=$1 and status='confirmed') a,
              (select count(*) from public.studio_calendar_reservations where studio_id=$1) r`,
      [f.studioId],
    );

    const res = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, f.candidate, hash64()],
    );
    expect(
      res.rows[0].result,
      "14:30 only existed because of the now-cancelled appointment",
    ).toBe("not_a_public_slot");

    const after = await adminQuery(
      `select (select count(*) from public.appointments where studio_id=$1 and status='confirmed') a,
              (select count(*) from public.studio_calendar_reservations where studio_id=$1) r,
              (select count(*) from public.appointment_audit x
                 join public.appointments ap on ap.id = x.appointment_id
                where ap.studio_id=$1 and ap.starts_at=$2::timestamptz) au`,
      [f.studioId, f.candidate],
    );
    expect(after.rows[0].a).toBe(before.rows[0].a);
    expect(after.rows[0].r).toBe(before.rows[0].r);
    expect(after.rows[0].au).toBe("0");
  }, 30_000);
});

describe("Test C: structural writers stay serialized and do not deadlock", () => {
  it("a timed-block insert blocks on the advisory lock the create holds", async () => {
    const f = await seedWithConflictCandidate("race-c");
    const A = await conn();
    const B = await conn();
    try {
      const bPid = (await B.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      await A.query("begin");
      await A.query(
        `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
        [f.studioId, f.clientId, f.serviceId, f.candidate, hash64()],
      );

      const bPromise = B.query(
        `insert into public.studio_timed_blocks (studio_id,starts_at,ends_at,category,practitioner_id)
         values ($1, now() + interval '40 days', now() + interval '40 days 1 hour','admin',null)`,
        [f.studioId],
      );
      const blocked = await waitUntilBlocked(bPid);
      expect(blocked, "structural writers must still serialize through the advisory lock").toBe(
        true,
      );

      await A.query("commit");
      await bPromise; // completes without deadlock
    } finally {
      await A.query("rollback").catch(() => undefined);
      await A.end();
      await B.end();
    }
  }, 30_000);
});

describe("Test D: a competing row lock on the source is serialized behind the create", () => {
  // RENAMED (appointment boundary B2). This test was previously titled
  // "mark_appointment_complete on the source waits for the create", which it
  // never did: the statement it runs is a bare `select ... for update`, and
  // mark_appointment_complete is not called anywhere in this file. The title
  // claimed an RPC invocation that did not happen.
  //
  // The behaviour it genuinely measures is worth keeping and is UNCHANGED,
  // a competing FOR UPDATE on the source row blocks until the booking
  // transaction commits. Holding the row lock directly is in fact the
  // sharpest way to observe that ordering, because it removes every other
  // variable the real commands would introduce.
  //
  // Command-level lifecycle behaviour, every refusal branch, the audit row,
  // the rollback invariant and the EXECUTE grant matrix for
  // mark_appointment_complete, mark_appointment_no_show and
  // practitioner_cancel_appointment, is now covered behaviourally in
  // tests/db/appointment-lifecycle-commands.db.test.ts.
  it("a competing FOR UPDATE on the source row waits for the booking transaction", async () => {
    // complete/no-show/cancel all lock only the appointment row and never take
    // the advisory lock, so a bare row lock is a faithful stand-in for that
    // whole class of writer.
    const f = await seedWithConflictCandidate("race-d");
    const A = await conn();
    const B = await conn();
    try {
      const bPid = (await B.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      await A.query("begin");
      await A.query(
        `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
        [f.studioId, f.clientId, f.serviceId, f.candidate, hash64()],
      );

      const bPromise = B.query(
        `select * from public.appointments where id=$1 for update`,
        [f.blockerId],
      );
      const blocked = await waitUntilBlocked(bPid);
      expect(
        blocked,
        "a competing row lock must wait on the create's source lock",
      ).toBe(true);

      await A.query("commit");
      await bPromise;
    } finally {
      await A.query("rollback").catch(() => undefined);
      await A.end();
      await B.end();
    }
  }, 30_000);
});

describe("no deadlock in the reverse direction", () => {
  it("a lifecycle writer holding an appointment row never waits on the advisory lock", async () => {
    // The safety argument for the new lock order: create takes
    // studios -> advisory -> services -> appointments, and NO path acquires the
    // advisory lock AFTER an appointment row lock. Verified against the live
    // function bodies rather than asserted.
    const r = await adminQuery(
      `select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and p.proname in ('public_cancel_appointment_with_token','practitioner_cancel_appointment',
                            'mark_appointment_complete','mark_appointment_no_show')`,
    );
    // B6 / 0175: the legacy `reschedule_appointment` left this set when it was
    // dropped after a zero-caller census, so the census is four.
    //
    // `reschedule_appointment_v2` is deliberately NOT swapped in as its
    // replacement. Measured against the live body, v2 DOES acquire
    // acquire_studio_capacity_lock, correctly, because it is a
    // cancel-plus-successor CREATING command rather than an in-place lifecycle
    // writer, so it belongs to the create lock path this test's premise
    // excludes. Substituting it would have inverted the test's meaning and
    // failed for the right reason at the wrong assertion. Its own ordering is
    // covered by tests/db/public-reschedule-command.db.test.ts.
    // B7 / 0176: the census selects by NAME, and
    // public_cancel_appointment_with_token is now OVERLOADED, the 7-argument
    // atomic command plus the fail-closed 5-argument compatibility shim. So the
    // row count is five while the writer SET is still four.
    //
    // Asserted as identity rather than as a number: a bare count of 5 would be
    // satisfied by an unrelated fifth lifecycle writer appearing, which is
    // exactly what this tripwire exists to catch. Both cancel overloads take
    // studios -> appointments and neither acquires the advisory lock, so the
    // premise is unchanged; the loop below now proves it for five bodies.
    expect(new Set(r.rows.map((row) => row.proname))).toEqual(
      new Set([
        "public_cancel_appointment_with_token",
        "practitioner_cancel_appointment",
        "mark_appointment_complete",
        "mark_appointment_no_show",
      ]),
    );
    expect(
      r.rows.filter((row) => row.proname === "public_cancel_appointment_with_token"),
      "the cancel command is overloaded exactly twice (7-arg command + 5-arg shim)",
    ).toHaveLength(2);
    expect(r.rowCount).toBe(5);
    for (const row of r.rows) {
      expect(
        row.prosrc,
        `${row.proname} must not acquire the studio capacity advisory lock (it would invert the order)`,
      ).not.toMatch(/acquire_studio_capacity_lock/);
    }
  });
});

describe("owner resolution is a single snapshot", () => {
  // A previous revision counted the active owners and then re-selected the id in
  // a SECOND statement. Under READ COMMITTED each statement takes a fresh
  // snapshot, so a concurrent activation committing between them could leave the
  // count seeing 1 while the lookup saw 2, and a non-STRICT `select ... into`
  // then assigns one unspecified row, recreating arbitrary assignment.

  async function seedTwoOwners(label: string) {
    const studioId = randomUUID();
    const mkUser = async () => {
      const u = randomUUID();
      await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [
        u,
        `${label}-${u.slice(0, 8)}@harness.local`,
      ]);
      return u;
    };
    const uA = await mkUser();
    const uB = await mkUser();
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const clientId = randomUUID();
    const serviceId = randomUUID();
    await adminQuery(
      `insert into public.studios (id,name,owner_email,timezone,buffer_minutes,slug,public_booking_horizon_months)
       values ($1,$2,$3,'UTC',30,$4,3)`,
      [studioId, `Own ${label}`, `${label}@harness.local`, `${label}-${studioId.slice(0, 8)}`],
    );
    await adminQuery(
      `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
       values ($1,$2,$3,'A',$4,'owner',true), ($5,$2,$6,'B',$7,'owner',false)`,
      [
        ownerA,
        studioId,
        uA,
        `a-${ownerA.slice(0, 8)}@harness.local`,
        ownerB,
        uB,
        `b-${ownerB.slice(0, 8)}@harness.local`,
      ],
    );
    await adminQuery(`insert into public.clients (id,studio_id,name,email) values ($1,$2,'C',$3)`, [
      clientId,
      studioId,
      `c-${studioId.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.services (id,studio_id,name,default_duration_minutes,active)
       values ($1,$2,'S',60,true)`,
      [serviceId, studioId],
    );
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       select $1,g,true,'09:00','17:00',null from generate_series(0,6) g`,
      [studioId],
    );
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 4);
    day.setUTCHours(10, 0, 0, 0);
    return { studioId, ownerA, ownerB, clientId, serviceId, when: day.toISOString() };
  }

  it("O6: a concurrent owner ACTIVATION yields a valid serial outcome, never a mixed snapshot", async () => {
    const f = await seedTwoOwners("o6");
    const A = await conn();
    const B = await conn();
    try {
      const bPid = (await B.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;

      // A begins the command and holds the studio row lock.
      await A.query("begin");
      const created = await A.query(
        `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
        [f.studioId, f.clientId, f.serviceId, f.when, hash64()],
      );

      // B tries to activate the second owner while A is in flight.
      const bPromise = B.query(`update public.practitioners set active = true where id = $1`, [
        f.ownerB,
      ]);
      // Activation does not touch the studio row, so it may or may not block;
      // what matters is that A's decision came from ONE snapshot.
      await waitUntilBlocked(bPid, 1500);

      await A.query("commit");
      await bPromise;

      // A saw exactly one active owner in its single snapshot, so it assigned A.
      // The only other valid serial outcome would be null (had it seen two).
      const assigned = created.rows[0].practitioner_id as string | null;
      expect(
        assigned === f.ownerA || assigned === null,
        `assignment must be a valid serial outcome, got ${assigned}`,
      ).toBe(true);
      expect(assigned, "owner B was inactive at decision time and must never be chosen").not.toBe(
        f.ownerB,
      );
    } finally {
      await A.query("rollback").catch(() => undefined);
      await A.end();
      await B.end();
    }
  }, 30_000);

  it("O7: a concurrent owner INSERT cannot produce a mixed-snapshot assignment", async () => {
    const f = await seedTwoOwners("o7");
    const A = await conn();
    const B = await conn();
    try {
      await A.query("begin");
      const created = await A.query(
        `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
        [f.studioId, f.clientId, f.serviceId, f.when, hash64()],
      );

      const newUser = randomUUID();
      await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [
        newUser,
        `n-${newUser.slice(0, 8)}@harness.local`,
      ]);
      const bPromise = B.query(
        `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
         values (gen_random_uuid(),$1,$2,'New',$3,'owner',true)`,
        [f.studioId, newUser, `n-${newUser.slice(0, 8)}@harness.local`],
      );

      await A.query("commit");
      await bPromise;

      const assigned = created.rows[0].practitioner_id as string | null;
      expect(
        assigned === f.ownerA || assigned === null,
        `assignment must be a valid serial outcome, got ${assigned}`,
      ).toBe(true);
    } finally {
      await A.query("rollback").catch(() => undefined);
      await A.end();
      await B.end();
    }
  }, 30_000);

  it("the resolution is ONE statement, no count-then-select shape survives", async () => {
    const r = await adminQuery(
      `select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='create_public_appointment'`,
    );
    const src = r.rows[0].prosrc as string;
    expect(src, "no separate owner count statement").not.toMatch(/count\(\*\)\s+into\s+v_owner_count/);
    expect(src, "no oldest/newest winner").not.toMatch(/order by pr\.created_at/);
    // Exactly one statement reads the active-owner set.
    const ownerReads = (src.match(/role\s*=\s*'owner'/g) ?? []).length;
    expect(ownerReads, "the active-owner set must be read exactly once").toBe(1);
    expect(src).toMatch(/with active_owners as materialized/);
    expect(src).toMatch(/when count\(\*\) = 1 then \(array_agg\(id\)\)\[1\] else null end/);
  });
});

// ===========================================================================
// Appointment boundary B2, title-truthfulness guard for THIS file
// ===========================================================================
//
// One test in this file was titled "mark_appointment_complete on the source
// waits for the create" while running a bare `select ... for update` and never
// invoking that RPC. A wrong title is not cosmetic: it is what let a
// never-tested command look covered for the whole life of the file, and the
// boundary audit found the gap only by reading the body.
//
// This guard makes the same mistake mechanical rather than editorial. If a
// test title in this file names a lifecycle RPC, the file must actually call
// that RPC.

describe("test titles in this file do not overclaim which RPC they invoke", () => {
  const SELF = readFileSync(
    path.resolve(__dirname, "public-booking-concurrency.db.test.ts"),
    "utf8",
  );

  const LIFECYCLE_RPCS = [
    "mark_appointment_complete",
    "mark_appointment_no_show",
    "practitioner_cancel_appointment",
    "public_cancel_appointment_with_token",
    "reschedule_appointment_v2",
    "move_or_reassign_appointment",
  ];

  // A title may name an RPC only if the file genuinely invokes it, i.e. the
  // source contains a `public.<rpc>(` call, not merely the bare name (which
  // also appears inside the prosrc-scan test's `in (...)` list).
  function overclaimedRpcs(title: string, source: string): string[] {
    return LIFECYCLE_RPCS.filter(
      (rpc) =>
        title.includes(rpc) &&
        !new RegExp(`public\\.${rpc}\\s*\\(`).test(source),
    );
  }

  const titles = [...SELF.matchAll(/\bit\(\s*"([^"]+)"/g)].map((m) => m[1]);

  it("the title scanner actually found this file's tests", () => {
    // Anti-vacuity: if the regex stopped matching, the guard below would
    // iterate an empty list and pass while checking nothing.
    expect(titles.length).toBeGreaterThan(5);
  });

  it("the overclaim detector detects a real overclaim (self-test, both directions)", () => {
    // The exact title this file used to carry, must be flagged.
    expect(
      overclaimedRpcs(
        "mark_appointment_complete on the source waits for the create",
        SELF,
      ),
    ).toEqual(["mark_appointment_complete"]);
    // The corrected title: must be clean.
    expect(
      overclaimedRpcs(
        "a competing FOR UPDATE on the source row waits for the booking transaction",
        SELF,
      ),
    ).toEqual([]);
  });

  it("no test in this file names a lifecycle RPC it never invokes", () => {
    for (const title of titles) {
      expect(
        overclaimedRpcs(title, SELF),
        `test title overclaims an RPC this file never calls: "${title}"`,
      ).toEqual([]);
    }
  });
});
