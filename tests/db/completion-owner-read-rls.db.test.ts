import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedMember, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// The completion pre-check (markAppointmentCompleteAction) reads the appointment's practitioner_id through the
// USER client and then applies canCompleteAppointment. The unit tests mock that client, so this is the DB-level
// half they cannot give: under real RLS an OWNER can read an appointment assigned to ANOTHER practitioner of the
// studio (and an unassigned one), so the owner path of the rule is not silently denied; a non-owner member reads
// the studio's rows too (the helper, not RLS, decides who may complete); another studio's owner reads nothing.
// Synthetic ids only.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

let A: SeededStudio;
let B: SeededStudio;
let member: { userId: string; practitionerId: string };
let serviceA: string;
let assignedToMember: string;
let unassigned: string;
let n = 0;

async function insertAppt(practitionerId: string | null): Promise<string> {
  n += 1;
  const day = String(10 + n).padStart(2, "0");
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4, ('2031-03-' || $5 || ' 10:00:00+00')::timestamptz, ('2031-03-' || $5 || ' 11:00:00+00')::timestamptz,
             60, 'confirmed', $6)
     returning id`,
    [A.studioId, practitionerId, A.clientId, serviceA, day, hash64()],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  A = await seedStudio("completion-rls-A");
  B = await seedStudio("completion-rls-B");
  member = await seedMember(A, "completion-rls-member");
  const s = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Service A',60,0,true) returning id`,
    [randomUUID(), A.studioId],
  );
  serviceA = s.rows[0].id as string;
  assignedToMember = await insertAppt(member.practitionerId);
  unassigned = await insertAppt(null);
});

afterAll(async () => {
  await closePool();
});

describe("completion pre-check read, under real RLS", () => {
  it("the OWNER reads an appointment assigned to another practitioner, with its practitioner_id", async () => {
    const r = await userQuery(
      A.userId,
      `select practitioner_id from public.appointments where id = $1 and studio_id = $2`,
      [assignedToMember, A.studioId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].practitioner_id).toBe(member.practitionerId);
    expect(r.rows[0].practitioner_id).not.toBe(A.practitionerId);
  });

  it("the OWNER reads an unassigned appointment (practitioner_id null), so the owner-only rule can be applied", async () => {
    const r = await userQuery(A.userId, `select practitioner_id from public.appointments where id = $1 and studio_id = $2`, [unassigned, A.studioId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].practitioner_id).toBeNull();
  });

  it("a non-owner member reads the studio's appointment rows (RLS is not what restricts completion; the helper is)", async () => {
    const r = await userQuery(member.userId, `select id from public.appointments where id = any($1::uuid[]) and studio_id = $2`, [[assignedToMember, unassigned], A.studioId]);
    expect(r.rowCount).toBe(2);
  });

  it("another studio's owner reads neither", async () => {
    const r = await userQuery(B.userId, `select id from public.appointments where id = any($1::uuid[])`, [[assignedToMember, unassigned]]);
    expect(r.rowCount).toBe(0);
  });
});
