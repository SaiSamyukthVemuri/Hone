import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { randomUUID } from "node:crypto";

// ===========================================================================
// TWO-CONNECTION CONCURRENCY PROOFS for reschedule_appointment_v2 (0171).
// ===========================================================================
//
// THE RACES THIS CLOSES.
//
// 1. DUPLICATE SUBMIT. The legacy RPC took only the original appointment's own
//    row lock. Two submissions carrying the same token could both pass their
//    checks and both create a successor, because the second one's `for update`
//    on the original was satisfied the moment the first committed — and nothing
//    re-read the status afterwards inside the same statement.
//
// 2. THE CANDIDATE-SOURCE RACE. A conflict-derived candidate exists only
//    BECAUSE some appointment generates it. Cancel that appointment between
//    validation and insert and the candidate silently stops being offered, with
//    no GiST overlap and no HB001 gap left to reject the write.
//
// The command locks the studio row, then the capacity advisory lock, then every
// relevant appointment row in id order — INCLUDING the original, by an explicit
// `a.id = p_original_appointment_id` disjunct, so an original whose current
// start lies outside the replacement window is still locked.
//
// These tests prove the BLOCKING ACTUALLY HAPPENS by polling pg_stat_activity,
// rather than inferring it from two promises resolving in a pleasing order.
// Each has a negative control alongside it.

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
      `select wait_event_type from pg_stat_activity where pid = $1`,
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
  originalId: string;
  originalHash: string;
  originalStart: string;
};

function at(days: number, hh: number, mm = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

async function seed(label: string): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const originalId = randomUUID();
  const originalHash = hash64();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;

  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios
       (id, name, owner_email, timezone, buffer_minutes, slug, public_booking_horizon_months)
     values ($1,$2,$3,'UTC',15,$4,3)`,
    [studioId, `Conc ${label}`, email, `${label}-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,'Owner',$4,'owner',true)`,
    [ownerId, studioId, userId, email],
  );
  await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,'C',$3)`, [
    clientId,
    studioId,
    `c-${studioId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1,$2,'S',45,true)`,
    [serviceId, studioId],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '00:00', '23:59', null from generate_series(0,6) g`,
    [studioId],
  );

  // The original deliberately sits 40 days out — WELL OUTSIDE the replacement
  // date window a naive window-only lock predicate would cover.
  const originalStart = at(40, 14, 0);
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4,$5,$6, $6::timestamptz + make_interval(mins => 45), 45,
             'confirmed', $7)`,
    [originalId, studioId, ownerId, clientId, serviceId, originalStart, originalHash],
  );

  return { studioId, ownerId, clientId, serviceId, originalId, originalHash, originalStart };
}

const CALL = `select * from public.reschedule_appointment_v2($1,$2,$3,$4,true,null)`;

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------

describe("0171 concurrency — duplicate submit with the same token", () => {
  it("serialises two concurrent reschedules: exactly one successor, one refusal", async () => {
    const f = await seed("dup");
    const a = await conn();
    const b = await conn();
    try {
      const bPid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;

      await a.query("begin");
      // A takes the studio lock and every relevant appointment lock, then stops
      // short of committing.
      const aRes = await a.query(CALL, [
        f.originalId,
        f.originalHash,
        at(11, 10, 0),
        hash64(),
      ]);
      expect(aRes.rows[0].result).toBe("success");

      // B enters the same command and MUST block on A's studio row lock.
      const bPromise = b
        .query("begin")
        .then(() =>
          b.query(CALL, [f.originalId, f.originalHash, at(12, 10, 0), hash64()]),
        );
      const blocked = await waitUntilBlocked(bPid);
      expect(blocked).toBe(true);

      await a.query("commit");
      const bRes = await bPromise;
      await b.query("commit");

      // B re-read the original UNDER the locks and saw it cancelled.
      expect(bRes.rows[0].result).toBe("appointment_not_reschedulable");

      const successors = await adminQuery(
        `select count(*)::int n from public.appointments where rescheduled_from_appointment_id = $1`,
        [f.originalId],
      );
      expect(successors.rows[0].n).toBe(1);

      const audits = await adminQuery(
        `select count(*)::int n from public.appointment_audit where appointment_id = $1`,
        [f.originalId],
      );
      expect(audits.rows[0].n).toBe(1);

      const reservations = await adminQuery(
        `select count(*)::int n from public.studio_calendar_reservations
          where source_kind = 'appointment' and source_id = $1`,
        [f.originalId],
      );
      expect(reservations.rows[0].n).toBe(0);
    } finally {
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    }
  });

  it("NEGATIVE CONTROL: without a competing transaction the second call is not blocked", async () => {
    const f = await seed("dupctl");
    const b = await conn();
    try {
      const bPid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
      await b.query("begin");
      const p = b.query(CALL, [f.originalId, f.originalHash, at(11, 10, 0), hash64()]);
      // Nothing holds the studio lock, so this must NOT report as lock-waiting.
      const blocked = await waitUntilBlocked(bPid, 1200);
      expect(blocked).toBe(false);
      const r = await p;
      expect(r.rows[0].result).toBe("success");
      await b.query("commit");
    } finally {
      await b.end().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------

describe("0171 concurrency — lifecycle transitions versus reschedule", () => {
  it.each([
    ["practitioner cancellation", "cancelled"],
    ["completion", "completed"],
    ["no-show", "no_show"],
  ])("%s that commits first makes the reschedule refuse", async (_label, status) => {
    const f = await seed(`life-${status}`);
    const a = await conn();
    const b = await conn();
    try {
      const bPid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;

      // A moves the original out of 'confirmed' and holds the row lock.
      await a.query("begin");
      await a.query(
        `update public.appointments set status = $2 where id = $1`,
        [f.originalId, status],
      );

      // B enters the command and blocks on A's appointment row lock.
      const bPromise = b
        .query("begin")
        .then(() =>
          b.query(CALL, [f.originalId, f.originalHash, at(11, 10, 0), hash64()]),
        );
      expect(await waitUntilBlocked(bPid)).toBe(true);

      await a.query("commit");
      const bRes = await bPromise;
      await b.query("commit");

      expect(bRes.rows[0].result).toBe("appointment_not_reschedulable");

      const successors = await adminQuery(
        `select count(*)::int n from public.appointments where rescheduled_from_appointment_id = $1`,
        [f.originalId],
      );
      expect(successors.rows[0].n).toBe(0);
    } finally {
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    }
  });

  it("a reschedule that commits first makes a later cancellation see a cancelled row", async () => {
    const f = await seed("resched-first");
    const a = await conn();
    try {
      await a.query("begin");
      const r = await a.query(CALL, [
        f.originalId,
        f.originalHash,
        at(11, 10, 0),
        hash64(),
      ]);
      expect(r.rows[0].result).toBe("success");
      await a.query("commit");

      const orig = await adminQuery(
        `select status, cancellation_kind from public.appointments where id = $1`,
        [f.originalId],
      );
      expect(orig.rows[0].status).toBe("cancelled");
      expect(orig.rows[0].cancellation_kind).toBe("rescheduled");
    } finally {
      await a.end().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------

describe("0171 concurrency — the target slot is taken first", () => {
  it("another booking that commits first forces a refusal, and the original survives", async () => {
    const f = await seed("taken");
    const target = at(11, 10, 0);
    const a = await conn();
    const b = await conn();
    try {
      const bPid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;

      // A takes the studio lock and books the exact target interval.
      await a.query("begin");
      await a.query(
        `select 1 from public.studios where id = $1 for update`,
        [f.studioId],
      );
      await a.query(
        `insert into public.appointments
           (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
            duration_minutes, status, cancellation_token_hash)
         values ($1,$2,$3,$4,$5, $5::timestamptz + make_interval(mins => 45), 45,
                 'confirmed', $6)`,
        [f.studioId, f.ownerId, f.clientId, f.serviceId, target, hash64()],
      );

      const bPromise = b
        .query("begin")
        .then(() => b.query(CALL, [f.originalId, f.originalHash, target, hash64()]));
      expect(await waitUntilBlocked(bPid)).toBe(true);

      await a.query("commit");
      const bRes = await bPromise;
      await b.query("commit");

      // The interval is gone, so the command refuses with a closed code — it
      // never raises a raw 23P01 to the caller.
      expect(["time_unavailable", "not_a_public_slot"]).toContain(bRes.rows[0].result);

      const orig = await adminQuery(
        `select status, cancellation_token_hash, rescheduled_to_appointment_id
           from public.appointments where id = $1`,
        [f.originalId],
      );
      expect(orig.rows[0].status).toBe("confirmed");
      expect(orig.rows[0].cancellation_token_hash).toBe(f.originalHash);
      expect(orig.rows[0].rescheduled_to_appointment_id).toBeNull();

      const res = await adminQuery(
        `select count(*)::int n from public.studio_calendar_reservations
          where source_kind = 'appointment' and source_id = $1`,
        [f.originalId],
      );
      expect(res.rows[0].n).toBe(1);
    } finally {
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------

describe("0171 concurrency — structural schedule writers", () => {
  it("an availability writer holding the advisory lock blocks the command", async () => {
    const f = await seed("avail");
    const a = await conn();
    const b = await conn();
    try {
      const bPid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;

      await a.query("begin");
      await a.query(`select public.acquire_studio_capacity_lock($1)`, [f.studioId]);

      const bPromise = b
        .query("begin")
        .then(() =>
          b.query(CALL, [f.originalId, f.originalHash, at(11, 10, 0), hash64()]),
        );
      expect(await waitUntilBlocked(bPid)).toBe(true);

      await a.query("commit");
      const bRes = await bPromise;
      await b.query("commit");
      expect(bRes.rows[0].result).toBe("success");
    } finally {
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------

describe("0171 concurrency — rollback completeness", () => {
  it("an explicit rollback after a successful command leaves NOTHING behind", async () => {
    const f = await seed("rollback");
    const a = await conn();
    try {
      await a.query("begin");
      const r = await a.query(CALL, [
        f.originalId,
        f.originalHash,
        at(11, 10, 0),
        hash64(),
      ]);
      expect(r.rows[0].result).toBe("success");
      const successorId = r.rows[0].new_appointment_id as string;
      await a.query("rollback");

      // Original: untouched, still confirmed, still holding its reservation.
      const orig = await adminQuery(
        `select status, cancellation_kind, cancellation_token_hash,
                rescheduled_to_appointment_id
           from public.appointments where id = $1`,
        [f.originalId],
      );
      expect(orig.rows[0].status).toBe("confirmed");
      expect(orig.rows[0].cancellation_kind).toBeNull();
      expect(orig.rows[0].cancellation_token_hash).toBe(f.originalHash);
      expect(orig.rows[0].rescheduled_to_appointment_id).toBeNull();

      // Successor, audits, acknowledgement and reservation: all gone.
      const succ = await adminQuery(`select count(*)::int n from public.appointments where id = $1`, [
        successorId,
      ]);
      expect(succ.rows[0].n).toBe(0);

      const audits = await adminQuery(
        `select count(*)::int n from public.appointment_audit where appointment_id in ($1,$2)`,
        [f.originalId, successorId],
      );
      expect(audits.rows[0].n).toBe(0);

      const acks = await adminQuery(
        `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id = $1`,
        [f.studioId],
      );
      expect(acks.rows[0].n).toBe(0);

      const res = await adminQuery(
        `select source_id from public.studio_calendar_reservations
          where source_kind = 'appointment' and source_id in ($1,$2)`,
        [f.originalId, successorId],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].source_id).toBe(f.originalId);

      const outbox = await adminQuery(
        `select count(*)::int n from public.calendar_sync_outbox where studio_id = $1`,
        [f.studioId],
      );
      expect(outbox.rows[0].n).toBe(0);
    } finally {
      await a.end().catch(() => {});
    }
  });
});
