import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { deriveConnectionReadiness, type ConnectionReadiness } from "./readiness";
import type { CalendarDestinationMode } from "./destination-scopes";

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
  // B2.4 dual-destination metadata (migration 0131). destinationMode drives the
  // destination-aware required event scope; the rest are safe display/provenance
  // facts (never tokens/PHI).
  destinationMode: string | null;
  selectedCalendarDisplayName: string | null;
  appCreatedCalendarId: string | null;
  destinationConfiguredAt: string | null;
  destinationOwnershipValidatedAt: string | null;
  // B2.4 Stage 2 provisioning-state (dedicated mode only). Non-sensitive.
  // ambiguousAt set => reconciliation found multiple token matches => needs
  // attention (readiness derives "needs_attention"). attemptToken/startedAt are
  // the idempotency + reconciliation inputs.
  provisioningAttemptToken: string | null;
  provisioningStartedAt: string | null;
  provisioningAmbiguousAt: string | null;
};

const METADATA_COLUMNS =
  "id, connection_status, google_account_email, write_calendar_id, granted_scopes, is_studio_calendar_owner, last_successful_auth_at, last_error_code, token_expires_at, destination_mode, selected_calendar_display_name, app_created_calendar_id, destination_configured_at, destination_ownership_validated_at, destination_provisioning_attempt_token, destination_provisioning_started_at, destination_provisioning_ambiguous_at";

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
    destinationMode: (row.destination_mode as string | null) ?? null,
    selectedCalendarDisplayName: (row.selected_calendar_display_name as string | null) ?? null,
    appCreatedCalendarId: (row.app_created_calendar_id as string | null) ?? null,
    destinationConfiguredAt: (row.destination_configured_at as string | null) ?? null,
    destinationOwnershipValidatedAt: (row.destination_ownership_validated_at as string | null) ?? null,
    provisioningAttemptToken: (row.destination_provisioning_attempt_token as string | null) ?? null,
    provisioningStartedAt: (row.destination_provisioning_started_at as string | null) ?? null,
    provisioningAmbiguousAt: (row.destination_provisioning_ambiguous_at as string | null) ?? null,
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

// The server-verified Google account id (sub) of the existing connection, if
// any. Used by the B2.2 scope-upgrade callback to REJECT account switching — a
// returned identity that differs must never overwrite the stored credentials.
export async function getConnectionAccountId(
  studioId: string,
  practitionerId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("calendar_connections")
    .select("google_account_id")
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .maybeSingle();
  return (data?.google_account_id as string | null) ?? null;
}

// Load the connection metadata + the DERIVED readiness in one server call. This
// is the single readiness source the settings UI consumes (and B2.3 will reuse).
export async function getOwnConnectionReadiness(
  studioId: string,
  practitionerId: string,
): Promise<{ metadata: ConnectionMetadata | null; readiness: ConnectionReadiness }> {
  const metadata = await getOwnConnectionMetadata(studioId, practitionerId);
  if (!metadata) return { metadata: null, readiness: "disconnected" };
  const ciphertext = await getRefreshTokenCiphertext(studioId, practitionerId);
  const readiness = deriveConnectionReadiness({
    connectionStatus: metadata.connectionStatus,
    grantedScopes: metadata.grantedScopes,
    hasUsableRefreshToken: !!ciphertext,
    isStudioCalendarOwner: metadata.isStudioCalendarOwner,
    writeCalendarId: metadata.writeCalendarId,
    destinationMode: metadata.destinationMode,
    appCreatedCalendarId: metadata.appCreatedCalendarId,
    destinationOwnershipValidatedAt: metadata.destinationOwnershipValidatedAt,
    provisioningAmbiguousAt: metadata.provisioningAmbiguousAt,
  });
  return { metadata, readiness };
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

// B2.4 — record the owner's chosen appointment DESTINATION mode. NO-SWITCH: once a
// mode is set, B2.4 does not support changing to the other mode (destination
// switching is a separate future product/data-lifecycle decision — see
// docs/integrations/google-calendar-sync.md). A re-select of the SAME mode is an
// idempotent no-op (recovery from a pending state stays on the same mode).
// Choosing a mode for the first time (currently NULL) is allowed. Readiness stays
// derived; this only records the input.
export async function setDestinationMode(
  studioId: string,
  practitionerId: string,
  mode: CalendarDestinationMode,
): Promise<PersistResult> {
  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("calendar_connections")
    .select("id, destination_mode")
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .maybeSingle();
  if (!conn) return { ok: false, reason: "connection_not_found" };
  const connectionId = conn.id as string;
  const current = conn.destination_mode as string | null;
  if (current === mode) return { ok: true, connectionId }; // idempotent no-op
  if (current !== null) return { ok: false, reason: "destination_switching_unsupported" };

  // First mode choice (NULL -> mode): start from a CLEAN destination slate. In
  // particular clear the Phase-A default write_calendar_id so it can never
  // masquerade as a configured destination target (the mode's config step
  // establishes the real target). No provenance can pre-exist for a fresh mode.
  const { error } = await admin
    .from("calendar_connections")
    .update({
      destination_mode: mode,
      write_calendar_id: null,
      selected_calendar_display_name: null,
      app_created_calendar_id: null,
      destination_ownership_validated_at: null,
      destination_configured_at: null,
      destination_provisioning_attempt_token: null,
      destination_provisioning_started_at: null,
      destination_provisioning_ambiguous_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);
  if (error) return { ok: false, reason: "destination_mode_update_failed" };
  return { ok: true, connectionId };
}

// B2.4 dedicated provisioning — record a NEW attempt token + start time BEFORE the
// Google calendars.insert, so an ambiguous provider response can be reconciled by
// EXACT token match. Guarded to the dedicated mode + only when NOT yet provisioned
// (app_created_calendar_id null) and NOT flagged ambiguous. Returns the token to
// embed in the created calendar's description.
export type ProvisioningAttemptResult =
  | { ok: true; connectionId: string; attemptToken: string }
  | { ok: false; reason: string };

export async function beginDedicatedProvisioningAttempt(
  studioId: string,
  practitionerId: string,
  attemptToken: string,
): Promise<ProvisioningAttemptResult> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: conn, error } = await admin
    .from("calendar_connections")
    .update({
      destination_provisioning_attempt_token: attemptToken,
      destination_provisioning_started_at: nowIso,
      updated_at: nowIso,
    })
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .eq("destination_mode", "dedicated_app_created")
    .is("app_created_calendar_id", null)
    .is("destination_provisioning_ambiguous_at", null)
    // CAS: only the FIRST caller mints the STABLE attempt token. A later retry
    // (token already present) or a concurrent caller matches 0 rows and re-reads
    // the claimed token — so every retry reconciles under ONE stable token and a
    // concurrent double-create is detected as ambiguous (never silently adopted).
    .is("destination_provisioning_attempt_token", null)
    .select("id")
    .maybeSingle();
  if (error || !conn) return { ok: false, reason: "begin_provisioning_failed" };
  return { ok: true, connectionId: conn.id as string, attemptToken };
}

// B2.4 dedicated_app_created — record the Hone-CREATED (or reconciled) secondary
// calendar as the destination. Sets the idempotency anchor (app_created_calendar_id)
// + write target + safe display name + configured timestamp, clears the ambiguity
// marker + the mutually-exclusive owned-validation fact. Guarded to the dedicated
// mode: a wrong-mode row matches nothing and fails closed.
export async function setDedicatedCalendarDestination(
  studioId: string,
  practitionerId: string,
  input: { calendarId: string; displayName: string },
): Promise<PersistResult> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: conn, error } = await admin
    .from("calendar_connections")
    .update({
      app_created_calendar_id: input.calendarId,
      write_calendar_id: input.calendarId,
      selected_calendar_display_name: input.displayName,
      destination_ownership_validated_at: null,
      destination_configured_at: nowIso,
      destination_provisioning_ambiguous_at: null,
      updated_at: nowIso,
    })
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .eq("destination_mode", "dedicated_app_created")
    .select("id")
    .maybeSingle();
  if (error || !conn) return { ok: false, reason: "dedicated_destination_update_failed" };
  return { ok: true, connectionId: conn.id as string };
}

// B2.4 dedicated — mark the connection AMBIGUOUS (reconciliation found multiple
// token matches). Readiness derives "needs_attention"; no calendar is auto-created
// while this is set. Guarded to the dedicated mode + only when not yet provisioned.
export async function markDedicatedProvisioningAmbiguous(
  studioId: string,
  practitionerId: string,
): Promise<PersistResult> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: conn, error } = await admin
    .from("calendar_connections")
    .update({
      destination_provisioning_ambiguous_at: nowIso,
      last_error_code: "provisioning_ambiguous",
      last_error_at: nowIso,
      updated_at: nowIso,
    })
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .eq("destination_mode", "dedicated_app_created")
    .is("app_created_calendar_id", null)
    .select("id")
    .maybeSingle();
  if (error || !conn) return { ok: false, reason: "mark_ambiguous_failed" };
  return { ok: true, connectionId: conn.id as string };
}

// B2.4 existing_owned — record a server-VALIDATED owned calendar as the destination
// (the caller has already confirmed accessRole === "owner" against Google's own
// calendar list for this connection). Sets the write target + safe display name +
// ownership-validated timestamp + configured timestamp, clears the mutually-
// exclusive app-created anchor. Guarded to the existing_owned mode.
export async function setOwnedCalendarDestination(
  studioId: string,
  practitionerId: string,
  input: { calendarId: string; displayName: string },
): Promise<PersistResult> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: conn, error } = await admin
    .from("calendar_connections")
    .update({
      write_calendar_id: input.calendarId,
      selected_calendar_display_name: input.displayName,
      app_created_calendar_id: null,
      destination_ownership_validated_at: nowIso,
      destination_configured_at: nowIso,
      updated_at: nowIso,
    })
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .eq("destination_mode", "existing_owned")
    .select("id")
    .maybeSingle();
  if (error || !conn) return { ok: false, reason: "owned_destination_update_failed" };
  return { ok: true, connectionId: conn.id as string };
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
