import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { storeRotatedRefreshToken } from "../connection";
import type { ConnectionAuthRow, ConnectionStore } from "./token-manager";

// Google Calendar — Phase B2.1: the production ConnectionStore, backed by the
// service-role admin client. Every read/write is re-derived by (connectionId,
// studioId) so a worker can never touch another studio's connection or secret.
// The ciphertext table is never exposed to a browser role (Phase A posture).

const AUTH_COLUMNS =
  "id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner, token_expires_at";

function toAuthRow(row: Record<string, unknown>): ConnectionAuthRow {
  return {
    id: row.id as string,
    studioId: row.studio_id as string,
    practitionerId: row.practitioner_id as string,
    connectionStatus: row.connection_status as ConnectionAuthRow["connectionStatus"],
    grantedScopes: (row.granted_scopes as string[] | null) ?? [],
    writeCalendarId: (row.write_calendar_id as string | null) ?? null,
    isStudioCalendarOwner: row.is_studio_calendar_owner === true,
    tokenExpiresAt: (row.token_expires_at as string | null) ?? null,
  };
}

export function createAdminConnectionStore(): ConnectionStore {
  const admin = createAdminClient();
  return {
    async loadConnection(connectionId, studioId) {
      const { data, error } = await admin
        .from("calendar_connections")
        .select(AUTH_COLUMNS)
        .eq("id", connectionId)
        .eq("studio_id", studioId)
        .maybeSingle();
      if (error || !data) return null;
      return toAuthRow(data);
    },
    async loadRefreshCiphertext(connectionId, studioId) {
      const { data } = await admin
        .from("calendar_connection_secrets")
        .select("encrypted_refresh_token")
        .eq("connection_id", connectionId)
        .eq("studio_id", studioId)
        .maybeSingle();
      return (data?.encrypted_refresh_token as string | null) ?? null;
    },
    async storeRotatedToken(args) {
      // Reuses the Phase-A helper (keyed by connectionId + studioId). Until B2.1
      // this was defined but never called — wiring it here fixes the live defect.
      await storeRotatedRefreshToken(args);
    },
    async touchTokenExpiry(connectionId, studioId, expiresAtIso) {
      await admin
        .from("calendar_connections")
        .update({ token_expires_at: expiresAtIso, updated_at: new Date().toISOString() })
        .eq("id", connectionId)
        .eq("studio_id", studioId);
    },
    async markReconnectRequired(connectionId, studioId, code) {
      const nowIso = new Date().toISOString();
      await admin
        .from("calendar_connections")
        .update({
          connection_status: "reconnect_required",
          last_error_code: code.slice(0, 64),
          last_error_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", connectionId)
        .eq("studio_id", studioId);
    },
  };
}
