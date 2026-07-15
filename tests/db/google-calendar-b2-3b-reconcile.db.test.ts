import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import {
  reconcileStudio,
  runReconciliation,
  type ReconcileLock,
  type ReconcileStore,
} from "@/lib/google-calendar/sync/reconcile";

// Google Calendar — Phase B2.3-b. Behavioural proof of the reconciliation SWEEP
// against the REAL migrated DB: the sweep detects drift left by an INTENT-OFF
// window (or a swallowed enqueue) and re-drives EXACTLY ONE effective operation
// per appointment through the EXISTING enqueue trigger + repair RPCs — with no
// duplicates on repeat/concurrent runs, no touching of health-parked work, and
// operational-metadata-only queue rows. The sweep core is transport-neutral; here
// it is driven by a raw-pg ReconcileStore so the actual trigger/RPCs execute.

const OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const HEALTHY_SCOPES = [OWNED, "openid", "https://www.googleapis.com/auth/userinfo.profile"];

let clock = 0;
function slot(): { start: string; end: string } {
  clock += 1;
  const s = new Date(Date.now() + clock * 3_600_000);
  return { start: s.toISOString(), end: new Date(s.getTime() + 30 * 60_000).toISOString() };
}

async function seedConn(
  studio: SeededStudio,
  opts: { status?: string; owner?: boolean; writeCalendar?: string | null; scopes?: string[]; secret?: boolean; flag?: boolean } = {},
): Promise<string> {
  const { status = "connected", owner = true, writeCalendar = "primary", scopes = HEALTHY_SCOPES, secret = true, flag = true } = opts;
  const id = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, is_studio_calendar_owner, write_calendar_id, granted_scopes, destination_mode)
     values ($1,$2,$3,$4,$5,$6,$7,'existing_owned')`,
    [id, studio.studioId, studio.practitionerId, status, owner, writeCalendar, scopes],
  );
  if (secret) {
    await adminQuery(
      `insert into public.calendar_connection_secrets (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
       values ($1,$2,'v1:1:iv:tag:ct',1)`,
      [id, studio.studioId],
    );
  }
  if (flag) {
    await adminQuery(`update public.studios set google_calendar_outbound_sync_enabled = true where id=$1`, [studio.studioId]);
  }
  return id;
}

async function insertAppt(
  studio: SeededStudio,
  opts: { id?: string; status?: string; starts_at?: string; ends_at?: string; cancellation_kind?: string | null } = {},
): Promise<string> {
  const { id, status = "confirmed", starts_at, ends_at, cancellation_kind = null } = opts;
  const aid = id ?? randomUUID();
  const s = starts_at && ends_at ? { start: starts_at, end: ends_at } : slot();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_kind)
     values ($1,$2,$3,$4,$5,30,$6,$7)`,
    [aid, studio.studioId, studio.clientId, s.start, s.end, status, cancellation_kind],
  );
  return aid;
}

async function outbox(apptId: string) {
  return (await adminQuery(`select * from public.calendar_sync_outbox where hone_entity_id=$1 order by created_at`, [apptId])).rows;
}
async function links(apptId: string) {
  return (await adminQuery(`select * from public.calendar_event_links where hone_entity_id=$1 and deleted_at is null`, [apptId])).rows;
}
async function setFlag(studioId: string, on: boolean) {
  await adminQuery(`update public.studios set google_calendar_outbound_sync_enabled=$2 where id=$1`, [studioId, on]);
}
async function setWorker(on: boolean) {
  await adminQuery(`update public.calendar_sync_control set worker_enabled=$1`, [on]);
}
async function claim(n = 25) {
  return adminQuery(`select * from public.claim_calendar_sync_op($1)`, [n]);
}

// A pg-backed ReconcileStore: identical queries to the production Supabase store,
// but through the raw admin pool so the REAL trigger + repair RPCs run.
// The CI DB lane shares ONE Postgres across all suites with no per-test row
// cleanup, so real INTENT-eligible studios accumulate across files. Tests scope the
// eligible-studio lookup to the studio under test (isolation) via `studioFilter`;
// the REAL (unfiltered) filter is asserted separately in the tenant-isolation test.
function pgStore(studioFilter?: string): ReconcileStore {
  return {
    async listEligibleStudioIds() {
      const r = await adminQuery(
        `select distinct c.studio_id
           from public.calendar_connections c
           join public.studios s on s.id = c.studio_id
          where c.is_studio_calendar_owner and c.write_calendar_id is not null
            and s.google_calendar_outbound_sync_enabled`,
      );
      const ids = r.rows.map((x) => x.studio_id as string);
      return studioFilter ? ids.filter((id) => id === studioFilter) : ids;
    },
    async pageConfirmedFutureAppointments(studioId, activationIso, snapshotIso, afterId, limit) {
      const r = await adminQuery(
        `select id, sync_version from public.appointments
          where studio_id=$1 and status='confirmed' and ends_at>=$2 and created_at<=$3
            and ($4::uuid is null or id > $4)
          order by id asc limit $5`,
        [studioId, activationIso, snapshotIso, afterId, limit],
      );
      return r.rows.map((x) => ({ id: x.id as string, syncVersion: Number(x.sync_version) }));
    },
    async pageActiveAppointmentLinks(studioId, afterId, limit) {
      const r = await adminQuery(
        `select id, hone_entity_id, google_event_id, last_hone_version from public.calendar_event_links
          where studio_id=$1 and hone_entity_type='appointment' and deleted_at is null
            and ($2::uuid is null or id > $2)
          order by id asc limit $3`,
        [studioId, afterId, limit],
      );
      return r.rows.map((x) => ({
        id: x.id as string,
        honeEntityId: x.hone_entity_id as string,
        googleEventId: (x.google_event_id as string | null) ?? null,
        lastHoneVersion: Number(x.last_hone_version),
      }));
    },
    async getActiveLinksForEntities(studioId, ids) {
      const m = new Map<string, { id: string; honeEntityId: string; googleEventId: string | null; lastHoneVersion: number }>();
      if (!ids.length) return m;
      const r = await adminQuery(
        `select id, hone_entity_id, google_event_id, last_hone_version from public.calendar_event_links
          where studio_id=$1 and hone_entity_type='appointment' and deleted_at is null and hone_entity_id = any($2::uuid[])`,
        [studioId, ids],
      );
      for (const x of r.rows)
        m.set(x.hone_entity_id as string, {
          id: x.id as string,
          honeEntityId: x.hone_entity_id as string,
          googleEventId: (x.google_event_id as string | null) ?? null,
          lastHoneVersion: Number(x.last_hone_version),
        });
      return m;
    },
    async getAppointmentStates(studioId, ids) {
      const m = new Map<string, { id: string; status: string; syncVersion: number; cancellationKind: string | null }>();
      if (!ids.length) return m;
      const r = await adminQuery(
        `select id, status, sync_version, cancellation_kind from public.appointments where studio_id=$1 and id = any($2::uuid[])`,
        [studioId, ids],
      );
      for (const x of r.rows)
        m.set(x.id as string, {
          id: x.id as string,
          status: x.status as string,
          syncVersion: Number(x.sync_version),
          cancellationKind: (x.cancellation_kind as string | null) ?? null,
        });
      return m;
    },
    async getEntitiesWithOpenJobs(studioId, ids) {
      const s = new Set<string>();
      if (!ids.length) return s;
      const r = await adminQuery(
        `select distinct hone_entity_id from public.calendar_sync_outbox
          where studio_id=$1 and hone_entity_type='appointment' and status in ('pending','processing')
            and hone_entity_id = any($2::uuid[])`,
        [studioId, ids],
      );
      for (const x of r.rows) if (x.hone_entity_id) s.add(x.hone_entity_id as string);
      return s;
    },
    async bumpAppointmentSyncVersion(apptId) {
      const r = (await adminQuery(`select public.repair_bump_appointment_sync_version($1) as v`, [apptId])).rows[0];
      return r.v === null || r.v === undefined ? null : Number(r.v);
    },
    async enqueueOrphanLinkDelete(linkId) {
      return String((await adminQuery(`select public.repair_enqueue_orphan_link_delete($1) as r`, [linkId])).rows[0].r);
    },
  };
}

const lockAlways: ReconcileLock = { acquire: async () => ({ ok: true, token: "t" }), release: async () => {}, renew: async () => true };
function lockSingleSlot(): ReconcileLock {
  const held = new Map<string, string>();
  let seq = 0;
  return {
    async acquire(studioId) {
      if (held.has(studioId)) return { ok: false, reason: "held" };
      const token = `tok-${seq++}`;
      held.set(studioId, token);
      return { ok: true, token };
    },
    async release(studioId, token) {
      if (held.get(studioId) === token) held.delete(studioId);
    },
  };
}
// Pin the run clock ~1s ahead so the millisecond-precision snapshot boundary
// (created_at <= snapshot) never races a just-inserted microsecond-precision row.
// Every test appointment ends >= 1h out, so the activation boundary still holds.
const NOW_AHEAD = () => Date.now() + 1000;
// Full run() scoped to ONE studio (via the store filter) so shared-DB accumulation
// from other suites never contaminates aggregate counts.
const run = (studioId: string, over: Partial<Parameters<typeof runReconciliation>[0]> = {}) =>
  runReconciliation({ store: pgStore(studioId), lock: lockAlways, now: NOW_AHEAD, ...over });

beforeEach(async () => {
  await adminQuery("delete from public.calendar_sync_outbox");
  await adminQuery("delete from public.calendar_event_links");
  await adminQuery("delete from public.calendar_sync_metric_events");
  await adminQuery("delete from public.ops_alerts where event like 'calendar%'");
  await adminQuery(
    `insert into public.calendar_sync_control (id, worker_enabled) values (true,false)
       on conflict (id) do update set worker_enabled = false`,
  );
});
afterAll(async () => {
  await closePool();
});

// =========================================================================
describe("sweep recovery — intent-off window", () => {
  it("outbound-off mutation -> restore flag -> sweep creates exactly one; repeat is a no-op", async () => {
    const a = await seedStudio("bo1");
    await seedConn(a, { flag: false }); // owner + write calendar, but INTENT OFF
    const appt = await insertAppt(a);
    // No bookkeeping while intent is off.
    expect(await outbox(appt)).toHaveLength(0);
    expect(await links(appt)).toHaveLength(0);

    await setFlag(a.studioId, true); // intent returns
    const r1 = await run(a.studioId);
    expect(r1.enqueued).toBe(1);
    expect(r1.byClass.missing_link_job).toBe(1);
    const o = await outbox(appt);
    expect(o.map((x) => x.op_type)).toEqual(["event.create"]);
    expect(await links(appt)).toHaveLength(1);

    const r2 = await run(a.studioId); // idempotent
    expect(r2.enqueued).toBe(0);
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.create"]);
  });

  it("no-owner then owner-restored -> sweep converges", async () => {
    const a = await seedStudio("bo2");
    const conn = await seedConn(a, { owner: false }); // flag on, but not the owner -> intent off
    const appt = await insertAppt(a);
    expect(await outbox(appt)).toHaveLength(0);

    await adminQuery(`update public.calendar_connections set is_studio_calendar_owner=true where id=$1`, [conn]);
    await run(a.studioId);
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.create"]);
  });

  it("no write-target then target-selected -> sweep converges", async () => {
    const a = await seedStudio("bo3");
    const conn = await seedConn(a, { writeCalendar: null }); // flag+owner, but no chosen calendar -> intent off
    const appt = await insertAppt(a);
    expect(await outbox(appt)).toHaveLength(0);

    await adminQuery(`update public.calendar_connections set write_calendar_id='primary' where id=$1`, [conn]);
    await run(a.studioId);
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.create"]);
  });

  it("swallowed enqueue failure leaves the same gap -> sweep converges", async () => {
    const a = await seedStudio("bo4");
    await seedConn(a);
    const appt = randomUUID();
    // Force the outbox insert to fail during booking; the never-raise guard swallows
    // it, leaving NO link + NO job (+ a skip marker) — the exact Class-1 gap.
    const fname = `_t_fail_${randomUUID().slice(0, 8)}`;
    const tname = `${fname}_trg`;
    await adminQuery(`create function public.${fname}() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`);
    await adminQuery(`create trigger ${tname} before insert on public.calendar_sync_outbox for each row execute function public.${fname}()`);
    try {
      await insertAppt(a, { id: appt });
    } finally {
      await adminQuery(`drop trigger if exists ${tname} on public.calendar_sync_outbox`);
      await adminQuery(`drop function if exists public.${fname}()`);
    }
    expect(await outbox(appt)).toHaveLength(0);
    expect(await links(appt)).toHaveLength(0);
    expect(
      (await adminQuery(`select id from public.ops_alerts where event='calendar_enqueue_skipped' and appointment_id=$1`, [appt])).rowCount,
    ).toBe(1);

    await run(a.studioId);
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.create"]);
    expect(await links(appt)).toHaveLength(1);
  });

  it("multiple mutations during the gap collapse to ONE create at the current state", async () => {
    const a = await seedStudio("bo5");
    await seedConn(a, { flag: false });
    const appt = await insertAppt(a);
    const t2 = slot();
    await adminQuery(`update public.appointments set starts_at=$2, ends_at=$3 where id=$1`, [appt, t2.start, t2.end]);
    const t3 = slot();
    await adminQuery(`update public.appointments set starts_at=$2, ends_at=$3 where id=$1`, [appt, t3.start, t3.end]);
    expect(await outbox(appt)).toHaveLength(0); // intent off throughout

    await setFlag(a.studioId, true);
    await run(a.studioId);
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.create"]); // single op
  });
});

// =========================================================================
describe("sweep recovery — link-behind (Class 3)", () => {
  it("a link trailing the appointment with no current job -> one update; repeat is a no-op", async () => {
    const a = await seedStudio("lb1");
    await seedConn(a);
    const appt = await insertAppt(a); // create job + link v1
    // Craft a behind state: mark the event pushed, advance the appointment version,
    // then clear the queue so there is NO current job.
    await adminQuery(`update public.calendar_event_links set google_event_id='ev', last_hone_version=1 where hone_entity_id=$1`, [appt]);
    await adminQuery(`update public.appointments set sync_version=4 where id=$1`, [appt]);
    await adminQuery(`delete from public.calendar_sync_outbox where hone_entity_id=$1`, [appt]);

    const r = await run(a.studioId);
    expect(r.byClass.link_version_behind).toBe(1);
    const o = await outbox(appt);
    expect(o.map((x) => x.op_type)).toEqual(["event.update"]);
    expect(o[0].idempotency_key).toBe(`appointment:${appt}:event.update:5`); // bumped 4 -> 5

    await run(a.studioId); // pending job present -> no second bump (no version inflation)
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.update"]);
    expect(Number((await adminQuery(`select sync_version from public.appointments where id=$1`, [appt])).rows[0].sync_version)).toBe(5);
  });
});

// =========================================================================
describe("sweep recovery — orphan / surplus delete (Classes 2 & 4)", () => {
  it("orphaned link (appointment gone) + real event -> one delete; repeat is delete_in_flight", async () => {
    const a = await seedStudio("or1");
    const conn = await seedConn(a);
    const linkId = randomUUID();
    await adminQuery(
      `insert into public.calendar_event_links (id, studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id, google_event_id, last_hone_version)
       values ($1,$2,$3,'appointment',$4,'primary','ev-orphan',3)`,
      [linkId, a.studioId, conn, randomUUID()], // hone_entity_id -> no appointment row
    );
    const r1 = await run(a.studioId);
    expect(r1.byClass.orphaned_link_delete).toBe(1);
    const dels = (await adminQuery(`select * from public.calendar_sync_outbox where op_type='event.delete' and connection_id=$1`, [conn])).rows;
    expect(dels).toHaveLength(1);
    expect(dels[0].hone_entity_id).toBeNull(); // entity-less tombstone

    const r2 = await run(a.studioId);
    expect(r2.enqueued).toBe(0); // guarded (delete_in_flight)
  });

  it("orphaned PLACEHOLDER link (no google_event_id) -> inert (no delete enqueued)", async () => {
    const a = await seedStudio("or2");
    const conn = await seedConn(a);
    await adminQuery(
      `insert into public.calendar_event_links (id, studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id, last_hone_version)
       values ($1,$2,$3,'appointment',$4,'primary',1)`,
      [randomUUID(), a.studioId, conn, randomUUID()],
    );
    const r = await run(a.studioId);
    expect(r.enqueued).toBe(0);
    expect((await adminQuery(`select count(*)::int n from public.calendar_sync_outbox where connection_id=$1`, [conn])).rows[0].n).toBe(0);
  });

  it("withdrawn cancellation during the gap (Class 4) -> one delete; rescheduled + completed are left alone", async () => {
    const a = await seedStudio("or3");
    await seedConn(a);
    // Live synced link, then cancel while intent is off (no delete enqueued), then clear the create job.
    const appt = await insertAppt(a);
    await adminQuery(`update public.calendar_event_links set google_event_id='ev' where hone_entity_id=$1`, [appt]);
    await setFlag(a.studioId, false);
    await adminQuery(`update public.appointments set status='cancelled', cancellation_kind='withdrawn' where id=$1`, [appt]);
    await adminQuery(`delete from public.calendar_sync_outbox where hone_entity_id=$1`, [appt]);
    // A rescheduled predecessor + a completed appointment must NOT be reconciled to a delete.
    const resched = await insertAppt(a);
    await adminQuery(`update public.calendar_event_links set google_event_id='ev2' where hone_entity_id=$1`, [resched]);
    await adminQuery(`update public.appointments set status='cancelled', cancellation_kind='rescheduled' where id=$1`, [resched]);
    const done = await insertAppt(a);
    await adminQuery(`update public.calendar_event_links set google_event_id='ev3' where hone_entity_id=$1`, [done]);
    await adminQuery(`update public.appointments set status='completed' where id=$1`, [done]);
    await adminQuery(`delete from public.calendar_sync_outbox where hone_entity_id in ($1,$2)`, [resched, done]);

    await setFlag(a.studioId, true);
    const r = await run(a.studioId);
    expect(r.byClass.surplus_event_delete).toBe(1);
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.delete"]);
    expect(await outbox(resched)).toHaveLength(0);
    expect(await outbox(done)).toHaveLength(0);
  });
});

// =========================================================================
describe("stable UUID pagination + snapshot boundary", () => {
  it("paginates every candidate exactly once across pages ordered by immutable id", async () => {
    const a = await seedStudio("pg1");
    await seedConn(a, { flag: false });
    const appts = [];
    for (let i = 0; i < 5; i++) appts.push(await insertAppt(a));
    await setFlag(a.studioId, true);
    await runReconciliation({ store: pgStore(a.studioId), lock: lockAlways, now: NOW_AHEAD, pageSize: 2 }); // multi-page
    for (const appt of appts) {
      expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.create"]); // each once
    }
  });

  it("rescheduling an already-processed appointment does not cause a second create (id cursor, not starts_at)", async () => {
    const a = await seedStudio("pg2");
    await seedConn(a, { flag: false });
    const a1 = await insertAppt(a);
    const a2 = await insertAppt(a);
    await setFlag(a.studioId, true);
    await runReconciliation({ store: pgStore(a.studioId), lock: lockAlways, now: NOW_AHEAD, pageSize: 1 });
    // Move a1 far into the future (mutating starts_at) — a starts_at cursor would
    // reorder it; the immutable id cursor is unaffected.
    const later = new Date(Date.now() + 500 * 3_600_000);
    await adminQuery(`update public.appointments set starts_at=$2, ends_at=$3 where id=$1`, [
      a1,
      later.toISOString(),
      new Date(later.getTime() + 30 * 60_000).toISOString(),
    ]);
    await runReconciliation({ store: pgStore(a.studioId), lock: lockAlways, now: NOW_AHEAD, pageSize: 1 });
    // a1 already has a create + now a trigger-made update (from the reschedule) — but
    // NO second create; a2 still exactly one create.
    expect((await outbox(a1)).filter((x) => x.op_type === "event.create")).toHaveLength(1);
    expect((await outbox(a2)).map((x) => x.op_type)).toEqual(["event.create"]);
  });
});

// =========================================================================
describe("no duplicate under repeat / concurrency", () => {
  it("concurrent sweeps under a single-slot per-studio lock -> exactly one create", async () => {
    const a = await seedStudio("cc1");
    await seedConn(a);
    const appt = await insertAppt(a, { status: "confirmed" });
    await adminQuery(`delete from public.calendar_sync_outbox where hone_entity_id=$1`, [appt]);
    await adminQuery(`delete from public.calendar_event_links where hone_entity_id=$1`, [appt]); // simulate the gap
    const lock = lockSingleSlot();
    await Promise.all([
      runReconciliation({ store: pgStore(a.studioId), lock, now: NOW_AHEAD }),
      runReconciliation({ store: pgStore(a.studioId), lock, now: NOW_AHEAD }),
    ]);
    expect((await outbox(appt)).filter((x) => x.op_type === "event.create")).toHaveLength(1);
  });
});

// =========================================================================
describe("existing health behaviour is NOT a sweep case", () => {
  it("an unhealthy-connection mutation makes PARKED pending work; the sweep never duplicates it; health restore makes it claimable", async () => {
    const a = await seedStudio("hp1");
    const conn = await seedConn(a, { status: "reconnect_required" }); // intent ON, health OFF
    const appt = await insertAppt(a);
    // INTENT still enqueued the create (parked), attempts=0.
    const before = await outbox(appt);
    expect(before.map((x) => x.op_type)).toEqual(["event.create"]);
    expect(before[0].status).toBe("pending");
    expect(Number(before[0].attempts)).toBe(0);

    // The sweep sees an open job -> does NOT bump / duplicate.
    const r = await run(a.studioId);
    expect(r.enqueued).toBe(0);
    const after = await outbox(appt);
    expect(after).toHaveLength(1);
    expect(Number(after[0].attempts)).toBe(0); // no decay caused by the sweep

    // Health restored + worker on -> the SAME parked job drains via the existing claim.
    await adminQuery(`update public.calendar_connections set connection_status='connected' where id=$1`, [conn]);
    await setWorker(true);
    expect((await claim(25)).rows.map((x) => x.id)).toContain(before[0].id);
  });
});

// =========================================================================
describe("tenant isolation + dormancy", () => {
  it("the sweep only actuates within intent-eligible studios; an intent-off studio is untouched", async () => {
    const on = await seedStudio("ti_on");
    await seedConn(on, { flag: false });
    const apptOn = await insertAppt(on);
    const off = await seedStudio("ti_off");
    await seedConn(off, { flag: false });
    const apptOff = await insertAppt(off);

    await setFlag(on.studioId, true); // only ON becomes eligible

    // The REAL (unfiltered) intent filter includes ON and excludes the intent-off OFF.
    const eligible = await pgStore().listEligibleStudioIds();
    expect(eligible).toContain(on.studioId);
    expect(eligible).not.toContain(off.studioId);

    // Sweeping ON must never touch OFF (a different tenant).
    await reconcileStudio(on.studioId, { store: pgStore(), lock: lockAlways }, new Date(NOW_AHEAD()).toISOString());
    expect((await outbox(apptOn)).map((x) => x.op_type)).toEqual(["event.create"]);
    expect(await outbox(apptOff)).toHaveLength(0); // OFF is never swept
    // A bump for ON never advanced OFF's appointment version.
    expect(Number((await adminQuery(`select sync_version from public.appointments where id=$1`, [apptOff])).rows[0].sync_version)).toBe(1);
  });
});

// =========================================================================
describe("privacy — operational metadata only", () => {
  it("sweep-produced outbox rows carry no client identity", async () => {
    const a = await seedStudio("pv1");
    await seedConn(a, { flag: false });
    const appt = await insertAppt(a);
    await setFlag(a.studioId, true);
    await run(a.studioId);
    const rows = await outbox(appt);
    expect(rows).toHaveLength(1);
    const blob = JSON.stringify(rows[0].payload);
    expect(blob).not.toMatch(/@|client|name|email|phone|note/i);
    expect(rows[0].payload).toMatchObject({ schema_version: 1 });
  });
});

// =========================================================================
describe("reconcileStudio result", () => {
  it("reports the immutable cursor + aggregate counts", async () => {
    const a = await seedStudio("rs1");
    await seedConn(a, { flag: false });
    const appt = await insertAppt(a);
    await setFlag(a.studioId, true);
    const res = await reconcileStudio(a.studioId, { store: pgStore(), lock: lockAlways }, new Date(NOW_AHEAD()).toISOString());
    expect(res.locked).toBe(true);
    expect(res.enqueued).toBe(1);
    expect(res.appointmentCursor).toBe(appt);
  });
});
