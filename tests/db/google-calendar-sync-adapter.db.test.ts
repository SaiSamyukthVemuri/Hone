import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio, type SeededStudio } from "./helpers/harness";
import { runCalendarSyncCronBatch } from "@/lib/google-calendar/sync/adapters";
import { handleCalendarSyncJob } from "@/lib/google-calendar/sync/handler";
import type { ClaimedJob, JobResult } from "@/lib/google-calendar/sync/job-result";
import type { ConnectionAuthRow, ConnectionStore, TokenManager } from "@/lib/google-calendar/sync/token-manager";

// Google Calendar — Phase B2.1 adapter DB integration (LOCAL disposable Supabase
// only). Proves the transport adapter's claim -> handle -> record loop against
// the deployed 0124 RPCs with a synthetic outbox row. NO hosted production is
// reachable (the harness enforces localhost); NO real Google call is made (the op
// is a mock; the token manager is a stub). This is the discipline B2.3 relies on.

const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

afterAll(async () => {
  await closePool();
});

// claim_calendar_sync_op is a GLOBAL drain; isolate each test's view of the queue.
beforeEach(async () => {
  await adminQuery("delete from public.calendar_sync_outbox");
});

function mapRow(r: Record<string, unknown>): ClaimedJob {
  return {
    id: r.id as string,
    studioId: r.studio_id as string,
    connectionId: r.connection_id as string,
    opType: r.op_type as ClaimedJob["opType"],
    honeEntityType: (r.hone_entity_type as ClaimedJob["honeEntityType"]) ?? null,
    honeEntityId: (r.hone_entity_id as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    idempotencyKey: r.idempotency_key as string,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    claimToken: r.claim_token as string,
    leaseExpiresAt: new Date(r.lease_expires_at as string).toISOString(),
    priority: Number(r.priority),
  };
}

function pgStore(): ConnectionStore {
  return {
    async loadConnection(id, studioId) {
      const r = await adminQuery(
        "select id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner, token_expires_at from public.calendar_connections where id=$1 and studio_id=$2",
        [id, studioId],
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
      };
    },
    loadRefreshCiphertext: async () => null,
    storeRotatedToken: async () => {},
    touchTokenExpiry: async () => {},
    markReconnectRequired: async () => {},
  };
}

async function seedEligibleConnection(studio: SeededStudio): Promise<string> {
  const connId = randomUUID();
  await adminQuery(
    "insert into public.calendar_connections (id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner) values ($1,$2,$3,'connected',$4,'primary',true)",
    [connId, studio.studioId, studio.practitionerId, [EVENTS_SCOPE]],
  );
  return connId;
}

async function insertOutboxJob(studio: SeededStudio, connId: string): Promise<{ id: string; entityId: string }> {
  const id = randomUUID();
  const entityId = randomUUID();
  await adminQuery(
    `insert into public.calendar_sync_outbox
       (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key, status, priority, next_attempt_at)
     values ($1,$2,$3,'event.create','appointment',$4,$5,'pending',100, now())`,
    [id, studio.studioId, connId, entityId, `appointment:${entityId}:event.create:1`],
  );
  return { id, entityId };
}

describe("cron adapter claim -> handle -> record", () => {
  it("targets a LOCAL database only (environment pin)", () => {
    expect(resolveLocalDbUrl()).toMatch(/127\.0\.0\.1|localhost/);
  });

  it("claims a synthetic outbox row, handles it, and records the result via the RPCs", async () => {
    const studio = await seedStudio("gcalAdapter");
    const connId = await seedEligibleConnection(studio);
    const job = await insertOutboxJob(studio, connId);

    // Real handler (eligibility gate runs against the DB connection), stub token
    // manager (no Google), mock operation returning ok.
    const store = pgStore();
    const tokenManager: TokenManager = {
      async ensureAccessToken(id, s) {
        const conn = (await store.loadConnection(id, s)) as ConnectionAuthRow;
        return { ok: true, accessToken: "fake-access-token", connection: conn };
      },
    };
    const handle = (j: ClaimedJob): Promise<JobResult> =>
      handleCalendarSyncJob(j, {
        store,
        tokenManager,
        isStudioOutboundEnabled: async () => true,
        operations: { "event.create": async () => ({ code: "ok" }) },
      });

    const summary = await runCalendarSyncCronBatch({
      batchSize: 25,
      claim: async (n) => {
        const r = await adminQuery("select * from public.claim_calendar_sync_op($1)", [n]);
        return r.rows.map(mapRow);
      },
      record: async (p) => {
        const r = await adminQuery("select public.record_calendar_sync_result($1,$2,$3,$4,$5,$6) as s", [
          p.id,
          p.claimToken,
          p.ok,
          p.errorCode,
          p.errorMessage,
          p.retryAfterSeconds,
        ]);
        return r.rows[0].s as string;
      },
      handle,
    });

    expect(summary.claimed).toBe(1);
    expect(summary.done).toBe(1);
    expect(summary.byCode.ok).toBe(1);

    const row = await adminQuery("select status, processed_at from public.calendar_sync_outbox where id=$1", [job.id]);
    expect(row.rows[0].status).toBe("done");
    expect(row.rows[0].processed_at).not.toBeNull();
  });

  it("an ineligible connection (outbound flag off) records a retry, not done", async () => {
    const studio = await seedStudio("gcalAdapterOff");
    const connId = await seedEligibleConnection(studio);
    const job = await insertOutboxJob(studio, connId);
    const store = pgStore();
    const tokenManager: TokenManager = {
      async ensureAccessToken(id, s) {
        const conn = (await store.loadConnection(id, s)) as ConnectionAuthRow;
        return { ok: true, accessToken: "x", connection: conn };
      },
    };
    const summary = await runCalendarSyncCronBatch({
      claim: async (n) => (await adminQuery("select * from public.claim_calendar_sync_op($1)", [n])).rows.map(mapRow),
      record: async (p) =>
        (
          await adminQuery("select public.record_calendar_sync_result($1,$2,$3,$4,$5,$6) as s", [
            p.id,
            p.claimToken,
            p.ok,
            p.errorCode,
            p.errorMessage,
            p.retryAfterSeconds,
          ])
        ).rows[0].s as string,
      handle: (j) =>
        handleCalendarSyncJob(j, {
          store,
          tokenManager,
          isStudioOutboundEnabled: async () => false, // flag OFF
          operations: { "event.create": async () => ({ code: "ok" }) },
        }),
    });
    expect(summary.retried).toBe(1);
    const row = await adminQuery("select status, attempts from public.calendar_sync_outbox where id=$1", [job.id]);
    // Recorded as a retry -> back to pending (claimed once, so attempts = 1).
    expect(row.rows[0].status).toBe("pending");
  });
});
