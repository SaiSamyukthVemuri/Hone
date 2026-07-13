import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// Google Calendar — Phase B, PR B1. Behavioral proof of the outbound-sync
// foundation (migration 0124): constraints, tenant isolation, the deterministic
// idempotency key, the four-state model, and the claim/result RPCs incl. the
// stale-lease dead transition + backoff bounds + token validation.

// claim_calendar_sync_op is a GLOBAL service-role drain (it claims across all
// studios, not one tenant), and tests/db share one long-lived local database, so
// rows seeded by earlier tests would otherwise be visible to a later claim and
// make any global rowCount assertion non-deterministic (the harness rule:
// "assertions must scope by these ids, never by global counts"). The outbox is
// touched only by this file, so clearing it before each test makes the global
// claim see exactly the rows the test under exercise seeded. Tenant isolation is
// still proven by the per-id / cross-studio assertions below.
beforeEach(async () => {
  await adminQuery("delete from public.calendar_sync_outbox");
  // Migration 0125 added a GLOBAL runtime worker control that gates claim; these
  // 0124 transport tests exercise the claim/record mechanics, so enable it.
  await adminQuery("update public.calendar_sync_control set worker_enabled = true");
});

afterAll(async () => {
  await closePool();
});

// Migration 0125 added claim-time HEALTH eligibility. The 0124 transport tests
// prove claim/record mechanics, so seed a FULLY outbound-ready owner connection
// (connected + owner + a selected write calendar + the .owned event scope + a
// usable encrypted secret) and enable the studio's outbound product-intent flag,
// so a job is claimable. Each test uses a distinct studio, so the one-owner-per-
// studio unique is never contended.
const OWNED_EVENT_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";
async function seedConnection(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status,
        is_studio_calendar_owner, write_calendar_id, granted_scopes)
     values ($1,$2,$3,'connected',true,'primary',array[$4]::text[])`,
    [id, studio.studioId, studio.practitionerId, OWNED_EVENT_SCOPE],
  );
  await adminQuery(
    `insert into public.calendar_connection_secrets
       (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
     values ($1,$2,'v1:1:iv:tag:ct',1)`,
    [id, studio.studioId],
  );
  await adminQuery(
    `update public.studios set google_calendar_outbound_sync_enabled = true where id=$1`,
    [studio.studioId],
  );
  return id;
}

async function insertOutbox(
  studio: SeededStudio,
  connId: string,
  o: Record<string, unknown> = {},
): Promise<string> {
  const id = (o.id as string) ?? randomUUID();
  const entityId = (o.hone_entity_id as string) ?? randomUUID();
  const key = (o.idempotency_key as string) ?? `appointment:${entityId}:event.create:1`;
  await adminQuery(
    `insert into public.calendar_sync_outbox
       (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id,
        idempotency_key, status, priority, attempts, max_attempts, next_attempt_at,
        claimed_at, claim_token, lease_expires_at, last_error_code)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, $12, $13, $14, $15, $16)`,
    [
      id, studio.studioId, connId,
      o.op_type ?? "event.create",
      o.hone_entity_type === null ? null : (o.hone_entity_type ?? "appointment"),
      o.hone_entity_type === null ? null : entityId,
      key,
      o.status ?? "pending",
      o.priority ?? 100,
      o.attempts ?? 0,
      o.max_attempts ?? 8,
      o.next_attempt_at ?? new Date().toISOString(),
      o.claimed_at ?? null,
      o.claim_token ?? null,
      o.lease_expires_at ?? null,
      o.last_error_code ?? null,
    ],
  );
  return id;
}

const claim = (n: number) =>
  adminQuery("select * from public.claim_calendar_sync_op($1)", [n]);
const result = (
  id: string, token: string | null, ok: boolean, code?: string, msg?: string, backoff?: number,
) =>
  adminQuery("select public.record_calendar_sync_result($1,$2,$3,$4,$5,$6) as r", [
    id, token, ok, code ?? null, msg ?? null, backoff ?? null,
  ]);

// =========================================================================
describe("calendar_event_links — constraints + isolation", () => {
  it("same-studio insert succeeds; cross-studio connection is rejected", async () => {
    const a = await seedStudio("elA");
    const b = await seedStudio("elB");
    const connA = await seedConnection(a);
    await adminQuery(
      `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id)
       values ($1,$2,'appointment',$3,'primary')`,
      [a.studioId, connA, randomUUID()],
    );
    // Studio B row pointing at Studio A's connection must fail (composite FK).
    await expect(
      adminQuery(
        `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id)
         values ($1,$2,'appointment',$3,'primary')`,
        [b.studioId, connA, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it("one active link per Hone entity; a soft-deleted link permits replacement", async () => {
    const a = await seedStudio("elDup");
    const conn = await seedConnection(a);
    const entity = randomUUID();
    await adminQuery(
      `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id)
       values ($1,$2,'appointment',$3,'primary')`,
      [a.studioId, conn, entity],
    );
    await expect(
      adminQuery(
        `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id)
         values ($1,$2,'appointment',$3,'primary')`,
        [a.studioId, conn, entity],
      ),
    ).rejects.toThrow();
    // Soft-delete the first, then a new active link for the same entity is allowed.
    await adminQuery(
      "update public.calendar_event_links set deleted_at = now() where studio_id=$1 and hone_entity_id=$2",
      [a.studioId, entity],
    );
    const ok = await adminQuery(
      `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id)
       values ($1,$2,'appointment',$3,'primary') returning id`,
      [a.studioId, conn, entity],
    );
    expect(ok.rowCount).toBe(1);
  });

  it("one active mapping per Google event id", async () => {
    const a = await seedStudio("elGoog");
    const conn = await seedConnection(a);
    await adminQuery(
      `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id, google_event_id)
       values ($1,$2,'appointment',$3,'primary','gev1')`,
      [a.studioId, conn, randomUUID()],
    );
    await expect(
      adminQuery(
        `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id, google_event_id)
         values ($1,$2,'appointment',$3,'primary','gev1')`,
        [a.studioId, conn, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it("a member SELECTs only same-studio links and cannot INSERT/UPDATE/DELETE", async () => {
    const a = await seedStudio("elRls");
    const b = await seedStudio("elRls2");
    const conn = await seedConnection(a);
    const linkId = randomUUID();
    await adminQuery(
      `insert into public.calendar_event_links (id, studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id)
       values ($1,$2,$3,'appointment',$4,'primary')`,
      [linkId, a.studioId, conn, randomUUID()],
    );
    expect((await userQuery(a.userId, "select id from public.calendar_event_links where id=$1", [linkId])).rowCount).toBe(1);
    expect((await userQuery(b.userId, "select id from public.calendar_event_links where id=$1", [linkId])).rowCount).toBe(0);
    await expect(
      userQuery(a.userId, "update public.calendar_event_links set google_event_id='x' where id=$1", [linkId]),
    ).rejects.toThrow();
    await expect(
      userQuery(a.userId, "delete from public.calendar_event_links where id=$1", [linkId]),
    ).rejects.toThrow();
    await expect(
      userQuery(a.userId,
        `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id) values ($1,$2,'appointment',$3,'primary')`,
        [a.studioId, conn, randomUUID()]),
    ).rejects.toThrow();
  });

  it("connection deletion is blocked while a link exists (RESTRICT)", async () => {
    const a = await seedStudio("elRestrict");
    const conn = await seedConnection(a);
    await adminQuery(
      `insert into public.calendar_event_links (studio_id, connection_id, hone_entity_type, hone_entity_id, google_calendar_id)
       values ($1,$2,'appointment',$3,'primary')`,
      [a.studioId, conn, randomUUID()],
    );
    await expect(
      adminQuery("delete from public.calendar_connections where id=$1", [conn]),
    ).rejects.toThrow();
  });
});

// =========================================================================
describe("calendar_sync_outbox — constraints + idempotency + isolation", () => {
  it("deterministic idempotency key: accepted once, duplicate rejected, a done row still blocks it", async () => {
    const a = await seedStudio("obKey");
    const conn = await seedConnection(a);
    const entity = randomUUID();
    const key = `appointment:${entity}:event.create:1`;
    await insertOutbox(a, conn, { hone_entity_id: entity, idempotency_key: key });
    await expect(
      insertOutbox(a, conn, { hone_entity_id: entity, idempotency_key: key }),
    ).rejects.toThrow();
    // Move it to done (claim metadata cleared) — the key must STILL block a re-enqueue.
    await adminQuery("update public.calendar_sync_outbox set status='done', processed_at=now() where idempotency_key=$1", [key]);
    await expect(
      insertOutbox(a, conn, { hone_entity_id: entity, idempotency_key: key }),
    ).rejects.toThrow();
  });

  it("cross-studio job rejected; priority outside 0..1000 rejected", async () => {
    const a = await seedStudio("obX");
    const b = await seedStudio("obX2");
    const connA = await seedConnection(a);
    await expect(insertOutbox(b, connA)).rejects.toThrow(); // studio B on studio A's connection
    await expect(insertOutbox(a, connA, { priority: 1001 })).rejects.toThrow();
    await expect(insertOutbox(a, connA, { priority: -1 })).rejects.toThrow();
  });

  it("entity ops require an entity; full.resync requires none", async () => {
    const a = await seedStudio("obEnt");
    const conn = await seedConnection(a);
    // event.create with null entity fields -> reject.
    await expect(
      adminQuery(
        `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, idempotency_key)
         values ($1,$2,'event.create',$3)`,
        [a.studioId, conn, `k1-${randomUUID()}`],
      ),
    ).rejects.toThrow();
    // full.resync WITH an entity -> reject.
    await expect(
      adminQuery(
        `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key)
         values ($1,$2,'full.resync','appointment',$3,$4)`,
        [a.studioId, conn, randomUUID(), `k2-${randomUUID()}`],
      ),
    ).rejects.toThrow();
    // full.resync WITHOUT an entity -> ok.
    const ok = await adminQuery(
      `insert into public.calendar_sync_outbox (studio_id, connection_id, op_type, idempotency_key)
       values ($1,$2,'full.resync',$3) returning id`,
      [a.studioId, conn, `connection:${conn}:full.resync:1`],
    );
    expect(ok.rowCount).toBe(1);
  });

  it("claim-metadata CHECK: processing needs full metadata; non-processing must have none", async () => {
    const a = await seedStudio("obMeta");
    const conn = await seedConnection(a);
    // processing WITHOUT claim metadata -> reject.
    await expect(insertOutbox(a, conn, { status: "processing" })).rejects.toThrow();
    // pending WITH claim metadata -> reject.
    await expect(
      insertOutbox(a, conn, { status: "pending", claimed_at: new Date().toISOString(), claim_token: randomUUID(), lease_expires_at: new Date().toISOString() }),
    ).rejects.toThrow();
    // done WITH claim metadata -> reject.
    await expect(
      insertOutbox(a, conn, { status: "done", claim_token: randomUUID(), claimed_at: new Date().toISOString(), lease_expires_at: new Date().toISOString() }),
    ).rejects.toThrow();
  });

  it("a member cannot SELECT or mutate outbox jobs (default-deny)", async () => {
    const a = await seedStudio("obRls");
    const conn = await seedConnection(a);
    await insertOutbox(a, conn);
    await expect(userQuery(a.userId, "select id from public.calendar_sync_outbox")).rejects.toThrow();
    await expect(userQuery(a.userId, "update public.calendar_sync_outbox set priority=1")).rejects.toThrow();
  });

  it("the claim/result RPCs are not executable by the authenticated role", async () => {
    const a = await seedStudio("obGrant");
    await expect(userQuery(a.userId, "select * from public.claim_calendar_sync_op(1)")).rejects.toThrow();
    await expect(
      userQuery(a.userId, "select public.record_calendar_sync_result($1,$2,true,null,null,null)", [randomUUID(), randomUUID()]),
    ).rejects.toThrow();
  });
});

// =========================================================================
describe("claim_calendar_sync_op", () => {
  it("claims due pending jobs; skips future/max-attempt; enforces batch cap; safe fields only", async () => {
    const a = await seedStudio("clm");
    const conn = await seedConnection(a);
    const due = await insertOutbox(a, conn);
    await insertOutbox(a, conn, { next_attempt_at: new Date(Date.now() + 3600_000).toISOString() }); // future
    await insertOutbox(a, conn, { attempts: 8, max_attempts: 8 }); // at cap
    const r = await claim(25);
    const ids = r.rows.map((x: Record<string, unknown>) => x.id);
    expect(ids).toContain(due);
    expect(r.rowCount).toBe(1); // only the due one
    const row = r.rows[0] as Record<string, unknown>;
    // Only safe operational fields returned (no secret/token-of-connection columns).
    expect(Object.keys(row).sort()).toEqual(
      ["attempts", "claim_token", "connection_id", "hone_entity_id", "hone_entity_type", "id", "idempotency_key", "lease_expires_at", "max_attempts", "op_type", "payload", "priority", "studio_id"].sort(),
    );
    // Lease ~5 minutes.
    const lease = new Date(row.lease_expires_at as string).getTime() - Date.now();
    expect(lease).toBeGreaterThan(4 * 60_000);
    expect(lease).toBeLessThan(6 * 60_000);
  });

  it("respects priority ASC, then next_attempt_at, then created_at", async () => {
    const a = await seedStudio("clmOrd");
    const conn = await seedConnection(a);
    const p200 = await insertOutbox(a, conn, { priority: 200 });
    const p50 = await insertOutbox(a, conn, { priority: 50 });
    const p100 = await insertOutbox(a, conn, { priority: 100 });
    const r = await claim(3);
    expect(r.rows.map((x: Record<string, unknown>) => x.id)).toEqual([p50, p100, p200]);
  });

  it("caps the batch at 25", async () => {
    const a = await seedStudio("clmBatch");
    const conn = await seedConnection(a);
    for (let i = 0; i < 30; i++) await insertOutbox(a, conn, { idempotency_key: `k-${i}-${randomUUID()}` });
    expect((await claim(100)).rowCount).toBe(25);
  });

  it("reclaims a stale lease (< max) with a new token; done/dead are never reclaimed", async () => {
    const a = await seedStudio("clmStale");
    const conn = await seedConnection(a);
    const past = new Date(Date.now() - 60_000).toISOString();
    const oldToken = randomUUID();
    const id = await insertOutbox(a, conn, {
      status: "processing", attempts: 2, max_attempts: 8,
      claimed_at: past, claim_token: oldToken, lease_expires_at: past,
    });
    await insertOutbox(a, conn, { status: "done", processed_at: new Date().toISOString(), idempotency_key: `done-${randomUUID()}` });
    const r = await claim(25);
    const reclaimed = r.rows.find((x: Record<string, unknown>) => x.id === id) as Record<string, unknown>;
    expect(reclaimed).toBeTruthy();
    expect(reclaimed.claim_token).not.toBe(oldToken);
    expect(Number(reclaimed.attempts)).toBe(3);
    // Exactly one row claimed (the done row is not reclaimable).
    expect(r.rowCount).toBe(1);
  });

  it("transitions a stale-at-max processing row to DEAD (orphan reaper) and never returns it", async () => {
    const a = await seedStudio("clmOrphan");
    const conn = await seedConnection(a);
    const past = new Date(Date.now() - 60_000).toISOString();
    const id = await insertOutbox(a, conn, {
      status: "processing", attempts: 8, max_attempts: 8,
      claimed_at: past, claim_token: randomUUID(), lease_expires_at: past,
    });
    const r = await claim(25);
    expect(r.rows.find((x: Record<string, unknown>) => x.id === id)).toBeUndefined();
    const dead = await adminQuery(
      "select status, claim_token, claimed_at, lease_expires_at, processed_at from public.calendar_sync_outbox where id=$1",
      [id],
    );
    expect(dead.rows[0].status).toBe("dead");
    expect(dead.rows[0].claim_token).toBeNull();
    expect(dead.rows[0].processed_at).toBeNull();
  });

  it("two concurrent claimers of one job: exactly one wins (SKIP LOCKED)", async () => {
    const a = await seedStudio("clmConc");
    const conn = await seedConnection(a);
    await insertOutbox(a, conn);
    const [r1, r2] = await Promise.all([claim(1), claim(1)]);
    expect((r1.rowCount ?? 0) + (r2.rowCount ?? 0)).toBe(1);
  });
});

// =========================================================================
describe("record_calendar_sync_result", () => {
  async function claimOne(studio: SeededStudio, conn: string, o: Record<string, unknown> = {}) {
    const id = await insertOutbox(studio, conn, o);
    const r = await claim(1);
    const row = r.rows.find((x: Record<string, unknown>) => x.id === id) as Record<string, unknown>;
    return { id, token: row.claim_token as string };
  }

  it("success -> done, sets processed_at, clears claim metadata, retains prior diagnostics; repeat is no-op", async () => {
    const a = await seedStudio("resOk");
    const conn = await seedConnection(a);
    const { id, token } = await claimOne(a, conn, { last_error_code: "PRIOR" });
    expect((await result(id, token, true)).rows[0].r).toBe("done");
    const row = (await adminQuery("select status, processed_at, claim_token, last_error_code from public.calendar_sync_outbox where id=$1", [id])).rows[0];
    expect(row.status).toBe("done");
    expect(row.processed_at).not.toBeNull();
    expect(row.claim_token).toBeNull();
    expect(row.last_error_code).toBe("PRIOR"); // retained
    // Repeat success is a deterministic no-op; job stays done.
    expect((await result(id, token, true)).rows[0].r).toBe("already_done");
  });

  it("retryable failure -> pending + future next_attempt_at + cleared claim metadata", async () => {
    const a = await seedStudio("resRetry");
    const conn = await seedConnection(a);
    const { id, token } = await claimOne(a, conn);
    expect((await result(id, token, false, "E", "msg", 120)).rows[0].r).toBe("pending");
    const row = (await adminQuery("select status, next_attempt_at, claim_token from public.calendar_sync_outbox where id=$1", [id])).rows[0];
    expect(row.status).toBe("pending");
    expect(row.claim_token).toBeNull();
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("rejects backoff of 0, negative, < 5s, and > 6h", async () => {
    const a = await seedStudio("resBackoff");
    const conn = await seedConnection(a);
    for (const bad of [0, -5, 3, 21601]) {
      const { id, token } = await claimOne(a, conn, { idempotency_key: `bo-${bad}-${randomUUID()}` });
      await expect(result(id, token, false, "E", "m", bad)).rejects.toThrow();
    }
  });

  it("exhaustion -> dead (processed_at stays NULL); wrong/stale token rejected; error message capped", async () => {
    const a = await seedStudio("resDead");
    const conn = await seedConnection(a);
    const { id, token } = await claimOne(a, conn, { attempts: 7, max_attempts: 8 }); // claim -> attempts 8
    // Wrong token first.
    expect((await result(id, randomUUID(), false, "E", "m", 60)).rows[0].r).toBe("stale_token");
    // Correct token -> exhaustion -> dead; 600-char message capped to 500.
    const longMsg = "x".repeat(600);
    expect((await result(id, token, false, "E", longMsg, 60)).rows[0].r).toBe("dead");
    const row = (await adminQuery("select status, processed_at, length(last_error_message) as len from public.calendar_sync_outbox where id=$1", [id])).rows[0];
    expect(row.status).toBe("dead");
    expect(row.processed_at).toBeNull();
    expect(Number(row.len)).toBeLessThanOrEqual(500);
    // A late result against the now-dead row is a no-op.
    expect((await result(id, token, true)).rows[0].r).toBe("already_dead");
  });
});
