import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// Google Calendar: Phase B2.4 DIRECT claim-RPC coverage (not composition/"inherits"
// reasoning). Proves the REAL production claim RPC (public.claim_calendar_sync_op)
// fails closed for a connection whose destination_mode is NULL even when every other
// eligibility fact is satisfied (connected, owner, write calendar, usable secret,
// studio outbound intent ON, worker ON, exact calendar.events.owned granted, a due
// pending job). Positive control: setting destination_mode='existing_owned' makes the
// same job claimable under the normal contract.

const OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const PHASE_A = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
const HEALTHY_SCOPES = [OWNED, ...PHASE_A];
const past = () => new Date(Date.now() - 60_000).toISOString();

let studio: SeededStudio;
let connId: string;
let jobId: string;

async function claim(n = 25) {
  return adminQuery(`select * from public.claim_calendar_sync_op($1)`, [n]);
}
async function jobRow() {
  return (
    await adminQuery(
      `select status, attempts, claim_token, claimed_at, lease_expires_at from public.calendar_sync_outbox where id=$1`,
      [jobId],
    )
  ).rows[0];
}

beforeEach(async () => {
  await adminQuery("delete from public.calendar_sync_outbox");
  await adminQuery("delete from public.calendar_event_links");
  await adminQuery("delete from public.calendar_connection_secrets");
  await adminQuery("delete from public.calendar_connections");
  // A fresh studio per run keeps ids unique across re-runs against one local DB.
  studio = await seedStudio("b24-claim-null");
  await adminQuery(
    `update public.studios set google_calendar_outbound_sync_enabled = true where id=$1`,
    [studio.studioId],
  );
  // Global worker ON: the HEALTH gate is what must reject a NULL destination.
  await adminQuery(
    `insert into public.calendar_sync_control (id, worker_enabled) values (true,true)
       on conflict (id) do update set worker_enabled = true`,
  );
  // Fully claimable EXCEPT destination_mode is NULL.
  connId = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, is_studio_calendar_owner, write_calendar_id, granted_scopes, destination_mode)
     values ($1,$2,$3,'connected',true,'primary',$4, NULL)`,
    [connId, studio.studioId, studio.practitionerId, HEALTHY_SCOPES],
  );
  await adminQuery(
    `insert into public.calendar_connection_secrets
       (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
     values ($1,$2,'v1:1:iv:tag:ct',1)`,
    [connId, studio.studioId],
  );
  jobId = randomUUID();
  await adminQuery(
    `insert into public.calendar_sync_outbox
       (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, idempotency_key,
        status, attempts, max_attempts, next_attempt_at)
     values ($1,$2,$3,'event.create','appointment',$4,$5,'pending',0,8,$6)`,
    [jobId, studio.studioId, connId, randomUUID(), `k-${randomUUID()}`, past()],
  );
});

afterAll(async () => {
  await closePool();
});

describe("B2.4 direct claim RPC: NULL destination fails closed", () => {
  it("NEGATIVE: NULL destination_mode -> the real claim_calendar_sync_op returns zero rows and mutates nothing", async () => {
    const r = await claim(25);
    expect(r.rowCount).toBe(0); // zero rows claimed

    const row = await jobRow();
    expect(row.status).toBe("pending"); // still pending/unclaimed
    expect(row.claim_token).toBeNull(); // ownership unset
    expect(row.claimed_at).toBeNull();
    expect(row.lease_expires_at).toBeNull(); // lease unset
    expect(Number(row.attempts)).toBe(0); // attempts unchanged

    // No event link created; no appointment exists to change.
    const links = await adminQuery(
      `select count(*)::int as n from public.calendar_event_links where studio_id=$1`,
      [studio.studioId],
    );
    expect(links.rows[0].n).toBe(0);
  });

  it("POSITIVE control: destination_mode='existing_owned' -> the same job becomes claimable", async () => {
    await adminQuery(
      `update public.calendar_connections
         set destination_mode='existing_owned', destination_ownership_validated_at=now(), destination_configured_at=now()
       where id=$1`,
      [connId],
    );
    const r = await claim(25);
    expect(r.rowCount).toBe(1); // now claimable under the normal contract
    expect(r.rows[0].id).toBe(jobId);

    const row = await jobRow();
    expect(row.status).toBe("processing");
    expect(row.claim_token).not.toBeNull();
    expect(row.lease_expires_at).not.toBeNull();
    expect(Number(row.attempts)).toBe(1);
  });

  it("NEGATIVE: an UNKNOWN destination_mode is rejected by the CHECK constraint (never reaches a fail-open claim)", async () => {
    await expect(
      adminQuery(`update public.calendar_connections set destination_mode='calendar' where id=$1`, [connId]),
    ).rejects.toThrow();
  });
});
