import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// ===========================================================================
// THE DOUBLE-SUBMIT PREMISE, MEASURED (not assumed).
// ===========================================================================
//
// A booking request key is meant to make a RETRY or a DOUBLE SUBMIT of one booking safe. Before it is designed around a failure mode, this file measures
// what the public booking command does TODAY when the same booking is submitted twice at once (two browser tabs, a double click, a retry after a lost
// answer). It does not test the key (it does not exist yet); it records the behaviour the key has to improve.
//
// WHAT THE COMMAND DOES (read from the latest definitions, MEASURED below): the public command first locks the studio's own row (`select ... for update`)
// and then takes the studio capacity advisory lock, so two submits to one studio SERIALISE; they never race to the insert. Measured on a fresh stack: the
// second submit is seen waiting with wait_event_type Lock / wait_event transactionid (that row lock), until the first commits. The second therefore sees the first's committed appointment and is judged against
// it. Three things can then happen, and each is a test:
//   1. studio with capacity OFF (studio-wide exclusion): the second submit is REFUSED as unavailable. It is not replayed (the client who lost the answer
//      is told the slot is gone) and it is not duplicated.
//   2. capacity ON, a practitioner NAMED: the per-practitioner exclusion refuses the second submit, the same way.
//   3. capacity ON, NO practitioner named ("any available"): the second submit is judged against the practitioners who are still free, so it can be
//      ASSIGNED TO ANOTHER PRACTITIONER. That is a duplicate booking for one client at one time, and it is the defect a request key closes.
// Each test names its outcome so a change in the command's behaviour (or a key that starts replaying) is a visible, deliberate edit here.

let B: SynthStudio;
let serviceId: string;

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

/** A start time inside the booking horizon, an hour mark in UTC, on the weekday the availability rows cover (all seven days). */
function startsAt(daysAhead: number, hour: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

/** Poll pg_stat_activity until `pid` is waiting on a lock; returns what it waits on (the evidence), or null if it never waits. */
async function waitUntilBlocked(pid: number, timeoutMs = 8000): Promise<{ type: string; event: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await adminQuery(`select wait_event_type, wait_event from pg_stat_activity where pid = $1`, [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return { type: r.rows[0].wait_event_type, event: r.rows[0].wait_event };
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
}

type Result = { result: string; appointment_id: string | null };

/** The public command, eight-argument form, with the practitioner optional. Each call carries its OWN cancellation token hash, as every form submit does. */
const submit = (c: Client, start: string, practitionerId: string | null) =>
  c.query<Result>(`select * from public.create_public_appointment_v2($1,$2,$3,$4::timestamptz,$5,null,null,$6)`, [B.studioId, B.clientId, serviceId, start, hash64(), practitionerId]);

/** Submit the SAME booking twice at once: A holds the command's locks in an open transaction, B starts and must WAIT, then A commits and B runs. */
async function doubleSubmit(start: string, practitionerId: string | null): Promise<{ a: Result; b: Result; bWaited: { type: string; event: string } | null }> {
  const A = await conn();
  const Bc = await conn();
  try {
    const bPid = (await Bc.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
    await A.query("begin");
    const a = (await submit(A, start, practitionerId)).rows[0];
    const bPromise = submit(Bc, start, practitionerId);
    const bWaited = await waitUntilBlocked(bPid);
    await A.query("commit");
    const b = (await bPromise).rows[0];
    return { a, b, bWaited };
  } finally {
    await A.query("rollback").catch(() => undefined);
    await A.end();
    await Bc.end();
  }
}

const confirmedAt = async (start: string) =>
  (await adminQuery(`select practitioner_id, client_id from public.appointments where studio_id=$1 and starts_at=$2::timestamptz and status='confirmed' order by practitioner_id`, [B.studioId, start])).rows as { practitioner_id: string | null; client_id: string }[];

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(`update public.studios set timezone='UTC', buffer_minutes=0, public_booking_horizon_months=3 where id=$1`, [B.studioId]);
  const svc = await adminQuery(`insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active) values ($1,$2,'Consult',60,0,true) returning id`, [randomUUID(), B.studioId]);
  serviceId = svc.rows[0].id as string;
  await adminQuery(
    `insert into public.studio_availability_default (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
     select gen_random_uuid(), $1, null, g, true, '09:00', '17:00' from generate_series(0,6) g`,
    [B.studioId],
  );
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const enableCapacity = async () => {
  await adminQuery(`update public.studios set practitioner_capacity_enabled = true, practitioner_capacity_booking_enabled = true where id = $1`, [B.studioId]);
  for (const p of B.practitioners) {
    await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3) on conflict do nothing`, [B.studioId, serviceId, p.practitionerId]);
  }
};

describe("capacity OFF: a double submit is serialised, then the second is refused (not replayed, not duplicated)", () => {
  it("the second submit WAITS on the studio lock, then is refused; exactly one appointment exists", async () => {
    const start = startsAt(5, 10);
    const { a, b, bWaited } = await doubleSubmit(start, null);
    expect(bWaited, "the second submit must wait on the first: they serialise, they do not race").toEqual({ type: "Lock", event: "transactionid" });
    expect(a.result).toBe("created");
    expect(b.result).toBe("time_unavailable"); // the refusal code observed on the stack
    expect(b.appointment_id, "a refusal carries no appointment: nothing is replayed").toBeNull();
    expect(await confirmedAt(start)).toHaveLength(1);
  }, 40_000);
});

describe("capacity ON, a practitioner named: the per-practitioner exclusion refuses the second submit", () => {
  it("one appointment for that practitioner; the second is refused", async () => {
    await enableCapacity();
    const start = startsAt(5, 11);
    const named = B.practitioners[1].practitionerId;
    const { a, b, bWaited } = await doubleSubmit(start, named);
    expect(bWaited).toEqual({ type: "Lock", event: "transactionid" });
    expect(a.result).toBe("created");
    expect(b.result).toBe("time_unavailable");
    expect(b.appointment_id).toBeNull();
    const rows = await confirmedAt(start);
    expect(rows).toHaveLength(1);
    expect(rows[0].practitioner_id).toBe(named);
  }, 40_000);
});

describe("capacity ON, no practitioner named: the second submit is assigned to ANOTHER practitioner (the duplicate a key closes)", () => {
  it("both submits are created, for two different practitioners, for the same client at the same start", async () => {
    await enableCapacity();
    const start = startsAt(5, 12);
    const { a, b, bWaited } = await doubleSubmit(start, null);
    expect(bWaited).toEqual({ type: "Lock", event: "transactionid" });
    expect(a.result).toBe("created");
    // THE PREMISE: the second is NOT refused; it lands on another free practitioner.
    expect(b.result).toBe("created");
    const rows = await confirmedAt(start);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.practitioner_id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.client_id)).size).toBe(1);
  }, 40_000);
});
