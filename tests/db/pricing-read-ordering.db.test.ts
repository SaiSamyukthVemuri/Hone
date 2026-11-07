import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// The billing loaders read client_pricing on the service role AFTER an RLS-scoped user-JWT read of the
// appointment proves membership and scope (see tests/lib/billing/pricing-service-role-ordering.test.ts for the
// loader-level ordering). This runs that exact two-step shape against the REAL migrated chain with real JWTs:
//   step 1  as the caller:   select the appointment (RLS)         -> found only for a member of that studio
//   step 2  service role:    select client_pricing by studio+client, ONLY if step 1 found a row
// Owner and an authorised (non-owner) practitioner get the custom price; another studio's owner and a missing
// appointment get no price. Holds both before and after 0303 (the service-role step is policy-independent).

let studio: SeededStudio;
let member: { userId: string; practitionerId: string };
let other: SeededStudio;
let apptId: string;
const MISSING = randomUUID();

async function priceFor(userId: string, appointmentId: string): Promise<number | null> {
  const appt = await asUser(userId, (q) =>
    q(`select id, client_id from public.appointments where id = $1 and studio_id = $2`, [appointmentId, studio.studioId]),
  );
  if (appt.rowCount === 0) return null;
  const p = await adminQuery(
    `select price_cents from public.client_pricing where studio_id = $1 and client_id = $2 order by effective_from desc limit 1`,
    [studio.studioId, appt.rows[0].client_id],
  );
  return p.rows[0]?.price_cents ?? null;
}

beforeAll(async () => {
  studio = await seedStudio("pr-owner");
  member = await seedMember(studio, "pr-member");
  other = await seedStudio("pr-other");
  const svc = (
    await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
       values ($1, 'PR Service', 60, 5000, true, 'electrolysis') returning id`,
      [studio.studioId],
    )
  ).rows[0].id;
  apptId = (
    await adminQuery(
      `insert into public.appointments (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
       values (gen_random_uuid(), $1, $2, $3, $4, now() + interval '10 days', now() + interval '10 days 60 minutes', 60, 'confirmed', $5) returning id`,
      [studio.studioId, studio.practitionerId, studio.clientId, svc, createHash("sha256").update(randomUUID()).digest("hex")],
    )
  ).rows[0].id;
  await adminQuery(`insert into public.client_pricing (studio_id, client_id, service_name, price_cents) values ($1, $2, 'PR Service', 7000)`, [
    studio.studioId,
    studio.clientId,
  ]);
});

afterAll(async () => {
  await closePool();
});

describe("service-role pricing read after a scoped membership read", () => {
  it("the owner gets the custom price", async () => {
    expect(await priceFor(studio.userId, apptId)).toBe(7000);
  });
  it("an authorised non-owner practitioner of the studio gets the custom price", async () => {
    expect(await priceFor(member.userId, apptId)).toBe(7000);
  });
  it("another studio's owner gets no price (the scoped read finds nothing)", async () => {
    expect(await priceFor(other.userId, apptId)).toBeNull();
  });
  it("a missing appointment gets no price", async () => {
    expect(await priceFor(studio.userId, MISSING)).toBeNull();
  });
});
