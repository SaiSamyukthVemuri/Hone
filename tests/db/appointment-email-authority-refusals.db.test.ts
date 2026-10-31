import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, seedStudio } from "./helpers/harness";

// ===========================================================================
// R1 (MSG-002/003): the SQL side of the #1032 route regressions, on the REAL
// migrated database. The route cases in tests/app/api/cron/reminder-email-claim.test.ts
// prove only that the cron maps "held" / "unavailable" correctly; they mock the
// operation. These prove the 0247 authority itself refuses a cancelled, moved,
// out-of-window or missing appointment, both BEFORE preparation and in the race
// between prepare and authorize, and that a refusal stamps nothing: no first
// possible attempt and no legacy reminder claim. Every assertion is scoped to
// ids seeded here.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

async function rpc(sql: string, params: unknown[]) {
  return adminTx(async (query) => {
    await query("set local role service_role");
    return (await query(sql, params)).rows[0].result;
  });
}

async function fixture(label: string, startsIn = "24 hours") {
  const studio = await seedStudio(label);
  await adminQuery("update public.clients set email='synthetic@harness.local' where id=$1 and studio_id=$2", [studio.clientId, studio.studioId]);
  await adminQuery("update public.studios set send_24h_reminders=true, send_intake_reminders=false where id=$1", [studio.studioId]);
  const appointmentId = (await adminQuery(`insert into public.appointments
    (studio_id,practitioner_id,client_id,starts_at,ends_at,duration_minutes,status,buffer_minutes_snapshot,blocked_ends_at,cancellation_token_hash)
    values($1,$2,$3,now()+$5::interval,now()+$5::interval+interval '1 hour',60,'confirmed',15,now()+$5::interval+interval '75 minutes',$4) returning id`,
    [studio.studioId, studio.practitionerId, studio.clientId, digest(`${studio.studioId}:${label}`), startsIn])).rows[0].id as string;
  const inspect = (id = appointmentId) =>
    rpc("select public.inspect_appointment_email_operation($1,$2,'reminder_24h') as result", [studio.studioId, id]);
  const prepare = async () => {
    const inspected = await inspect();
    expect(inspected.kind).toBe("eligible");
    const p = await rpc("select public.prepare_appointment_email_operation($1,$2,'reminder_24h','offline-account',$3::jsonb) as result",
      [studio.studioId, appointmentId, JSON.stringify(inspected.authority)]);
    expect(p.kind).toBe("prepared");
    return p as { operationId: string; leaseToken: string; providerKey: string; authority: unknown; render: unknown };
  };
  const authorize = (p: Awaited<ReturnType<typeof prepare>>) =>
    rpc("select public.authorize_appointment_email_operation($1,$2,$3::jsonb,'offline-account',$4,$5,$6,$7::jsonb) as result",
      [p.operationId, p.leaseToken, JSON.stringify(p.authority), p.providerKey, digest("request"), digest("capability"), JSON.stringify(p.render)]);
  const stamped = async (operationId: string) => {
    const op = (await adminQuery("select first_possible_attempt_at from appointment_email_private.operations where id=$1 and studio_id=$2",
      [operationId, studio.studioId])).rows[0];
    const appt = (await adminQuery("select reminder_24h_claimed_at, reminder_24h_sent_at from public.appointments where id=$1 and studio_id=$2",
      [appointmentId, studio.studioId])).rows[0];
    return { firstAttempt: op?.first_possible_attempt_at ?? null, claimed: appt?.reminder_24h_claimed_at ?? null, sent: appt?.reminder_24h_sent_at ?? null };
  };
  const shift = (by: string) => adminQuery(
    `update public.appointments set starts_at=starts_at+$3::interval, ends_at=ends_at+$3::interval, blocked_ends_at=blocked_ends_at+$3::interval
      where id=$1 and studio_id=$2`, [appointmentId, studio.studioId, by]);
  const cancel = () => adminQuery("update public.appointments set status='cancelled' where id=$1 and studio_id=$2", [appointmentId, studio.studioId]);
  return { studio, appointmentId, inspect, prepare, authorize, stamped, shift, cancel };
}

describe("R1: the 0247 authority refuses before preparation", () => {
  it("a cancelled appointment is held ineligible", async () => {
    const f = await fixture("r1-cancelled");
    await f.cancel();
    expect(await f.inspect()).toMatchObject({ kind: "held", reason: "ineligible" });
  });

  it("an appointment outside the 24h window is held ineligible", async () => {
    const f = await fixture("r1-outside", "30 hours");
    expect(await f.inspect()).toMatchObject({ kind: "held", reason: "ineligible" });
  });

  it("an appointment moved out of the window is held ineligible", async () => {
    const f = await fixture("r1-moved-out");
    expect((await f.inspect()).kind).toBe("eligible");
    await f.shift("3 hours");
    expect(await f.inspect()).toMatchObject({ kind: "held", reason: "ineligible" });
  });

  it("a missing appointment is held missing_scope", async () => {
    const f = await fixture("r1-missing");
    expect(await f.inspect("00000000-0000-4000-8000-0000000000aa")).toMatchObject({ kind: "held", reason: "missing_scope" });
  });
});

describe("R1: a change between prepare and authorize is refused and stamps nothing", () => {
  it("control: an unchanged appointment is authorized and records its first possible attempt", async () => {
    const f = await fixture("r1-control");
    const p = await f.prepare();
    expect((await f.authorize(p)).kind).toBe("authorized");
    expect((await f.stamped(p.operationId)).firstAttempt).not.toBeNull();
  });

  it.each([
    ["cancelled", (f: Awaited<ReturnType<typeof fixture>>) => f.cancel()],
    ["moved within the window", (f: Awaited<ReturnType<typeof fixture>>) => f.shift("5 minutes")],
    ["moved out of the window", (f: Awaited<ReturnType<typeof fixture>>) => f.shift("3 hours")],
  ] as const)("%s after prepare: authorize is held", async (label, change) => {
    const f = await fixture(`r1-race-${label.replace(/\W+/g, "-")}`);
    const p = await f.prepare();
    await change(f);
    expect((await f.authorize(p)).kind).toBe("held");
    expect(await f.stamped(p.operationId)).toEqual({ firstAttempt: null, claimed: null, sent: null });
  });

  it("missing after prepare (row deleted): authorize is held and nothing is stamped", async () => {
    const f = await fixture("r1-race-deleted");
    const p = await f.prepare();
    await adminQuery("delete from public.appointments where id=$1 and studio_id=$2", [f.appointmentId, f.studio.studioId]);
    expect((await f.authorize(p)).kind).toBe("held");
    expect((await f.stamped(p.operationId)).firstAttempt).toBeNull();
  });
});
