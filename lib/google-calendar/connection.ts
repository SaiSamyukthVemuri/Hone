import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";

// calendar_connections / calendar_connection_secrets access. All writes are
// service-role (admin client); the ciphertext table is never read by browser
// roles. Callers MUST have already authorized the actor (own practitioner, or
// studio owner for the designate action) before invoking the write helpers.

// Non-secret metadata surfaced to the settings card. NEVER includes ciphertext.
export type ConnectionMetadata = {
  id: string;
  connectionStatus: "disconnected" | "connected" | "reconnect_required" | "revoked" | "error";
  googleAccountEmail: string | null;
  writeCalendarId: string | null;
  grantedScopes: string[];
  isStudioCalendarOwner: boolean;
  lastSuccessfulAuthAt: string | null;
  lastErrorCode: string | null;
  tokenExpiresAt: string | null;
};

const METADATA_COLUMNS =
  "id, connection_status, google_account_email, write_calendar_id, granted_scopes, is_studio_calendar_owner, last_successful_auth_at, last_error_code, token_expires_at";

function toMetadata(row: Record<string, unknown>): ConnectionMetadata {
  return {
    id: row.id as string,
    connectionStatus: row.connection_status as ConnectionMetadata["connectionStatus"],
    googleAccountEmail: (row.google_account_email as string | null) ?? null,
    writeCalendarId: (row.write_calendar_id as string | null) ?? null,
    grantedScopes: (row.granted_scopes as string[] | null) ?? [],
    isStudioCalendarOwner: row.is_studio_calendar_owner === true,
    lastSuccessfulAuthAt: (row.last_successful_auth_at as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    tokenExpiresAt: (row.token_expires_at as string | null) ?? null,
  };
}

// The practitioner's own connection metadata (studio-scoped lookup). Read via
// the admin client but re-derives ownership by filtering on BOTH ids, so it can
// never surface another studio's row.
export async function getOwnConnectionMetadata(
  studioId: string,
  practitionerId: string,
): Promise<ConnectionMetadata | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_connections")
    .select(METADATA_COLUMNS)
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .maybeSingle();
  if (error || !data) return null;
  return toMetadata(data);
}

// Read only the studio_id/practitioner_id-scoped ciphertext (service-role).
// Used by calendar-selection to re-mint an access token. Never returned to UI.
export async function getRefreshTokenCiphertext(
  studioId: string,
  practitionerId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("calendar_connections")
    .select("id")
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .maybeSingle();
  if (!conn) return null;
  const { data: secret } = await admin
    .from("calendar_connection_secrets")
    .select("encrypted_refresh_token")
    .eq("connection_id", conn.id as string)
    .eq("studio_id", studioId)
    .maybeSingle();
  return (secret?.encrypted_refresh_token as string | null) ?? null;
}

export type PersistResult =
  | { ok: true; connectionId: string }
  | { ok: false; reason: string };

// Upsert the connection (connected) + the encrypted refresh token. If Google
// did not return a refresh token (silent re-grant), PRESERVE an existing stored
// token; if none exists, the connection is NOT marked healthy (reconnect_required).
// Never overwrites is_studio_calendar_owner (a reconnect must not change it).
export async function persistConnectedFromCallback(input: {
  studioId: string;
  practitionerId: string;
  googleAccountId: string;
  googleAccountEmail: string | null;
  grantedScopes: string[];
  tokenExpiresAt: string;
  writeCalendarId: string | null;
  encryptedRefreshToken: string | null;
  refreshTokenLast4: string | null;
  encryptionKeyVersion: number;
}): Promise<PersistResult> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: conn, error: upsertError } = await admin
    .from("calendar_connections")
    .upsert(
      {
        studio_id: input.studioId,
        practitioner_id: input.practitionerId,
        provider: "google",
        google_account_id: input.googleAccountId,
        google_account_email: input.googleAccountEmail,
        write_calendar_id: input.writeCalendarId,
        connection_status: "connected",
        granted_scopes: input.grantedScopes,
        token_expires_at: input.tokenExpiresAt,
        last_successful_auth_at: nowIso,
        last_error_code: null,
        last_error_at: null,
        disconnected_at: null,
        updated_at: nowIso,
      },
      { onConflict: "practitioner_id" },
    )
    .select("id")
    .maybeSingle();
  if (upsertError || !conn) return { ok: false, reason: "connection_upsert_failed" };
  const connectionId = conn.id as string;

  if (input.encryptedRefreshToken) {
    const { error: secretError } = await admin.from("calendar_connection_secrets").upsert(
      {
        connection_id: connectionId,
        studio_id: input.studioId,
        encrypted_refresh_token: input.encryptedRefreshToken,
        refresh_token_last4: input.refreshTokenLast4,
        encryption_key_version: input.encryptionKeyVersion,
        updated_at: nowIso,
      },
      { onConflict: "connection_id" },
    );
    if (secretError) return { ok: false, reason: "secret_upsert_failed" };
    return { ok: true, connectionId };
  }

  // No new refresh token — preserve an existing one, else fail closed.
  const { data: existing } = await admin
    .from("calendar_connection_secrets")
    .select("encrypted_refresh_token")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (existing?.encrypted_refresh_token) return { ok: true, connectionId };

  await admin
    .from("calendar_connections")
    .update({
      connection_status: "reconnect_required",
      last_error_code: "no_refresh_token",
      last_error_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", connectionId);
  return { ok: false, reason: "no_refresh_token" };
}

// Store a rotated refresh token (Google returned a new one during a refresh).
export async function storeRotatedRefreshToken(input: {
  connectionId: string;
  studioId: string;
  encryptedRefreshToken: string;
  refreshTokenLast4: string;
  encryptionKeyVersion: number;
}): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("calendar_connection_secrets")
    .update({
      encrypted_refresh_token: input.encryptedRefreshToken,
      refresh_token_last4: input.refreshTokenLast4,
      encryption_key_version: input.encryptionKeyVersion,
      updated_at: new Date().toISOString(),
    })
    .eq("connection_id", input.connectionId)
    .eq("studio_id", input.studioId);
}

export async function markReconnectRequired(
  studioId: string,
  practitionerId: string,
  code: string,
): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  await admin
    .from("calendar_connections")
    .update({
      connection_status: "reconnect_required",
      last_error_code: code.slice(0, 64),
      last_error_at: nowIso,
      updated_at: nowIso,
    })
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId);
}

// Disconnect: DESTROY the stored ciphertext (delete the secrets row) and mark
// the connection disconnected. Non-sensitive metadata (account email, last auth)
// is preserved for history. The Google-side revoke is attempted by the caller.
export async function disconnectConnection(
  studioId: string,
  practitionerId: string,
): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: conn } = await admin
    .from("calendar_connections")
    .select("id")
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .maybeSingle();
  if (!conn) return;
  await admin
    .from("calendar_connection_secrets")
    .delete()
    .eq("connection_id", conn.id as string)
    .eq("studio_id", studioId);
  await admin
    .from("calendar_connections")
    .update({
      connection_status: "disconnected",
      disconnected_at: nowIso,
      is_studio_calendar_owner: false,
      updated_at: nowIso,
    })
    .eq("id", conn.id as string);
}

// Store a validated write-calendar selection (the action validated it against
// Google's own calendar list for this connection before calling).
export async function setWriteCalendar(
  studioId: string,
  practitionerId: string,
  calendarId: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("calendar_connections")
    .update({ write_calendar_id: calendarId, updated_at: new Date().toISOString() })
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId);
}

// Designate the studio's single calendar owner. Clears the flag on every other
// connection in the studio FIRST (so the partial unique index never sees two
// true rows), then sets it on the target.
export async function designateStudioCalendarOwner(
  studioId: string,
  practitionerId: string,
): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  await admin
    .from("calendar_connections")
    .update({ is_studio_calendar_owner: false, updated_at: nowIso })
    .eq("studio_id", studioId)
    .neq("practitioner_id", practitionerId);
  await admin
    .from("calendar_connections")
    .update({ is_studio_calendar_owner: true, updated_at: nowIso })
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId);
}
