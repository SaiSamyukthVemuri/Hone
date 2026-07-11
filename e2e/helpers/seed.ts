import { createHmac, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import {
  E2E_DB_URL,
  E2E_SUPABASE_URL,
  E2E_SERVICE_ROLE_KEY,
  E2E_WEB_SERVER_ENV,
} from "./local-env";
import { timezoneWithLocalMorning } from "./timezone";

// Seed helpers for the browser E2E lane (PR #227). Direct SQL against
// the LOCAL database only (E2E_DB_URL is hardcoded localhost), plus
// the local GoTrue admin API for the auth user, so the practitioner
// account is a REAL auth user created through the invite path
// (pending_invitations -> handle_new_user trigger -> owner
// practitioner row): no runtime auth bypass anywhere.
//
// Every identifier is unique per run (e2e- prefix + random suffix).
// Cleanup is deliberately NOT attempted: the lane assumes a
// disposable local database (supabase db reset --local), which also
// respects the 0087 delete hardening.

export type E2eSeed = {
  runId: string;
  studioId: string;
  slug: string;
  studioName: string;
  ownerEmail: string;
  serviceName: string;
  clientName: string;
  clientEmail: string;
};

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new PgClient({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

export async function seedE2eStudio(): Promise<E2eSeed> {
  const runId = randomUUID().slice(0, 8);
  const studioId = randomUUID();
  const slug = `e2e-studio-${runId}`;
  const studioName = `E2E Studio ${runId}`;
  const ownerEmail = `e2e-owner-${runId}@harness.local`;
  const serviceName = `E2E Consultation ${runId}`;
  const clientName = `E2E Client ${runId}`;
  const clientEmail = `e2e-client-${runId}@harness.local`;

  // Studio: buffer 0 so slot math in the test is exact; a local-
  // morning timezone so today always has slots (see
  // ./timezone.ts); confirmation emails ON so the
  // booking flow exercises its real path (Resend has a dummy key,
  // the send fails gracefully, and the booking still succeeds by
  // design).
  await sql(
    `insert into public.studios
       (id, name, owner_email, slug, timezone, buffer_minutes,
        default_appointment_duration_minutes)
     values ($1, $2, $3, $4, $5, 0, 30)`,
    [studioId, studioName, ownerEmail, slug, timezoneWithLocalMorning()],
  );

  // Weekly availability: open every day with a wide window so the
  // booking page has slots no matter which weekday the run lands on.
  await sql(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time)
     select $1, d, true, '06:00', '22:00' from generate_series(0, 6) d`,
    [studioId],
  );

  // One active consultation service: the public NEW-client booking
  // path offers consultation services only.
  await sql(
    `insert into public.services
       (studio_id, name, modality, default_duration_minutes, price_cents, active)
     values ($1, $2, 'consultation', 30, 0, true)`,
    [studioId, serviceName],
  );

  // Owner invitation, then a REAL local auth user via the GoTrue
  // admin API. The 0081 handle_new_user trigger fires on the insert
  // and creates the owner practitioner row from the invitation.
  await sql(
    `insert into public.pending_invitations (studio_id, email, role, display_name)
     values ($1, $2, 'owner', $3)`,
    [studioId, ownerEmail, `E2E Owner ${runId}`],
  );
  const response = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: ownerEmail, email_confirm: true }),
  });
  if (!response.ok) {
    throw new Error(
      `local GoTrue admin createUser failed: ${response.status} ${await response.text()}`,
    );
  }
  const practitioner = await sql<{ id: string; role: string }>(
    `select id, role from public.practitioners where studio_id = $1`,
    [studioId],
  );
  if (practitioner.length !== 1 || practitioner[0].role !== "owner") {
    throw new Error(
      "seed failed: handle_new_user did not create the owner practitioner",
    );
  }

  return {
    runId,
    studioId,
    slug,
    studioName,
    ownerEmail,
    serviceName,
    clientName,
    clientEmail,
  };
}

// PR #253: seed a NO-STUDIO auth user — a real local GoTrue user for an
// email with NO pending invitation. The 0081 handle_new_user trigger
// fires on creation, finds no invitation, and creates NOTHING (no studio,
// no practitioner). Used to prove the invite-only gate: this user can
// authenticate but must be redirected to /no-access, never the app shell.
export async function seedNoStudioAuthUser(): Promise<{ email: string }> {
  const runId = randomUUID().slice(0, 8);
  const email = `e2e-nostudio-${runId}@harness.local`;
  const response = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!response.ok) {
    throw new Error(
      `local GoTrue admin createUser (no-studio) failed: ${response.status} ${await response.text()}`,
    );
  }
  // Sanity: invite-only handle_new_user must NOT have created a practitioner.
  const rows = await sql<{ count: string }>(
    `select count(*)::text as count from public.practitioners p
       join auth.users u on u.id = p.user_id
      where lower(u.email) = lower($1)`,
    [email],
  );
  if (rows[0]?.count !== "0") {
    throw new Error(
      "seed failed: an uninvited auth user unexpectedly has a practitioner row",
    );
  }
  return { email };
}

// PR #254: the internal New Studio Wizard operator. A REAL auth user whose
// email is in ADMIN_EMAILS (local-env.ts) so isAdmin() is true, but who is
// uninvited — so handle_new_user creates NO practitioner and they are a
// no-studio operator. The PR #254 middleware carve-out lets this admin reach
// /admin without a studio. Fixed (not run-scoped) email so it matches the
// allowlist; idempotent so Playwright retries don't fail on a duplicate.
export async function seedOperatorAuthUser(): Promise<{ email: string }> {
  const email = "e2e-operator@harness.local";
  const existing = await sql<{ count: string }>(
    `select count(*)::text as count from auth.users where lower(email) = lower($1)`,
    [email],
  );
  if (existing[0]?.count === "0") {
    const response = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: E2E_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, email_confirm: true }),
    });
    if (!response.ok) {
      throw new Error(
        `local GoTrue admin createUser (operator) failed: ${response.status} ${await response.text()}`,
      );
    }
  }
  // The operator is uninvited -> handle_new_user must NOT have created a
  // practitioner (they reach /admin via the isAdmin carve-out, not a studio).
  const rows = await sql<{ count: string }>(
    `select count(*)::text as count from public.practitioners p
       join auth.users u on u.id = p.user_id
      where lower(u.email) = lower($1)`,
    [email],
  );
  if (rows[0]?.count !== "0") {
    throw new Error(
      "seed failed: the operator unexpectedly has a practitioner row",
    );
  }
  return { email };
}

// PR: amendment-path reliability. Seed a NATIVE, FINALIZED, corrections-enabled
// session so the spec can drive the real Amend flow (UI -> server action ->
// PostgREST RPC -> amendment row + audit event). The finalize call runs as the
// authenticated owner (role + request.jwt.claims, exactly how PostgREST presents
// a logged-in user) so finalize_session's auth.uid()/RLS behave as in production;
// no runtime auth bypass. Both clinical flags are turned on for the studio.
export async function seedFinalizedSession(
  seed: E2eSeed,
): Promise<{ clientId: string; sessionId: string; snapshotId: string }> {
  await sql(
    `update public.studios
        set clinical_finalization_enabled = true,
            clinical_corrections_enabled = true
      where id = $1`,
    [seed.studioId],
  );
  const prac = (
    await sql<{ id: string; user_id: string }>(
      `select id, user_id from public.practitioners
        where studio_id = $1 and role = 'owner' limit 1`,
      [seed.studioId],
    )
  )[0];
  if (!prac) throw new Error("seedFinalizedSession: owner practitioner not found");

  const clientId = randomUUID();
  const sessionId = randomUUID();
  const blockId = randomUUID();
  await sql(
    `insert into public.clients (id, studio_id, name, email)
     values ($1, $2, $3, $4)`,
    [clientId, seed.studioId, `Amend Client ${seed.runId}`, `e2e-amend-${seed.runId}@harness.local`],
  );
  await sql(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, $4, 'electrolysis')`,
    [sessionId, seed.studioId, clientId, prac.id],
  );
  await sql(
    `insert into public.session_blocks (id, studio_id, session_id)
     values ($1, $2, $3)`,
    [blockId, seed.studioId, sessionId],
  );
  await sql(
    `insert into public.electrolysis_entries (id, session_id, area, block_id)
     values ($1, $2, 'chin', $3)`,
    [randomUUID(), sessionId, blockId],
  );

  // Finalize as the authenticated owner (auth.uid() + RLS active).
  const client = new PgClient({ connectionString: E2E_DB_URL });
  await client.connect();
  let snapshotId: string;
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: prac.user_id, role: "authenticated" }),
    ]);
    const fin = await client.query(
      "select * from public.finalize_session($1, $2)",
      [sessionId, 1],
    );
    snapshotId = fin.rows[0].snapshot_id as string;
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  return { clientId, sessionId, snapshotId };
}

// Toggle a studio's corrections flag mid-test to drive a REAL server-side
// failure (the server action re-reads the flag on every call) without mocking.
export async function setStudioCorrectionsEnabled(
  studioId: string,
  enabled: boolean,
): Promise<void> {
  await sql(
    `update public.studios set clinical_corrections_enabled = $2 where id = $1`,
    [studioId, enabled],
  );
}

// Ground-truth checks the amend spec asserts against the real DB.
export async function getAmendmentCount(sessionId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from public.clinical_record_amendments where session_id = $1`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? "0");
}

export async function getClinicalAuditEventCount(
  sessionId: string,
  operationType: string,
): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from public.clinical_audit_events
      where session_id = $1 and operation_type = $2`,
    [sessionId, operationType],
  );
  return Number(rows[0]?.n ?? "0");
}

export async function getSessionRecordState(
  sessionId: string,
): Promise<{ record_version: number; current_snapshot_id: string | null }> {
  const rows = await sql<{ record_version: number; current_snapshot_id: string | null }>(
    `select record_version, current_snapshot_id from public.sessions where id = $1`,
    [sessionId],
  );
  return rows[0];
}

// Read-only lookups the spec uses to bridge between UI steps.

// Intake links are SIGNED tokens (lib/intake/tokens.ts), not stored
// columns. Recreate the exact format here with the E2E dummy
// INTAKE_SIGNING_SECRET so the spec can follow the same link the
// confirmation email would have carried (the email itself fails
// gracefully against the dummy Resend key).
const E2E_INTAKE_SIGNING_SECRET = "dummy-intake-signing-secret";

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function getIntakeTokenForClient(
  studioId: string,
  clientEmail: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }>(
    `select f.id
       from public.client_intake_forms f
       join public.clients c on c.id = f.client_id
      where f.studio_id = $1 and lower(c.email) = lower($2)
      order by f.created_at desc limit 1`,
    [studioId, clientEmail],
  );
  const intakeId = rows[0]?.id;
  if (!intakeId) return null;
  const expiresAt = new Date(Date.now() + 13 * 24 * 60 * 60 * 1000);
  const payload = base64Url(
    Buffer.from(
      JSON.stringify({ intake_id: intakeId, expires_at: expiresAt.toISOString() }),
    ),
  );
  const signature = base64Url(
    createHmac("sha256", E2E_INTAKE_SIGNING_SECRET).update(payload).digest(),
  );
  return `${payload}.${signature}`;
}

export async function getClientIdByEmail(
  studioId: string,
  clientEmail: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }>(
    `select id from public.clients where studio_id = $1 and lower(email) = lower($2) limit 1`,
    [studioId, clientEmail],
  );
  return rows[0]?.id ?? null;
}

export async function getAppointmentsForClient(
  studioId: string,
  clientId: string,
): Promise<Array<{ id: string; starts_at: string; status: string }>> {
  return sql(
    `select id, starts_at, status from public.appointments
      where studio_id = $1 and client_id = $2 order by starts_at`,
    [studioId, clientId],
  );
}

// PR #260: appointment tokens are hashed at rest, so the raw token a
// confirmation email carried can no longer be read back from the DB. The
// public /cancel, /reschedule, and /manage routes all accept the stateless
// HMAC fallback (the same token the portal + reminders mint), so this
// helper mints one — matching lib/booking/tokens.ts byte-for-byte using
// the dummy e2e signing secret the dev server runs with — so the e2e can
// drive a working manage/cancel/reschedule link end to end.
function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function getCancellationToken(
  studioId: string,
  appointmentId: string,
): Promise<string | null> {
  const rows = await sql<{ starts_at: string | null }>(
    `select starts_at from public.appointments
      where studio_id = $1 and id = $2`,
    [studioId, appointmentId],
  );
  const startsAt = rows[0]?.starts_at;
  if (!startsAt) return null;
  const payloadB64 = base64url(
    Buffer.from(
      JSON.stringify({
        appointment_id: appointmentId,
        expires_at: new Date(startsAt).toISOString(),
      }),
    ),
  );
  const sig = base64url(
    createHmac("sha256", E2E_WEB_SERVER_ENV.APPOINTMENT_SIGNING_SECRET)
      .update(payloadB64)
      .digest(),
  );
  return `${payloadB64}.${sig}`;
}
