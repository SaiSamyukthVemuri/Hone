import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asRole, closePool, seedStudio } from "./helpers/harness";

// ===========================================================================
// 0250: MSG-002/003 R2. A stale, expired, provably unattempted 0247
// preparation no longer blocks the cohort forever.
//
// Before 0250 a reschedule (any authority change) between prepare and
// authorize left a 'prepared' row that every later prepare refused with
// held/stale_preparation, and nobody could retire it once its lease expired.
// Executed against the REAL migrated database with the role the cron uses.
// Every assertion is scoped to ids seeded here.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

type Prepared = { kind: string; reason?: string; operationId: string; leaseToken: string; providerKey: string; authority: Record<string, string>; render: unknown };

async function rpc(sql: string, params: unknown[]) {
  return adminTx(async (query) => {
    await query("set local role service_role");
    return (await query(sql, params)).rows[0].result;
  });
}

async function fixture(label: string) {
  const studio = await seedStudio(label);
  await adminQuery("update public.clients set email='synthetic@harness.local' where id=$1 and studio_id=$2", [studio.clientId, studio.studioId]);
  await adminQuery("update public.studios set send_24h_reminders=true, send_intake_reminders=false where id=$1", [studio.studioId]);
  const appointmentId = (await adminQuery(`insert into public.appointments
    (studio_id,practitioner_id,client_id,starts_at,ends_at,duration_minutes,status,buffer_minutes_snapshot,blocked_ends_at,cancellation_token_hash)
    values($1,$2,$3,now()+interval '24 hours',now()+interval '25 hours',60,'confirmed',15,now()+interval '25 hours 15 minutes',$4) returning id`,
    [studio.studioId, studio.practitionerId, studio.clientId, createHash("sha256").update(studio.studioId).digest("hex")])).rows[0].id as string;
  const inspect = () => rpc("select public.inspect_appointment_email_operation($1,$2,'reminder_24h') as result", [studio.studioId, appointmentId]);
  const prepare = async (): Promise<Prepared> => {
    const inspected = await inspect();
    expect(inspected.kind).toBe("eligible");
    return rpc("select public.prepare_appointment_email_operation($1,$2,'reminder_24h','offline-account',$3::jsonb) as result",
      [studio.studioId, appointmentId, JSON.stringify(inspected.authority)]);
  };
  const operation = async (id: string) => (await adminQuery(
    "select state, first_possible_attempt_at from appointment_email_private.operations where id=$1 and studio_id=$2", [id, studio.studioId])).rows[0];
  const expire = (id: string) => adminQuery(
    "update appointment_email_private.operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1 and studio_id=$2", [id, studio.studioId]);
  const reschedule = () => adminQuery(
    `update public.appointments set starts_at=starts_at+interval '5 minutes', ends_at=ends_at+interval '5 minutes',
       blocked_ends_at=blocked_ends_at+interval '5 minutes' where id=$1 and studio_id=$2`, [appointmentId, studio.studioId]);
  const rename = () => adminQuery("update public.clients set name=name||' (renamed)' where id=$1 and studio_id=$2", [studio.clientId, studio.studioId]);
  return { studio, appointmentId, prepare, operation, expire, reschedule, rename };
}

describe("0250: a stale expired unattempted preparation is retired, not a permanent block", () => {
  it.each([["reschedule", "reschedule"], ["client rename", "rename"]] as const)(
    "%s between prepare and authorize: the next prepare after lease expiry succeeds once", async (_label, change) => {
      const f = await fixture(`0250-${change}`);
      const first = await f.prepare();
      expect(first.kind).toBe("prepared");
      await f[change]();
      await f.expire(first.operationId);
      const second = await f.prepare();
      expect(second.kind).toBe("prepared");
      expect(second.operationId).not.toBe(first.operationId);
      expect((await f.operation(first.operationId)).state).toBe("retired");
      expect((await f.operation(second.operationId)).state).toBe("prepared");
      // Exactly one unresolved operation remains for the cohort.
      const open = await adminQuery(
        "select count(*)::int as n from appointment_email_private.operations where studio_id=$1 and appointment_id=$2 and state in ('prepared','unknown','accepted')",
        [f.studio.studioId, f.appointmentId]);
      expect(open.rows[0].n).toBe(1);
    },
  );

  it("control: an UNEXPIRED stale lease is still held (leased), never retired", async () => {
    const f = await fixture("0250-leased");
    const first = await f.prepare();
    await f.reschedule();
    const second = await f.prepare();
    expect(second).toMatchObject({ kind: "held", reason: "leased" });
    expect((await f.operation(first.operationId)).state).toBe("prepared");
  });

  it("control: a possibly ATTEMPTED stale preparation stays fail-closed", async () => {
    const f = await fixture("0250-attempted");
    const first = await f.prepare();
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    const granted = await rpc("select public.authorize_appointment_email_operation($1,$2,$3::jsonb,'offline-account',$4,$5,$6,$7::jsonb) as result",
      [first.operationId, first.leaseToken, JSON.stringify(first.authority), first.providerKey, digest("request"), digest("capability"), JSON.stringify(first.render)]);
    expect(granted.kind).toBe("authorized");
    await f.reschedule();
    await f.expire(first.operationId);
    const second = await f.prepare();
    expect(second.kind).toBe("held");
    const row = await f.operation(first.operationId);
    expect(row.state).not.toBe("retired");
    expect(row.first_possible_attempt_at).not.toBeNull();
  });

  it("control: an expired but CURRENT preparation is renewed in place, not retired", async () => {
    const f = await fixture("0250-current");
    const first = await f.prepare();
    await f.expire(first.operationId);
    const second = await f.prepare();
    expect(second.kind).toBe("prepared");
    expect(second.operationId).toBe(first.operationId);
    expect((await f.operation(first.operationId)).state).toBe("prepared");
  });

  it.each(["anon", "authenticated"] as const)("%s still cannot call prepare", async (role) => {
    await expect(asRole(role, (query) => query("select public.prepare_appointment_email_operation(null,null,null,null,null)"))).rejects.toMatchObject({ code: "42501" });
  });
});
