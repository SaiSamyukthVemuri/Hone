import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedStudioWideOpenAllWeek, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// ONE LIVE APPOINTMENT PER CLIENT, SERVICE AND EXACT START, enforced by the database.
//
// The shape: a request that repeats a booking (a double submit, a retry, two tabs) must never become a second appointment, whichever practitioner the
// booking is given to and however the requests interleave. The public command serialises two submits to one studio and then judges the second against
// the first; with no practitioner named, the per-practitioner exclusion alone lets the second land on another free practitioner. This rule refuses it.
//
// The first three describes are the outcome that matters. The last describes are the cases that must STILL work.

let B: SynthStudio;
let serviceId: string;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const startsAt = (daysAhead: number, hour: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const conn = async () => {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
};
type Result = { result: string; appointment_id: string | null };
const submit = (c: Client, clientId: string, start: string, svc = serviceId) =>
  c.query<Result>(`select * from public.create_public_appointment_v2($1,$2,$3,$4::timestamptz,$5,null,null,null)`, [B.studioId, clientId, svc, start, hash64()]);
const live = async (clientId: string, start: string) =>
  (await adminQuery(`select practitioner_id from public.appointments where studio_id=$1 and client_id=$2 and starts_at=$3::timestamptz and status='confirmed'`, [B.studioId, clientId, start])).rows;
const INDEX = "appointments_one_live_per_client_service_start";

async function waitUntilBlocked(pid: number, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await adminQuery(`select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}
/** Two submits for one client at one start, the second started while the first still holds the studio lock. */
async function simultaneous(clientId: string, start: string) {
  const A = await conn();
  const Bc = await conn();
  try {
    const bPid = (await Bc.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0]!.pid;
    await A.query("begin");
    const a = (await submit(A, clientId, start)).rows[0]!;
    const bPromise = submit(Bc, clientId, start).then((r) => ({ ok: true as const, row: r.rows[0]! }), (e) => ({ ok: false as const, error: e as { code?: string; message?: string } }));
    const waited = await waitUntilBlocked(bPid);
    await A.query("commit");
    return { a, b: await bPromise, waited };
  } finally {
    await A.query("rollback").catch(() => undefined);
    await A.end();
    await Bc.end();
  }
}

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(`update public.studios set timezone='UTC', buffer_minutes=0, public_booking_horizon_months=3, practitioner_capacity_enabled = true, practitioner_capacity_booking_enabled = true where id=$1`, [B.studioId]);
  serviceId = (await adminQuery(`insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active) values ($1,$2,'Consult',60,0,true) returning id`, [randomUUID(), B.studioId])).rows[0].id;
  await adminQuery(
    `insert into public.studio_availability_default (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
     select gen_random_uuid(), $1, null, g, true, '09:00', '17:00' from generate_series(0,6) g`,
    [B.studioId],
  );
  for (const p of B.practitioners) {
    await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3) on conflict do nothing`, [B.studioId, serviceId, p.practitionerId]);
  }
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

describe("the migration is one index and nothing else", () => {
  const up = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0365_appointments_one_live_per_client_service_start.sql"), "utf8");
  const down = readFileSync(join(__dirname, "..", "..", "supabase", "rollbacks", "0365_appointments_one_live_per_client_service_start.down.sql"), "utf8");
  it("opens its own transaction with a lock timeout inside it, and creates only the partial unique index", () => {
    expect(up).toMatch(/^begin;\s*$/m);
    expect(up).toMatch(/set local lock_timeout = '5s';/);
    expect(up).toMatch(/create unique index appointments_one_live_per_client_service_start\s+on public\.appointments \(client_id, service_id, starts_at\)\s+where status = 'confirmed' and service_id is not null;/);
    expect(up).toMatch(/^commit;\s*$/m);
    expect(up).not.toMatch(/create (or replace )?function|alter table|grant |revoke |create policy|drop /i);
  });
  it("the rollback only drops that index", () => {
    expect(down).toMatch(/drop index if exists public\.appointments_one_live_per_client_service_start;/);
    expect(down).not.toMatch(/create |alter |grant |revoke /i);
  });
  it("the index exists with the live-only predicate", async () => {
    const r = await adminQuery(`select indexdef from pg_indexes where schemaname='public' and indexname=$1`, [INDEX]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].indexdef).toMatch(/UNIQUE/);
    expect(r.rows[0].indexdef).toMatch(/\(client_id, service_id, starts_at\)/);
    expect(r.rows[0].indexdef).toMatch(/status = 'confirmed'/);
  });
});

describe("a repeat of one booking never becomes a second appointment", () => {
  it("two simultaneous any-practitioner creates for one client: exactly one appointment, the second refused by the rule", async () => {
    const start = startsAt(5, 12);
    const { a, b, waited } = await simultaneous(B.clientId, start);
    expect(waited, "the second submit waits on the first: they serialise, they do not race").toBe(true);
    expect(a.result).toBe("created");
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error("unreachable");
    expect(b.error.code).toBe("23505");
    expect(b.error.message).toContain(INDEX);
    expect(await live(B.clientId, start)).toHaveLength(1);
  }, 40_000);

  it("a retry after the first committed is refused the same way, and the appointment that exists is the one the first made", async () => {
    const start = startsAt(5, 13);
    const c = await conn();
    try {
      const first = (await submit(c, B.clientId, start)).rows[0]!;
      expect(first.result).toBe("created");
      await expect(submit(c, B.clientId, start)).rejects.toMatchObject({ code: "23505" });
    } finally {
      await c.end();
    }
    const rows = await live(B.clientId, start);
    expect(rows).toHaveLength(1);
  }, 40_000);

  it("the refused second leaves nothing behind: no second appointment and no second audit row", async () => {
    const start = startsAt(5, 14);
    await simultaneous(B.clientId, start);
    const n = await adminQuery(`select count(*)::int n from public.appointments where studio_id=$1 and client_id=$2 and starts_at=$3::timestamptz`, [B.studioId, B.clientId, start]);
    expect(n.rows[0].n).toBe(1);
    const audit = await adminQuery(`select count(*)::int n from public.appointment_audit au join public.appointments a on a.id = au.appointment_id where a.studio_id=$1 and a.client_id=$2 and a.starts_at=$3::timestamptz`, [B.studioId, B.clientId, start]);
    expect(audit.rows[0].n).toBe(1);
  }, 40_000);
});

describe("legitimate bookings still work", () => {
  it("two different clients at the same start (each on their own practitioner)", async () => {
    const other = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'SYNTH other client')`, [other, B.studioId]);
    const start = startsAt(5, 10);
    const c = await conn();
    try {
      expect((await submit(c, B.clientId, start)).rows[0]!.result).toBe("created");
      expect((await submit(c, other, start)).rows[0]!.result).toBe("created");
    } finally {
      await c.end();
    }
    expect(await live(B.clientId, start)).toHaveLength(1);
    expect(await live(other, start)).toHaveLength(1);
  }, 40_000);

  it("the same client at different times", async () => {
    const c = await conn();
    try {
      expect((await submit(c, B.clientId, startsAt(5, 10))).rows[0]!.result).toBe("created");
      expect((await submit(c, B.clientId, startsAt(5, 12))).rows[0]!.result).toBe("created");
    } finally {
      await c.end();
    }
  }, 40_000);

  it("rebooking the same time after a cancellation", async () => {
    const start = startsAt(5, 11);
    const c = await conn();
    try {
      const first = (await submit(c, B.clientId, start)).rows[0]!;
      expect(first.result).toBe("created");
      await adminQuery(`update public.appointments set status='cancelled', cancelled_at=now(), cancelled_by='client' where id=$1`, [first.appointment_id]);
      const again = (await submit(c, B.clientId, start)).rows[0]!;
      expect(again.result).toBe("created");
      expect(again.appointment_id).not.toBe(first.appointment_id);
    } finally {
      await c.end();
    }
    expect(await live(B.clientId, start)).toHaveLength(1);
  }, 40_000);

  it("the same client, two DIFFERENT services at the same start (the key carries the service)", async () => {
    const second = (await adminQuery(`insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active) values ($1,$2,'Second',60,0,true) returning id`, [randomUUID(), B.studioId])).rows[0].id as string;
    for (const p of B.practitioners) {
      await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3) on conflict do nothing`, [B.studioId, second, p.practitionerId]);
    }
    const start = startsAt(5, 15);
    const c = await conn();
    try {
      expect((await submit(c, B.clientId, start)).rows[0]!.result).toBe("created");
      expect((await submit(c, B.clientId, start, second)).rows[0]!.result).toBe("created");
    } finally {
      await c.end();
    }
    expect(await live(B.clientId, start)).toHaveLength(2);
  }, 40_000);
});

describe("a move or a reschedule onto a key the same client already holds", () => {
  const TOKEN_Y = hash64();
  /** A confirmed appointment written directly, so each case holds exactly the keys it names. */
  async function seed(practitionerId: string, start: string, tokenHash = hash64()) {
    const end = new Date(new Date(start).getTime() + 60 * 60_000).toISOString();
    return (await adminQuery(
      `insert into public.appointments (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
       values (gen_random_uuid(),$1,$2,$3,$4,$5::timestamptz,$6::timestamptz,60,'confirmed',$7) returning id, starts_at::text s, ends_at::text e`,
      [B.studioId, practitionerId, B.clientId, serviceId, start, end, tokenHash],
    )).rows[0] as { id: string; s: string; e: string };
  }
  const row = async (id: string) => (await adminQuery(`select practitioner_id, starts_at::text s, status from public.appointments where id=$1`, [id])).rows[0];
  const ownerId = () => B.practitioners.find((p) => p.role === "owner")!.practitionerId;
  const P = (i: number) => B.practitioners[i]!.practitionerId;
  const err = (e: unknown) => e as { code?: string; message?: string };

  it("an in-app move onto it fails on the rule's index, and the original is untouched", async () => {
    await seedStudioWideOpenAllWeek(B.studioId);
    const held = startsAt(5, 10);
    await seed(P(1), held);
    const y = await seed(P(2), startsAt(5, 13));
    let caught: { code?: string; message?: string } | null = null;
    await adminQuery(
      `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
      [y.id, B.studioId, ownerId(), P(2), y.s, y.e, held],
    ).catch((e) => { caught = err(e); });
    expect(caught, "the move raised").not.toBeNull();
    expect(caught!.code).toBe("23505");
    expect(caught!.message).toContain(INDEX);
    const after = await row(y.id);
    expect(after.status).toBe("confirmed");
    expect(new Date(after.s).toISOString()).toBe(new Date(y.s).toISOString());
    expect(after.practitioner_id).toBe(P(2));
  }, 40_000);

  it("the same move to a start the client does NOT hold still succeeds (control)", async () => {
    await seedStudioWideOpenAllWeek(B.studioId);
    await seed(P(1), startsAt(5, 10));
    const y = await seed(P(2), startsAt(5, 13));
    const r = await adminQuery(
      `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
      [y.id, B.studioId, ownerId(), P(2), y.s, y.e, startsAt(5, 15)],
    );
    expect(r.rows[0].result).toBe("moved");
  }, 40_000);

  it("a public reschedule onto it fails on the rule's index, and the original survives", async () => {
    await seedStudioWideOpenAllWeek(B.studioId);
    const held = startsAt(6, 10);
    await seed(P(1), held);
    const y = await seed(P(2), startsAt(6, 13), TOKEN_Y);
    let caught: { code?: string; message?: string } | null = null;
    await adminQuery(`select * from public.reschedule_appointment_v2($1,$2,$3::timestamptz,$4,true,null)`, [y.id, TOKEN_Y, held, hash64()]).catch((e) => { caught = err(e); });
    expect(caught, "the reschedule raised").not.toBeNull();
    expect(caught!.code).toBe("23505");
    expect(caught!.message).toContain(INDEX);
    expect((await row(y.id)).status, "the original is still confirmed: the successor and the cancel rolled back together").toBe("confirmed");
    expect(await live(B.clientId, held)).toHaveLength(1);
  }, 40_000);
});
