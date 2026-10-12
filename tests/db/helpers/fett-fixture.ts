import { randomUUID } from "node:crypto";
import {
  adminQuery,
  purgeAppointmentAudit,
  type SeededStudio,
} from "./harness";

// ===========================================================================
// FETT REHEARSAL FIXTURE — synthetic multi-practitioner LA studio (#824)
// ===========================================================================
//
// A Fett-SHAPED synthetic studio for the Friday 2026-10-16 rehearsal: owner
// plus five treating practitioners, America/Los_Angeles, electrolysis
// services. Built on the local-only DB harness (tests/db/helpers/harness.ts —
// localhost-pinned; never production, never a real tenant).
//
// This is a PARALLEL helper. It does not import from, extend, or modify
// tests/db/helpers/synth-fleet.ts, whose SynthStudio.label is the closed union
// "A" | "B" | "C" — a Fett studio cannot join that fleet without editing
// shared code, and #825 is frozen at its checkpoint. Teardown deliberately
// mirrors dropSynthStudio's appointment_audit discipline rather than reusing
// it (see dropFettStudio).
//
// WHAT IS ACTUALLY SEEDED (accurate claims only, all verified against the
// 0210 chain):
//   * studios row with timezone EXPLICITLY 'America/Los_Angeles'. The column
//     default is 'America/Toronto' (0010_booking_v1.sql:20), so a fixture that
//     omits it silently rehearses the wrong timezone — the one thing an LA
//     studio demo must not get wrong.
//   * owner + five treating practitioners, all role 'practitioner' except the
//     owner. Recognizably synthetic: names prefixed "SYNTH-FETT", emails
//     "<slug>@synth.local". Run-unique randomUUID ids, so the fixture is
//     parallel-safe and recreatable; it is NOT stable across runs.
//   * two services — an electrolysis consultation and an electrolysis
//     treatment — with explicit durations inside services_duration_check
//     (5..480, 0010_booking_v1.sql:158).
//   * studio-wide weekly availability, open the given local hours on the
//     requested days (default Mon–Fri 09:00–17:00). Capacity-ON studios with
//     no availability rows read as CLOSED, so the rehearsal needs real rows.
//   * the PRACTITIONER-CAPACITY STATE, defaulting to LIVE. This is load-bearing
//     and easy to miss. 0134/0136 model concurrency with TWO studio flags whose
//     three valid states are:
//         LEGACY                        capacity=false booking=false
//         CAPACITY_READY_BOOKING_PAUSED capacity=true  booking=false
//         LIVE                          capacity=true  booking=true
//     (capacity=false + booking=true is rejected by the CHECK at 0136:52.)
//     BOTH DEFAULT FALSE, so a studio seeded without them is LEGACY — ONE
//     studio-wide resource. Five practitioners in a LEGACY studio therefore
//     CANNOT hold parallel appointments, which is precisely what a Fett demo
//     must show. The fixture defaults to "live" because Fett's premise is 5+
//     practitioners; pass capacity: "legacy" to rehearse today's default
//     studio instead.
//
// WHAT THIS FIXTURE CANNOT SEED ON THE 0210 CHAIN — named, not papered over.
// Each is a real gap in the Friday demo surface, owned by another lane:
//
//   1. RESTRICTED RECEPTIONIST — schema-impossible today, not merely
//      unseeded. practitioners.role carries
//      check (role in ('owner','practitioner')) (0001_init.sql:24), and the
//      string "receptionist" appears in NO migration on this chain. The
//      receptionist limb is therefore OPTIONAL and FEATURE-DETECTED
//      (seedFettReceptionist / detectFettCapabilities): it composes only when
//      the chain admits the role, and the rehearsal must never gate on it.
//      Owned by the RBAC lane (#838 0216, #850 0218), both unmerged.
//   2. USD / payment jurisdiction — currency on this chain defaults to
//      'cad' (0073_payment_charge_attempts.sql:113,
//      0187_appointment_settlement.sql:126, 0064_manual_fee_protection.sql:141)
//      and services.price_cents carries NO currency column at all. This
//      fixture sets no price and makes NO USD claim. Owned by the
//      Audit/USD lane (#833 0214 and its stack), unmerged.
//   3. Machine / device catalogue and machine-first selection — #829's
//      contract is unverified and Fett's actual inventory is unknown. Nothing
//      here seeds devices.
//
// Do NOT describe the Fett rehearsal as covering receptionist access, USD
// flows, or machine-first selection on the strength of this fixture.
// ===========================================================================

const FETT_EMAIL_DOMAIN = "@synth.local";
const FETT_TIMEZONE = "America/Los_Angeles";

/** Mon–Fri. day_of_week is 0=Sunday .. 6=Saturday. */
const WEEKDAYS = [1, 2, 3, 4, 5] as const;

export type FettPractitioner = {
  userId: string;
  practitionerId: string;
  /** 'owner' for the studio owner, 'practitioner' for the five treating staff. */
  role: "owner" | "practitioner";
  email: string;
  displayName: string;
};

/** A receptionist seeded ONLY when the chain admits the role. `null` on the
 *  0210 chain — see note 1 in the header. */
export type FettReceptionist = {
  userId: string;
  practitionerId: string;
  email: string;
  displayName: string;
  /** How the row was created: the 0216 command, or a direct insert once the
   *  role check admits 'receptionist'. Recorded so a test can say which. */
  via: "add_studio_receptionist" | "direct_insert";
};

/** What the CHAIN UNDER TEST supports — probed, never assumed. */
export type FettCapabilities = {
  /** practitioners.role admits 'receptionist'. */
  receptionistRole: boolean;
  /** public.add_studio_receptionist(...) exists. */
  receptionistCommand: boolean;
  /** Either path can produce a receptionist. */
  receptionist: boolean;
};

/** The three valid practitioner-capacity states (0134/0136). */
export type FettCapacityState = "legacy" | "ready" | "live";

export type FettStudio = SeededStudio & {
  name: string;
  ownerEmail: string;
  timezone: string;
  /** Owner first, then the five treating practitioners. */
  practitioners: FettPractitioner[];
  /** The five treating practitioners, owner excluded. */
  treating: FettPractitioner[];
  services: { consultationId: string; treatmentId: string };
  receptionist: FettReceptionist | null;
  capabilities: FettCapabilities;
  /** Which of the three 0134/0136 states the studio was left in. */
  capacityState: FettCapacityState;
};

/** Probe the live schema for the receptionist limb. Read-only; safe to call
 *  before seeding. Reads the CHECK constraint text rather than attempting an
 *  insert, so it neither writes nor depends on an error message. */
export async function detectFettCapabilities(): Promise<FettCapabilities> {
  const role = await adminQuery(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'practitioners'
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ilike '%role%'`,
  );
  const receptionistRole = role.rows.some((r) =>
    r.def.toLowerCase().includes("receptionist"),
  );
  const cmd = await adminQuery(
    `select count(*)::text as n
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'add_studio_receptionist'`,
  );
  const receptionistCommand = cmd.rows[0].n !== "0";
  return {
    receptionistRole,
    receptionistCommand,
    receptionist: receptionistRole || receptionistCommand,
  };
}

async function seedAuthUser(email: string): Promise<string> {
  const userId = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    email,
  ]);
  return userId;
}

function fettEmail(slug: string): string {
  return `synth-fett-${slug}-${randomUUID().slice(0, 8)}${FETT_EMAIL_DOMAIN}`;
}

async function seedFettPractitioner(
  studioId: string,
  role: "owner" | "practitioner",
  slug: string,
  displayName: string,
): Promise<FettPractitioner> {
  const email = fettEmail(slug);
  const userId = await seedAuthUser(email);
  const practitionerId = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, $6, true)`,
    [practitionerId, studioId, userId, displayName, email, role],
  );
  return { userId, practitionerId, role, email, displayName };
}

export type SeedFettOptions = {
  /** Treating practitioners, owner excluded. Fett's enquiry says 5+. */
  treatingCount?: number;
  /** Local opening time for the seeded weekly availability. */
  open?: string;
  /** Local closing time. */
  close?: string;
  /** day_of_week values to open (0=Sun..6=Sat). Default Mon–Fri. */
  days?: readonly number[];
  /** Attempt the receptionist limb when the chain supports it. Default true;
   *  it is a NO-OP returning receptionist: null on an unsupporting chain. */
  withReceptionist?: boolean;
  /** Practitioner-capacity state. Default "live" — see the header. "legacy"
   *  leaves both flags false, i.e. one studio-wide resource. */
  capacity?: FettCapacityState;
};

/**
 * Seed the Fett rehearsal studio. Returns the seeded ids plus the probed
 * capabilities of the chain it ran against.
 *
 * `receptionist` is `null` whenever the chain cannot represent one — that is
 * the expected result on the 0210 production chain and is NOT a failure.
 * Assert on `capabilities` to branch a test, never on a hard-coded migration
 * number.
 */
export async function seedFettStudio(
  opts: SeedFettOptions = {},
): Promise<FettStudio> {
  const {
    treatingCount = 5,
    open = "09:00",
    close = "17:00",
    days = WEEKDAYS,
    withReceptionist = true,
    capacity = "live",
  } = opts;

  const studioId = randomUUID();
  const name = `SYNTH-FETT Derm LA ${randomUUID().slice(0, 6)}`;
  const ownerEmail = fettEmail("owner");

  // studios.timezone default is 'America/Toronto' — set LA explicitly.
  await adminQuery(
    `insert into public.studios (id, name, owner_email, timezone)
     values ($1, $2, $3, $4)`,
    [studioId, name, ownerEmail, FETT_TIMEZONE],
  );

  const ownerUserId = await seedAuthUser(ownerEmail);
  const ownerPractitionerId = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'owner', true)`,
    [ownerPractitionerId, studioId, ownerUserId, "SYNTH-FETT owner", ownerEmail],
  );
  const owner: FettPractitioner = {
    userId: ownerUserId,
    practitionerId: ownerPractitionerId,
    role: "owner",
    email: ownerEmail,
    displayName: "SYNTH-FETT owner",
  };

  const treating: FettPractitioner[] = [];
  for (let i = 1; i <= treatingCount; i += 1) {
    treating.push(
      await seedFettPractitioner(
        studioId,
        "practitioner",
        `electrologist-${i}`,
        `SYNTH-FETT electrologist ${i}`,
      ),
    );
  }

  // Electrolysis services. Durations sit inside services_duration_check
  // (5..480). No price: currency is not modelled for USD on this chain.
  const consultationId = randomUUID();
  const treatmentId = randomUUID();
  await adminQuery(
    `insert into public.services
       (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'SYNTH-FETT electrolysis consultation', 30, true),
            ($3, $2, 'SYNTH-FETT electrolysis treatment', 60, true)`,
    [consultationId, studioId, treatmentId],
  );

  await seedFettAvailability(studioId, { open, close, days });

  // Both flags default FALSE (LEGACY = one studio-wide resource), so this is
  // what makes five practitioners genuinely schedulable in parallel.
  await setFettCapacityState(studioId, capacity);

  const capabilities = await detectFettCapabilities();
  const receptionist = withReceptionist
    ? await seedFettReceptionist(studioId, capabilities)
    : null;

  // One synthetic client so boundary/intake tests have a target row.
  const clientId = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name) values ($1, $2, $3)`,
    [clientId, studioId, "SYNTH-FETT client"],
  );

  return {
    studioId,
    userId: ownerUserId,
    practitionerId: ownerPractitionerId,
    clientId,
    name,
    ownerEmail,
    timezone: FETT_TIMEZONE,
    practitioners: [owner, ...treating],
    treating,
    services: { consultationId, treatmentId },
    receptionist,
    capabilities,
    capacityState: capacity,
  };
}

/**
 * Put the studio into one of the three valid practitioner-capacity states.
 *
 * Ordering matters: `capacity=false + booking=true` is rejected by the CHECK
 * at `0136:52`, so the two columns are always written in ONE statement rather
 * than sequentially — a two-step update would transiently violate it.
 */
export async function setFettCapacityState(
  studioId: string,
  state: FettCapacityState,
): Promise<void> {
  const capacity = state !== "legacy";
  const booking = state === "live";
  await adminQuery(
    `update public.studios
        set practitioner_capacity_enabled = $2,
            practitioner_capacity_booking_enabled = $3
      where id = $1`,
    [studioId, capacity, booking],
  );
}

/** Studio-wide (practitioner_id NULL) weekly availability for the given days. */
export async function seedFettAvailability(
  studioId: string,
  opts: { open?: string; close?: string; days?: readonly number[] } = {},
): Promise<void> {
  const { open = "09:00", close = "17:00", days = WEEKDAYS } = opts;
  for (const dow of days) {
    await adminQuery(
      `insert into public.studio_availability_default
         (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time)
       values (gen_random_uuid(), $1, null, $2, true, $3, $4)
       on conflict on constraint studio_availability_default_scope_key
       do update set is_open = true,
                     open_time = excluded.open_time,
                     close_time = excluded.close_time`,
      [studioId, dow, open, close],
    );
  }
}

/**
 * The OPTIONAL receptionist limb. Returns `null` when the chain cannot
 * represent a receptionist — the expected 0210 result.
 *
 * Prefers the 0216 command when it exists so the fixture exercises the real
 * authority path rather than a hand-built row. Its argument names are NOT
 * known to this fixture, so the call is attempted by named-ish positional
 * shape and any failure degrades to `null` rather than throwing: a rehearsal
 * must not die because another lane's unmerged command has a different
 * signature.
 */
export async function seedFettReceptionist(
  studioId: string,
  capabilities?: FettCapabilities,
): Promise<FettReceptionist | null> {
  const caps = capabilities ?? (await detectFettCapabilities());
  if (!caps.receptionist) return null;

  const email = fettEmail("receptionist");
  const displayName = "SYNTH-FETT receptionist";

  if (caps.receptionistCommand) {
    try {
      const r = await adminQuery(
        `select public.add_studio_receptionist($1, $2, $3) as id`,
        [studioId, email, displayName],
      );
      const id = r.rows[0]?.id;
      if (id) {
        const u = await adminQuery(
          `select user_id from public.practitioners where id = $1`,
          [id],
        );
        return {
          userId: u.rows[0]?.user_id ?? "",
          practitionerId: id,
          email,
          displayName,
          via: "add_studio_receptionist",
        };
      }
    } catch {
      // Signature mismatch against an unmerged lane — fall through.
    }
  }

  if (!caps.receptionistRole) return null;
  const userId = await seedAuthUser(email);
  const practitionerId = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'receptionist', true)`,
    [practitionerId, studioId, userId, displayName, email],
  );
  return { userId, practitionerId, email, displayName, via: "direct_insert" };
}

/**
 * Teardown by id. Never truncates.
 *
 * appointment_audit.studio_id is ON DELETE RESTRICT (0174), and 0174 leaves no
 * runtime path that can remove the trail — so a studio that has ever had an
 * appointment audited cannot be deleted until the owner-only harness fixture
 * purges it. Same discipline as dropSynthStudio, duplicated deliberately so
 * this helper stays independent of the frozen synth fleet.
 */
export async function dropFettStudio(studio: FettStudio): Promise<void> {
  await purgeAppointmentAudit(studio.studioId);
  await adminQuery(`delete from public.studios where id = $1`, [
    studio.studioId,
  ]);
  const users = [
    ...studio.practitioners.map((p) => p.userId),
    ...(studio.receptionist ? [studio.receptionist.userId] : []),
  ].filter((id) => id.length > 0);
  for (const userId of users) {
    await adminQuery(`delete from auth.users where id = $1`, [userId]);
  }
}
