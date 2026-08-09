import { randomUUID } from "node:crypto";
import { adminQuery, purgeAppointmentAudit, type SeededStudio } from "./harness";

// ===========================================================================
// SAFE-SYNTH — synthetic tenant fleet (Wave 1, PR 1) — PARTIALLY DELIVERED
// ===========================================================================
//
// Studio A/B/C synthetic tenants built ON the local-only DB/RLS harness
// (tests/db/helpers/harness.ts — localhost-pinned; never production, never
// Willow). Later tenant-boundary / provider P1 tests seed from this fleet so
// isolation is proven against the real migrated schema, not mocked.
//
// Properties (accurate claims only):
//   * Recognizable synthetic identifiers — every studio name is prefixed
//     "SYNTH-<A|B|C>" and every email is "<slug>@synth.local"; nothing shares
//     an identifier space with production.
//   * RUN-UNIQUE and parallel-safe — all ids are randomUUID(). They therefore
//     DIFFER on every run; this is NOT deterministic/stable-across-runs
//     seeding. It makes the fleet safe to recreate and safe under parallel
//     test files (no id collisions).
//   * Cleanup by id — dropSynthStudio removes a studio and its fake auth users
//     by id (never by global truncation). Proven, not asserted, by
//     tests/db/synth-fleet-cleanup.db.test.ts.
//   * No real providers, no secrets — pure local SQL seeding.
//
// Studio A: solo studio (one owner).
// Studio B: three-practitioner studio (owner + two members).
// Studio C: failure/recovery studio carrying an INERT failure-mode label
//   (SynthFailureMode) — vocabulary only. There is NO executable failure
//   injection yet; the enum names the primitives later slices will implement.
//
// NOT YET DELIVERED (named remaining scope, tracked in WAVE1_DESIGN.md):
//   * richer per-domain seeding (appointments, intake/consent, sessions/
//     clinical, treatment-photo metadata, payment/provider test state);
//   * EXECUTABLE failure injection for Studio C (each SynthFailureMode wired
//     to a real forced error / revoked token / rejected provider call / etc.).
// Do NOT describe SAFE-SYNTH as complete or Studio C failure injection as
// working until those land.

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

// INERT failure-mode vocabulary for Studio C. This is a TYPE-CHECKED LABEL
// ONLY — the fleet records it and does nothing with it. There is NO failure
// injection implemented here; a future slice must wire each mode to a real
// forced error before any test may claim to exercise that failure path.
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

/** Studio C — failure/recovery studio. `failureMode` is an INERT label recorded
 *  on the returned object; it drives NO side effect and NO failure injection
 *  exists yet. A future slice must wire it to a real forced error. */
export async function seedSynthStudioC(
  failureMode: SynthFailureMode = "provisioning",
): Promise<SynthStudio & { failureMode: SynthFailureMode }> {
  const studio = await seedStudioShell("C", 1);
  return { ...studio, failureMode };
}

/** Seed a studio-wide (practitioner_id NULL) weekly availability window that is
 *  OPEN on every weekday for the given [open, close) local times. Part 4 wired
 *  the shared availability validator into the booking + move/reassign commands,
 *  so a capacity-ON studio with NO availability rows now reads as "closed". Tests
 *  whose subject is collisions / integrity / concurrency (not working hours) call
 *  this so their appointment times fall inside a real window; per-practitioner or
 *  date-override behaviour is asserted in the dedicated validator/parity suites. */
export async function seedStudioWideOpenAllWeek(
  studioId: string,
  open = "00:00",
  close = "23:59",
): Promise<void> {
  for (let dow = 0; dow <= 6; dow++) {
    await adminQuery(
      `insert into public.studio_availability_default
         (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
       values (gen_random_uuid(), $1, null, $2, true, $3, $4)
       on conflict on constraint studio_availability_default_scope_key
       do update set is_open = true, open_time = excluded.open_time, close_time = excluded.close_time`,
      [studioId, dow, open, close],
    );
  }
}

/** Teardown by id: delete the studio's rows and its fake auth users by id.
 *  Cascades cover child rows; auth.users are removed explicitly since they
 *  live outside the public schema. Never truncates. Proven by
 *  tests/db/synth-fleet-cleanup.db.test.ts. */
export async function dropSynthStudio(studio: SynthStudio): Promise<void> {
  // B5/0174: appointment_audit.studio_id is ON DELETE RESTRICT (the convention
  // every append-only history table in this schema uses — clinical_audit_events,
  // clinical_record_amendments, clinical_record_snapshots). A studio that has
  // ever had an appointment audited therefore cannot be deleted until its trail
  // is removed, and 0174 leaves NO runtime path that can remove it. The
  // owner-only harness fixture is the sanctioned teardown.
  await purgeAppointmentAudit(studio.studioId);
  await adminQuery(`delete from public.studios where id = $1`, [studio.studioId]);
  for (const p of studio.practitioners) {
    await adminQuery(`delete from auth.users where id = $1`, [p.userId]);
  }
}
