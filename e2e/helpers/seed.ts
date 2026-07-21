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

  // Owner invitation + a REAL local GoTrue auth user. handle_new_user is a
  // no-op (migration 0141) — provisioning + acceptance now happen at sign-in —
  // so the test fixture provisions the fully-onboarded owner DIRECTLY (genuine
  // current-version acceptance stamps) and marks the invitation accepted, which
  // is equivalent to completing the acceptance flow.
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
  const created = (await response.json()) as { id: string };
  await sql(
    `insert into public.practitioners
       (studio_id, user_id, display_name, email, role, active,
        terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
     values ($1, $2, $3, $4, 'owner', true,
             now(), '2026-05-22', now(), '2026-05-22')`,
    [studioId, created.id, `E2E Owner ${runId}`, ownerEmail],
  );
  await sql(
    `update public.pending_invitations set status = 'accepted', accepted_at = now()
      where studio_id = $1 and lower(email) = lower($2)`,
    [studioId, ownerEmail],
  );
  const practitioner = await sql<{ id: string; role: string }>(
    `select id, role from public.practitioners where studio_id = $1`,
    [studioId],
  );
  if (practitioner.length !== 1 || practitioner[0].role !== "owner") {
    throw new Error("seed failed: owner practitioner was not provisioned");
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

// Seed a NON-OWNER practitioner (role 'practitioner') for an existing studio: a
// pending_invitation + a real local GoTrue user, so the 0081 handle_new_user
// trigger creates the member practitioner. Used to prove owner-only surfaces deny
// non-owners. Returns the login email.
export async function seedE2eMember(seed: E2eSeed): Promise<{ email: string }> {
  const uniq = randomUUID().slice(0, 8);
  const email = `e2e-member-${seed.runId}-${uniq}@harness.local`;
  await sql(
    `insert into public.pending_invitations (studio_id, email, role, display_name)
     values ($1, $2, 'practitioner', $3)`,
    [seed.studioId, email, `E2E Member ${uniq}`],
  );
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
      `local GoTrue admin createUser (member) failed: ${response.status} ${await response.text()}`,
    );
  }
  // handle_new_user is a no-op (0141); provision the member directly for the
  // fixture and accept the invitation (equivalent to completing acceptance).
  const created = (await response.json()) as { id: string };
  await sql(
    `insert into public.practitioners
       (studio_id, user_id, display_name, email, role, active,
        terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
     values ($1, $2, $3, $4, 'practitioner', true,
             now(), '2026-05-22', now(), '2026-05-22')`,
    [seed.studioId, created.id, `E2E Member ${uniq}`, email],
  );
  await sql(
    `update public.pending_invitations set status = 'accepted', accepted_at = now()
      where studio_id = $1 and lower(email) = lower($2)`,
    [seed.studioId, email],
  );
  const rows = await sql<{ role: string }>(
    `select pr.role from public.practitioners pr
       join auth.users u on u.id = pr.user_id
      where pr.studio_id = $1 and lower(u.email) = lower($2)`,
    [seed.studioId, email],
  );
  if (rows[0]?.role !== "practitioner") {
    throw new Error("seed failed: member practitioner was not provisioned");
  }
  return { email };
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
  // Unique per call: this helper may be invoked more than once for the SAME
  // studio, and clients carry a per-studio normalized-email unique constraint.
  const uniq = randomUUID().slice(0, 8);
  await sql(
    `insert into public.clients (id, studio_id, name, email)
     values ($1, $2, $3, $4)`,
    [
      clientId,
      seed.studioId,
      `Amend Client ${seed.runId}-${uniq}`,
      `e2e-amend-${seed.runId}-${uniq}@harness.local`,
    ],
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

// --- Existing-user invitation reconciliation (migration 0141) helpers -------

// Create a REAL local GoTrue auth user (an "existing Hone account") with no
// membership. Returns the auth user id.
export async function createLocalAuthUser(email: string): Promise<string> {
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
      `createLocalAuthUser failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { id: string };
  return body.id;
}

// A minimal target studio (no linked owner practitioner) for an invitation.
export async function insertBareStudio(
  label: string,
): Promise<{ studioId: string; slug: string; name: string }> {
  const runId = randomUUID().slice(0, 8);
  const studioId = randomUUID();
  const slug = `e2e-${label}-${runId}`;
  const name = `E2E ${label} ${runId}`;
  await sql(
    `insert into public.studios (id, name, owner_email, slug, timezone)
     values ($1, $2, $3, $4, $5)`,
    [studioId, name, `owner-${runId}@harness.local`, slug, timezoneWithLocalMorning()],
  );
  return { studioId, slug, name };
}

export async function insertPendingInvite(
  studioId: string,
  email: string,
  role: "owner" | "practitioner" = "practitioner",
): Promise<void> {
  await sql(
    `insert into public.pending_invitations (studio_id, email, role, display_name)
     values ($1, $2, $3, $4)`,
    [studioId, email, role, "E2E Invitee"],
  );
}

// A practitioner row carrying CURRENT-version terms+privacy acceptance — the
// reusable evidence the reconcile RPC copies. `active` controls whether it also
// counts as a live membership (active=false = evidence only, 0 active studios).
export async function insertEvidenceMembership(
  userId: string,
  email: string,
  active: boolean,
): Promise<{ studioId: string }> {
  const { studioId } = await insertBareStudio("evidence");
  await sql(
    `insert into public.practitioners
       (studio_id, user_id, display_name, email, role, active,
        terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
     values ($1, $2, 'E2E Existing', $3, 'owner', $4,
             now(), '2026-05-22', now(), '2026-05-22')`,
    [studioId, userId, email, active],
  );
  return { studioId };
}

// Insert a practitioner membership into a SPECIFIC studio (e.g. to construct a
// conflicting membership held by another auth user under the invited email).
export async function insertMembershipInStudio(
  studioId: string,
  userId: string,
  email: string,
  active = true,
): Promise<void> {
  await sql(
    `insert into public.practitioners
       (studio_id, user_id, display_name, email, role, active,
        terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
     values ($1, $2, 'E2E', $3, 'owner', $4,
             now(), '2026-05-22', now(), '2026-05-22')`,
    [studioId, userId, email, active],
  );
}

// Onboarding v2 (migration 0140). Toggle the studio-scoped kill-switch so the
// browser lane can exercise the guided wizard + pinned card. The direct SQL
// connection is not a browser role, so the operator-only guard trigger allows
// the flip (it only blocks anon/authenticated).
export async function setStudioOnboardingV2Enabled(
  studioId: string,
  enabled: boolean,
): Promise<void> {
  await sql(
    `update public.studios set onboarding_v2_enabled = $2 where id = $1`,
    [studioId, enabled],
  );
}

// Google Calendar — Phase A. Toggle the studio-scoped connection flag so the
// e2e can exercise the flag gate (card hidden when OFF, shown when ON).
export async function setStudioGoogleCalendarConnectionEnabled(
  studioId: string,
  enabled: boolean,
): Promise<void> {
  await sql(
    `update public.studios set google_calendar_connection_enabled = $2 where id = $1`,
    [studioId, enabled],
  );
}

// Toggle the OWNER practitioner's active flag — proves the inactive-practitioner
// server-side denial in the destination E2E.
export async function setE2eOwnerActive(studioId: string, active: boolean): Promise<void> {
  await sql(
    `update public.practitioners set active = $2 where studio_id = $1 and role = 'owner'`,
    [studioId, active],
  );
}

// Read the owner connection's destination state (for E2E assertions of what the
// server actually stored). Returns null when no connection exists.
export async function getE2eOwnerConnectionState(
  studioId: string,
): Promise<{
  destination_mode: string | null;
  write_calendar_id: string | null;
  app_created_calendar_id: string | null;
  destination_ownership_validated_at: string | null;
  destination_provisioning_ambiguous_at: string | null;
  granted_scopes: string[];
} | null> {
  const rows = await sql<{
    destination_mode: string | null;
    write_calendar_id: string | null;
    app_created_calendar_id: string | null;
    destination_ownership_validated_at: string | null;
    destination_provisioning_ambiguous_at: string | null;
    granted_scopes: string[];
  }>(
    `select destination_mode, write_calendar_id, app_created_calendar_id,
            destination_ownership_validated_at, destination_provisioning_ambiguous_at, granted_scopes
       from public.calendar_connections
      where studio_id = $1 and connection_status <> 'disconnected'
      order by created_at desc limit 1`,
    [studioId],
  );
  return rows[0] ?? null;
}

// Dormancy assertions for the destination E2E: outbox + event-link counts.
export async function getE2eCalendarSyncCounts(): Promise<{ outbox: number; links: number }> {
  const outbox = await sql<{ n: string }>(`select count(*)::text as n from public.calendar_sync_outbox`);
  const links = await sql<{ n: string }>(`select count(*)::text as n from public.calendar_event_links`);
  return { outbox: Number(outbox[0]?.n ?? "0"), links: Number(links[0]?.n ?? "0") };
}

// Google Calendar — Phase B2.2. Seed a CONNECTED owner connection (+ a dummy
// encrypted secret so readiness sees a usable token) so the e2e can exercise the
// derived readiness rendering (Grant-event-access CTA vs ready) WITHOUT a live
// Google round-trip. The ciphertext is never decrypted for readiness (existence
// only), so a placeholder is fine.
export async function seedE2eGoogleConnection(
  studioId: string,
  grantedScopes: string[],
  // B2.4: optional destination. When 'existing_owned'/'dedicated_app_created' the
  // connection is seeded as a fully-configured destination (so readiness can reach
  // outbound_scope_ready with the matching event scope). Null = no destination.
  destinationMode: "existing_owned" | "dedicated_app_created" | null = null,
): Promise<void> {
  const owner = await sql<{ id: string }>(
    `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
    [studioId],
  );
  const practitionerId = owner[0]?.id;
  const connId = randomUUID();
  const ownedValidatedAt = destinationMode === "existing_owned" ? new Date().toISOString() : null;
  const appCreatedId = destinationMode === "dedicated_app_created" ? "e2e-hone-appointments-cal" : null;
  const configuredAt = destinationMode ? new Date().toISOString() : null;
  await sql(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner, google_account_id, google_account_email,
        destination_mode, selected_calendar_display_name, app_created_calendar_id, destination_ownership_validated_at, destination_configured_at)
     values ($1,$2,$3,'connected',$4,'primary',true,'e2e-sub','e2e-google@example.com',
        $5,$6,$7,$8,$9)`,
    [connId, studioId, practitionerId, grantedScopes, destinationMode,
     destinationMode ? "Hone Appointments" : null, appCreatedId, ownedValidatedAt, configuredAt],
  );
  await sql(
    `insert into public.calendar_connection_secrets
       (connection_id, studio_id, encrypted_refresh_token, refresh_token_last4, encryption_key_version)
     values ($1,$2,'v1:1:iv:tag:ct','1234',1)`,
    [connId, studioId],
  );
}

// Emergency chip-loading fix. Seed a DRAFT electrolysis session with one entry
// whose observations live in the LEGACY `comments` field (observation_chips = [],
// as pre-0108 / legacy-form rows do), reproducing Chloe's exact data so the e2e
// can prove the chips now render as pills. Returns the client + session ids.
export async function seedE2eDraftSessionWithLegacyChipEntry(
  seed: E2eSeed,
  comments: string,
): Promise<{
  clientId: string;
  sessionId: string;
  blockId: string;
  entryId: string;
}> {
  const prac = (
    await sql<{ id: string }>(
      `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
      [seed.studioId],
    )
  )[0];
  const clientId = randomUUID();
  const sessionId = randomUUID();
  const blockId = randomUUID();
  const entryId = randomUUID();
  const uniq = randomUUID().slice(0, 8);
  await sql(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [clientId, seed.studioId, `Chip Client ${seed.runId}-${uniq}`, `e2e-chip-${seed.runId}-${uniq}@harness.local`],
  );
  await sql(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values ($1,$2,$3,$4,'electrolysis')`,
    [sessionId, seed.studioId, clientId, prac.id],
  );
  await sql(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area) values ($1,$2,$3,'Chin')`,
    [blockId, seed.studioId, sessionId],
  );
  // observation_chips defaults to '[]' (0108); the chips are only in comments.
  await sql(
    `insert into public.electrolysis_entries (id, session_id, area, areas, block_id, comments)
     values ($1,$2,'Chin',array['Chin']::text[],$3,$4)`,
    [entryId, sessionId, blockId, comments],
  );
  return { clientId, sessionId, blockId, entryId };
}

// Read-back the stored observation_chips of a session's electrolysis entry —
// 'first' (earliest, edited by block-setup-form) or 'last' (newest, created by
// SimplifiedEntryForm). Ground truth for the chip save-cycle e2e.
export async function getEntryObservationChips(
  sessionId: string,
  which: "first" | "last" = "first",
): Promise<string[]> {
  const rows = await sql<{ observation_chips: string[] }>(
    `select observation_chips from public.electrolysis_entries
      where session_id = $1 and deleted_at is null
      order by created_at ${which === "first" ? "asc" : "desc"} limit 1`,
    [sessionId],
  );
  return rows[0]?.observation_chips ?? [];
}

// Seed a draft electrolysis session with a client and NO blocks. The charting
// page opens with the "Add settings block" form ready (blocks.length === 0).
export async function seedE2eDraftElectrolysisSession(
  seed: E2eSeed,
): Promise<{ clientId: string; sessionId: string }> {
  const prac = (
    await sql<{ id: string }>(
      `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
      [seed.studioId],
    )
  )[0];
  const clientId = randomUUID();
  const sessionId = randomUUID();
  const uniq = randomUUID().slice(0, 8);
  await sql(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [clientId, seed.studioId, `Area Client ${seed.runId}-${uniq}`, `e2e-area-${seed.runId}-${uniq}@harness.local`],
  );
  await sql(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values ($1,$2,$3,$4,'electrolysis')`,
    [sessionId, seed.studioId, clientId, prac.id],
  );
  return { clientId, sessionId };
}

// Seed a probe row in the studio's sterilization inventory
// (record_keeping_sterile_items) so the charting probe-lot selector has an
// ACTIVE (or expired) candidate. expiryDate null = never expires.
export async function seedE2eProbeInventoryItem(
  seed: E2eSeed,
  opts: {
    lotNumber: string;
    description?: string;
    manufacturer?: string;
    expiryDate?: string | null;
  },
): Promise<void> {
  await sql(
    `insert into public.record_keeping_sterile_items
       (id, studio_id, date_purchased, item_description, manufacturer_name,
        amount_purchased, lot_number, expiry_date)
     values ($1,$2, current_date, $3, $4, '1 box', $5, $6)`,
    [
      randomUUID(),
      seed.studioId,
      opts.description ?? "Sterex Gold F3 probe",
      opts.manufacturer ?? "Sterex",
      opts.lotNumber,
      opts.expiryDate === undefined ? null : opts.expiryDate,
    ],
  );
}

// Willow follow-up: seed an OVERDUE disinfectant record (record_keeping_disinfectants)
// so the Notification Centre computes its "Replace disinfectant now" operational
// alert. A far-past discard_due_date with no date_discarded is unambiguously
// overdue in any studio timezone. Returns the record id.
export async function seedE2eOverdueDisinfectant(
  seed: E2eSeed,
  opts: { name?: string; discardDueDate?: string; datePrepared?: string } = {},
): Promise<{ recordId: string }> {
  const recordId = randomUUID();
  await sql(
    `insert into public.record_keeping_disinfectants
       (id, studio_id, date_prepared, disinfectant_name, discard_due_date)
     values ($1,$2,$3,$4,$5)`,
    [
      recordId,
      seed.studioId,
      opts.datePrepared ?? "2019-12-01",
      opts.name ?? "Barbicide E2E jar",
      opts.discardDueDate ?? "2020-01-01",
    ],
  );
  return { recordId };
}

// Read a disinfectant record's date_discarded (E2E ground truth for resolution).
export async function getDisinfectantDateDiscarded(
  recordId: string,
): Promise<string | null> {
  const rows = await sql<{ date_discarded: string | null }>(
    `select date_discarded from public.record_keeping_disinfectants where id = $1`,
    [recordId],
  );
  return rows[0]?.date_discarded ?? null;
}

// Seed a LEGACY single-area block (primary_area + block-level side, no child
// rows) so the e2e can prove legacy records still render their single area.
export async function seedE2eLegacyBlock(
  seed: E2eSeed,
  sessionId: string,
  opts: { primaryArea: string; side?: string | null; sortOrder?: number },
): Promise<{ blockId: string }> {
  const blockId = randomUUID();
  await sql(
    `insert into public.session_blocks
       (id, studio_id, session_id, primary_area, side, sort_order)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      blockId,
      seed.studioId,
      sessionId,
      opts.primaryArea,
      opts.side ?? null,
      opts.sortOrder ?? 0,
    ],
  );
  return { blockId };
}

// Read the probe-lot snapshots saved on a session's (non-deleted) blocks.
export async function getSessionBlockProbeLots(
  sessionId: string,
): Promise<Array<string | null>> {
  const rows = await sql<{ probe_lot_number: string | null }>(
    `select probe_lot_number from public.session_blocks
      where session_id = $1 and deleted_at is null
      order by sort_order, created_at`,
    [sessionId],
  );
  return rows.map((r) => r.probe_lot_number);
}

// Force a block's updated_at to a stale value out-of-band, to exercise the
// optimistic-concurrency conflict (stale_block_version) from a browser edit.
export async function bumpSessionBlockUpdatedAt(sessionId: string): Promise<void> {
  await sql(
    `update public.session_blocks
        set updated_at = now() + interval '1 second'
      where session_id = $1 and deleted_at is null`,
    [sessionId],
  );
}

// Read a session's structured block areas (migration 0128) for e2e ground truth.
// Returns "<area>|<laterality>" strings ordered by block + display_order.
export async function getSessionBlockAreas(sessionId: string): Promise<string[]> {
  const rows = await sql<{ area: string; laterality: string }>(
    `select a.area, a.laterality
       from public.session_block_areas a
       join public.session_blocks b on b.id = a.session_block_id
      where b.session_id = $1 and b.deleted_at is null
      order by a.session_block_id, a.display_order, a.created_at`,
    [sessionId],
  );
  return rows.map((r) => `${r.area}|${r.laterality}`);
}

// Seed a bare client under the studio (no session). Used by the clinical-notes
// e2e to exercise the consultation/skin-hair surfaces on the client profile.
export async function seedE2eClient(seed: E2eSeed): Promise<{ clientId: string }> {
  const clientId = randomUUID();
  const uniq = randomUUID().slice(0, 8);
  await sql(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [
      clientId,
      seed.studioId,
      `Notes Client ${seed.runId}-${uniq}`,
      `e2e-notes-${seed.runId}-${uniq}@harness.local`,
    ],
  );
  return { clientId };
}

// Ground truth for the clinical-notes e2e: how many rows of a kind exist, and
// the CURRENT (non-superseded) body for a kind.
export async function getClinicalNoteCount(
  clientId: string,
  kind?: string,
): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::int as n from public.client_clinical_notes
      where client_id = $1 and ($2::text is null or kind = $2)`,
    [clientId, kind ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getLatestClinicalNoteBody(
  clientId: string,
  kind: string,
): Promise<string | null> {
  const rows = await sql<{ body: string }>(
    `select body from public.client_clinical_notes n
      where n.client_id = $1 and n.kind = $2
        and not exists (
          select 1 from public.client_clinical_notes r
          where r.supersedes_note_id = n.id
        )
      order by n.occurred_at desc, n.created_at desc
      limit 1`,
    [clientId, kind],
  );
  return rows[0]?.body ?? null;
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
