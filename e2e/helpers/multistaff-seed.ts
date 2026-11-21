import { seedE2eStudio, seedE2eMember, seedConfirmedAppointment, sql, type E2eSeed } from "./seed";
import { PUBLISHED_SERVICE, NUMERIC_CENTS } from "./multistaff-proof";

// Seed for the integrated multi-staff proof (photos/MULTISTAFF-PROOF-PLAN.md, scenario S0). Plan-stage: typechecked only,
// never run. Two synthetic studios (A has owner, two practitioners and a receptionist slot; B is the cross-studio target).
// The receptionist is NOT inserted by hand here: the real provisioning path (invite, accept, 0216/0218/0220/0274 RPCs) is
// the thing under test, so that step is filled in only once OPS names the candidate chain.

export type StudioWithStaff = {
  seed: E2eSeed;
  prac1: Awaited<ReturnType<typeof seedE2eMember>>;
  prac2: Awaited<ReturnType<typeof seedE2eMember>>;
};

export async function seedStudioWithStaff(): Promise<StudioWithStaff> {
  const seed = await seedE2eStudio();
  const prac1 = await seedE2eMember(seed);
  const prac2 = await seedE2eMember(seed);
  return { seed, prac1, prac2 };
}

/** A client of the studio whose preferred and stored names differ, so the "preferred, else Name on file" rule is observable. */
export async function seedClientWithPreferredName(studioId: string, preferred: string | null): Promise<string> {
  const rows = await sql<{ id: string }>(
    `insert into public.clients (id, studio_id, name, email) values (gen_random_uuid(), $1, $2, $3) returning id`,
    [studioId, `RBACZZSTORED01 Stored Name`, `rbac-${Date.now()}@harness.local`],
  );
  void preferred; // the preferred-name column is candidate-specific (#1323); set it when the candidate head is named
  return rows[0]!.id;
}

/** One future appointment per practitioner for the race (S3) and schedule (S4) scenarios. */
export async function seedAppointmentFor(studioId: string, practitionerId: string, clientId: string, minutesFromNow: number): Promise<string> {
  const t = (await sql<{ a: Date; b: Date }>(`select now() + ($1 || ' minutes')::interval a, now() + ($1::int + 60 || ' minutes')::interval b`, [String(minutesFromNow)]))[0];
  return seedConfirmedAppointment(studioId, practitionerId, clientId, new Date(t.a).toISOString(), new Date(t.b).toISOString());
}

/** The published-price service the practitioner may see on booking only (section 8.3). */
export async function pricePublishedService(studioId: string): Promise<void> {
  await sql(`update public.services set name = $2, price_cents = $3 where studio_id = $1 and id = (select id from public.services where studio_id = $1 order by created_at limit 1)`, [studioId, PUBLISHED_SERVICE.name, PUBLISHED_SERVICE.cents]);
  void NUMERIC_CENTS; // absent-everywhere numbers are applied to payments/overrides per scenario once the schema columns are confirmed on the candidate
}
