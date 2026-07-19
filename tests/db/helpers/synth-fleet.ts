import { randomUUID } from "node:crypto";
import { adminQuery, type SeededStudio } from "./harness";

// ===========================================================================
// SAFE-SYNTH — deterministic synthetic tenant fleet (Wave 1, PR 1)
// ===========================================================================
//
// Studio A/B/C synthetic tenants built ON the local-only DB/RLS harness
// (tests/db/helpers/harness.ts — localhost-pinned; never production, never
// Willow). Every later tenant-boundary / provider P1 negative test seeds from
// this fleet so isolation and failure behaviour are proven against the real
// migrated schema, not mocked.
//
// Guarantees:
//   * Recognizable synthetic identifiers — every studio name is prefixed
//     "SYNTH-<A|B|C>" and every email is "<slug>@synth.local"; nothing shares
//     an identifier space with production.
//   * Deterministic per run but collision-free — all ids are random UUIDs, so
//     the fleet is safe to recreate and safe under parallel test files.
//   * Deterministic cleanup — dropSynthStudio removes a studio and its fake
//     auth users by id (never by global truncation).
//   * No real providers, no secrets — pure local SQL seeding.
//
// Studio A: solo studio (one owner).
// Studio B: three-practitioner studio (owner + two members).
// Studio C: failure/recovery studio, carrying an injectable failure switch
//   consumed by later provisioning/payment/OAuth/export/purge/worker tests.

const SYNTH_EMAIL_DOMAIN = "@synth.local";

export type SynthPractitioner = {
  userId: string;
  practitionerId: string;
  role: "owner" | "practitioner";
  email: string;
};

export type SynthStudio = SeededStudio & {
  label: "A" | "B" | "C";
  name: string;
  ownerEmail: string;
  practitioners: SynthPractitioner[];
};

// Failure modes Studio C can be primed for. The switch itself is inert data
// the fleet records; the consuming test decides how to act on it (e.g. force a
// provisioning error, drop an OAuth token, reject a provider call). Kept here
// so the vocabulary is centralized and type-checked.
export type SynthFailureMode =
  | "provisioning"
  | "payment"
  | "revoked_oauth"
  | "provider_rejection"
  | "export"
  | "cancellation"
  | "legal_hold"
  | "purge"
  | "stale_worker_claim"
  | "retry_dead_letter";

async function seedAuthUser(email: string): Promise<string> {
  const userId = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    email,
  ]);
  return userId;
}

async function seedPractitioner(
  studioId: string,
  label: string,
  role: "owner" | "practitioner",
  n: number,
): Promise<SynthPractitioner> {
  const email = `synth-${label.toLowerCase()}-${role}-${n}-${randomUUID().slice(0, 8)}${SYNTH_EMAIL_DOMAIN}`;
  const userId = await seedAuthUser(email);
  const practitionerId = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, $6, true)`,
    [practitionerId, studioId, userId, `SYNTH-${label} ${role} ${n}`, email, role],
  );
  return { userId, practitionerId, role, email };
}

async function seedStudioShell(
  label: "A" | "B" | "C",
  practitionerCount: number,
): Promise<SynthStudio> {
  const studioId = randomUUID();
  const name = `SYNTH-${label}`;
  const ownerEmail = `synth-${label.toLowerCase()}-owner-0-${randomUUID().slice(0, 8)}${SYNTH_EMAIL_DOMAIN}`;
  // owner
  const ownerUserId = await seedAuthUser(ownerEmail);
  const ownerPractitionerId = randomUUID();
  await adminQuery(
    `insert into public.studios (id, name, owner_email) values ($1, $2, $3)`,
    [studioId, name, ownerEmail],
  );
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'owner', true)`,
    [ownerPractitionerId, studioId, ownerUserId, `SYNTH-${label} owner`, ownerEmail],
  );
  const practitioners: SynthPractitioner[] = [
    { userId: ownerUserId, practitionerId: ownerPractitionerId, role: "owner", email: ownerEmail },
  ];
  for (let i = 1; i < practitionerCount; i++) {
    practitioners.push(await seedPractitioner(studioId, label, "practitioner", i));
  }
  // one synthetic client so isolation/boundary tests have a target row
  const clientId = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name) values ($1, $2, $3)`,
    [clientId, studioId, `SYNTH-${label} client`],
  );
  return {
    studioId,
    userId: ownerUserId,
    practitionerId: ownerPractitionerId,
    clientId,
    label,
    name,
    ownerEmail,
    practitioners,
  };
}

/** Studio A — solo synthetic studio (one owner). */
export function seedSynthStudioA(): Promise<SynthStudio> {
  return seedStudioShell("A", 1);
}

/** Studio B — three-practitioner synthetic studio (owner + 2 members). */
export function seedSynthStudioB(): Promise<SynthStudio> {
  return seedStudioShell("B", 3);
}

/** Studio C — failure/recovery studio. `failureMode` is inert data recorded on
 *  the returned object for the consuming test; it drives no side effect here. */
export async function seedSynthStudioC(
  failureMode: SynthFailureMode = "provisioning",
): Promise<SynthStudio & { failureMode: SynthFailureMode }> {
  const studio = await seedStudioShell("C", 1);
  return { ...studio, failureMode };
}

/** Deterministic teardown: delete the studio's rows and its fake auth users by
 *  id. Cascades cover child rows; auth.users are removed explicitly since they
 *  live outside the public schema. Never truncates. */
export async function dropSynthStudio(studio: SynthStudio): Promise<void> {
  await adminQuery(`delete from public.studios where id = $1`, [studio.studioId]);
  for (const p of studio.practitioners) {
    await adminQuery(`delete from auth.users where id = $1`, [p.userId]);
  }
}
