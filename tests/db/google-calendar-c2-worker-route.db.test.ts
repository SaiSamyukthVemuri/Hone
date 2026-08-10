import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, purgeAppointmentAudit, closePool, resolveLocalDbUrl, seedStudio, type SeededStudio } from "./helpers/harness";
import {
  drainCalendarSyncQueue,
  toClaimedJob,
  type ClaimPort,
  type HandlePort,
  type RecordPort,
} from "@/lib/google-calendar/sync/worker-runtime";
import { handleCalendarSyncJob } from "@/lib/google-calendar/sync/handler";
import { createCalendarSyncOperations } from "@/lib/google-calendar/sync/operations";
import { createGoogleRestClient } from "@/lib/google-calendar/sync/google-rest-client";
import { buildEventMarker, deriveEventId } from "@/lib/google-calendar/sync/event-id";
import type { ClaimedJob, JobResult } from "@/lib/google-calendar/sync/job-result";
import type { ConnectionAuthRow, ConnectionStore, TokenManager } from "@/lib/google-calendar/sync/token-manager";
import type { AppointmentState, LinkRow, OpsLinkStore, TransitionArgs, TransitionResult } from "@/lib/google-calendar/sync/link-transition-store";

// Google Calendar — Phase B2.3-c2. LOCAL disposable Supabase ONLY (the harness
// enforces localhost; CI's db-integration lane). Proves, against the DEPLOYED
// 0124/0125/0132 RPCs:
//   §23 two concurrent authorized drains race the SAME claim RPC (no new route
//       lock) and cannot dispatch/record a row twice (FOR UPDATE SKIP LOCKED);
//   §24 the real claim -> handleCalendarSyncJob -> c1 operations map -> ACTUAL REST
//       client over FAKE transport -> transactional link transition -> real record
//       RPC (success, retry, provider-success-then-record-failure recovery);
//   §25 worker_enabled=false => claim returns zero rows and performs zero mutation.
// No hosted DB is reachable; NO real Google call is ever made.

const APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created";

let studio: SeededStudio;
let connId: string;

async function seedConn(): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, is_studio_calendar_owner, write_calendar_id, granted_scopes, destination_mode)
     values ($1,$2,$3,'connected',true,'cal',$4,'dedicated_app_created')`,
    [id, studio.studioId, studio.practitionerId, [APP_CREATED]],
  );
  await adminQuery(
    `insert into public.calendar_connection_secrets (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
     values ($1,$2,'v1:1:iv:tag:ct',1)`,
    [id, studio.studioId],
  );
  await adminQuery(`update public.studios set google_calendar_outbound_sync_enabled=true where id=$1`, [studio.studioId]);
  return id;
}

let slotSeq = 0;
// Inserting a confirmed appointment with an eligible connection auto-enqueues (via
// the deployed trigger) a placeholder calendar_event_links row + a pending
// event.create outbox row — exactly the production create lifecycle.
async function insertAppt(): Promise<string> {
  const id = randomUUID();
  const base = Date.now() + 86_400_000 + slotSeq++ * 3_600_000;
  const start = new Date(base).toISOString();
  const end = new Date(base + 1_800_000).toISOString();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4,$5,30,'confirmed')`,
    [id, studio.studioId, studio.clientId, start, end],
  );
  return id;
}

async function pendingOutbox(apptId: string) {
  const r = await adminQuery(
    `select * from public.calendar_sync_outbox where hone_entity_id=$1 and status='pending' order by created_at limit 1`,
    [apptId],
  );
  return r.rows[0];
}
async function outboxRow(id: string) {
  return (await adminQuery(`select * from public.calendar_sync_outbox where id=$1`, [id])).rows[0];
}
async function placeholderLink(apptId: string) {
  return (await adminQuery(`select * from public.calendar_event_links where hone_entity_id=$1 order by created_at limit 1`, [apptId])).rows[0];
}

// --- adminQuery-backed production-shaped adapters (pg, not the supabase client) ---
function adminConnStore(): ConnectionStore {
  return {
    async loadConnection(id, s) {
      const r = await adminQuery(
        `select id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner, token_expires_at, destination_mode
           from public.calendar_connections where id=$1 and studio_id=$2`,
        [id, s],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      return {
        id: row.id,
        studioId: row.studio_id,
        practitionerId: row.practitioner_id,
        connectionStatus: row.connection_status,
        grantedScopes: row.granted_scopes ?? [],
        writeCalendarId: row.write_calendar_id,
        isStudioCalendarOwner: row.is_studio_calendar_owner === true,
        tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
        destinationMode: row.destination_mode ?? null,
      } satisfies ConnectionAuthRow;
    },
    loadRefreshCiphertext: async () => null,
    storeRotatedToken: async () => {},
    touchTokenExpiry: async () => {},
    markReconnectRequired: async () => {},
  };
}

// Stub token manager (no real Google refresh — the refresh path + its Upstash
// mutex are covered by the coordinator unit tests + the token-refresh db test).
function stubTokenManager(store: ConnectionStore): TokenManager {
  return {
    async ensureAccessToken(id, s) {
      const conn = (await store.loadConnection(id, s)) as ConnectionAuthRow;
      return { ok: true, accessToken: "fake-access-token", connection: conn };
    },
  };
}

function toLinkRow(row: Record<string, unknown>): LinkRow {
  return {
    id: row.id as string,
    studioId: row.studio_id as string,
    connectionId: row.connection_id as string,
    honeEntityType: row.hone_entity_type as LinkRow["honeEntityType"],
    honeEntityId: row.hone_entity_id as string,
    googleCalendarId: row.google_calendar_id as string,
    googleEventId: (row.google_event_id as string | null) ?? null,
    googleIcalUid: (row.google_ical_uid as string | null) ?? null,
    googleEtag: (row.google_etag as string | null) ?? null,
    lastHoneVersion: Number(row.last_hone_version ?? 0),
    syncStatus: row.sync_status as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}
const LINK_COLS =
  "id, studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id, google_event_id, google_ical_uid, google_etag, last_hone_version, sync_status, deleted_at";

function adminOpsStore(): OpsLinkStore {
  return {
    async loadActiveLinkByEntity(s, t, e) {
      const r = await adminQuery(
        `select ${LINK_COLS} from public.calendar_event_links where studio_id=$1 and hone_entity_type=$2 and hone_entity_id=$3 and deleted_at is null limit 1`,
        [s, t, e],
      );
      return r.rowCount ? toLinkRow(r.rows[0]) : null;
    },
    async loadLinkById(id) {
      const r = await adminQuery(`select ${LINK_COLS} from public.calendar_event_links where id=$1`, [id]);
      return r.rowCount ? toLinkRow(r.rows[0]) : null;
    },
    async loadLinkForJob(id, s, c) {
      const r = await adminQuery(`select ${LINK_COLS} from public.calendar_event_links where id=$1 and studio_id=$2 and connection_id=$3`, [id, s, c]);
      return r.rowCount ? toLinkRow(r.rows[0]) : null;
    },
    async loadAppointmentState(id, s) {
      const r = await adminQuery(
        `select a.id, a.studio_id, a.status, a.sync_version, a.starts_at, a.ends_at, st.timezone
           from public.appointments a join public.studios st on st.id=a.studio_id where a.id=$1 and a.studio_id=$2`,
        [id, s],
      );
      if (!r.rowCount) return null;
      const row = r.rows[0];
      return {
        id: row.id,
        studioId: row.studio_id,
        status: row.status,
        syncVersion: Number(row.sync_version ?? 0),
        startsAt: new Date(row.starts_at).toISOString(),
        endsAt: new Date(row.ends_at).toISOString(),
        studioTimezone: row.timezone ?? "UTC",
      } satisfies AppointmentState;
    },
    async transition(a: TransitionArgs): Promise<TransitionResult> {
      const r = await adminQuery(
        `select public.calendar_event_link_transition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r`,
        [a.action, a.outboxId, a.claimToken, a.linkId, a.studioId, a.connectionId, a.honeEntityType, a.honeEntityId,
          a.expectedSourceVersion ?? null, a.googleEventId ?? null, a.googleIcalUid ?? null, a.googleEtag ?? null],
      );
      const obj = r.rows[0].r as { status?: string; code?: string; link_id?: string };
      return { status: obj.status === "ok" ? "ok" : "rejected", code: obj.code ?? "unknown", linkId: obj.link_id };
    },
  };
}

function claimAdapter(): ClaimPort {
  return async (n) => {
    const r = await adminQuery(`select * from public.claim_calendar_sync_op($1)`, [n]);
    return r.rows.map((row) => toClaimedJob(row as Record<string, unknown>));
  };
}
function recordAdapter(): RecordPort {
  return async (p) => {
    const r = await adminQuery(`select public.record_calendar_sync_result($1,$2,$3,$4,$5,$6) as s`, [
      p.id, p.claimToken, p.ok, p.errorCode, p.errorMessage, p.retryAfterSeconds,
    ]);
    return r.rows[0].s as string;
  };
}

// A guarded FAKE fetch (never a real Google call).
type Req = { method: string; url: string; body: unknown };
function fakeFetch(handler: (req: Req) => { status: number; body?: unknown }) {
  const calls: Req[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const req: Req = { method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const r = handler(req);
    return { status: r.status, headers: { get: () => null }, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) } as unknown as Response;
  });
  return { impl, calls };
}

function c1Handle(fetchImpl: typeof fetch): HandlePort {
  const store = adminConnStore();
  const rest = createGoogleRestClient({ fetchImpl });
  const operations = createCalendarSyncOperations({ rest, store: adminOpsStore(), invalidateAccessToken: () => {} });
  return (job: ClaimedJob): Promise<JobResult> =>
    handleCalendarSyncJob(job, { store, tokenManager: stubTokenManager(store), isStudioOutboundEnabled: async () => true, operations });
}

const NOW_OPTS = () => ({ startedAt: Date.now(), deadlineMs: Date.now() + 30_000, now: () => Date.now() });

beforeAll(async () => {
  studio = await seedStudio("gcalC2Worker");
  connId = await seedConn();
});
afterAll(async () => {
  await adminQuery(`delete from public.calendar_sync_outbox where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.calendar_event_links where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.appointments where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.calendar_connection_secrets where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.calendar_connections where studio_id=$1`, [studio.studioId]).catch(() => {});
  await purgeAppointmentAudit(studio.studioId).catch(() => {});
  await adminQuery(`delete from public.studios where id = $1`, [studio.studioId]).catch(() => {});
  await closePool();
});
beforeEach(async () => {
  await adminQuery(`delete from public.calendar_sync_outbox where studio_id=$1`, [studio.studioId]);
  await adminQuery(`delete from public.calendar_event_links where studio_id=$1`, [studio.studioId]);
  await adminQuery(`update public.calendar_sync_control set worker_enabled=true`);
});

describe("environment pin", () => {
  it("targets a LOCAL database only", () => {
    expect(resolveLocalDbUrl()).toMatch(/127\.0\.0\.1|localhost/);
  });
});

describe("§25 worker-off dormancy proof", () => {
  it("worker_enabled=false: claim returns zero, no reap/attempt/claim-token/lease mutation, no handle/record", async () => {
    const appt = await insertAppt();
    const ob = await pendingOutbox(appt);
    expect(ob).toBeTruthy();
    await adminQuery(`update public.calendar_sync_control set worker_enabled=false`);

    const handle = vi.fn<HandlePort>(async () => ({ code: "ok" }));
    const record = vi.fn<RecordPort>(async () => "done");
    const r = await drainCalendarSyncQueue({ claim: claimAdapter(), handle, record }, NOW_OPTS());

    expect(r.claimed).toBe(0);
    expect(handle).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    const after = await outboxRow(ob.id);
    expect(after.status).toBe("pending");
    expect(Number(after.attempts)).toBe(0);
    expect(after.claim_token).toBeNull();
    expect(after.claimed_at).toBeNull();
    expect(after.lease_expires_at).toBeNull();
    expect(new Date(after.next_attempt_at).getTime()).toBe(new Date(ob.next_attempt_at).getTime());
  });
});

describe("§23 concurrent invocations race the claim RPC (no new route lock)", () => {
  it("two concurrent drains: a single row is claimed + executed + recorded exactly once; the other sees no work", async () => {
    const appt = await insertAppt();
    const ob = await pendingOutbox(appt);
    const executions: string[] = [];
    const ledger: HandlePort = async (job) => {
      executions.push(job.id);
      return { code: "ok" };
    };
    const ports = { claim: claimAdapter(), handle: ledger, record: recordAdapter() };
    const [a, b] = await Promise.all([drainCalendarSyncQueue(ports, NOW_OPTS()), drainCalendarSyncQueue(ports, NOW_OPTS())]);

    expect(a.claimed + b.claimed).toBe(1); // exactly one invocation claimed the row
    expect(executions).toEqual([ob.id]); // exactly one provider execution
    expect(a.recorded_done + b.recorded_done).toBe(1); // exactly one durable transition
    expect(a.no_work !== b.no_work).toBe(true); // exactly one reported no-work
    expect((await outboxRow(ob.id)).status).toBe("done");
  });

  it("multiple rows: SKIP LOCKED partitions across two invocations — each row processed exactly once", async () => {
    const appts = [] as string[];
    for (let i = 0; i < 6; i++) appts.push(await insertAppt());
    const obIds = new Set<string>();
    for (const a of appts) obIds.add((await pendingOutbox(a)).id);

    const executions: string[] = [];
    const ledger: HandlePort = async (job) => {
      executions.push(job.id);
      return { code: "ok" };
    };
    const ports = { claim: claimAdapter(), handle: ledger, record: recordAdapter() };
    const [a, b] = await Promise.all([drainCalendarSyncQueue(ports, NOW_OPTS()), drainCalendarSyncQueue(ports, NOW_OPTS())]);

    expect(a.claimed + b.claimed).toBe(6);
    expect(new Set(executions).size).toBe(6); // no row executed twice
    expect([...new Set(executions)].sort()).toEqual([...obIds].sort());
    const dead = await adminQuery(`select count(*)::int c from public.calendar_sync_outbox where studio_id=$1 and status<>'done'`, [studio.studioId]);
    expect(dead.rows[0].c).toBe(0); // every row converged to done
  });
});

describe("§24 claim -> handle -> record integration (real RPCs + real REST over fake transport)", () => {
  it("success: create executes once, the link binds transactionally, the record RPC marks the outbox done", async () => {
    const appt = await insertAppt();
    const ob = await pendingOutbox(appt);
    const link = await placeholderLink(appt);
    const expectedId = deriveEventId(studio.studioId, link.id);
    const f = fakeFetch((req) =>
      req.method === "POST"
        ? { status: 200, body: { id: expectedId, status: "confirmed", etag: "e-srv", extendedProperties: { private: buildEventMarker(link.id) } } }
        : { status: 404 },
    );
    const r = await drainCalendarSyncQueue({ claim: claimAdapter(), handle: c1Handle(f.impl as never), record: recordAdapter() }, NOW_OPTS());

    expect(r.recorded_done).toBe(1);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1); // exactly one create
    const bound = await placeholderLink(appt);
    expect(bound.google_event_id).toBe(expectedId);
    expect(bound.sync_status).toBe("synced");
    expect((await outboxRow(ob.id)).status).toBe("done");
  });

  it("retry: a transient provider failure returns the row to pending with a bounded backoff (never bound)", async () => {
    const appt = await insertAppt();
    const ob = await pendingOutbox(appt);
    const f = fakeFetch((req) => (req.method === "POST" ? { status: 503, body: { error: { message: "backend" } } } : { status: 404 }));
    const r = await drainCalendarSyncQueue({ claim: claimAdapter(), handle: c1Handle(f.impl as never), record: recordAdapter() }, NOW_OPTS());

    expect(r.recorded_pending).toBe(1);
    const row = await outboxRow(ob.id);
    expect(row.status).toBe("pending");
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(new Date(ob.next_attempt_at).getTime());
    const stillPlaceholder = await placeholderLink(appt);
    expect(stillPlaceholder.google_event_id).toBeNull(); // never bound on a failed create
  });

  it("provider success then record failure: the link state applies, the row is NOT falsely done, and reclaim converges with NO second provider event", async () => {
    const appt = await insertAppt();
    const ob = await pendingOutbox(appt);
    const link = await placeholderLink(appt);
    const expectedId = deriveEventId(studio.studioId, link.id);
    const f = fakeFetch((req) =>
      req.method === "POST"
        ? { status: 200, body: { id: expectedId, status: "confirmed", etag: "e-srv", extendedProperties: { private: buildEventMarker(link.id) } } }
        : { status: 404 },
    );
    const handle = c1Handle(f.impl as never);

    // First drain: the provider create + link bind apply, but recording throws.
    const sabotagedRecord: RecordPort = async () => {
      throw new Error("record_rpc_error");
    };
    const first = await drainCalendarSyncQueue({ claim: claimAdapter(), handle, record: sabotagedRecord }, NOW_OPTS());
    expect(first.outcome).toBe("error");
    expect(first.record_errors).toBe(1);
    // Link IS bound (provider effect applied); the outbox row was NOT marked done.
    const boundAfterFail = await placeholderLink(appt);
    expect(boundAfterFail.google_event_id).toBe(expectedId);
    expect((await outboxRow(ob.id)).status).toBe("processing");

    // Simulate lease expiry so the claim RPC reclaims the row.
    await adminQuery(`update public.calendar_sync_outbox set lease_expires_at = now() - interval '1 minute' where id=$1`, [ob.id]);

    // Second drain (record works): reclaim sees the applied link state -> the fence
    // proves completion -> ok_noop_superseded -> recorded done. NO second create.
    const second = await drainCalendarSyncQueue({ claim: claimAdapter(), handle, record: recordAdapter() }, NOW_OPTS());
    expect(second.recorded_done).toBe(1);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1); // still exactly one create
    expect((await outboxRow(ob.id)).status).toBe("done");
  });
});
