import { createHmac, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import {
  E2E_DB_URL,
  E2E_SUPABASE_URL,
  E2E_SERVICE_ROLE_KEY,
} from "./local-env";

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

  // Studio: buffer 0 so slot math in the test is exact; Toronto tz
  // (the project default); confirmation emails ON so the booking
  // flow exercises its real path (Resend has a dummy key, the send
  // fails gracefully, and the booking still succeeds by design).
  await sql(
    `insert into public.studios
       (id, name, owner_email, slug, timezone, buffer_minutes,
        default_appointment_duration_minutes)
     values ($1, $2, $3, $4, 'America/Toronto', 0, 30)`,
    [studioId, studioName, ownerEmail, slug],
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

export async function getCancellationToken(
  studioId: string,
  appointmentId: string,
): Promise<string | null> {
  const rows = await sql<{ cancellation_token: string | null }>(
    `select cancellation_token from public.appointments
      where studio_id = $1 and id = $2`,
    [studioId, appointmentId],
  );
  return rows[0]?.cancellation_token ?? null;
}
