import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// Google Calendar — Phase B2.3-a (migration 0125). Behavioural proof of the
// outbound enqueue + claim ACTIVATION BOUNDARY: the appointment-transition matrix,
// INTENT vs HEALTH gating, the genuinely-never-raise triggers, the health-aware
// expired-lease reaper, the append-only suppression telemetry, the repair
// primitives (full-unique-safe), the entity-CHECK relaxation, the queue-health
// view, and DORMANCY (flags OFF + worker OFF => zero rows / zero mutations).

const OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const PHASE_A = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
// Google bundles userinfo.profile even though Phase A never requested it — the
// SUPERSET eligibility check must still treat this as healthy.
const HEALTHY_SCOPES = [OWNED, ...PHASE_A, "https://www.googleapis.com/auth/userinfo.profile"];

let clock = 0;
function slot(): { start: string; end: string } {
  clock += 1;
  const s = new Date(Date.now() + clock * 3_600_000);
  return { start: s.toISOString(), end: new Date(s.getTime() + 30 * 60_000).toISOString() };
}

async function seedConn(
  studio: SeededStudio,
  opts: {
    status?: string;
    owner?: boolean;
    writeCalendar?: string | null;
    scopes?: string[];
    secret?: boolean;
    flag?: boolean;
  } = {},
): Promise<string> {
  const {
    status = "connected",
    owner = true,
    writeCalendar = "primary",
    scopes = HEALTHY_SCOPES,
    secret = true,
    flag = true,
  } = opts;
  const id = randomUUID();
  await adminQuery(
    // B2.4: readiness is destination-aware — these B2.3-a scenarios use the
    // existing-owned destination (calendar.events.owned). Not-ready cases still
    // arise from missing scope / secret / flag, unchanged.
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, is_studio_calendar_owner, write_calendar_id, granted_scopes, destination_mode)
     values ($1,$2,$3,$4,$5,$6,$7,'existing_owned')`,
    [id, studio.studioId, studio.practitionerId, status, owner, writeCalendar, scopes],
  );
  if (secret) {
    await adminQuery(
      `insert into public.calendar_connection_secrets
         (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
       values ($1,$2,'v1:1:iv:tag:ct',1)`,
      [id, studio.studioId],
    );
  }
  if (flag) {
    await adminQuery(
      `update public.studios set google_calendar_outbound_sync_enabled = true where id=$1`,
      [studio.studioId],
    );
  }
  return id;
}

async function insertAppt(
  studio: SeededStudio,
  opts: { id?: string; status?: string; starts_at?: string; ends_at?: string; rescheduled_from?: string | null; cancellation_kind?: string | null } = {},
): Promise<string> {
  const { id, status = "confirmed", starts_at, ends_at, rescheduled_from = null, cancellation_kind = null } = opts;
  const aid = id ?? randomUUID();
  const s = starts_at && ends_at ? { start: starts_at, end: ends_at } : slot();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes, status,
        rescheduled_from_appointment_id, cancellation_kind)
     values ($1,$2,$3,$4,$5,30,$6,$7,$8)`,
    [aid, studio.studioId, studio.clientId, s.start, s.end, status, rescheduled_from, cancellation_kind],
  );
  return aid;
}

async function outbox(apptId: string) {
  return (await adminQuery(`select * from public.calendar_sync_outbox where hone_entity_id=$1 order by created_at`, [apptId])).rows;
}
async function links(apptId: string) {
  return (await adminQuery(`select * from public.calendar_event_links where hone_entity_id=$1`, [apptId])).rows;
}
async function claim(n = 25) {
  return adminQuery(`select * from public.claim_calendar_sync_op($1)`, [n]);
}
async function setWorker(on: boolean) {
  await adminQuery(`update public.calendar_sync_control set worker_enabled=$1`, [on]);
}
const past = () => new Date(Date.now() - 60_000).toISOString();

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
describe("dormancy (flags OFF, worker OFF)", () => {
  it("a confirmed booking with NO product intent creates zero outbox/link rows", async () => {
    const a = await seedStudio("dorm1");
    const appt = await insertAppt(a); // no connection, flag OFF
    expect(await outbox(appt)).toHaveLength(0);
    expect(await links(appt)).toHaveLength(0);
  });

  it("an owner connection + write calendar but flag OFF still enqueues nothing", async () => {
    const a = await seedStudio("dorm2");
    await seedConn(a, { flag: false }); // owner + write_calendar, but studio flag OFF
    const appt = await insertAppt(a);
    expect(await outbox(appt)).toHaveLength(0);
    expect(await links(appt)).toHaveLength(0);
  });

  it("claim is inert while the global worker control is OFF (no dead, no claim)", async () => {
    const a = await seedStudio("dorm3");
    const conn = await seedConn(a); // fully healthy
    // A processing row past its lease at max attempts would be deaded IF healthy+enabled.
    const id = randomUUID();
    await adminQuery(
      `insert into public.calendar_sync_outbox
         (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key,
          status, attempts, max_attempts, claimed_at, claim_token, lease_expires_at)
       values ($1,$2,$3,'event.create','appointment',$4,$5,'processing',8,8,$6,$7,$6)`,
      [id, a.studioId, conn, randomUUID(), `k-${randomUUID()}`, past(), randomUUID()],
    );
    // worker OFF (beforeEach default)
    const r = await claim(25);
    expect(r.rowCount).toBe(0);
    const row = (await adminQuery(`select status, attempts from public.calendar_sync_outbox where id=$1`, [id])).rows[0];
    expect(row.status).toBe("processing"); // NOT deaded merely because claim was invoked
    expect(Number(row.attempts)).toBe(8);
  });
});

// =========================================================================
describe("enqueue transition matrix (product intent ON)", () => {
  it("INSERT confirmed -> one pending link + event.create:1", async () => {
    const a = await seedStudio("mx1");
    await seedConn(a);
    const appt = await insertAppt(a);
    const l = await links(appt);
    expect(l).toHaveLength(1);
    expect(l[0].google_event_id).toBeNull();
    // Migration 0132 (B2.3-c1 §6): a placeholder link starts at last_hone_version=0
    // — it never claims the appointment version was applied before Google confirms.
    expect(Number(l[0].last_hone_version)).toBe(0);
    const o = await outbox(appt);
    expect(o).toHaveLength(1);
    expect(o[0].op_type).toBe("event.create");
    expect(o[0].idempotency_key).toBe(`appointment:${appt}:event.create:1`);
  });

  it("INSERT non-confirmed -> nothing", async () => {
    const a = await seedStudio("mx2");
    await seedConn(a);
    const appt = await insertAppt(a, { status: "cancelled" });
    expect(await outbox(appt)).toHaveLength(0);
    expect(await links(appt)).toHaveLength(0);
  });

  it("confirmed timing change -> event.update:2 (sync_version bumped)", async () => {
    const a = await seedStudio("mx3");
    await seedConn(a);
    const appt = await insertAppt(a);
    const later = slot();
    await adminQuery(`update public.appointments set starts_at=$2, ends_at=$3 where id=$1`, [appt, later.start, later.end]);
    const o = await outbox(appt);
    expect(o.map((x) => x.op_type)).toEqual(["event.create", "event.update"]);
    expect(o[1].idempotency_key).toBe(`appointment:${appt}:event.update:2`);
  });

  it("notes-only change -> no new outbox (sync_version preserved)", async () => {
    const a = await seedStudio("mx4");
    await seedConn(a);
    const appt = await insertAppt(a);
    await adminQuery(`update public.appointments set notes='hello' where id=$1`, [appt]);
    expect(await outbox(appt)).toHaveLength(1); // only the create
    const v = (await adminQuery(`select sync_version from public.appointments where id=$1`, [appt])).rows[0];
    expect(Number(v.sync_version)).toBe(1);
  });

  it("withdrawn cancellation -> event.delete", async () => {
    const a = await seedStudio("mx5");
    await seedConn(a);
    const appt = await insertAppt(a);
    await adminQuery(`update public.appointments set status='cancelled', cancellation_kind='withdrawn' where id=$1`, [appt]);
    const o = await outbox(appt);
    expect(o.map((x) => x.op_type)).toEqual(["event.create", "event.delete"]);
    expect(o[1].idempotency_key).toBe(`appointment:${appt}:event.delete:2`);
  });

  it("completed / no_show -> no outbound op", async () => {
    const a = await seedStudio("mx6");
    await seedConn(a);
    const appt = await insertAppt(a);
    await adminQuery(`update public.appointments set status='completed' where id=$1`, [appt]);
    const b = await insertAppt(a);
    await adminQuery(`update public.appointments set status='no_show' where id=$1`, [b]);
    expect((await outbox(appt)).map((x) => x.op_type)).toEqual(["event.create"]);
    expect((await outbox(b)).map((x) => x.op_type)).toEqual(["event.create"]);
  });

  it("cancelled -> confirmed (defensive un-cancel) -> event.update", async () => {
    const a = await seedStudio("mx7");
    await seedConn(a);
    const appt = await insertAppt(a);
    await adminQuery(`update public.appointments set status='cancelled', cancellation_kind='withdrawn' where id=$1`, [appt]);
    await adminQuery(`update public.appointments set status='confirmed', cancellation_kind=null where id=$1`, [appt]);
    const o = await outbox(appt);
    expect(o.map((x) => x.op_type)).toEqual(["event.create", "event.delete", "event.update"]);
    expect(o[2].idempotency_key).toBe(`appointment:${appt}:event.update:3`);
  });

  it("reschedule successor WITH predecessor link -> rebinds link + resets last_hone_version to pending/0, preserving provider coordinates", async () => {
    const a = await seedStudio("mx8");
    await seedConn(a);
    const pred = await insertAppt(a); // link created (last_hone_version 0)
    // Simulate prior syncs so the predecessor's version is non-zero and bound.
    await adminQuery(`update public.calendar_event_links set last_hone_version=5, google_event_id='ev-pred', sync_status='synced' where hone_entity_id=$1`, [pred]);
    const succ = await insertAppt(a, { rescheduled_from: pred });
    // Predecessor's active link is rebound to the successor.
    expect(await links(pred)).toHaveLength(0);
    const sl = await links(succ);
    expect(sl).toHaveLength(1);
    // 0132 (B2.3-c1 §6): the rebind RESETS the applied-version proof to pending/0 —
    // it must not claim the successor's timing was applied before Google is updated —
    // while PRESERVING the provider identity/coordinates.
    expect(Number(sl[0].last_hone_version)).toBe(0);
    expect(sl[0].sync_status).toBe("pending");
    expect(sl[0].google_event_id).toBe("ev-pred"); // carried forward
    const o = await outbox(succ);
    expect(o).toHaveLength(1);
    expect(o[0].op_type).toBe("event.update");
    expect(o[0].idempotency_key).toBe(`appointment:${succ}:event.update:1`);
  });

  it("reschedule successor WITHOUT a predecessor active link -> event.create + new link", async () => {
    const a = await seedStudio("mx9");
    await seedConn(a);
    const pred = await insertAppt(a); // real predecessor (valid FK) whose link we soft-delete
    await adminQuery(`update public.calendar_event_links set deleted_at=now() where hone_entity_id=$1`, [pred]);
    const succ = await insertAppt(a, { rescheduled_from: pred });
    expect((await links(succ)).filter((l) => l.deleted_at === null)).toHaveLength(1); // fresh active link
    expect((await outbox(succ))[0].op_type).toBe("event.create");
  });

  it("reschedule predecessor (cancelled, kind=rescheduled) -> delete is SUPPRESSED", async () => {
    const a = await seedStudio("mx10");
    await seedConn(a);
    const pred = await insertAppt(a);
    await adminQuery(`update public.appointments set status='cancelled', cancellation_kind='rescheduled' where id=$1`, [pred]);
    // Only the original create; no delete enqueued (the successor will rebind the link).
    expect((await outbox(pred)).map((x) => x.op_type)).toEqual(["event.create"]);
    expect(await links(pred)).toHaveLength(1); // link left active for the successor
  });

  it("hard delete WITH an active synced link -> event.delete tombstone from the link", async () => {
    const a = await seedStudio("mx11");
    await seedConn(a);
    const appt = await insertAppt(a);
    await adminQuery(`update public.calendar_event_links set google_event_id='ev-x', last_hone_version=1 where hone_entity_id=$1`, [appt]);
    await adminQuery(`delete from public.appointments where id=$1`, [appt]);
    const o = await outbox(appt);
    expect(o.map((x) => x.op_type)).toEqual(["event.create", "event.delete"]);
    expect(o[1].idempotency_key).toBe(`appointment:${appt}:event.delete:1`);
  });

  it("hard delete WITHOUT an active link -> no-op", async () => {
    const a = await seedStudio("mx12");
    const appt = await insertAppt(a); // no intent -> no link
    await adminQuery(`delete from public.appointments where id=$1`, [appt]);
    expect(await outbox(appt)).toHaveLength(0);
  });

  it("intent gate requires OWNER + write_calendar (not just the flag)", async () => {
    const a = await seedStudio("mx13");
    await seedConn(a, { owner: false }); // flag ON, but not the calendar owner
    const appt = await insertAppt(a);
    expect(await outbox(appt)).toHaveLength(0);

    const b = await seedStudio("mx14");
    await seedConn(b, { writeCalendar: null }); // owner + flag, but no write calendar chosen
    const appt2 = await insertAppt(b);
    expect(await outbox(appt2)).toHaveLength(0);
  });
});

// =========================================================================
describe("intent vs health: intent survives a connection outage; claim holds it", () => {
  it("a change during an outage enqueues (intent) and drains only when health returns", async () => {
    const a = await seedStudio("ih1");
    // Unhealthy: owner + flag + write_calendar, but reconnect_required (+ no usable claim health).
    const conn = await seedConn(a, { status: "reconnect_required" });
    const appt = await insertAppt(a);
    // INTENT still recorded despite the outage.
    const o = await outbox(appt);
    expect(o).toHaveLength(1);
    expect(o[0].status).toBe("pending");

    await setWorker(true);
    expect((await claim(25)).rowCount).toBe(0); // HEALTH gate: not connected -> not claimable
    const held = (await adminQuery(`select status, attempts from public.calendar_sync_outbox where id=$1`, [o[0].id])).rows[0];
    expect(held.status).toBe("pending");
    expect(Number(held.attempts)).toBe(0); // no attempt decay while ineligible

    await adminQuery(`update public.calendar_connections set connection_status='connected' where id=$1`, [conn]);
    const r = await claim(25);
    expect(r.rows.map((x) => x.id)).toContain(o[0].id); // drains on recovery
  });
});

// =========================================================================
describe("genuine never-raise (a sync fault never aborts a booking)", () => {
  async function withFailingTrigger(table: string, fn: () => Promise<void>) {
    const fname = `_t_fail_${table}_${randomUUID().slice(0, 8)}`;
    const tname = `_t_fail_${table}_trg_${randomUUID().slice(0, 8)}`;
    await adminQuery(`create function public.${fname}() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`);
    await adminQuery(`create trigger ${tname} before insert on public.${table} for each row execute function public.${fname}()`);
    try {
      await fn();
    } finally {
      await adminQuery(`drop trigger if exists ${tname} on public.${table}`);
      await adminQuery(`drop function if exists public.${fname}()`);
    }
  }

  it("an outbox-insert failure does not abort the booking; a marker is recorded", async () => {
    const a = await seedStudio("nr1");
    await seedConn(a);
    const appt = randomUUID();
    await withFailingTrigger("calendar_sync_outbox", async () => {
      await insertAppt(a, { id: appt }); // must SUCCEED despite the enqueue fault
    });
    expect((await adminQuery(`select id from public.appointments where id=$1`, [appt])).rowCount).toBe(1);
    expect(await outbox(appt)).toHaveLength(0);
    const marker = await adminQuery(
      `select safe_details from public.ops_alerts where event='calendar_enqueue_skipped' and appointment_id=$1`,
      [appt],
    );
    expect(marker.rowCount).toBe(1);
    // PHI-free marker.
    expect(JSON.stringify(marker.rows[0].safe_details)).not.toMatch(/@|client|name|email|phone/i);
  });

  it("a marker-insert failure ALSO does not abort the booking (nested guard, marker-write sabotage)", async () => {
    const a = await seedStudio("nr2");
    await seedConn(a);
    const appt = randomUUID();
    await withFailingTrigger("calendar_sync_outbox", async () => {
      await withFailingTrigger("ops_alerts", async () => {
        await insertAppt(a, { id: appt }); // both enqueue AND marker fail -> booking still succeeds
      });
    });
    expect((await adminQuery(`select id from public.appointments where id=$1`, [appt])).rowCount).toBe(1);
    expect(await outbox(appt)).toHaveLength(0);
    expect((await adminQuery(`select id from public.ops_alerts where appointment_id=$1`, [appt])).rowCount).toBe(0);
  });

  it("marker DEDUP: repeated enqueue failure for the same appointment keeps ONE unresolved marker", async () => {
    const a = await seedStudio("nr3");
    await seedConn(a);
    const appt = randomUUID();
    await withFailingTrigger("calendar_sync_outbox", async () => {
      await insertAppt(a, { id: appt }); // marker 1 (dedup_key = appointment:<id>)
      const later = slot();
      await adminQuery(`update public.appointments set starts_at=$2, ends_at=$3 where id=$1`, [appt, later.start, later.end]); // 2nd failing enqueue, same dedup_key
    });
    const markers = await adminQuery(
      `select id, safe_details from public.ops_alerts
        where event='calendar_enqueue_skipped' and studio_id=$1 and resolved_at is null`,
      [a.studioId],
    );
    expect(markers.rowCount).toBe(1); // deduped via ON CONFLICT DO NOTHING on the partial unique index
    expect(markers.rows[0].safe_details.dedup_key).toBe(`appointment:${appt}`);
    // A resolved marker never blocks a fresh one: resolve it, fail again -> a new marker.
    await adminQuery(`update public.ops_alerts set resolved_at=now() where id=$1`, [markers.rows[0].id]);
    await withFailingTrigger("calendar_sync_outbox", async () => {
      const later = slot();
      await adminQuery(`update public.appointments set starts_at=$2, ends_at=$3 where id=$1`, [appt, later.start, later.end]);
    });
    expect(
      (await adminQuery(`select id from public.ops_alerts where event='calendar_enqueue_skipped' and studio_id=$1 and resolved_at is null`, [a.studioId])).rowCount,
    ).toBe(1);
  });

  it("DELETE-trigger marker is guarded + deduped (no appointment_id; PHI-free)", async () => {
    const a = await seedStudio("nr4");
    await seedConn(a);
    const appt = await insertAppt(a);
    await adminQuery(`update public.calendar_event_links set google_event_id='ev-d' where hone_entity_id=$1`, [appt]);
    await withFailingTrigger("calendar_sync_outbox", async () => {
      await adminQuery(`delete from public.appointments where id=$1`, [appt]); // delete must SUCCEED despite the enqueue fault
    });
    expect((await adminQuery(`select id from public.appointments where id=$1`, [appt])).rowCount).toBe(0); // deleted
    const marker = await adminQuery(
      `select appointment_id, safe_details from public.ops_alerts
        where event='calendar_enqueue_skipped' and studio_id=$1 and route='trigger:enqueue_calendar_outbound_on_delete'`,
      [a.studioId],
    );
    expect(marker.rowCount).toBe(1);
    expect(marker.rows[0].appointment_id).toBeNull(); // never references the just-deleted appointment
    expect(marker.rows[0].safe_details.dedup_key).toBe(`appointment:${appt}`);
    expect(JSON.stringify(marker.rows[0].safe_details)).not.toMatch(/@|client|name|email|phone/i);
  });
});

// =========================================================================
describe("condition 2: health-aware expired-lease reaper", () => {
  async function seedProcessing(studio: SeededStudio, conn: string, attempts: number) {
    const id = randomUUID();
    await adminQuery(
      `insert into public.calendar_sync_outbox
         (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key,
          status, attempts, max_attempts, claimed_at, claim_token, lease_expires_at)
       values ($1,$2,$3,'event.create','appointment',$4,$5,'processing',$6,8,$7,$8,$7)`,
      [id, studio.studioId, conn, randomUUID(), `k-${randomUUID()}`, attempts, past(), randomUUID()],
    );
    return id;
  }

  it("UNHEALTHY expired-at-max -> RELEASED to pending (attempts-1), never dead; drains on recovery", async () => {
    const a = await seedStudio("rp1");
    const conn = await seedConn(a);
    const id = await seedProcessing(a, conn, 8);
    await adminQuery(`update public.calendar_connections set connection_status='reconnect_required' where id=$1`, [conn]);
    await setWorker(true);
    const r1 = await claim(25);
    expect(r1.rowCount).toBe(0); // released row is pending but ineligible (unhealthy)
    const rel = (await adminQuery(`select status, attempts, claim_token, lease_expires_at from public.calendar_sync_outbox where id=$1`, [id])).rows[0];
    expect(rel.status).toBe("pending");
    expect(Number(rel.attempts)).toBe(7); // restored, not deaded
    expect(rel.claim_token).toBeNull();
    expect(rel.lease_expires_at).toBeNull();
    // Restore health -> claimable.
    await adminQuery(`update public.calendar_connections set connection_status='connected' where id=$1`, [conn]);
    expect((await claim(25)).rows.map((x) => x.id)).toContain(id);
  });

  it("HEALTHY expired-at-max -> dead (deployed contract)", async () => {
    const a = await seedStudio("rp2");
    const conn = await seedConn(a);
    const id = await seedProcessing(a, conn, 8);
    await setWorker(true);
    await claim(25);
    const row = (await adminQuery(`select status, processed_at from public.calendar_sync_outbox where id=$1`, [id])).rows[0];
    expect(row.status).toBe("dead");
    expect(row.processed_at).toBeNull();
  });

  it("HEALTHY expired-below-max -> reclaimed (attempts+1)", async () => {
    const a = await seedStudio("rp3");
    const conn = await seedConn(a);
    const id = await seedProcessing(a, conn, 3);
    await setWorker(true);
    const r = await claim(25);
    const row = r.rows.find((x) => x.id === id);
    expect(row).toBeTruthy();
    expect(Number(row!.attempts)).toBe(4);
  });

  it("a missing control row is fail-safe disabled: claim mutates nothing", async () => {
    const a = await seedStudio("rp4");
    const conn = await seedConn(a);
    const id = await seedProcessing(a, conn, 8);
    try {
      await adminQuery(`delete from public.calendar_sync_control`);
      const r = await claim(25);
      expect(r.rowCount).toBe(0);
      expect((await adminQuery(`select status from public.calendar_sync_outbox where id=$1`, [id])).rows[0].status).toBe("processing");
    } finally {
      await adminQuery(`insert into public.calendar_sync_control (id, worker_enabled) values (true,false) on conflict (id) do nothing`);
    }
  });

  it("single-health-read: exactly ONE transition per stale row (never released AND deaded)", async () => {
    const a = await seedStudio("rp5");
    const conn = await seedConn(a);
    const id = await seedProcessing(a, conn, 8); // unhealthy-at-max after we flip status
    await adminQuery(`update public.calendar_connections set connection_status='reconnect_required' where id=$1`, [conn]);
    await setWorker(true);
    await claim(25);
    const row = (await adminQuery(`select status, attempts from public.calendar_sync_outbox where id=$1`, [id])).rows[0];
    // Released exactly once (attempts 8->7). If two predicates had both fired it would be dead or 6.
    expect(row.status).toBe("pending");
    expect(Number(row.attempts)).toBe(7);
  });

  it("two concurrent claim calls do not process the same stale row twice (FOR UPDATE SKIP LOCKED)", async () => {
    const a = await seedStudio("rp6");
    const conn = await seedConn(a);
    const id = await seedProcessing(a, conn, 8);
    await adminQuery(`update public.calendar_connections set connection_status='reconnect_required' where id=$1`, [conn]); // unhealthy
    await setWorker(true);
    await Promise.all([claim(25), claim(25)]); // both run the reaper concurrently
    const row = (await adminQuery(`select status, attempts from public.calendar_sync_outbox where id=$1`, [id])).rows[0];
    expect(row.status).toBe("pending");
    expect(Number(row.attempts)).toBe(7); // released ONCE (not 6) — SKIP LOCKED prevented double-processing
  });
});

// =========================================================================
describe("claim eligibility (superset scope + usable secret + intent)", () => {
  async function seedPendingJob(studio: SeededStudio, conn: string) {
    const id = randomUUID();
    await adminQuery(
      `insert into public.calendar_sync_outbox
         (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key)
       values ($1,$2,$3,'event.create','appointment',$4,$5)`,
      [id, studio.studioId, conn, randomUUID(), `k-${randomUUID()}`],
    );
    return id;
  }

  it("required-plus-extra scopes are healthy; missing .owned / missing secret / flag OFF are not", async () => {
    await setWorker(true);
    // healthy (has .owned + extra bundled scopes)
    const a = await seedStudio("el1");
    const cA = await seedConn(a);
    const jA = await seedPendingJob(a, cA);
    // missing .owned (Phase A only)
    const b = await seedStudio("el2");
    const cB = await seedConn(b, { scopes: PHASE_A });
    const jB = await seedPendingJob(b, cB);
    // missing secret
    const c = await seedStudio("el3");
    const cC = await seedConn(c, { secret: false });
    const jC = await seedPendingJob(c, cC);
    // studio flag OFF
    const d = await seedStudio("el4");
    const cD = await seedConn(d, { flag: false });
    const jD = await seedPendingJob(d, cD);

    const claimed = (await claim(25)).rows.map((x) => x.id);
    expect(claimed).toContain(jA);
    expect(claimed).not.toContain(jB);
    expect(claimed).not.toContain(jC);
    expect(claimed).not.toContain(jD);
    // The ineligible jobs did not decay.
    for (const j of [jB, jC, jD]) {
      expect(Number((await adminQuery(`select attempts from public.calendar_sync_outbox where id=$1`, [j])).rows[0].attempts)).toBe(0);
    }
  });

  it("two concurrent claimers of one eligible job: exactly one wins (SKIP LOCKED)", async () => {
    await setWorker(true);
    const a = await seedStudio("el5");
    const conn = await seedConn(a);
    await seedPendingJob(a, conn);
    const [r1, r2] = await Promise.all([claim(1), claim(1)]);
    expect((r1.rowCount ?? 0) + (r2.rowCount ?? 0)).toBe(1);
  });
});

// =========================================================================
describe("repair primitives (full-unique-safe; a dead/done row never blocks a repair)", () => {
  it("a genuine sync_version bump mints a NEW organic key past a prior done/dead row", async () => {
    for (const terminal of ["done", "dead"] as const) {
      const a = await seedStudio(`rep_${terminal}`);
      await seedConn(a);
      const appt = await insertAppt(a); // event.create:1
      await adminQuery(
        `update public.calendar_sync_outbox set status=$2, processed_at=case when $2='done' then now() else null end where hone_entity_id=$1`,
        [appt, terminal],
      );
      const newV = (await adminQuery(`select public.repair_bump_appointment_sync_version($1) as v`, [appt])).rows[0].v;
      expect(Number(newV)).toBe(2);
      const rows = await outbox(appt);
      const repair = rows.find((x) => x.idempotency_key === `appointment:${appt}:event.update:2`);
      expect(repair).toBeTruthy();
      expect(repair!.status).toBe("pending"); // a genuinely new, claimable row
    }
  });

  it("orphan-link delete: entity-less #reconcile key; deduped in a generation; re-issued on a new one", async () => {
    const a = await seedStudio("orp");
    const conn = await seedConn(a);
    const linkId = randomUUID();
    await adminQuery(
      `insert into public.calendar_event_links (id, studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id, google_event_id, last_hone_version)
       values ($1,$2,$3,'appointment',$4,'primary','ev-orphan',3)`,
      [linkId, a.studioId, conn, randomUUID()], // hone_entity_id points at a non-existent appointment (orphan)
    );
    const first = (await adminQuery(`select public.repair_enqueue_orphan_link_delete($1) as r`, [linkId])).rows[0].r;
    expect(first).not.toBe("no_active_link");
    const row = (await adminQuery(`select op_type, hone_entity_id, idempotency_key from public.calendar_sync_outbox where connection_id=$1`, [conn])).rows[0];
    expect(row.op_type).toBe("event.delete");
    expect(row.hone_entity_id).toBeNull(); // entity-less tombstone (relaxed CHECK)
    expect(row.idempotency_key).toBe(`connection:${conn}:link:${linkId}:event.delete#reconcile:0`);
    // Second call while a delete is in-flight -> guarded no dup.
    expect((await adminQuery(`select public.repair_enqueue_orphan_link_delete($1) as r`, [linkId])).rows[0].r).toBe("delete_in_flight");
    // Mark done, same generation -> suppressed (key already present under FULL unique).
    await adminQuery(`update public.calendar_sync_outbox set status='done', processed_at=now() where connection_id=$1`, [conn]);
    expect((await adminQuery(`select public.repair_enqueue_orphan_link_delete($1) as r`, [linkId])).rows[0].r).toBe("suppressed");
    // New reconcile generation -> a fresh key re-issues.
    await adminQuery(`update public.calendar_connections set reconcile_generation=1 where id=$1`, [conn]);
    const reissue = (await adminQuery(`select public.repair_enqueue_orphan_link_delete($1) as r`, [linkId])).rows[0].r;
    expect(reissue).not.toBe("suppressed");
    expect((await adminQuery(`select count(*)::int as n from public.calendar_sync_outbox where idempotency_key like $1`, [`connection:${conn}:link:${linkId}:event.delete#reconcile:1`])).rows[0].n).toBe(1);
  });
});

// =========================================================================
describe("entity CHECK relaxation (tombstone delete only)", () => {
  it("event.delete may be entity-less; create/update may not; full.resync unchanged", async () => {
    const a = await seedStudio("ec");
    const conn = await seedConn(a);
    const ins = (op: string, withEntity: boolean) =>
      adminQuery(
        `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key)
         values ($1,$2,$3,$4,$5,$6)`,
        [a.studioId, conn, op, withEntity ? "appointment" : null, withEntity ? randomUUID() : null, `k-${randomUUID()}`],
      );
    await expect(ins("event.delete", false)).resolves.toBeTruthy(); // NEW: entity-less tombstone delete OK
    await expect(ins("event.delete", true)).resolves.toBeTruthy(); // normal entity-backed delete OK
    await expect(ins("event.create", false)).rejects.toThrow(); // create needs an entity
    await expect(ins("event.update", false)).rejects.toThrow(); // update needs an entity
    await expect(ins("full.resync", true)).rejects.toThrow(); // resync must carry none
    await expect(ins("full.resync", false)).resolves.toBeTruthy(); // resync OK entity-less
  });

  it("invalid PARTIAL entity shapes fail (type xor id) for create/update/resync", async () => {
    const a = await seedStudio("ecp");
    const conn = await seedConn(a);
    const insPartial = (op: string, type: string | null, entityId: string | null) =>
      adminQuery(
        `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key)
         values ($1,$2,$3,$4,$5,$6)`,
        [a.studioId, conn, op, type, entityId, `k-${randomUUID()}`],
      );
    // create/update: type-without-id and id-without-type both reject.
    await expect(insPartial("event.create", "appointment", null)).rejects.toThrow();
    await expect(insPartial("event.create", null, randomUUID())).rejects.toThrow();
    await expect(insPartial("event.update", "appointment", null)).rejects.toThrow();
    await expect(insPartial("event.update", null, randomUUID())).rejects.toThrow();
    // full.resync: any partial entity rejects (must carry neither).
    await expect(insPartial("full.resync", "appointment", null)).rejects.toThrow();
    await expect(insPartial("full.resync", null, randomUUID())).rejects.toThrow();
  });
});

// =========================================================================
describe("queue-health view + append-only suppression telemetry", () => {
  it("a studio with ZERO outbox rows but an open skip marker still appears", async () => {
    const a = await seedStudio("hv1");
    await adminQuery(
      `insert into public.ops_alerts (severity, event, message, studio_id) values ('warning','calendar_enqueue_skipped','x',$1)`,
      [a.studioId],
    );
    const v = (await adminQuery(`select * from public.calendar_sync_queue_health where studio_id=$1`, [a.studioId])).rows[0];
    expect(v).toBeTruthy();
    expect(Number(v.pending)).toBe(0);
    expect(Number(v.skip_markers_open)).toBe(1);
  });

  it("splits ELIGIBLE vs PARKED pending; parked still counts in total pending + oldest_pending_due", async () => {
    // Eligible studio (healthy conn) with a pending job.
    const elig = await seedStudio("hvElig");
    const cElig = await seedConn(elig);
    await adminQuery(
      `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key)
       values ($1,$2,'event.create','appointment',$3,$4)`,
      [elig.studioId, cElig, randomUUID(), `k-${randomUUID()}`],
    );
    const vElig = (await adminQuery(`select * from public.calendar_sync_queue_health where studio_id=$1`, [elig.studioId])).rows[0];
    expect(Number(vElig.pending)).toBe(1);
    expect(Number(vElig.eligible_pending)).toBe(1);
    expect(Number(vElig.parked_pending)).toBe(0);
    expect(vElig.oldest_eligible_pending_due).not.toBeNull();
    expect(vElig.oldest_parked_pending_due).toBeNull();

    // Parked studio (unhealthy conn: reconnect_required) with a pending job.
    const park = await seedStudio("hvPark");
    const cPark = await seedConn(park, { status: "reconnect_required" });
    await adminQuery(
      `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key)
       values ($1,$2,'event.create','appointment',$3,$4)`,
      [park.studioId, cPark, randomUUID(), `k-${randomUUID()}`],
    );
    const vPark = (await adminQuery(`select * from public.calendar_sync_queue_health where studio_id=$1`, [park.studioId])).rows[0];
    // Parked work is NOT invisible: it still counts in total pending + oldest_pending_due.
    expect(Number(vPark.pending)).toBe(1);
    expect(vPark.oldest_pending_due).not.toBeNull();
    expect(Number(vPark.eligible_pending)).toBe(0);
    expect(Number(vPark.parked_pending)).toBe(1);
    expect(vPark.oldest_eligible_pending_due).toBeNull();
    expect(vPark.oldest_parked_pending_due).not.toBeNull();
  });

  it("suppression telemetry is append-only (no shared counter row; no (studio,metric,day) unique)", async () => {
    const a = await seedStudio("hv2");
    const conn = await seedConn(a);
    // Force TWO suppressions for the same studio by pre-seeding the exact keys.
    for (let i = 0; i < 2; i++) {
      const appt = randomUUID();
      await adminQuery(
        `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key)
         values ($1,$2,'event.create','appointment',$3,$4)`,
        [a.studioId, conn, appt, `appointment:${appt}:event.create:1`],
      );
      await insertAppt(a, { id: appt }); // enqueue hits the existing key -> suppressed -> one metric event
    }
    const events = await adminQuery(
      `select id from public.calendar_sync_metric_events where studio_id=$1 and metric='idempotency_suppressed'`,
      [a.studioId],
    );
    expect(events.rowCount).toBe(2); // two INDEPENDENT rows, not one merged counter
    const uniques = await adminQuery(
      `select count(*)::int as n from pg_constraint
        where conrelid='public.calendar_sync_metric_events'::regclass and contype='u'`,
    );
    expect(uniques.rows[0].n).toBe(0); // no unique constraint that would serialize concurrent suppressions
    const v = (await adminQuery(`select idempotency_suppressed_24h from public.calendar_sync_queue_health where studio_id=$1`, [a.studioId])).rows[0];
    expect(Number(v.idempotency_suppressed_24h)).toBe(2);
  });
});
